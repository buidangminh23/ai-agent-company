import tls from "node:tls";
import type { MailAccount, MailContent, MailLabel, MailMessage } from "../../shared/inbox.ts";
import { parseMime } from "./mime.ts";

export interface GmailCredentials {
  address: string;
  password: string;
}

export interface ImapResponse {
  line: string;
  literals: Buffer[];
}

interface ImapSession {
  command(text: string): Promise<ImapResponse[]>;
  close(): void;
}

interface MailboxOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  limit?: number;
  connect?: (host: string, port: number) => tls.TLSSocket;
  onUpdate?: (account: MailAccount) => void;
  includeLabels?: boolean;
  onLabel?: (label: MailLabel) => void;
  poolIdleMs?: number;
}

const DEFAULT_HOST = "imap.gmail.com";
const DEFAULT_PORT = 993;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 50;
const MAX_MESSAGE_BYTES = 3 * 1024 * 1024;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const LABEL_LIMIT = 25;
const MAX_LABELS = 40;
const MAX_LABEL_SCAN_MS = 60_000;
const labelScanCursor = new Map<string, string>();
const INBOX_BOX = "INBOX";
const POOL_IDLE_MS = 5 * 60_000;
const MAX_BATCH_UIDS = 20;
const SENDER_BATCH = 25;
const FETCH_ITEMS = "UID FLAGS INTERNALDATE X-GM-THRID X-GM-LABELS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)]";
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNLISTED_FLAG = /\\(Noselect|NonExistent|All|Archive|Drafts|Flagged|Important|Junk|Sent|Trash)\b/i;
const PUBLIC_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "outlook.com", "hotmail.com", "live.com", "icloud.com", "me.com", "proton.me", "protonmail.com"]);
const SUGGEST_SHARE = 0.6;
const DOMAIN_MIN = 2;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ENCODED_WORD = /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g;

export class ImapError extends Error {}

export class ResponseReader {
  private buffer: Buffer = Buffer.alloc(0);
  private line = "";
  private literals: Buffer[] = [];
  private pending = 0;
  private ready: ImapResponse[] = [];

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) throw new ImapError("IMAP response too large");
    for (;;) {
      if (this.pending > 0) {
        if (this.buffer.length < this.pending) return;
        this.literals.push(Buffer.from(this.buffer.subarray(0, this.pending)));
        this.buffer = this.buffer.subarray(this.pending);
        this.pending = 0;
        continue;
      }
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) return;
      const part = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 2);
      const literal = /\{(\d+)\+?\}$/.exec(part);
      if (literal) {
        this.line += `${part.slice(0, literal.index)}\u0000`;
        this.pending = Number(literal[1]);
        if (this.pending === 0) this.literals.push(Buffer.alloc(0));
        continue;
      }
      this.ready.push({ line: this.line + part, literals: this.literals });
      this.line = "";
      this.literals = [];
    }
  }

  drain(): ImapResponse[] {
    const out = this.ready;
    this.ready = [];
    return out;
  }
}

export function quote(value: string): string {
  return `"${value.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`;
}

function qBytes(data: string): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const hex = data.slice(i + 1, i + 3);
    if (ch === "_") out.push(0x20);
    else if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

function decodeBytes(charset: string, bytes: Buffer): string {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("latin1");
  }
}

export function decodeWords(value: string): string {
  const parts: (string | { charset: string; bytes: Buffer[] })[] = [];
  let last = 0;
  let previousWord = false;
  for (const match of value.matchAll(ENCODED_WORD)) {
    const between = value.slice(last, match.index);
    const blank = /^\s*$/.test(between);
    const charset = match[1].replace(/\*.*$/, "").toLowerCase();
    const bytes = match[2].toUpperCase() === "B" ? Buffer.from(match[3], "base64") : qBytes(match[3]);
    const tail = parts[parts.length - 1];
    if (previousWord && blank && typeof tail === "object" && tail.charset === charset) tail.bytes.push(bytes);
    else {
      if (!(previousWord && blank) && between) parts.push(between);
      parts.push({ charset, bytes: [bytes] });
    }
    previousWord = true;
    last = (match.index ?? 0) + match[0].length;
  }
  parts.push(value.slice(last));
  return parts.map((part) => (typeof part === "string" ? part : decodeBytes(part.charset, Buffer.concat(part.bytes)))).join("");
}

export function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!(key in headers)) headers[key] = decodeWords(line.slice(colon + 1).trim());
  }
  return headers;
}

export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>/.exec(from);
  if (!match) return from.trim();
  return match[1].trim() || match[2].trim();
}

export function parseInternalDate(value: string): string | null {
  const match = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(value);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month < 0) return null;
  const offset = (match[7] === "-" ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9])) * 60_000;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])) - offset).toISOString();
}

export function searchIds(responses: ImapResponse[]): number[] {
  const ids: number[] = [];
  for (const response of responses) {
    if (!/^\* SEARCH\b/i.test(response.line)) continue;
    for (const token of response.line.slice(8).trim().split(/\s+/)) if (/^\d+$/.test(token)) ids.push(Number(token));
  }
  return ids;
}

export function gmailUrl(address: string, threadId?: string): string {
  const base = `https://mail.google.com/mail/?authuser=${encodeURIComponent(address)}`;
  if (!threadId || !/^\d+$/.test(threadId)) return `${base}#inbox`;
  return `${base}#all/${BigInt(threadId).toString(16)}`;
}

export function fromAddress(from: string): string {
  const angled = /<([^>\s]+@[^>\s]+)>/.exec(from)?.[1];
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(from)?.[1];
  return (angled ?? bare ?? "").toLowerCase();
}

export function decodeMailbox(name: string): string {
  return name.replace(/&([^-]*)-/g, (_, chunk: string) => {
    if (!chunk) return "&";
    const bytes = Buffer.from(chunk.replace(/,/g, "/"), "base64");
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  });
}

function unescapeQuoted(value: string): string {
  return value.replace(/\\(["\\])/g, "$1");
}

export function isHiddenLabel(path: string): boolean {
  return /^\[Gmail\]/i.test(path) || /^INBOX$/i.test(path) || path.split("/").some((part) => EMAIL_LIKE.test(part.trim()));
}

export interface LabelBox {
  raw: string;
  path: string;
}

export function parseLabelList(responses: ImapResponse[]): LabelBox[] {
  const out: LabelBox[] = [];
  for (const response of responses) {
    const match = /^\* LIST \(([^)]*)\) (?:"((?:[^"\\]|\\.)*)"|NIL) (.+)$/i.exec(response.line);
    if (!match || UNLISTED_FLAG.test(match[1])) continue;
    const name = match[3].trim();
    const raw = name === "\u0000" ? response.literals[0]?.toString("utf8") ?? "" : name.startsWith('"') ? unescapeQuoted(name.slice(1, -1)) : name;
    const delimiter = match[2] ? unescapeQuoted(match[2]) : "";
    const path = delimiter ? decodeMailbox(raw).split(delimiter).join("/") : decodeMailbox(raw);
    if (raw && !isHiddenLabel(path)) out.push({ raw, path });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, "vi", { sensitivity: "base" }));
}

export function allMailBox(responses: ImapResponse[]): string | null {
  for (const response of responses) {
    const match = /^\* LIST \(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (.+)$/i.exec(response.line);
    if (!match || !/\\All\b/i.test(match[1])) continue;
    const name = match[2].trim();
    return name === "\u0000" ? response.literals[0]?.toString("utf8") ?? null : name.startsWith('"') ? unescapeQuoted(name.slice(1, -1)) : name;
  }
  return null;
}

export function senderQueries(emails: string[], size = SENDER_BATCH): string[] {
  const clean = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter((email) => /^[^\s@"()]+@[^\s@"()]+\.[^\s@"()]+$/.test(email)))];
  const out: string[] = [];
  for (let index = 0; index < clean.length; index += size) out.push(`from:(${clean.slice(index, index + size).join(" OR ")})`);
  return out;
}

export async function searchSenders(account: GmailCredentials, emails: string[], limit: number, options: MailboxOptions = {}): Promise<MailMessage[]> {
  const queries = senderQueries(emails);
  if (!queries.length) return [];
  return withPooledSession(account, options, async (pooled) => {
    const box = allMailBox(await pooled.session.command('LIST "" "*"')) ?? INBOX_BOX;
    await examine(pooled, box);
    const uids = new Set<number>();
    for (const query of queries) for (const uid of searchIds(await pooled.session.command(`UID SEARCH X-GM-RAW ${quote(query)}`))) uids.add(uid);
    const latest = [...uids].sort((a, b) => a - b).slice(-limit);
    return latest.length ? parseFetch(await pooled.session.command(`UID FETCH ${latest.join(",")} (${FETCH_ITEMS})`), account.address, box) : [];
  });
}

export function parseGmailLabels(line: string): string[] {
  const list = /\bX-GM-LABELS \(((?:[^()"]|"(?:[^"\\]|\\.)*")*)\)/i.exec(line)?.[1] ?? "";
  const labels: string[] = [];
  for (const token of list.matchAll(/"((?:[^"\\]|\\.)*)"|([^\s"]+)/g)) {
    const text = token[1] ?? token[2];
    if (text.startsWith("\\")) continue;
    const raw = token[1] !== undefined ? unescapeQuoted(text) : text;
    const path = decodeMailbox(raw);
    if (!isHiddenLabel(path) && !labels.includes(path)) labels.push(path);
  }
  return labels;
}

export function messageId(address: string, box: string, uid: string | number): string {
  return box === INBOX_BOX ? `${address}:${uid}` : `${address}:L${Buffer.from(box, "utf8").toString("hex")}.${uid}`;
}

export function parseMessageRef(ref: string): { box: string; uid: number } | null {
  const match = /^(?:L((?:[0-9a-f]{2}){1,200})\.)?(\d{1,10})$/.exec(ref);
  if (!match) return null;
  const box = match[1] ? Buffer.from(match[1], "hex").toString("utf8") : INBOX_BOX;
  if (/[\u0000-\u001f]/.test(box)) return null;
  return { box, uid: Number(match[2]) };
}

function tally(counts: Map<string, Map<string, number>>, key: string, label: string): void {
  const row = counts.get(key) ?? new Map<string, number>();
  row.set(label, (row.get(label) ?? 0) + 1);
  counts.set(key, row);
}

function favourite(row: Map<string, number> | undefined, minimum: number): string | null {
  if (!row) return null;
  const total = [...row.values()].reduce((sum, n) => sum + n, 0);
  const [label, count] = [...row.entries()].sort((a, b) => b[1] - a[1])[0];
  return count >= minimum && count / total >= SUGGEST_SHARE ? label : null;
}

export function suggestLabels(messages: MailMessage[], labeled: MailMessage[]): MailMessage[] {
  const bySender = new Map<string, Map<string, number>>();
  const byDomain = new Map<string, Map<string, number>>();
  for (const message of labeled) {
    const address = message.fromAddress ?? "";
    const domain = address.split("@")[1] ?? "";
    for (const label of message.labels ?? []) {
      if (address) tally(bySender, address, label);
      if (domain && !PUBLIC_DOMAINS.has(domain)) tally(byDomain, domain, label);
    }
  }
  return messages.map((message) => {
    if (message.labels?.length || !message.fromAddress) return message;
    const domain = message.fromAddress.split("@")[1] ?? "";
    const suggested = favourite(bySender.get(message.fromAddress), 1) ?? (PUBLIC_DOMAINS.has(domain) ? null : favourite(byDomain.get(domain), DOMAIN_MIN));
    return suggested ? { ...message, suggested } : message;
  });
}

export function parseFetch(responses: ImapResponse[], address: string, box = INBOX_BOX): MailMessage[] {
  const messages: MailMessage[] = [];
  for (const response of responses) {
    if (!/^\* \d+ FETCH /i.test(response.line)) continue;
    const uid = /\bUID (\d+)/i.exec(response.line)?.[1];
    if (!uid) continue;
    const thread = /\bX-GM-THRID (\d+)/i.exec(response.line)?.[1];
    const at = parseInternalDate(/\bINTERNALDATE "([^"]+)"/i.exec(response.line)?.[1] ?? "");
    const headers = parseHeaders(response.literals[0]?.toString("utf8") ?? "");
    const flags = /\bFLAGS \(([^)]*)\)/i.exec(response.line)?.[1] ?? "";
    const labels = parseGmailLabels(response.line);
    const sender = fromAddress(headers.from ?? "");
    messages.push({
      id: messageId(address, box, uid),
      from: senderName(headers.from ?? "") || "Không rõ người gửi",
      subject: (headers.subject ?? "").trim() || "(Không có tiêu đề)",
      at: at ?? new Date(0).toISOString(),
      url: gmailUrl(address, thread),
      unread: !/\\Seen\b/i.test(flags),
      ...(sender ? { fromAddress: sender } : {}),
      ...(labels.length ? { labels } : {}),
    });
  }
  return messages.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function openSession(host: string, port: number, timeoutMs: number, connect = (host: string, port: number) => tls.connect({ host, port, servername: host })): Promise<ImapSession> {
  return new Promise((resolve, reject) => {
    const socket = connect(host, port);
    const reader = new ResponseReader();
    let collected: ImapResponse[] = [];
    let waiter: { tag: string; resolve: (responses: ImapResponse[]) => void; reject: (error: Error) => void } | null = null;
    let greeted = false;
    let failure: Error | null = null;
    let counter = 0;
    let timer = setTimeout(() => fail(new ImapError("Gmail không phản hồi kịp")), timeoutMs);
    function fail(error: Error): void {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      socket.destroy();
      if (!greeted) reject(error);
      const pending = waiter;
      waiter = null;
      pending?.reject(error);
    }
    const session: ImapSession = {
      command(text) {
        if (failure) return Promise.reject(failure);
        if (waiter) return Promise.reject(new ImapError("IMAP command already pending"));
        const tag = `m${++counter}`;
        return new Promise((done, broken) => {
          waiter = { tag, resolve: done, reject: broken };
          clearTimeout(timer);
          timer = setTimeout(() => fail(new ImapError("Gmail không phản hồi kịp")), timeoutMs);
          socket.write(`${tag} ${text}\r\n`);
        });
      },
      close() {
        if (failure) return;
        failure = new ImapError("closed");
        clearTimeout(timer);
        const pending = waiter;
        waiter = null;
        pending?.reject(failure);
        socket.end(`m${++counter} LOGOUT\r\n`);
        setTimeout(() => socket.destroy(), 1000).unref();
      },
    };
    socket.on("error", (error) => fail(error));
    socket.on("close", () => fail(new ImapError("Gmail đóng kết nối")));
    socket.on("data", (chunk: Buffer) => {
      try {
        reader.push(chunk);
      } catch (error) {
        fail(error as Error);
        return;
      }
      for (const response of reader.drain()) {
        if (!greeted) {
          if (!/^\* (OK|PREAUTH)\b/i.test(response.line)) {
            fail(new ImapError("Máy chủ IMAP từ chối kết nối"));
            return;
          }
          greeted = true;
          clearTimeout(timer);
          resolve(session);
          continue;
        }
        if (waiter && response.line.startsWith(`${waiter.tag} `)) {
          const done = waiter;
          waiter = null;
          clearTimeout(timer);
          const status = response.line.slice(done.tag.length + 1);
          const result = collected;
          collected = [];
          if (/^OK\b/i.test(status)) done.resolve(result);
          else done.reject(new ImapError(status));
        } else collected.push(response);
      }
    });
  });
}

function failureNote(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(message)) return "Gmail từ chối đăng nhập: App Password sai hoặc đã bị thu hồi";
  if (/WEBALERT|ALERT/i.test(message)) return "Gmail yêu cầu xác minh lại tài khoản trên trình duyệt";
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(message)) return "Không kết nối được máy chủ Gmail";
  return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}

async function login(account: GmailCredentials, options: MailboxOptions): Promise<ImapSession> {
  const session = await openSession(options.host ?? DEFAULT_HOST, options.port ?? DEFAULT_PORT, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.connect);
  try {
    await session.command(`LOGIN ${quote(account.address)} ${quote(account.password.replace(/\s+/g, ""))}`);
    return session;
  } catch (error) {
    session.close();
    throw error;
  }
}

interface PooledSession {
  session: ImapSession;
  box: string | null;
  idle: ReturnType<typeof setTimeout> | null;
}

const pooledSessions = new Map<string, PooledSession>();
const poolQueues = new Map<string, Promise<unknown>>();

function dropPooled(address: string, pooled: PooledSession): void {
  if (pooled.idle) clearTimeout(pooled.idle);
  pooled.idle = null;
  if (pooledSessions.get(address) === pooled) pooledSessions.delete(address);
  pooled.session.close();
}

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof ImapError)) return error instanceof Error;
  return /closed|đóng|kịp/i.test(error.message);
}

async function runPooled<T>(account: GmailCredentials, options: MailboxOptions, work: (pooled: PooledSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const reused = pooledSessions.get(account.address);
    const pooled = reused ?? { session: await login(account, options), box: null, idle: null };
    if (pooled.idle) clearTimeout(pooled.idle);
    pooled.idle = null;
    pooledSessions.set(account.address, pooled);
    try {
      const result = await work(pooled);
      pooled.idle = setTimeout(() => dropPooled(account.address, pooled), options.poolIdleMs ?? POOL_IDLE_MS);
      pooled.idle.unref?.();
      return result;
    } catch (error) {
      dropPooled(account.address, pooled);
      if (reused && attempt === 0 && isConnectionFailure(error)) continue;
      throw error;
    }
  }
}

function withPooledSession<T>(account: GmailCredentials, options: MailboxOptions, work: (pooled: PooledSession) => Promise<T>): Promise<T> {
  const previous = poolQueues.get(account.address) ?? Promise.resolve();
  const run = previous.then(() => runPooled(account, options, work));
  const tail = run.then(() => undefined, () => undefined);
  poolQueues.set(account.address, tail);
  void tail.then(() => { if (poolQueues.get(account.address) === tail) poolQueues.delete(account.address); });
  return run;
}

async function examine(pooled: PooledSession, box: string): Promise<void> {
  pooled.box = null;
  await pooled.session.command(`EXAMINE ${quote(box)}`);
  pooled.box = box;
}

export function closeMailSessions(): void {
  for (const [address, pooled] of [...pooledSessions]) dropPooled(address, pooled);
}

function existsCount(responses: ImapResponse[]): number {
  for (const response of responses) {
    const match = /^\* (\d+) EXISTS\b/i.exec(response.line);
    if (match) return Number(match[1]);
  }
  return 0;
}

async function readLabel(session: ImapSession, address: string, box: LabelBox): Promise<MailLabel> {
  const total = existsCount(await session.command(`EXAMINE ${quote(box.raw)}`));
  let unread = 0;
  if (total) {
    const status = await session.command(`STATUS ${quote(box.raw)} (UNSEEN)`);
    const match = status.map((entry) => entry.line).join("\n").match(/\bUNSEEN (\d+)\b/i);
    unread = match ? Number(match[1]) : searchIds(await session.command("UID SEARCH UNSEEN")).length;
  }
  const first = Math.max(1, total - LABEL_LIMIT + 1);
  const recent = total ? parseFetch(await session.command(`FETCH ${first}:${total} (${FETCH_ITEMS})`), address, box.raw) : [];
  return { path: box.path, unread, total, recent };
}

export async function readLabels(account: GmailCredentials, options: MailboxOptions = {}): Promise<MailLabel[]> {
  const session = await login(account, options);
  const deadline = setTimeout(() => session.close(), MAX_LABEL_SCAN_MS);
  try {
    const listed = parseLabelList(await session.command('LIST "" "*"')).slice(0, MAX_LABELS);
    const cursor = listed.findIndex((box) => box.raw === labelScanCursor.get(account.address));
    const boxes = [...listed.slice(cursor + 1), ...listed.slice(0, cursor + 1)];
    const labels: MailLabel[] = [];
    for (const box of boxes) {
      labelScanCursor.set(account.address, box.raw);
      try {
        const label = await readLabel(session, account.address, box);
        labels.push(label);
        options.onLabel?.(label);
      } catch (error) {
        if (!(error instanceof ImapError) || /closed|đóng|kịp/i.test(error.message)) throw error;
      }
    }
    labelScanCursor.delete(account.address);
    return labels.sort((a, b) => a.path.localeCompare(b.path, "vi", { sensitivity: "base" }));
  } finally {
    clearTimeout(deadline);
    session.close();
  }
}

export async function readMailbox(account: GmailCredentials, options: MailboxOptions = {}): Promise<MailAccount> {
  if (options.includeLabels === false) return readInbox(account, options);
  const [inbox, labels] = await Promise.all([
    readInbox(account, options).then((inbox) => { options.onUpdate?.(inbox); return inbox; }),
    readLabels(account, options).catch((error: unknown) => {
      console.error(`[mail] labels unreadable for ${account.address}:`, error instanceof Error ? error.message : error);
      return null;
    }),
  ]);
  if (!inbox.connected || !labels) return inbox;
  const complete = { ...inbox, recent: suggestLabels(inbox.recent, labels.flatMap((label) => label.recent)), labels };
  options.onUpdate?.(complete);
  return complete;
}

async function readInbox(account: GmailCredentials, options: MailboxOptions): Promise<MailAccount> {
  const base: MailAccount = { address: account.address, connected: false, note: "", unread: null, unreadAll: null, recent: [], url: gmailUrl(account.address) };
  let session: ImapSession | null = null;
  try {
    session = await login(account, options);
    await session.command("EXAMINE INBOX");
    const all = searchIds(await session.command("UID SEARCH UNSEEN"));
    const listed = searchIds(await session.command("UID SEARCH ALL"));
    const latest = listed.sort((a, b) => a - b).slice(-(options.limit ?? DEFAULT_LIMIT));
    const recent = latest.length ? parseFetch(await session.command(`UID FETCH ${latest.join(",")} (${FETCH_ITEMS})`), account.address) : [];
    return { ...base, connected: true, note: "Hộp thư đến", unread: all.length, unreadAll: all.length, recent };
  } catch (error) {
    return { ...base, note: failureNote(error) };
  } finally {
    session?.close();
  }
}

export function parseMessage(responses: ImapResponse[], address: string, box = INBOX_BOX): MailContent | null {
  return parseMessages(responses, address, box)[0] ?? null;
}

export function parseMessages(responses: ImapResponse[], address: string, box = INBOX_BOX): MailContent[] {
  return responses.flatMap((response) => {
    const mail = /^\* \d+ FETCH /i.test(response.line) && response.literals.length ? messageFromFetch(response, address, box) : null;
    return mail ? [mail] : [];
  });
}

function messageFromFetch(response: ImapResponse, address: string, box: string): MailContent | null {
  const uid = /\bUID (\d+)/i.exec(response.line)?.[1];
  if (!uid) return null;
  const raw = response.literals[0];
  const mime = parseMime(raw);
  const thread = /\bX-GM-THRID (\d+)/i.exec(response.line)?.[1];
  const at = parseInternalDate(/\bINTERNALDATE "([^"]+)"/i.exec(response.line)?.[1] ?? "");
  return {
    id: messageId(address, box, uid),
    account: address,
    from: (mime.headers.from ?? "").trim() || "Không rõ người gửi",
    to: (mime.headers.to ?? "").trim(),
    subject: (mime.headers.subject ?? "").trim() || "(Không có tiêu đề)",
    at: at ?? new Date(0).toISOString(),
    url: gmailUrl(address, thread),
    html: mime.html,
    text: mime.text,
    attachments: mime.attachments,
    truncated: raw.length >= MAX_MESSAGE_BYTES,
  };
}

export async function readMessage(account: GmailCredentials, uid: number, options: MailboxOptions = {}, box = INBOX_BOX): Promise<MailContent | null> {
  return (await readMessages(account, [uid], options, box))[0] ?? null;
}

export async function readMessages(account: GmailCredentials, uids: number[], options: MailboxOptions = {}, box = INBOX_BOX): Promise<MailContent[]> {
  const wanted = [...new Set(uids)].slice(0, MAX_BATCH_UIDS);
  if (!wanted.length) return [];
  const fetchBodies = async (pooled: PooledSession) => parseMessages(await pooled.session.command(`UID FETCH ${wanted.join(",")} (UID INTERNALDATE X-GM-THRID BODY.PEEK[]<0.${MAX_MESSAGE_BYTES}>)`), account.address, box);
  return withPooledSession(account, options, async (pooled) => {
    if (pooled.box === box) {
      const found = await fetchBodies(pooled);
      if (found.length >= wanted.length) return found;
    }
    await examine(pooled, box);
    return fetchBodies(pooled);
  });
}

export async function trashMessage(account: GmailCredentials, uid: number, options: MailboxOptions = {}, box = INBOX_BOX): Promise<boolean> {
  const session = await login(account, options);
  try {
    await session.command(`SELECT ${quote(box)}`);
    if (!searchIds(await session.command(`UID SEARCH UID ${uid}`)).includes(uid)) return false;
    await session.command(`UID STORE ${uid} +X-GM-LABELS (\\Trash)`);
    return true;
  } finally {
    session.close();
  }
}
