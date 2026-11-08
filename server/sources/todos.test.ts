import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { columnOf } from "../../shared/todos.ts";
import { TodoError, TodoStore, validateCreate, validatePatch } from "./todos.ts";

function store(): { store: TodoStore; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msc-todos-"));
  const file = path.join(dir, "todos.json");
  return { store: new TodoStore(file), file };
}

test("new to-dos go to the top of Cần làm and persist to disk", () => {
  const { store: todos, file } = store();
  const first = todos.create(validateCreate({ title: "Một" }), Date.parse("2026-11-04T01:00:00Z"));
  const second = todos.create(validateCreate({ title: "Hai", priority: "high", due: "2026-11-05", project: "Website" }), Date.parse("2026-11-04T02:00:00Z"));
  assert.deepEqual(columnOf(todos.list(), "todo").map((todo) => todo.id), [second.id, first.id]);
  const reloaded = new TodoStore(file).list();
  assert.equal(reloaded.length, 2);
  assert.equal(reloaded.find((todo) => todo.id === second.id)!.project, "Website");
});

test("patching moves between columns, edits fields and deletes", () => {
  const { store: todos } = store();
  const a = todos.create(validateCreate({ title: "A" }));
  const b = todos.create(validateCreate({ title: "B" }));
  const moved = todos.update(a.id, validatePatch({ status: "done" }), Date.parse("2026-11-04T03:00:00Z"))!;
  assert.equal(moved.status, "done");
  assert.equal(moved.doneAt, "2026-11-04T03:00:00.000Z");
  assert.equal(todos.update(b.id, validatePatch({ title: "B mới", due: "", note: "ghi chú" }))!.title, "B mới");
  assert.equal(todos.list().find((todo) => todo.id === b.id)!.due, null);
  assert.equal(todos.update("missing", validatePatch({ title: "x" })), null);
  assert.equal(todos.remove(a.id), true);
  assert.equal(todos.remove(a.id), false);
  assert.equal(todos.list().length, 1);
});

test("validation rejects bad input in Vietnamese", () => {
  assert.throws(() => validateCreate({ title: "  " }), (error: unknown) => error instanceof TodoError && error.message === "Cần nhập tên việc");
  assert.throws(() => validateCreate({ title: "x", due: "2026-02-31" }), TodoError);
  assert.throws(() => validatePatch({ status: "later" }), TodoError);
  assert.throws(() => validatePatch({ index: -1 }), TodoError);
  assert.throws(() => validatePatch({}), TodoError);
  assert.throws(() => validateCreate([]), TodoError);
});
