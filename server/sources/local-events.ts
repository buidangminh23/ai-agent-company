import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CalendarEvent } from "../../shared/inbox.ts";

export interface LocalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export type LocalEventInput = Pick<LocalEvent, "title" | "start" | "end" | "allDay" | "location" | "description">;

export const LOCAL_CALENDAR = "Lịch trên hub";
export const LOCAL_PREFIX = "local:";
const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 366 * DAY_MS;
const MAX_EVENTS = 2000;

export class LocalEventError extends Error {}

function limitText(value: unknown, max: number, field: string, required = false): string {
  if (typeof value !== "string") throw new LocalEventError(`${field} không hợp lệ`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new LocalEventError(`Cần nhập ${field.toLowerCase()}`);
  if (trimmed.length > max) throw new LocalEventError(`${field} dài quá ${max} ký tự`);
  return trimmed;
}

export function validateInput(raw: unknown): LocalEventInput {
  if (!raw || typeof raw !== "object") throw new LocalEventError("Dữ liệu sự kiện không hợp lệ");
  const data = raw as Record<string, unknown>;
  const title = limitText(data.title, 200, "Tiêu đề", true);
  const location = limitText(data.location ?? "", 300, "Địa điểm");
  const description = limitText(data.description ?? "", 5000, "Nội dung");
  const allDay = data.allDay === true;
  const start = typeof data.start === "string" ? Date.parse(data.start) : NaN;
  const end = typeof data.end === "string" ? Date.parse(data.end) : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new LocalEventError("Thời gian không hợp lệ");
  if (end <= start) throw new LocalEventError("Giờ kết thúc phải sau giờ bắt đầu");
  if (end - start > MAX_SPAN_MS) throw new LocalEventError("Sự kiện dài quá 1 năm");
  return { title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay, location, description };
}

export class LocalEventStore {
  private readonly file: string;
  private events: LocalEvent[] | null = null;

  constructor(file = process.env.MSC_LOCAL_EVENTS_FILE ?? path.join(os.homedir(), ".msc-company", "calendar-events.json")) {
    this.file = file;
  }

  private load(): LocalEvent[] {
    if (this.events) return this.events;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      this.events = Array.isArray(parsed) ? (parsed as LocalEvent[]).filter((event) => event && typeof event.id === "string") : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.events = [];
    }
    return this.events;
  }

  private save(events: LocalEvent[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(events, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.events = events;
  }

  list(from: number, to: number): CalendarEvent[] {
    return this.load()
      .filter((event) => Date.parse(event.start) < to && Date.parse(event.end) > from)
      .map((event) => ({ id: `${LOCAL_PREFIX}${event.id}`, calendar: LOCAL_CALENDAR, title: event.title, start: event.start, end: event.end, allDay: event.allDay, location: event.location, description: event.description, local: true }));
  }

  create(input: LocalEventInput, now = Date.now()): LocalEvent {
    const events = this.load();
    if (events.length >= MAX_EVENTS) throw new LocalEventError(`Đã đủ ${MAX_EVENTS} sự kiện trên hub`);
    const stamp = new Date(now).toISOString();
    const event: LocalEvent = { id: randomUUID(), ...input, createdAt: stamp, updatedAt: stamp };
    this.save([...events, event]);
    return event;
  }

  update(id: string, input: LocalEventInput, now = Date.now()): LocalEvent | null {
    const events = this.load();
    const current = events.find((event) => event.id === id);
    if (!current) return null;
    const next: LocalEvent = { ...current, ...input, updatedAt: new Date(now).toISOString() };
    this.save(events.map((event) => (event.id === id ? next : event)));
    return next;
  }

  remove(id: string): boolean {
    const events = this.load();
    if (!events.some((event) => event.id === id)) return false;
    this.save(events.filter((event) => event.id !== id));
    return true;
  }
}
