import type { CalendarEvent, InboxSnapshot, MailAccount, MailContent, MailMessage } from "../shared/inbox.ts";
import { LABEL_PREFIX, labelRows, mergeLabels, messageChips, type LabelNode } from "./mail-labels.ts";
import { escapeHtml } from "./markdown.ts";
import "./inbox-views.css";

const TIMEZONE = "Asia/Ho_Chi_Minh";
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;

const HOUR_PX = 48;
const MINUTE_PX = HOUR_PX / 60;
const MIN_EVENT_PX = 20;
const COMPACT_EVENT_PX = 36;
const SHARED_COLOR = "#0077b5";
const SETUP_SCRIPT = "pwsh scripts/setup-google-inbox.ps1";
const ACCOUNT_COLORS = ["#1a73e8", "#d93025", "#188038", "#e37400", "#9334e6", "#007b83"];

export const ALL_MAILBOXES = "all";

interface Row {
  message: MailMessage;
  account: MailAccount;
  color: string;
}

interface Placed {
  event: CalendarEvent;
  top: number;
  height: number;
  lane: number;
  lanes: number;
  color: string;
}

function text(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function safeHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function vnDay(ms: number): string {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(0, 10);
}

function vnMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00+07:00`);
}

function mailTime(value: string, now: number): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  if (vnDay(ms) === vnDay(now)) return new Date(ms).toLocaleTimeString("vi-VN", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
  return new Date(ms).toLocaleDateString("vi-VN", { timeZone: TIMEZONE, day: "numeric", month: "short" });
}

function accountColor(index: number): string {
  return ACCOUNT_COLORS[index % ACCOUNT_COLORS.length];
}

function setupMarkup(kind: "mail" | "calendar"): string {
  const steps = kind === "mail"
    ? [["Bật xác minh 2 bước rồi tạo App Password 16 ký tự cho từng Gmail.", "https://myaccount.google.com/apppasswords", "Mở App Passwords"]]
    : [["Google Calendar → Cài đặt → chọn từng lịch → Tích hợp lịch → sao chép “Địa chỉ bí mật ở định dạng iCal”.", "https://calendar.google.com/calendar/u/0/r/settings", "Mở Cài đặt Lịch"]];
  const title = kind === "mail" ? "Chưa kết nối Gmail" : "Chưa kết nối Google Calendar";
  const intro = kind === "mail"
    ? "Tạo App Password trên Google mới là bước 1. Mật khẩu đó phải được lưu lên hub thì hộp thư mới hiện ở đây."
    : "Lịch chỉ đọc qua đường link iCal bí mật; link được lưu trên hub, không gửi xuống trình duyệt.";
  return `<div class="ix-setup"><span class="ix-setup-icon" aria-hidden="true">${kind === "mail" ? "✉" : "▦"}</span><h2>${title}</h2><p>${intro}</p><ol><li>${steps[0][0]} <a href="${steps[0][1]}" target="_blank" rel="noopener noreferrer">${steps[0][2]}</a></li><li>Chạy lệnh dưới đây trên máy Windows, nhập ${kind === "mail" ? "địa chỉ Gmail và App Password" : "link iCal"} khi được hỏi. Script kiểm tra đăng nhập trước khi lưu lên hub rồi khởi động lại hub.</li></ol><p class="ix-code">${text(SETUP_SCRIPT)}</p></div>`;
}

export interface MailReader {
  id: string;
  mail: MailContent | null;
  error: string;
  deleting?: boolean;
}

function mailDocument(mail: MailContent): string {
  const policy = "default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data: https: http:";
  const body = mail.html !== null ? mail.html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, "") : `<pre>${text(mail.text ?? "")}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><base target="_blank"><style>body{margin:0;padding:1rem 1.5rem;font:0.875rem/1.5 Inter,Arial,sans-serif;color:#202124;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{margin:0;white-space:pre-wrap;font:inherit}</style></head><body>${body}</body></html>`;
}

function readerMarkup(reader: MailReader, now: number): string {
  const back = '<button type="button" class="gm-back" data-action="mail-back"><span aria-hidden="true">←</span>Hộp thư</button>';
  const trash = reader.mail ? `<button type="button" class="gm-trash" data-action="mail-delete"${reader.deleting ? " disabled" : ""} title="Chuyển vào Thùng rác của Gmail"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.8 7v4M9.2 7v4"/></svg>${reader.deleting ? "Đang xóa…" : "Xóa"}</button>` : "";
  const mail = reader.mail;
  if (!mail) return `<div class="gm-toolbar">${back}</div><div class="gm-empty"><strong>${reader.error ? "Không mở được thư" : "Đang mở thư…"}</strong><span>${text(reader.error || "Đang đọc nội dung từ Gmail qua hub.")}</span></div>`;
  const notes = [
    mail.attachments.length ? `<p class="gm-attach">${mail.attachments.length} tệp đính kèm: ${mail.attachments.map((name) => text(name)).join(", ")}</p>` : "",
    mail.truncated ? '<p class="gm-banner">Thư quá dài, chỉ hiện phần đầu.</p>' : "",
  ].join("");
  const href = safeHref(mail.url) ?? "https://mail.google.com/mail/";
  return `<div class="gm-toolbar">${back}${trash}<a class="gm-open" href="${text(href)}" target="_blank" rel="noopener noreferrer">Mở trong Gmail</a></div><header class="gm-head"><h2>${text(mail.subject)}</h2><p><b>${text(mail.from)}</b><time datetime="${text(mail.at)}">${text(mailTime(mail.at, now))}</time></p>${mail.to ? `<p>Tới: ${text(mail.to)}</p>` : ""}</header>${notes}<iframe class="gm-frame" title="Nội dung thư" sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" srcdoc="${text(mailDocument(mail))}"></iframe>`;
}

function tagIcon(color: string): string {
  return `<svg class="gm-tag-icon" viewBox="0 0 16 16" style="--c:${color}" aria-hidden="true"><path d="M2.5 3.5v4.1c0 .4.2.8.4 1l5 5c.6.6 1.5.6 2.1 0l3.4-3.4c.6-.6.6-1.5 0-2.1l-5-5c-.3-.3-.6-.4-1-.4H3.5a1 1 0 0 0-1 1Z"/><circle cx="5.5" cy="5.5" r="1.1"/></svg>`;
}

function chipsMarkup(message: MailMessage, currentKey: string | null): string {
  const { chips, more } = messageChips(message, currentKey);
  if (!chips.length) return "";
  const items = chips.map((chip) => `<span class="gm-chip" style="--c:${chip.color}" data-suggested="${chip.suggested}" title="${text(chip.suggested ? `Gợi ý nhãn “${chip.name}”: các thư trước của người gửi này đều nằm trong nhãn đó` : `Nhãn ${chip.name}`)}">${chip.suggested ? "Gợi ý: " : ""}${text(chip.name)}</span>`).join("");
  return `<span class="gm-chips">${items}${more ? `<span class="gm-chip gm-chip-more">+${more}</span>` : ""}</span>`;
}

function rowMarkup(row: Row, now: number, currentKey: string | null): string {
  const message = row.message;
  return `<li><button type="button" class="gm-row" data-unread="${message.unread !== false}" data-mail="${text(message.id)}"><span class="gm-dot" style="--c:${row.color}" title="${text(row.account.address)}"></span><span class="gm-from">${text(message.from)}</span><span class="gm-subject">${chipsMarkup(message, currentKey)}<span class="gm-subject-text">${text(message.subject)}</span></span><time datetime="${text(message.at)}">${text(mailTime(message.at, now))}</time></button></li>`;
}

function labelSide(labels: LabelNode[], openKey: string | null): string {
  if (!labels.length) return "";
  const items = labels.map((label) => `<button type="button" class="gm-folder gm-label" data-mailbox="${text(LABEL_PREFIX + label.key)}" aria-current="${openKey === label.key}" data-unread="${label.unread > 0}" style="--depth:${label.depth}" title="${text(`${label.path} · ${label.total} thư${label.unread ? ` · ${label.unread} chưa đọc` : ""}`)}">${tagIcon(label.color)}<span class="gm-folder-name">${text(label.name)}</span>${label.unread ? `<b>${label.unread}</b>` : ""}</button>`).join("");
  return `<p class="gm-side-label">Nhãn</p>${items}`;
}

export function mailView(inbox: InboxSnapshot, mailbox: string, now: number, reader: MailReader | null = null): string {
  if (!inbox.accounts.length) return setupMarkup("mail");
  const labels = mergeLabels(inbox.accounts);
  const openKey = mailbox.startsWith(LABEL_PREFIX) ? mailbox.slice(LABEL_PREFIX.length) : null;
  const openLabel = openKey === null ? null : labels.find((label) => label.key === openKey) ?? null;
  const rows: Row[] = openKey !== null
    ? labelRows(inbox.accounts, openKey).map((row) => ({ message: row.message, account: inbox.accounts[row.account], color: accountColor(row.account) }))
    : inbox.accounts.flatMap((account, index) => account.recent.map((message) => ({ message, account, color: accountColor(index) })))
      .filter((row) => mailbox === ALL_MAILBOXES || row.account.address === mailbox)
      .sort((a, b) => Date.parse(b.message.at) - Date.parse(a.message.at));
  const total = inbox.accounts.reduce((sum, account) => sum + (account.unread ?? 0), 0);
  const current = inbox.accounts.find((account) => account.address === mailbox);
  const side = [
    `<button type="button" class="gm-folder" data-mailbox="${ALL_MAILBOXES}" aria-current="${mailbox === ALL_MAILBOXES}"><span class="gm-folder-icon" aria-hidden="true">▤</span><span class="gm-folder-name">Hộp thư đến</span>${total ? `<b>${total}</b>` : ""}</button>`,
    '<p class="gm-side-label">Tài khoản</p>',
    ...inbox.accounts.map((account, index) => `<button type="button" class="gm-folder" data-mailbox="${text(account.address)}" aria-current="${mailbox === account.address}" title="${text(account.connected ? account.address : account.note)}"><span class="gm-dot" style="--c:${accountColor(index)}" data-offline="${!account.connected}"></span><span class="gm-folder-name">${text(account.address)}</span>${account.unread ? `<b>${account.unread}</b>` : ""}</button>`),
    labelSide(labels, openKey),
  ].join("");
  const broken = inbox.accounts.filter((account) => !account.connected && (mailbox === ALL_MAILBOXES || account.address === mailbox));
  const warnings = broken.map((account) => `<p class="gm-warn"><b>${text(account.address)}</b> chưa đọc được: ${text(account.note)}</p>`).join("");
  const emptyNote = openKey !== null ? (openLabel ? "Nhãn này chưa có thư nào." : "Nhãn này không còn trong Gmail.") : "Hộp thư đến chưa có thư nào.";
  const list = rows.length
    ? `<ul class="gm-list">${rows.map((row) => rowMarkup(row, now, openKey)).join("")}</ul>`
    : `<div class="gm-empty"><strong>Không có thư</strong><span>${emptyNote}</span></div>`;
  const unread = rows.filter((row) => row.message.unread !== false).length;
  const range = openLabel
    ? `${rows.length} thư gần nhất · ${openLabel.unread} chưa đọc · ${openLabel.total} thư trong nhãn`
    : `${rows.length ? `1–${rows.length}` : "0"} thư · ${unread} chưa đọc`;
  const tab = openLabel
    ? `<span class="gm-tab gm-tab-label" aria-current="true" style="--c:${openLabel.color}">${tagIcon(openLabel.color)}${text(openLabel.path)}</span>`
    : '<span class="gm-tab" aria-current="true">Hộp thư đến</span>';
  const gmailUrl = safeHref(openLabel?.url ?? current?.url) ?? "https://mail.google.com/mail/";
  const main = reader
    ? `<section class="gm-main gm-reader">${readerMarkup(reader, now)}</section>`
    : `<section class="gm-main"><div class="gm-toolbar">${tab}<span class="gm-range">${range}</span><a class="gm-open" href="${text(gmailUrl)}" target="_blank" rel="noopener noreferrer">Mở Gmail</a></div>${warnings}${list}<p class="gm-note">Chỉ xem · ${inbox.fetchedAt ? `cập nhật ${text(mailTime(inbox.fetchedAt, now))}` : "chưa đọc lần nào"} · bấm một thư để đọc, xóa ngay tại đây</p></section>`;
  return `<div class="gm" data-reading="${Boolean(reader)}"><aside class="gm-side">${side}</aside>${main}</div>`;
}

export type CalendarMode = "day" | "week" | "month";

export interface CalendarState {
  mode: CalendarMode;
  anchor: string;
  events: CalendarEvent[] | null;
  loading: boolean;
  error: string;
  selected: string | null;
  form: EventDraft | null;
  saving: boolean;
  formError: string;
}

export interface EventDraft {
  id: string | null;
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
}

export interface EventInput {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
}

function vnClock(ms: number): string {
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(11, 16);
}

export function newDraft(day: string, now: number): EventDraft {
  const hour = vnDay(now) === day ? Math.min(22, new Date(now + VN_OFFSET_MS).getUTCHours() + 1) : 9;
  const start = `${String(hour).padStart(2, "0")}:00`;
  const end = `${String(hour + 1).padStart(2, "0")}:00`;
  return { id: null, title: "", allDay: false, startDate: day, startTime: start, endDate: day, endTime: end, location: "", description: "" };
}

export function draftFromEvent(event: CalendarEvent): EventDraft {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const lastDay = event.allDay ? vnDay(Math.max(start, end - DAY_MS)) : vnDay(end);
  return { id: event.id, title: event.title, allDay: event.allDay, startDate: vnDay(start), startTime: vnClock(start), endDate: lastDay, endTime: vnClock(end), location: event.location, description: event.description ?? "" };
}

export function draftToInput(draft: EventDraft): EventInput | string {
  const title = draft.title.trim();
  if (!title) return "Cần nhập tiêu đề";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.endDate)) return "Chọn ngày bắt đầu và kết thúc";
  if (!draft.allDay && (!/^\d{2}:\d{2}$/.test(draft.startTime) || !/^\d{2}:\d{2}$/.test(draft.endTime))) return "Chọn giờ bắt đầu và kết thúc";
  const start = draft.allDay ? vnMidnight(draft.startDate) : Date.parse(`${draft.startDate}T${draft.startTime}:00+07:00`);
  const end = draft.allDay ? vnMidnight(draft.endDate) + DAY_MS : Date.parse(`${draft.endDate}T${draft.endTime}:00+07:00`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Thời gian không hợp lệ";
  if (end <= start) return draft.allDay ? "Ngày kết thúc phải từ ngày bắt đầu trở đi" : "Giờ kết thúc phải sau giờ bắt đầu";
  return { title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay: draft.allDay, location: draft.location.trim(), description: draft.description.trim() };
}

const MODES: [CalendarMode, string][] = [["day", "Ngày"], ["week", "Tuần"], ["month", "Tháng"]];
const MONTH_CHIPS = 3;

function noon(day: string): Date {
  return new Date(vnMidnight(day) + 12 * 3_600_000);
}

export function addDays(day: string, count: number): string {
  return vnDay(vnMidnight(day) + count * DAY_MS + 12 * 3_600_000);
}

function weekdayIndex(day: string): number {
  return (noon(day).getUTCDay() + 6) % 7;
}

function monthEnd(day: string): string {
  const date = noon(day);
  return vnDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 5));
}

export function todayKey(now: number): string {
  return vnDay(now);
}

export function calendarDays(mode: CalendarMode, anchor: string): string[] {
  if (mode === "day") return [anchor];
  const monthStart = `${anchor.slice(0, 8)}01`;
  const first = mode === "week" ? addDays(anchor, -weekdayIndex(anchor)) : addDays(monthStart, -weekdayIndex(monthStart));
  const last = mode === "week" ? addDays(first, 6) : addDays(monthEnd(anchor), 6 - weekdayIndex(monthEnd(anchor)));
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

export function calendarRange(mode: CalendarMode, anchor: string): { from: number; to: number } {
  const days = calendarDays(mode, anchor);
  return { from: vnMidnight(days[0]), to: vnMidnight(days[days.length - 1]) + DAY_MS };
}

export function shiftAnchor(mode: CalendarMode, anchor: string, direction: number): string {
  if (mode === "day") return addDays(anchor, direction);
  if (mode === "week") return addDays(anchor, 7 * direction);
  const date = noon(anchor);
  return vnDay(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + direction, 1, 5));
}

function monthYear(day: string): string {
  return noon(day).toLocaleDateString("vi-VN", { timeZone: TIMEZONE, month: "long", year: "numeric" });
}

function calendarTitle(mode: CalendarMode, days: string[], anchor: string): string {
  if (mode === "day") return noon(anchor).toLocaleDateString("vi-VN", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  if (mode === "month") return monthYear(anchor);
  const first = monthYear(days[0]);
  const last = monthYear(days[days.length - 1]);
  return first === last ? first : `${first} – ${last}`;
}

const LOCAL_COLOR = "#0b8043";

function calendarColors(inbox: InboxSnapshot, events: CalendarEvent[]): Map<string, string> {
  const names = [...new Set([...inbox.calendars.map((feed) => feed.label), ...inbox.events.map((event) => event.calendar)])];
  const colors = new Map(names.map((name) => [name, SHARED_COLOR]));
  for (const event of [...inbox.events, ...events]) if (event.local) colors.set(event.calendar, LOCAL_COLOR);
  return colors;
}

function placeDay(events: CalendarEvent[], day: string, colors: Map<string, string>): Placed[] {
  const dayStart = vnMidnight(day);
  const dayEnd = dayStart + DAY_MS;
  const items = events
    .filter((event) => !event.allDay && Date.parse(event.start) < dayEnd && Math.max(Date.parse(event.end), Date.parse(event.start) + 1) > dayStart)
    .map((event) => {
      const start = Math.max(Date.parse(event.start), dayStart);
      const end = Math.min(Math.max(Date.parse(event.end), Date.parse(event.start) + 30 * 60_000), dayEnd);
      return { event, start, end };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const placed: Placed[] = [];
  let cluster: { item: (typeof items)[number]; lane: number }[] = [];
  let clusterEnd = 0;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((entry) => entry.lane + 1));
    for (const { item, lane } of cluster) {
      const top = ((item.start - dayStart) / 60_000) * MINUTE_PX;
      placed.push({ event: item.event, top, height: Math.max(MIN_EVENT_PX, ((item.end - item.start) / 60_000) * MINUTE_PX - 2), lane, lanes, color: colors.get(item.event.calendar) ?? SHARED_COLOR });
    }
    cluster = [];
  };
  for (const item of items) {
    if (cluster.length && item.start >= clusterEnd) flush();
    const busy = new Set(cluster.filter((entry) => entry.item.end > item.start).map((entry) => entry.lane));
    let lane = 0;
    while (busy.has(lane)) lane++;
    cluster.push({ item, lane });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  if (cluster.length) flush();
  return placed;
}

function clock(value: string): string {
  return new Date(value).toLocaleTimeString("vi-VN", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit" });
}

function eventTime(event: CalendarEvent): string {
  return Date.parse(event.end) > Date.parse(event.start) ? `${clock(event.start)} – ${clock(event.end)}` : clock(event.start);
}

function timeGrid(days: string[], events: CalendarEvent[], now: number, colors: Map<string, string>): string {
  const today = todayKey(now);
  const head = days.map((day) => {
    const date = noon(day);
    const weekday = date.toLocaleDateString("vi-VN", { timeZone: TIMEZONE, weekday: "short" });
    return `<div class="gc-day-head" data-today="${day === today}"><span>${text(weekday)}</span><b>${date.getUTCDate()}</b></div>`;
  }).join("");
  const allDay = days.map((day) => {
    const start = vnMidnight(day);
    const chips = events.filter((event) => event.allDay && Date.parse(event.start) < start + DAY_MS && Date.parse(event.end) > start);
    return `<div class="gc-allday-cell">${chips.map((event) => `<button type="button" class="gc-chip" data-event="${text(event.id)}" data-key="cal-event:${text(event.id)}" style="--c:${colors.get(event.calendar) ?? SHARED_COLOR}" title="${text(event.title)}">${text(event.title)}</button>`).join("")}</div>`;
  }).join("");
  const hours = Array.from({ length: 24 }, (_, h) => `<span style="top:${h * HOUR_PX}px">${h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}</span>`).join("");
  const nowTop = ((now - vnMidnight(today)) / 60_000) * MINUTE_PX;
  const columns = days.map((day) => {
    const blocks = placeDay(events, day, colors).map((item) => {
      const where = item.event.location && !safeHref(item.event.location) ? ` · ${item.event.location}` : "";
      const compact = item.height < COMPACT_EVENT_PX;
      const body = compact
        ? `<small>${text(clock(item.event.start))}</small><strong>${text(item.event.title)}</strong>`
        : `<strong>${text(item.event.title)}</strong><small>${text(eventTime(item.event))}${text(where)}</small>`;
      const tip = text(`${item.event.title} · ${eventTime(item.event)}${where}`);
      const style = `top:${item.top}px;height:${item.height}px;left:calc(${(item.lane / item.lanes) * 100}% + 2px);width:calc(${100 / item.lanes}% - 4px);--c:${item.color}`;
      const ended = Date.parse(item.event.end) <= now;
      return `<button type="button" class="gc-event" data-event="${text(item.event.id)}" data-key="cal-event:${text(item.event.id)}" data-compact="${compact}" data-ended="${ended}" style="${style}" title="${tip}">${body}</button>`;
    }).join("");
    const line = day === today ? `<span class="gc-now" style="top:${nowTop}px"></span>` : "";
    return `<div class="gc-col">${blocks}${line}</div>`;
  }).join("");
  return `<div class="gc-week" style="--gc-cols:${days.length}"><div class="gc-head"><div class="gc-gutter"></div>${head}</div><div class="gc-allday"><div class="gc-gutter">Cả ngày</div>${allDay}</div><div class="gc-scroll"><div class="gc-grid" style="height:${24 * HOUR_PX}px"><div class="gc-hours">${hours}</div>${columns}</div></div></div>`;
}

function monthChip(event: CalendarEvent, colors: Map<string, string>): string {
  const tip = text(`${event.title} · ${event.allDay ? "Cả ngày" : eventTime(event)}`);
  return `<button type="button" class="gc-mchip" data-event="${text(event.id)}" data-key="cal-event:${text(event.id)}" style="--c:${colors.get(event.calendar) ?? SHARED_COLOR}" data-allday="${event.allDay}" title="${tip}">${event.allDay ? "" : `<small>${text(clock(event.start))}</small>`}<span>${text(event.title)}</span></button>`;
}

function monthGrid(days: string[], anchor: string, events: CalendarEvent[], now: number, colors: Map<string, string>): string {
  const today = todayKey(now);
  const month = anchor.slice(0, 7);
  const names = days.slice(0, 7).map((day) => `<span>${text(noon(day).toLocaleDateString("vi-VN", { timeZone: TIMEZONE, weekday: "short" }))}</span>`).join("");
  const cells = days.map((day) => {
    const start = vnMidnight(day);
    const items = events.filter((event) => Date.parse(event.start) < start + DAY_MS && Math.max(Date.parse(event.end), Date.parse(event.start) + 1) > start);
    const more = items.length > MONTH_CHIPS ? `<button type="button" class="gc-more" data-cal-day="${day}">+${items.length - MONTH_CHIPS} sự kiện</button>` : "";
    const label = noon(day).toLocaleDateString("vi-VN", { timeZone: TIMEZONE, day: "numeric", month: "long" });
    return `<div class="gc-mcell" data-out="${day.slice(0, 7) !== month}" data-today="${day === today}"><button type="button" class="gc-mday" data-cal-day="${day}" aria-label="Xem ngày ${text(label)}">${noon(day).getUTCDate()}</button>${items.slice(0, MONTH_CHIPS).map((event) => monthChip(event, colors)).join("")}${more}</div>`;
  }).join("");
  return `<div class="gc-month"><div class="gc-mnames">${names}</div><div class="gc-mgrid" style="--gc-rows:${days.length / 7}">${cells}</div></div>`;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function plainDescription(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_, href: string, label: string) => (label.replace(/<[^>]+>/g, "").trim() === href ? href : `${label} (${href})`))
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
      const point = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function linkify(value: string): string {
  return value.split(/(https?:\/\/[^\s<>"']+)/g).map((part, index) => {
    if (index % 2 === 0) return text(part);
    const href = safeHref(part.replace(/[).,;:]+$/, ""));
    return href ? `<a href="${text(href)}" target="_blank" rel="noopener noreferrer">${text(part)}</a>` : text(part);
  }).join("");
}

function longDate(ms: number): string {
  return new Date(ms).toLocaleDateString("vi-VN", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function eventWhen(event: CalendarEvent): string {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (event.allDay) {
    const last = Math.max(start, end - DAY_MS);
    return vnDay(start) === vnDay(last) ? `${longDate(start)} · Cả ngày` : `${longDate(start)} – ${longDate(last)} · Cả ngày`;
  }
  if (!(end > start)) return `${longDate(start)} · ${clock(event.start)}`;
  return vnDay(start) === vnDay(end - 1) ? `${longDate(start)} · ${clock(event.start)} – ${clock(event.end)}` : `${longDate(start)} ${clock(event.start)} – ${longDate(end)} ${clock(event.end)}`;
}

function eventDetail(event: CalendarEvent, colors: Map<string, string>): string {
  const place = event.location ? `<li><span>Địa điểm</span><p>${linkify(event.location)}</p></li>` : "";
  const about = plainDescription(event.description ?? "");
  const description = about ? `<li><span>Nội dung</span><p class="gc-desc">${linkify(about)}</p></li>` : `<li><span>Nội dung</span><p class="gc-muted">Sự kiện không có mô tả.</p></li>`;
  const footer = event.local
    ? '<footer><button type="button" class="gc-danger" data-action="cal-delete">Xóa</button><button type="button" class="gc-primary" data-action="cal-edit">Sửa</button></footer>'
    : '<footer><p class="gc-readonly">Sự kiện từ Google Calendar, chỉ xem.</p></footer>';
  return `<div class="gc-pop-back" aria-hidden="true" data-action="cal-close"></div><section class="gc-pop" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="gc-pop-title"><header><span class="gc-swatch" style="--c:${colors.get(event.calendar) ?? SHARED_COLOR}" aria-hidden="true"></span><h3 id="gc-pop-title">${text(event.title)}</h3><button type="button" class="gc-close" data-action="cal-close" data-key="ev-detail-close" aria-label="Đóng">×</button></header><ul><li><span>Thời gian</span><p>${text(eventWhen(event))}</p></li>${place}<li><span>Lịch</span><p>${text(event.calendar)}</p></li>${description}</ul>${footer}</section>`;
}

function field(label: string, control: string, wide = true): string {
  return `<label class="gc-field"${wide ? "" : ' data-narrow="true"'}><span>${label}</span>${control}</label>`;
}

function eventForm(draft: EventDraft, saving: boolean, error: string): string {
  const value = (key: keyof EventDraft) => text(String(draft[key] ?? ""));
  const input = (key: keyof EventDraft, type: string, extra = "") => `<input type="${type}" data-ev="${key}" data-key="ev-${key}" value="${value(key)}"${extra}>`;
  const time = (key: keyof EventDraft) => (draft.allDay ? "" : field("Giờ", input(key, "time", " required"), false));
  return `<div class="gc-pop-back" aria-hidden="true" data-action="cal-cancel"></div><div class="gc-pop gc-form" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="gc-form-title"><form data-cal-form novalidate><header><h3 id="gc-form-title">${draft.id ? "Sửa sự kiện" : "Tạo sự kiện"}</h3><button type="button" class="gc-close" data-action="cal-cancel" data-key="ev-close" aria-label="Đóng">×</button></header><div class="gc-fields">${field("Tiêu đề", input("title", "text", ' maxlength="200" required placeholder="Thêm tiêu đề"'))}<label class="gc-check"><input type="checkbox" data-ev="allDay" data-key="ev-allDay"${draft.allDay ? " checked" : ""}><span>Cả ngày</span></label><div class="gc-row">${field("Ngày bắt đầu", input("startDate", "date", " required"))}${time("startTime")}</div><div class="gc-row">${field("Ngày kết thúc", input("endDate", "date", " required"))}${time("endTime")}</div>${field("Địa điểm", input("location", "text", ' maxlength="300" placeholder="Thêm địa điểm hoặc link họp"'))}${field("Nội dung", `<textarea data-ev="description" data-key="ev-description" rows="5" maxlength="5000" placeholder="Thêm mô tả">${value("description")}</textarea>`)}${error ? `<p class="gc-form-error" role="alert">${text(error)}</p>` : ""}<p class="gc-readonly">Sự kiện chỉ lưu trên hub, không ghi lên Google Calendar.</p></div><footer><button type="button" data-action="cal-cancel" data-key="ev-cancel">Hủy</button><button type="submit" class="gc-primary" data-key="ev-save"${saving ? " disabled" : ""}>${saving ? "Đang lưu…" : "Lưu"}</button></footer></form></div>`;
}

function calendarToolbar(state: CalendarState, days: string[]): string {
  const status = state.loading ? "Đang tải lịch…" : state.error || "Giờ Việt Nam";
  const modes = MODES.map(([mode, label]) => `<button type="button" data-cal-mode="${mode}" aria-pressed="${mode === state.mode}">${label}</button>`).join("");
  return `<div class="gc-toolbar"><button type="button" class="gc-create" data-action="cal-create" data-key="cal-create"><span aria-hidden="true">+</span>Tạo</button><button type="button" class="gc-today" data-action="cal-today">Hôm nay</button><div class="gc-nav"><button type="button" class="gc-arrow" data-action="cal-prev" aria-label="Lùi lại" title="Lùi lại"><span aria-hidden="true">‹</span></button><button type="button" class="gc-arrow" data-action="cal-next" aria-label="Tiến tới" title="Tiến tới"><span aria-hidden="true">›</span></button></div><h2>${text(calendarTitle(state.mode, days, state.anchor))}</h2><span class="gc-range" data-error="${Boolean(state.error)}">${text(status)}</span><div class="gc-tools"><label class="gc-date"><span>Chọn ngày</span><input type="date" aria-label="Chọn ngày" data-cal-date value="${state.anchor}"></label><div class="gc-modes" role="group" aria-label="Kiểu xem">${modes}</div></div></div>`;
}

export function calendarView(inbox: InboxSnapshot, now: number, state: CalendarState): string {
  if (!inbox.calendars.length) return setupMarkup("calendar");
  const days = calendarDays(state.mode, state.anchor);
  const events = state.events ?? inbox.events;
  const colors = calendarColors(inbox, events);
  const broken = inbox.calendars.filter((feed) => !feed.connected).map((feed) => `<p class="gm-warn"><b>${text(feed.label)}</b>: ${text(feed.note)}</p>`).join("");
  const body = state.mode === "month" ? monthGrid(days, state.anchor, events, now, colors) : timeGrid(days, events, now, colors);
  const selected = state.selected ? events.find((event) => event.id === state.selected) : undefined;
  const overlay = state.form ? eventForm(state.form, state.saving, state.formError) : selected ? eventDetail(selected, colors) : "";
  return `<div class="gc" data-mode="${state.mode}">${calendarToolbar(state, days)}${broken}<div class="gc-body">${body}</div>${overlay}</div>`;
}

export function calendarScrollTop(now: number): number {
  const minutes = ((now + VN_OFFSET_MS) % DAY_MS) / 60_000;
  return Math.max(0, (minutes - 90) * MINUTE_PX);
}

export function eventsToday(inbox: InboxSnapshot | null, now: number): number {
  if (!inbox) return 0;
  const start = vnMidnight(vnDay(now));
  return inbox.events.filter((event) => Date.parse(event.start) < start + DAY_MS && Date.parse(event.end) > Math.max(start, now)).length;
}
