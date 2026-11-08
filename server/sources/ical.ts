import { L } from "../../shared/i18n.ts";
import type { CalendarEvent } from "../../shared/inbox.ts";

export interface DateValue {
  wall: number;
  allDay: boolean;
  zone: string | null;
}

export interface RawEvent {
  uid: string;
  summary: string;
  location: string;
  description: string;
  status: string;
  start: DateValue;
  end: DateValue | null;
  duration: number | null;
  rrule: string | null;
  exdates: DateValue[];
  recurrenceId: DateValue | null;
}

export interface ParsedCalendar {
  name: string;
  zone: string | null;
  events: RawEvent[];
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

export const DEFAULT_ZONE = "Asia/Ho_Chi_Minh";
const DAY_MS = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_PERIODS = 20_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(zone, found);
  }
  return found;
}

function validZone(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    formatter(zone);
    return zone;
  } catch {
    return null;
  }
}

function offsetAt(utc: number, zone: string): number {
  const parts = formatter(zone).formatToParts(new Date(utc));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(utc / 1000) * 1000;
}

export function zonedToUtc(wall: number, zone: string): number {
  const first = wall - offsetAt(wall, zone);
  return wall - offsetAt(first, zone);
}

export function toUtc(value: DateValue, fallbackZone: string): number {
  if (value.zone === "UTC") return value.wall;
  return zonedToUtc(value.wall, value.allDay ? DEFAULT_ZONE : value.zone ?? fallbackZone);
}

function splitOutsideQuotes(text: string, separator: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === separator && !quoted) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function parseLine(line: string): Property | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const [name, ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
  const params: Record<string, string> = {};
  for (const raw of rawParams) {
    const eq = raw.indexOf("=");
    if (eq > 0) params[raw.slice(0, eq).toUpperCase()] = raw.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

export function parseDateValue(value: string, params: Record<string, string> = {}): DateValue | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const allDay = params.VALUE === "DATE" || match[4] === undefined;
  const wall = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0));
  if (allDay) return { wall, allDay: true, zone: null };
  return { wall, allDay: false, zone: match[7] ? "UTC" : validZone(params.TZID) };
}

export function parseDuration(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total = ((Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 24 * 3600 + Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;
  return sign === "-" ? -total : total;
}

export function parseCalendar(text: string): ParsedCalendar {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const calendar: ParsedCalendar = { name: "", zone: null, events: [] };
  const stack: string[] = [];
  let props: Property[] = [];
  for (const line of lines) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      stack.push(prop.value.toUpperCase());
      if (prop.value.toUpperCase() === "VEVENT" && stack.length === 2) props = [];
      continue;
    }
    if (prop.name === "END") {
      const closing = stack.pop();
      if (closing === "VEVENT" && stack.length === 1) {
        const event = buildEvent(props);
        if (event) calendar.events.push(event);
      }
      continue;
    }
    if (stack.length === 1 && stack[0] === "VCALENDAR") {
      if (prop.name === "X-WR-CALNAME") calendar.name = unescapeText(prop.value).trim();
      if (prop.name === "X-WR-TIMEZONE") calendar.zone = validZone(prop.value.trim());
    } else if (stack.length === 2 && stack[1] === "VEVENT") props.push(prop);
  }
  return calendar;
}

function buildEvent(props: Property[]): RawEvent | null {
  const first = (name: string) => props.find((prop) => prop.name === name);
  const startProp = first("DTSTART");
  const start = startProp ? parseDateValue(startProp.value, startProp.params) : null;
  if (!start) return null;
  const endProp = first("DTEND");
  const recurrenceProp = first("RECURRENCE-ID");
  const durationProp = first("DURATION");
  const exdates: DateValue[] = [];
  for (const prop of props) {
    if (prop.name !== "EXDATE") continue;
    for (const raw of prop.value.split(",")) {
      const value = parseDateValue(raw, prop.params);
      if (value) exdates.push(value);
    }
  }
  return {
    uid: first("UID")?.value.trim() ?? "",
    summary: unescapeText(first("SUMMARY")?.value ?? "").trim(),
    location: unescapeText(first("LOCATION")?.value ?? "").trim(),
    description: unescapeText(first("DESCRIPTION")?.value ?? "").trim(),
    status: (first("STATUS")?.value ?? "").trim().toUpperCase(),
    start,
    end: endProp ? parseDateValue(endProp.value, endProp.params) : null,
    duration: durationProp ? parseDuration(durationProp.value) : null,
    rrule: first("RRULE")?.value.trim() ?? null,
    exdates,
    recurrenceId: recurrenceProp ? parseDateValue(recurrenceProp.value, recurrenceProp.params) : null,
  };
}

function parseRule(rule: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of rule.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  return out;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function monthDays(year: number, month: number, byDay: string[], byMonthDay: number[], fallbackDay: number): number[] {
  const length = daysInMonth(year, month);
  if (byDay.length) {
    const days: number[] = [];
    for (const token of byDay) {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
      if (!match) continue;
      const weekday = WEEKDAYS.indexOf(match[2]);
      const matching: number[] = [];
      for (let day = 1; day <= length; day++) if (new Date(Date.UTC(year, month, day)).getUTCDay() === weekday) matching.push(day);
      if (!match[1]) days.push(...matching);
      else {
        const n = Number(match[1]);
        const picked = n > 0 ? matching[n - 1] : matching[matching.length + n];
        if (picked) days.push(picked);
      }
    }
    return [...new Set(days)].sort((a, b) => a - b);
  }
  const wanted = byMonthDay.length ? byMonthDay : [fallbackDay];
  return [...new Set(wanted.map((day) => (day < 0 ? length + day + 1 : day)).filter((day) => day >= 1 && day <= length))].sort((a, b) => a - b);
}

function periodCandidates(freq: string, index: number, interval: number, start: number, rule: Record<string, string>): number[] {
  const date = new Date(start);
  const timeOfDay = start - Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const byDay = rule.BYDAY ? rule.BYDAY.split(",") : [];
  const byMonthDay = rule.BYMONTHDAY ? rule.BYMONTHDAY.split(",").map(Number).filter(Number.isFinite) : [];
  const byMonth = rule.BYMONTH ? rule.BYMONTH.split(",").map((value) => Number(value) - 1) : [];
  const step = index * interval;
  if (freq === "DAILY") {
    const at = start + step * DAY_MS;
    const day = new Date(at);
    if (byDay.length && !byDay.some((token) => token.endsWith(WEEKDAYS[day.getUTCDay()]))) return [];
    if (byMonth.length && !byMonth.includes(day.getUTCMonth())) return [];
    return [at];
  }
  if (freq === "WEEKLY") {
    const weekStart = WEEKDAYS.indexOf(rule.WKST ?? "MO");
    const startDay = start - timeOfDay;
    const anchor = startDay - ((date.getUTCDay() - weekStart + 7) % 7) * DAY_MS + step * 7 * DAY_MS;
    const weekdays = byDay.length ? byDay.map((token) => WEEKDAYS.indexOf(token.slice(-2))).filter((day) => day >= 0) : [date.getUTCDay()];
    return weekdays.map((weekday) => anchor + ((weekday - weekStart + 7) % 7) * DAY_MS + timeOfDay).sort((a, b) => a - b);
  }
  if (freq === "MONTHLY") {
    const total = date.getUTCMonth() + step;
    const year = date.getUTCFullYear() + Math.floor(total / 12);
    const month = total % 12;
    if (byMonth.length && !byMonth.includes(month)) return [];
    return monthDays(year, month, byDay, byMonthDay, date.getUTCDate()).map((day) => Date.UTC(year, month, day) + timeOfDay);
  }
  if (freq === "YEARLY") {
    const year = date.getUTCFullYear() + step;
    const months = byMonth.length ? byMonth : [date.getUTCMonth()];
    const useDay = byDay.length || byMonthDay.length;
    return months.flatMap((month) => monthDays(year, month, useDay ? byDay : [], byMonthDay, date.getUTCDate()).map((day) => Date.UTC(year, month, day) + timeOfDay));
  }
  return [];
}

export function occurrenceWalls(event: RawEvent, floor: number, windowEnd: number, zone: string): number[] {
  const startZone = event.start.allDay ? DEFAULT_ZONE : event.start.zone === "UTC" ? "UTC" : event.start.zone ?? zone;
  const toInstant = (wall: number) => (startZone === "UTC" ? wall : zonedToUtc(wall, startZone));
  if (!event.rrule) return [event.start.wall];
  const rule = parseRule(event.rrule);
  const freq = rule.FREQ ?? "";
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const untilValue = rule.UNTIL ? parseDateValue(rule.UNTIL) : null;
  const until = untilValue ? (untilValue.allDay ? toInstant(untilValue.wall + DAY_MS - 1) : untilValue.zone === "UTC" ? untilValue.wall : toInstant(untilValue.wall)) : Infinity;
  const out: number[] = [];
  let produced = 0;
  for (let index = 0; index < MAX_PERIODS; index++) {
    const candidates = periodCandidates(freq, index, interval, event.start.wall, rule);
    if (!candidates.length && !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) break;
    let beyond = false;
    for (const wall of candidates) {
      if (wall < event.start.wall) continue;
      if (produced >= count) return out;
      if (wall < floor - 2 * DAY_MS && wall + 2 * DAY_MS < until) {
        produced++;
        continue;
      }
      const instant = toInstant(wall);
      if (instant > until) return out;
      if (instant > windowEnd) {
        beyond = true;
        break;
      }
      produced++;
      if (instant >= floor) out.push(wall);
    }
    if (beyond) break;
  }
  return out;
}

export function expandEvents(calendar: ParsedCalendar, label: string, windowStart: number, windowEnd: number): CalendarEvent[] {
  const zone = calendar.zone ?? DEFAULT_ZONE;
  const overrides = new Map<string, Set<number>>();
  for (const event of calendar.events) {
    if (!event.recurrenceId) continue;
    const set = overrides.get(event.uid) ?? new Set<number>();
    set.add(toUtc(event.recurrenceId, zone));
    overrides.set(event.uid, set);
  }
  const out: CalendarEvent[] = [];
  for (const event of calendar.events) {
    if (event.status === "CANCELLED") continue;
    const startUtc = toUtc(event.start, zone);
    const endUtc = event.end ? toUtc(event.end, zone) : null;
    const length = endUtc !== null ? Math.max(0, endUtc - startUtc) : event.duration ?? (event.start.allDay ? DAY_MS : 0);
    const excluded = new Set(event.exdates.map((value) => toUtc(value, zone)));
    const skip = event.recurrenceId ? new Set<number>() : overrides.get(event.uid) ?? new Set<number>();
    const walls = event.recurrenceId ? [event.start.wall] : occurrenceWalls(event, windowStart - length, windowEnd, zone);
    for (const wall of walls) {
      const start = toUtc({ ...event.start, wall }, zone);
      if (excluded.has(start) || skip.has(start)) continue;
      const end = start + length;
      if (start >= windowEnd || Math.max(end, start + 1) <= windowStart) continue;
      out.push({
        id: `${event.uid || label}@${start}`,
        calendar: label,
        title: event.summary || L("(Không có tiêu đề)"),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        allDay: event.start.allDay,
        location: event.location,
        description: event.description,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title));
}
