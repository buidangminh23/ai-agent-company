import { L } from "./i18n.ts";
export type TodoStatus = "todo" | "doing" | "done";
export type TodoPriority = "high" | "normal" | "low";

export interface Todo {
  id: string;
  title: string;
  note: string;
  status: TodoStatus;
  priority: TodoPriority;
  due: string | null;
  project: string;
  order: number;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
}

export interface TodoFields {
  title: string;
  note: string;
  priority: TodoPriority;
  due: string | null;
  project: string;
}

export type DueTone = "overdue" | "today" | "soon" | "later";

export const TODO_STATUSES: [TodoStatus, string][] = [["todo", L("Cần làm")], ["doing", L("Đang làm")], ["done", "Xong"]];
export const PRIORITY_LABELS: Record<TodoPriority, string> = { high: "Cao", normal: L("Thường"), low: L("Thấp") };
export const TODO_LIMITS = { title: 200, note: 2000, project: 60 };

const DAY_MS = 86_400_000;
const WEEKDAYS = ["CN", L("Thứ 2"), L("Thứ 3"), L("Thứ 4"), L("Thứ 5"), L("Thứ 6"), L("Thứ 7")];
const EDGE = "(^|\\s)";
const END = "(?=\\s|$)";

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayNumber(key: string): number {
  return Date.parse(`${key}T00:00:00Z`) / DAY_MS;
}

function keyOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function addDays(key: string, days: number): string {
  return keyOf(dayNumber(key) + days);
}

function nextWeekday(today: string, weekday: number): string {
  const current = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, (weekday - current + 7) % 7);
}

function calendarDate(today: string, day: number, month: number, year: number | null): string | null {
  const thisYear = Number(today.slice(0, 4));
  const pad = (value: number) => String(value).padStart(2, "0");
  const build = (y: number) => `${y}-${pad(month)}-${pad(day)}`;
  if (year !== null) {
    const full = year < 100 ? 2000 + year : year;
    return isDateKey(build(full)) ? build(full) : null;
  }
  const candidate = build(thisYear);
  if (!isDateKey(candidate)) return null;
  return candidate < today ? build(thisYear + 1) : candidate;
}

interface DateRule {
  pattern: RegExp;
  resolve: (match: RegExpMatchArray, today: string) => string | null;
}

const DATE_RULES: DateRule[] = [
  { pattern: new RegExp(`${EDGE}(hôm nay|hnay)${END}`, "iu"), resolve: (_, today) => today },
  { pattern: new RegExp(`${EDGE}(ngày kia|ngày mốt|mốt)${END}`, "iu"), resolve: (_, today) => addDays(today, 2) },
  { pattern: new RegExp(`${EDGE}(ngày mai)${END}`, "iu"), resolve: (_, today) => addDays(today, 1) },
  { pattern: new RegExp(`${EDGE}(mai)${END}`, "u"), resolve: (_, today) => addDays(today, 1) },
  { pattern: new RegExp(`${EDGE}(chủ nhật|cn)${END}`, "iu"), resolve: (_, today) => nextWeekday(today, 0) },
  { pattern: new RegExp(`${EDGE}(today)${END}`, "iu"), resolve: (_, today) => today },
  { pattern: new RegExp(`${EDGE}(tomorrow|tmr)${END}`, "iu"), resolve: (_, today) => addDays(today, 1) },
  { pattern: new RegExp(`${EDGE}(sun|sunday|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday)${END}`, "iu"), resolve: (match, today) => nextWeekday(today, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(match[2].slice(0, 3).toLowerCase())) },
  { pattern: new RegExp(`${EDGE}(?:thứ\\s?|t)([2-7])${END}`, "iu"), resolve: (match, today) => nextWeekday(today, Number(match[2]) - 1) },
  { pattern: new RegExp(`${EDGE}(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2}|\\d{4}))?${END}`, "u"), resolve: (match, today) => calendarDate(today, Number(match[2]), Number(match[3]), match[4] ? Number(match[4]) : null) },
];

export function parseQuickAdd(raw: string, today: string): TodoFields {
  let rest = ` ${raw} `;
  let priority: TodoPriority = "normal";
  let due: string | null = null;
  let project = "";
  const cut = (match: RegExpMatchArray) => {
    rest = `${rest.slice(0, match.index!)}${match[1] ?? ""} ${rest.slice(match.index! + match[0].length)}`;
  };
  const high = rest.match(new RegExp(`${EDGE}(?:!!|!cao|!gấp|!high|!urgent)${END}`, "iu"));
  const low = rest.match(new RegExp(`${EDGE}(?:!thấp|!thap|!low)${END}`, "iu"));
  const normal = rest.match(new RegExp(`${EDGE}(?:!thường|!thuong|!normal)${END}`, "iu"));
  for (const [match, value] of [[high, "high"], [low, "low"], [normal, "normal"]] as const) {
    if (!match) continue;
    priority = value;
    cut(match);
    break;
  }
  const tag = rest.match(/(^|\s)#([\p{L}\p{N}_.-]+)(?=\s|$)/u);
  if (tag) {
    project = tag[2].slice(0, TODO_LIMITS.project);
    cut(tag);
  }
  for (const rule of DATE_RULES) {
    const match = rest.match(rule.pattern);
    if (!match) continue;
    const value = rule.resolve(match, today);
    if (!value) continue;
    due = value;
    cut(match);
    break;
  }
  const title = rest.replace(/\s+/g, " ").trim().slice(0, TODO_LIMITS.title);
  return { title, note: "", priority, due, project };
}

export function dueLabel(due: string, today: string): { text: string; tone: DueTone } {
  const diff = dayNumber(due) - dayNumber(today);
  const short = `${due.slice(8, 10)}/${due.slice(5, 7)}`;
  if (diff < 0) return { text: L("Quá hạn {0} ngày", -diff), tone: "overdue" };
  if (diff === 0) return { text: L("Hôm nay"), tone: "today" };
  if (diff === 1) return { text: "Mai", tone: "soon" };
  if (diff < 7) return { text: `${WEEKDAYS[new Date(`${due}T00:00:00Z`).getUTCDay()]} ${short}`, tone: "later" };
  return { text: due.slice(0, 4) === today.slice(0, 4) ? short : `${short}/${due.slice(0, 4)}`, tone: "later" };
}

export function columnOf(todos: Todo[], status: TodoStatus): Todo[] {
  return todos.filter((todo) => todo.status === status).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export function todoCounts(todos: Todo[], today: string): { todo: number; doing: number; done: number; overdue: number; doneToday: number } {
  const open = todos.filter((todo) => todo.status !== "done");
  return {
    todo: open.filter((todo) => todo.status === "todo").length,
    doing: open.filter((todo) => todo.status === "doing").length,
    done: todos.length - open.length,
    overdue: open.filter((todo) => todo.due !== null && todo.due < today).length,
    doneToday: todos.filter((todo) => todo.doneAt !== null && vietnamDay(Date.parse(todo.doneAt)) === today).length,
  };
}

export function vietnamDay(at: number): string {
  return new Date(at + 7 * 3_600_000).toISOString().slice(0, 10);
}

export function moveTodo(todos: Todo[], id: string, status: TodoStatus, index: number, stamp: string): Todo[] {
  const current = todos.find((todo) => todo.id === id);
  if (!current) return todos;
  const moved: Todo = { ...current, status, updatedAt: stamp, doneAt: status === "done" ? current.doneAt ?? stamp : null };
  const target = columnOf(todos, status).filter((todo) => todo.id !== id);
  target.splice(Math.max(0, Math.min(index, target.length)), 0, moved);
  const orders = new Map(target.map((todo, position) => [todo.id, position]));
  const source = current.status === status ? [] : columnOf(todos, current.status).filter((todo) => todo.id !== id);
  source.forEach((todo, position) => orders.set(todo.id, position));
  return todos.map((todo) => {
    const base = todo.id === id ? moved : todo;
    const order = orders.get(todo.id);
    return order === undefined || order === base.order ? base : { ...base, order };
  });
}
