import { L } from "../shared/i18n.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentInfo } from "../shared/types.ts";
import { replyFieldHints, replyFieldHintsValid } from "../shared/replies.ts";
import type { ReplyApp, ReplyField, ReplyKind, ReplyList, ReplyQuestion, ReplyReceipt, ReplyStatus, ReplySubmission } from "../shared/replies.ts";

export interface ReplyIdentity {
  accountId: string;
  cwd: string;
  sessionId: string;
  threadId: string;
  nativeRequestId: string;
  version: string;
}

export interface NativeReplyQuestion {
  kind: ReplyKind;
  title: string;
  detail: string;
  agentId: string;
  app: ReplyApp;
  machine: AgentInfo["machine"];
  identity: ReplyIdentity;
  askedAt: string;
  fields: ReplyField[];
}

export interface NativeReplyAdapter {
  app: ReplyApp;
  list(agent: AgentInfo, signal: AbortSignal): Promise<NativeReplyQuestion[]>;
  submit(question: NativeReplyQuestion, answers: Record<string, string[]>, context: { author: "human-web"; requestId: string; signal: AbortSignal }): Promise<{ status: "answered" | "stale" | "unknown" }>;
}

export interface ReplyBrokerOptions {
  adapters: NativeReplyAdapter[];
  file?: string;
  timeoutMs?: number;
}

interface ReceiptRow extends ReplyReceipt {
  digest: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATUS_TEXT: Record<ReplyStatus, string> = {
  pending: L("Đang kiểm tra và gửi câu trả lời; không gửi lại"),
  answered: L("Ứng dụng gốc đã xác nhận nhận câu trả lời"),
  rejected: L("Câu hỏi đã thay đổi, đã được trả lời hoặc dữ liệu không hợp lệ; chưa gửi"),
  unknown: L("Chưa xác nhận được kết quả; không tự gửi lại, kiểm tra chat gốc"),
};

export class ReplyBrokerError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

function normalizedCwd(value: string): string {
  if (/^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\")) return path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
  return path.posix.normalize(value).replace(/\/+$/, "") || "/";
}

const KINDS: readonly ReplyKind[] = ["question", "approval", "plan"];

function plain(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function labelsValid(field: ReplyField): boolean {
  if (field.labels === undefined) return true;
  if (!field.labels || typeof field.labels !== "object" || Array.isArray(field.labels)) return false;
  const entries = Object.entries(field.labels);
  return entries.length <= field.options.length && entries.every(([option, label]) => field.options.includes(option) && text(label, 200));
}

function questionValid(question: NativeReplyQuestion, agent: AgentInfo): boolean {
  if (!KINDS.includes(question.kind) || !text(question.title, 300) || !plain(question.detail, 8000) || question.agentId !== agent.id || question.app !== agent.app || question.machine !== agent.machine) return false;
  const identity = question.identity;
  if (!identity || ![identity.accountId, identity.cwd, identity.sessionId, identity.threadId, identity.nativeRequestId, identity.version].every((value) => text(value, 2048))) return false;
  if (!agent.cwd || !agent.sessionId || normalizedCwd(agent.cwd) !== normalizedCwd(identity.cwd) || agent.sessionId !== identity.sessionId) return false;
  if (!Number.isFinite(Date.parse(question.askedAt)) || !Array.isArray(question.fields) || question.fields.length < 1 || question.fields.length > 8) return false;
  const ids = new Set<string>();
  for (const field of question.fields) {
    if (!field || !text(field.id, 200) || ids.has(field.id) || !text(field.text, 6000) || typeof field.multiSelect !== "boolean" || typeof field.allowFreeText !== "boolean" || (field.optional !== undefined && typeof field.optional !== "boolean")) return false;
    if (!Array.isArray(field.options) || field.options.length > 30 || !field.options.every((option) => text(option, 1000)) || new Set(field.options).size !== field.options.length || (!field.options.length && !field.allowFreeText) || !labelsValid(field) || !replyFieldHintsValid(field)) return false;
    ids.add(field.id);
  }
  return question.fields.some((field) => !field.optional) && Buffer.byteLength(JSON.stringify(question)) <= 64 * 1024;
}

function publicField(field: ReplyField): ReplyField {
  return { id: field.id, text: field.text, options: [...field.options], multiSelect: field.multiSelect, allowFreeText: field.allowFreeText, ...(field.labels ? { labels: Object.fromEntries(field.options.filter((option) => Object.hasOwn(field.labels!, option)).map((option) => [option, field.labels![option]])) } : {}), ...replyFieldHints(field), ...(field.optional ? { optional: true } : {}) };
}

export function replyQuestionId(question: NativeReplyQuestion): string {
  return digest([question.kind, question.title, question.detail, question.agentId, question.app, question.machine, question.identity.accountId, normalizedCwd(question.identity.cwd), question.identity.sessionId, question.identity.threadId, question.identity.nativeRequestId, question.identity.version, question.askedAt, question.fields.map((field) => { const shown = publicField(field); return [shown.id, shown.text, shown.options, shown.multiSelect, shown.allowFreeText, shown.labels ? Object.entries(shown.labels) : null, shown.optional === true]; })]);
}

function nativeBaseKey(question: NativeReplyQuestion): string {
  return digest([question.app, question.machine, question.identity.accountId, normalizedCwd(question.identity.cwd), question.identity.sessionId, question.identity.threadId, question.identity.nativeRequestId]);
}

function nativeRequestKey(question: NativeReplyQuestion): string {
  return digest([question.app, question.machine, question.identity.accountId, normalizedCwd(question.identity.cwd), question.identity.sessionId, question.identity.threadId, question.identity.nativeRequestId, question.identity.version]);
}

function publicQuestion(question: NativeReplyQuestion): ReplyQuestion {
  return { id: replyQuestionId(question), kind: question.kind, title: question.title, detail: question.detail, agentId: question.agentId, app: question.app, machine: question.machine, threadId: question.identity.threadId, nativeRequestId: question.identity.nativeRequestId, askedAt: question.askedAt, fields: question.fields.map(publicField) };
}

function submission(value: unknown): ReplySubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReplyBrokerError(400, L("Dữ liệu trả lời không hợp lệ"));
  const body = value as ReplySubmission;
  if (!UUID.test(body.requestId) || !HASH.test(body.questionId) || !text(body.agentId, 300) || !body.answers || typeof body.answers !== "object" || Array.isArray(body.answers)) throw new ReplyBrokerError(400, L("Dữ liệu trả lời không hợp lệ"));
  const entries = Object.entries(body.answers);
  if (entries.length < 1 || entries.length > 8 || entries.some(([id, answers]) => !text(id, 200) || !Array.isArray(answers) || answers.length > 30 || answers.some((answer) => !plain(answer, 4000)))) throw new ReplyBrokerError(400, L("Nội dung câu trả lời không hợp lệ"));
  if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024) throw new ReplyBrokerError(413, L("Nội dung câu trả lời quá dài"));
  const filled = entries.map(([id, answers]) => [id, answers.filter((answer) => answer.trim().length > 0)] as const).filter(([, answers]) => answers.length > 0);
  return { requestId: body.requestId.toLowerCase(), questionId: body.questionId, agentId: body.agentId, answers: Object.fromEntries(filled.sort(([a], [b]) => a.localeCompare(b)).map(([id, answers]) => [id, [...answers]])) };
}

function answersValid(question: NativeReplyQuestion, answers: Record<string, string[]>): boolean {
  if (Object.keys(answers).some((id) => !question.fields.some((field) => field.id === id))) return false;
  return question.fields.every((field) => {
    const values = Object.hasOwn(answers, field.id) ? answers[field.id] : [];
    if (!Array.isArray(values)) return false;
    if (!values.length) return field.optional === true;
    return (field.multiSelect || values.length === 1) && new Set(values).size === values.length && values.every((value) => field.allowFreeText || field.options.includes(value));
  });
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export class ReplyBroker {
  private db: DatabaseSync | null = null;
  private readonly adapters: Map<ReplyApp, NativeReplyAdapter>;
  private readonly timeoutMs: number;

  constructor(options: ReplyBrokerOptions) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.app, adapter]));
    this.timeoutMs = options.timeoutMs ?? 8000;
    try {
      const file = options.file ?? process.env.MSC_REPLIES_FILE ?? path.join(os.homedir(), ".msc-company", "replies.sqlite");
      if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(file);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; PRAGMA max_page_count=16384; CREATE TABLE IF NOT EXISTS receipts (requestId TEXT PRIMARY KEY, questionId TEXT NOT NULL, agentId TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, detail TEXT NOT NULL); CREATE TABLE IF NOT EXISTS nativeClaims (nativeKey TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL); CREATE TABLE IF NOT EXISTS nativeBases (requestId TEXT PRIMARY KEY, baseKey TEXT NOT NULL); CREATE INDEX IF NOT EXISTS native_base_key ON nativeBases(baseKey)");
      const schema = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'receipts'").get() as { sql: string };
      if (schema.sql.includes("questionId TEXT UNIQUE NOT NULL")) this.db.exec("BEGIN IMMEDIATE; CREATE TABLE receipts_v2 (requestId TEXT PRIMARY KEY, questionId TEXT NOT NULL, agentId TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, detail TEXT NOT NULL); INSERT INTO receipts_v2 SELECT * FROM receipts; DROP TABLE receipts; ALTER TABLE receipts_v2 RENAME TO receipts; COMMIT;");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS active_question_claim ON receipts(questionId) WHERE status != 'rejected'");
    } catch {
      this.db?.close();
      this.db = null;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  receipt(requestId: string): ReplyReceipt | null {
    if (!UUID.test(requestId)) throw new ReplyBrokerError(400, L("Mã gửi không hợp lệ"));
    const row = this.row(requestId.toLowerCase());
    return row ? this.publicReceipt(row) : null;
  }

  async list(agents: AgentInfo[]): Promise<ReplyList> {
    const result: ReplyList = { generatedAt: new Date().toISOString(), questions: [], unavailable: [] };
    const eligible = agents.filter((agent) => agent.app === "codex" || agent.app === "claude").slice(0, 100);
    await Promise.all(eligible.map(async (agent) => {
      const app = agent.app as ReplyApp;
      const unavailable = (reason: string) => result.unavailable.push({ agentId: agent.id, app, machine: agent.machine, reason });
      const adapter = this.adapters.get(app);
      if (!adapter) return unavailable(L("Ứng dụng chưa có kênh trả lời trực tiếp đã xác minh"));
      if (!this.db) return unavailable(L("Không lưu được biên nhận; gửi trực tiếp đang tắt"));
      try {
        const questions = await bounded((signal) => adapter.list(agent, signal), this.timeoutMs);
        if (!Array.isArray(questions) || questions.length > 16) return unavailable(L("Dữ liệu câu hỏi từ ứng dụng không hợp lệ"));
        for (const question of questions) {
          if (!questionValid(question, agent)) continue;
          const id = replyQuestionId(question);
          const claimed = this.db?.prepare("SELECT requestId FROM receipts WHERE questionId = ? AND status != 'rejected'").get(id);
          if (!claimed && !this.nativeBlocked(question)) result.questions.push(publicQuestion(question));
        }
      } catch { unavailable(L("Không xác minh được câu hỏi trong ứng dụng gốc")); }
    }));
    result.questions.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
    return result;
  }

  async answer(value: unknown, agents: AgentInfo[]): Promise<ReplyReceipt> {
    const body = submission(value);
    if (!this.db) throw new ReplyBrokerError(503, L("Không lưu được biên nhận; chưa gửi câu trả lời"));
    const hash = digest([body.questionId, body.agentId, body.answers]);
    const previous = this.row(body.requestId);
    if (previous) {
      if (previous.digest !== hash) throw new ReplyBrokerError(409, L("Mã gửi đã được dùng cho nội dung khác"));
      return this.publicReceipt(previous);
    }
    const agent = agents.find((item) => item.id === body.agentId);
    const adapter = agent && (agent.app === "codex" || agent.app === "claude") ? this.adapters.get(agent.app) : undefined;
    if (!agent || !adapter || !agent.cwd || !agent.sessionId) throw new ReplyBrokerError(409, L("Không xác minh được phiên đích; chưa gửi"));
    let native: NativeReplyQuestion | undefined;
    try {
      const questions = await bounded((signal) => adapter.list(agent, signal), this.timeoutMs);
      if (Array.isArray(questions) && questions.length <= 16) {
        const current = questions.find((question) => questionValid(question, agent) && replyQuestionId(question) === body.questionId);
        native = current && structuredClone(current);
      }
    } catch {
      native = undefined;
    }
    const initialStatus: ReplyStatus = native && answersValid(native, body.answers) ? "pending" : "rejected";
    const now = new Date().toISOString();
    try {
      this.db.prepare("INSERT INTO receipts (requestId,questionId,agentId,digest,status,createdAt,updatedAt,detail) VALUES (?,?,?,?,?,?,?,?)").run(body.requestId, body.questionId, body.agentId, hash, initialStatus, now, now, STATUS_TEXT[initialStatus]);
    } catch {
      const current = this.row(body.requestId);
      if (current?.digest === hash) return this.publicReceipt(current);
      if (current) throw new ReplyBrokerError(409, L("Mã gửi đã được dùng cho nội dung khác"));
      if (this.db.prepare("SELECT requestId FROM receipts WHERE questionId = ? AND status != 'rejected'").get(body.questionId)) throw new ReplyBrokerError(409, L("Câu hỏi đã có một lần gửi; kiểm tra biên nhận trước khi tiếp tục"));
      throw new ReplyBrokerError(503, L("Không lưu được biên nhận; chưa gửi câu trả lời"));
    }
    if (!native || initialStatus === "rejected") return this.publicReceipt(this.row(body.requestId)!);
    try {
      this.transaction(() => {
        if (this.nativeBlocked(native!)) throw new Error("claimed");
        this.db!.prepare("DELETE FROM nativeClaims WHERE nativeKey = ? AND requestId IN (SELECT requestId FROM receipts WHERE status = 'rejected')").run(nativeRequestKey(native!));
        this.db!.prepare("INSERT INTO nativeClaims (nativeKey,requestId) VALUES (?,?)").run(nativeRequestKey(native!), body.requestId);
        this.db!.prepare("INSERT INTO nativeBases (requestId,baseKey) VALUES (?,?)").run(body.requestId, nativeBaseKey(native!));
      });
    } catch {
      return this.finish(body.requestId, "rejected", true);
    }
    try {
      const result = await bounded((signal) => adapter.submit(native!, body.answers, { author: "human-web", requestId: body.requestId, signal }), this.timeoutMs);
      return this.finish(body.requestId, result.status === "answered" ? "answered" : result.status === "stale" ? "rejected" : "unknown", result.status === "stale");
    } catch {
      return this.finish(body.requestId, "unknown");
    }
  }

  private nativeBlocked(question: NativeReplyQuestion): boolean {
    if (!this.db) return true;
    const base = nativeBaseKey(question);
    return !!this.db.prepare("SELECT c.requestId FROM nativeClaims c LEFT JOIN receipts r ON r.requestId = c.requestId WHERE c.nativeKey = ? AND (r.status IS NULL OR r.status != 'rejected')").get(nativeRequestKey(question))
      || !!this.db.prepare("SELECT b.requestId FROM nativeBases b JOIN receipts r ON r.requestId = b.requestId WHERE b.baseKey = ? AND r.status IN ('pending','unknown')").get(base)
      || !!this.db.prepare("SELECT c.requestId FROM nativeClaims c JOIN receipts r ON r.requestId = c.requestId WHERE c.nativeKey = ? AND r.status IN ('pending','unknown')").get(base);
  }

  private row(requestId: string): ReceiptRow | undefined {
    if (!this.db) throw new ReplyBrokerError(503, L("Kho biên nhận chưa sẵn sàng"));
    return this.db.prepare("SELECT * FROM receipts WHERE requestId = ?").get(requestId) as unknown as ReceiptRow | undefined;
  }

  private publicReceipt(row: ReceiptRow): ReplyReceipt {
    return { requestId: row.requestId, questionId: row.questionId, agentId: row.agentId, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, detail: row.detail };
  }

  private transaction(work: () => void): void {
    this.db!.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.db!.exec("COMMIT");
    } catch (error) {
      try { this.db!.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  private finish(requestId: string, status: ReplyStatus, unsent = false): ReplyReceipt {
    const now = new Date().toISOString();
    try {
      this.transaction(() => {
        this.db!.prepare("UPDATE receipts SET status = ?, updatedAt = ?, detail = ? WHERE requestId = ?").run(status, now, STATUS_TEXT[status], requestId);
        if (unsent && status === "rejected") {
          this.db!.prepare("DELETE FROM nativeClaims WHERE requestId = ?").run(requestId);
          this.db!.prepare("DELETE FROM nativeBases WHERE requestId = ?").run(requestId);
        }
      });
      return this.publicReceipt(this.row(requestId)!);
    } catch {
      throw new ReplyBrokerError(503, L("Không cập nhật được biên nhận; không gửi lại, kiểm tra chat gốc"));
    }
  }
}
