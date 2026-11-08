import { EMPTY_INBOX, type CalendarEvent, type CalendarFeed, type InboxSnapshot, type MailAccount, type MailContent, type MailLabel, type MailMessage } from "../../shared/inbox.ts";
import { DEFAULT_ZONE, expandEvents, parseCalendar, zonedToUtc, type ParsedCalendar } from "./ical.ts";
import { type GmailCredentials, parseMessageRef, readLabels, readMailbox, readMessage, readMessages, searchSenders, suggestLabels, trashMessage } from "./imap.ts";
import { LocalEventStore } from "./local-events.ts";

const DAY_MS = 86_400_000;
const LOOKAHEAD_DAYS = 7;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_CALENDAR_BYTES = 30 * 1024 * 1024;
const MAX_EVENTS = 120;
const MAX_RANGE_EVENTS = 1500;
const CUSTOMER_MAIL_LIMIT = 150;

interface MailSyncOptions {
  readMail?: (account: GmailCredentials) => Promise<MailAccount>;
  readLabels?: (account: GmailCredentials, onLabel: (label: MailLabel) => void) => Promise<MailLabel[]>;
  onError?: (error: unknown) => void;
}

interface MailSyncState {
  current: MailAccount | null;
  labels: MailLabel[] | undefined;
  primary: Promise<void> | null;
  labelScan: Promise<void> | null;
  dirty: boolean;
  labelsDirty: boolean;
}

export class MailSync {
  private states = new Map<string, MailSyncState>();
  private options: MailSyncOptions;
  private accounts: GmailCredentials[];
  private publish: (account: MailAccount) => void;

  constructor(accounts: GmailCredentials[], publish: (account: MailAccount) => void, options: MailSyncOptions = {}) {
    this.accounts = accounts;
    this.publish = publish;
    this.options = options;
    for (const account of accounts) this.states.set(account.address, { current: null, labels: undefined, primary: null, labelScan: null, dirty: false, labelsDirty: false });
  }

  refresh(address?: string, labels = true): Promise<void> {
    return Promise.all(this.accounts.filter((account) => !address || account.address === address).map((account) => {
      const state = this.states.get(account.address)!;
      if (labels) this.scanLabels(account, state);
      if (state.primary) { state.dirty = true; return state.primary; }
      state.primary = (async () => {
        do {
          state.dirty = false;
          try {
            state.current = await (this.options.readMail ?? ((credentials) => readMailbox(credentials, { includeLabels: false })))(account);
            this.emit(state);
          } catch (error) { this.options.onError?.(error); }
        } while (state.dirty);
      })().finally(() => { state.primary = null; });
      return state.primary;
    })).then(() => undefined);
  }

  private emit(state: MailSyncState): void {
    if (!state.current) return;
    const labels = state.labels;
    this.publish(labels ? { ...state.current, labels, recent: suggestLabels(state.current.recent, labels.flatMap((label) => label.recent)) } : state.current);
  }

  private scanLabels(account: GmailCredentials, state: MailSyncState): void {
    if (state.labelScan) { state.labelsDirty = true; return; }
    state.labelScan = (async () => {
      do {
        state.labelsDirty = false;
        try {
          const onLabel = (label: MailLabel) => {
            const previous = state.labels ?? [];
            state.labels = previous.some((entry) => entry.path === label.path) ? previous.map((entry) => entry.path === label.path ? label : entry) : [...previous, label];
            this.emit(state);
          };
          state.labels = await (this.options.readLabels ?? ((credentials, update) => readLabels(credentials, { onLabel: update })))(account, onLabel);
          this.emit(state);
        } catch (error) { this.options.onError?.(error); }
      } while (state.labelsDirty);
    })().finally(() => { state.labelScan = null; });
  }
}

export function parseAccounts(raw: string): GmailCredentials[] {
  const seen = new Set<string>();
  const accounts: GmailCredentials[] = [];
  for (const entry of raw.split(",")) {
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;
    const address = entry.slice(0, colon).trim().toLowerCase();
    const password = entry.slice(colon + 1).replace(/\s+/g, "");
    if (!address.includes("@") || !password || seen.has(address)) continue;
    seen.add(address);
    accounts.push({ address, password });
  }
  return accounts;
}

export function parseCalendarUrls(raw: string): string[] {
  return [...new Set(raw.split(",").map((value) => value.trim()).filter((value) => value.startsWith("https://")))];
}

export function calendarIdFromUrl(url: string): string {
  const match = /\/calendar\/ical\/([^/]+)\//.exec(url);
  try {
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return match?.[1] ?? "";
  }
}

export function vietnamDayStart(now: number): number {
  const wall = new Date(now + 7 * 3_600_000);
  return zonedToUtc(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()), DEFAULT_ZONE);
}

interface LoadedCalendar {
  feed: CalendarFeed;
  calendar: ParsedCalendar | null;
}

const CALENDAR_CACHE_MS = 5 * 60_000;
let calendarCache: { at: number; key: string; entries: LoadedCalendar[] } | null = null;

async function fetchCalendar(url: string, index: number): Promise<LoadedCalendar> {
  const fallback = calendarIdFromUrl(url) || `Lịch ${index + 1}`;
  const broken = (note: string): LoadedCalendar => ({ feed: { label: fallback, connected: false, note }, calendar: null });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "text/calendar" } });
    if (res.status === 404 || res.status === 403) return broken("Link iCal sai hoặc đã bị đặt lại");
    if (!res.ok) return broken(`Google Calendar lỗi HTTP ${res.status}`);
    const body = await res.text();
    if (body.length > MAX_CALENDAR_BYTES) return broken("Lịch quá lớn để đọc");
    if (!body.includes("BEGIN:VCALENDAR")) return broken("Link không trả về lịch iCal");
    const calendar = parseCalendar(body);
    return { feed: { label: calendar.name || fallback, connected: true, note: "" }, calendar };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return broken(timeout ? "Google Calendar không phản hồi kịp" : "Không tải được lịch");
  }
}

async function loadCalendars(urls: string[], now: number, fresh: boolean): Promise<LoadedCalendar[]> {
  const key = urls.join(",");
  if (!fresh && calendarCache && calendarCache.key === key && now - calendarCache.at < CALENDAR_CACHE_MS) return calendarCache.entries;
  const entries = await Promise.all(urls.map((url, index) => fetchCalendar(url, index)));
  calendarCache = { at: now, key, entries };
  return entries;
}

export function dedupeEvents(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  return events
    .filter((event) => {
      const key = `${event.title}|${event.start}|${event.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

function expandAll(entries: LoadedCalendar[], windowStart: number, windowEnd: number): { feeds: CalendarFeed[]; events: CalendarEvent[] } {
  const perFeed = entries.map((entry) => (entry.calendar ? expandEvents(entry.calendar, entry.feed.label, windowStart, windowEnd) : []));
  const feeds = entries.map((entry, index) => (entry.calendar ? { ...entry.feed, note: `${perFeed[index].length} sự kiện` } : entry.feed));
  return { feeds, events: dedupeEvents(perFeed.flat()) };
}

export const MAX_RANGE_DAYS = 45;
export const localEvents = new LocalEventStore();

function withLocal(events: CalendarEvent[], from: number, to: number): CalendarEvent[] {
  let local: CalendarEvent[] = [];
  try {
    local = localEvents.list(from, to);
  } catch (error) {
    console.error("[calendar] local events unreadable:", error instanceof Error ? error.message : error);
  }
  return [...events, ...local].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export async function readCalendarRange(from: number, to: number, now = Date.now()): Promise<{ calendars: CalendarFeed[]; events: CalendarEvent[] } | null> {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > MAX_RANGE_DAYS * DAY_MS) return null;
  const urls = parseCalendarUrls(process.env.MSC_CALENDAR_ICS ?? "");
  const { feeds, events } = expandAll(await loadCalendars(urls, now, false), from, to);
  return { calendars: feeds, events: withLocal(events, from, to).slice(0, MAX_RANGE_EVENTS) };
}

export async function readInbox(now = Date.now(), onAccount?: (account: MailAccount) => void, accounts = parseAccounts(process.env.MSC_GMAIL_ACCOUNTS ?? "")): Promise<InboxSnapshot> {
  const urls = parseCalendarUrls(process.env.MSC_CALENDAR_ICS ?? "");
  if (!accounts.length && !urls.length) return { ...EMPTY_INBOX, fetchedAt: new Date(now).toISOString() };
  const windowStart = vietnamDayStart(now);
  const windowEnd = windowStart + LOOKAHEAD_DAYS * DAY_MS;
  const [mail, loaded] = await Promise.all([
    Promise.all(accounts.map((account) => readMailbox(account, { onUpdate: onAccount }))),
    loadCalendars(urls, now, false),
  ]);
  const { feeds, events } = expandAll(loaded, windowStart, windowEnd);
  return { configured: true, fetchedAt: new Date(now).toISOString(), accounts: mail, calendars: feeds, events: withLocal(events, windowStart, windowEnd).slice(0, MAX_EVENTS) };
}

export function parseMessageId(id: string, accounts: GmailCredentials[]): { account: GmailCredentials; uid: number; box: string } | null {
  const colon = id.lastIndexOf(":");
  if (colon <= 0) return null;
  const address = id.slice(0, colon).toLowerCase();
  const ref = parseMessageRef(id.slice(colon + 1));
  const account = accounts.find((entry) => entry.address === address);
  if (!account || !ref) return null;
  return { account, ...ref };
}

export interface CustomerMail {
  messages: MailMessage[];
  accounts: { address: string; connected: boolean; note: string }[];
}

export async function readCustomerMail(emails: string[], limit = CUSTOMER_MAIL_LIMIT): Promise<CustomerMail> {
  const accounts = parseAccounts(process.env.MSC_GMAIL_ACCOUNTS ?? "");
  const own = new Set(accounts.map((account) => account.address));
  const senders = emails.filter((email) => !own.has(email.trim().toLowerCase()));
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      return { address: account.address, connected: true, note: "", messages: await searchSenders(account, senders, limit) };
    } catch (error) {
      return { address: account.address, connected: false, note: error instanceof Error ? error.message.slice(0, 140) : "Gmail không trả lời", messages: [] as MailMessage[] };
    }
  }));
  const messages = results.flatMap((result) => result.messages).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  return { messages, accounts: results.map(({ address, connected, note }) => ({ address, connected, note })) };
}

export async function readMail(id: string): Promise<MailContent | null> {
  const target = parseMessageId(id, parseAccounts(process.env.MSC_GMAIL_ACCOUNTS ?? ""));
  return target ? await readMessage(target.account, target.uid, {}, target.box) : null;
}

export async function readMails(ids: string[]): Promise<Map<string, MailContent>> {
  const accounts = parseAccounts(process.env.MSC_GMAIL_ACCOUNTS ?? "");
  const groups = new Map<string, { account: GmailCredentials; box: string; uids: number[] }>();
  for (const id of ids) {
    const target = parseMessageId(id, accounts);
    if (!target) continue;
    const key = `${target.account.address}\u0000${target.box}`;
    const group = groups.get(key) ?? { account: target.account, box: target.box, uids: [] };
    group.uids.push(target.uid);
    groups.set(key, group);
  }
  const found = new Map<string, MailContent>();
  await Promise.all([...groups.values()].map(async (group) => {
    for (const mail of await readMessages(group.account, group.uids, {}, group.box)) found.set(mail.id, mail);
  }));
  return found;
}

export async function trashMail(id: string): Promise<boolean> {
  const target = parseMessageId(id, parseAccounts(process.env.MSC_GMAIL_ACCOUNTS ?? ""));
  return target ? await trashMessage(target.account, target.uid, {}, target.box) : false;
}
