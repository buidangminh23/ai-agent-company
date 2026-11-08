import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TODO_LIMITS, isDateKey, moveTodo, type Todo, type TodoFields, type TodoPriority, type TodoStatus } from "../../shared/todos.ts";

const MAX_TODOS = 2000;
const STATUSES: TodoStatus[] = ["todo", "doing", "done"];
const PRIORITIES: TodoPriority[] = ["high", "normal", "low"];

export class TodoError extends Error {}

export interface TodoPatch extends Partial<TodoFields> {
  status?: TodoStatus;
  index?: number;
}

function limitText(value: unknown, max: number, field: string, required = false): string {
  if (typeof value !== "string") throw new TodoError(`${field} không hợp lệ`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new TodoError(`Cần nhập ${field.toLowerCase()}`);
  if (trimmed.length > max) throw new TodoError(`${field} dài quá ${max} ký tự`);
  return trimmed;
}

function readFields(data: Record<string, unknown>, partial: boolean): Partial<TodoFields> {
  const fields: Partial<TodoFields> = {};
  if (!partial || data.title !== undefined) fields.title = limitText(data.title, TODO_LIMITS.title, "Tên việc", true);
  if (data.note !== undefined) fields.note = limitText(data.note, TODO_LIMITS.note, "Ghi chú");
  if (data.project !== undefined) fields.project = limitText(data.project, TODO_LIMITS.project, "Dự án");
  if (data.priority !== undefined) {
    if (!PRIORITIES.includes(data.priority as TodoPriority)) throw new TodoError("Mức ưu tiên không hợp lệ");
    fields.priority = data.priority as TodoPriority;
  }
  if (data.due !== undefined) {
    if (data.due !== null && data.due !== "" && !isDateKey(data.due)) throw new TodoError("Hạn chót không hợp lệ");
    fields.due = data.due ? (data.due as string) : null;
  }
  return fields;
}

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TodoError("Dữ liệu công việc không hợp lệ");
  return raw as Record<string, unknown>;
}

export function validateCreate(raw: unknown): TodoFields {
  const fields = readFields(asObject(raw), false);
  return { title: fields.title!, note: fields.note ?? "", priority: fields.priority ?? "normal", due: fields.due ?? null, project: fields.project ?? "" };
}

export function validatePatch(raw: unknown): TodoPatch {
  const data = asObject(raw);
  const patch: TodoPatch = readFields(data, true);
  if (data.status !== undefined) {
    if (!STATUSES.includes(data.status as TodoStatus)) throw new TodoError("Trạng thái không hợp lệ");
    patch.status = data.status as TodoStatus;
  }
  if (data.index !== undefined) {
    if (!Number.isInteger(data.index) || (data.index as number) < 0) throw new TodoError("Vị trí không hợp lệ");
    patch.index = data.index as number;
  }
  if (!Object.keys(patch).length) throw new TodoError("Không có gì để cập nhật");
  return patch;
}

export class TodoStore {
  private readonly file: string;
  private todos: Todo[] | null = null;

  constructor(file = process.env.MSC_TODOS_FILE ?? path.join(os.homedir(), ".msc-company", "todos.json")) {
    this.file = file;
  }

  private load(): Todo[] {
    if (this.todos) return this.todos;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      this.todos = Array.isArray(parsed) ? (parsed as Todo[]).filter((todo) => todo && typeof todo.id === "string" && STATUSES.includes(todo.status)) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.todos = [];
    }
    return this.todos;
  }

  private save(todos: Todo[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(todos, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.todos = todos;
  }

  list(): Todo[] {
    return this.load();
  }

  create(fields: TodoFields, now = Date.now()): Todo {
    const todos = this.load();
    if (todos.length >= MAX_TODOS) throw new TodoError(`Đã đủ ${MAX_TODOS} việc, xoá bớt việc đã xong trước`);
    const stamp = new Date(now).toISOString();
    const todo: Todo = { id: randomUUID(), ...fields, status: "todo", order: -1, createdAt: stamp, updatedAt: stamp, doneAt: null };
    this.save(moveTodo([...todos, todo], todo.id, "todo", 0, stamp));
    return this.load().find((item) => item.id === todo.id)!;
  }

  update(id: string, patch: TodoPatch, now = Date.now()): Todo | null {
    const todos = this.load();
    const current = todos.find((todo) => todo.id === id);
    if (!current) return null;
    const stamp = new Date(now).toISOString();
    const { status, index, ...fields } = patch;
    let next = todos.map((todo) => (todo.id === id ? { ...todo, ...fields, updatedAt: stamp } : todo));
    if (status !== undefined || index !== undefined) next = moveTodo(next, id, status ?? current.status, index ?? (status === undefined || status === current.status ? current.order : 0), stamp);
    this.save(next);
    return next.find((todo) => todo.id === id)!;
  }

  remove(id: string): boolean {
    const todos = this.load();
    if (!todos.some((todo) => todo.id === id)) return false;
    this.save(todos.filter((todo) => todo.id !== id));
    return true;
  }
}
