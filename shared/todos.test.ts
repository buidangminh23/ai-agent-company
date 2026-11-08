import assert from "node:assert/strict";
import test from "node:test";
import { columnOf, dueLabel, moveTodo, parseQuickAdd, todoCounts, type Todo } from "./todos.ts";

const TODAY = "2026-11-04";

function todo(id: string, status: Todo["status"], order: number, extra: Partial<Todo> = {}): Todo {
  return { id, title: id, note: "", status, priority: "normal", due: null, project: "", order, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", doneAt: null, ...extra };
}

test("quick add reads due date, priority and project out of the title", () => {
  assert.deepEqual(parseQuickAdd("Gửi báo giá mai !cao #Website", TODAY), { title: "Gửi báo giá", note: "", priority: "high", due: "2026-11-05", project: "Website" });
  assert.deepEqual(parseQuickAdd("Dọn kho !thấp", TODAY), { title: "Dọn kho", note: "", priority: "low", due: null, project: "" });
});

test("quick add understands Vietnamese day words", () => {
  const due = (text: string) => parseQuickAdd(text, TODAY).due;
  assert.equal(due("Họp hôm nay"), TODAY);
  assert.equal(due("Họp ngày mai"), "2026-11-05");
  assert.equal(due("Họp ngày mốt"), "2026-11-06");
  assert.equal(due("Họp thứ 6"), "2026-11-06");
  assert.equal(due("Họp t2"), "2026-11-09");
  assert.equal(due("Họp thứ 4"), TODAY);
  assert.equal(due("Đi chợ chủ nhật"), "2026-11-08");
  assert.equal(due("Nộp bài 15/12"), "2026-12-15");
  assert.equal(due("Gia hạn 1/3"), "2027-03-01");
  assert.equal(due("Báo cáo 5/1/2027"), "2027-01-05");
});

test("quick add leaves look-alike words in the title", () => {
  assert.deepEqual(parseQuickAdd("Gọi chị Mai", TODAY), { title: "Gọi chị Mai", note: "", priority: "normal", due: null, project: "" });
  assert.equal(parseQuickAdd("Phát hành bản 1.2", TODAY).due, null);
  assert.equal(parseQuickAdd("Sửa lỗi 31/2", TODAY).title, "Sửa lỗi 31/2");
});

test("due labels count days from today", () => {
  assert.deepEqual(dueLabel("2026-11-01", TODAY), { text: "Quá hạn 3 ngày", tone: "overdue" });
  assert.deepEqual(dueLabel(TODAY, TODAY), { text: "Hôm nay", tone: "today" });
  assert.deepEqual(dueLabel("2026-11-05", TODAY), { text: "Mai", tone: "soon" });
  assert.deepEqual(dueLabel("2026-11-07", TODAY), { text: "Thứ 7 07/11", tone: "later" });
  assert.deepEqual(dueLabel("2027-02-01", TODAY), { text: "01/02/2027", tone: "later" });
});

test("moving a card reorders both columns and tracks completion", () => {
  const board = [todo("a", "todo", 0), todo("b", "todo", 1), todo("c", "doing", 0)];
  const moved = moveTodo(board, "a", "doing", 1, "2026-11-04T03:00:00Z");
  assert.deepEqual(columnOf(moved, "todo").map((item) => [item.id, item.order]), [["b", 0]]);
  assert.deepEqual(columnOf(moved, "doing").map((item) => [item.id, item.order]), [["c", 0], ["a", 1]]);
  const done = moveTodo(moved, "c", "done", 0, "2026-11-04T04:00:00Z");
  assert.equal(done.find((item) => item.id === "c")!.doneAt, "2026-11-04T04:00:00Z");
  const reopened = moveTodo(done, "c", "todo", 0, "2026-11-04T05:00:00Z");
  assert.equal(reopened.find((item) => item.id === "c")!.doneAt, null);
  assert.deepEqual(columnOf(moveTodo(board, "b", "todo", 0, "x"), "todo").map((item) => item.id), ["b", "a"]);
});

test("counts split open work, overdue and today's finished items", () => {
  const board = [todo("a", "todo", 0, { due: "2026-11-01" }), todo("b", "doing", 0), todo("c", "done", 0, { doneAt: "2026-11-04T02:00:00Z" }), todo("d", "done", 1, { doneAt: "2026-11-02T02:00:00Z" })];
  assert.deepEqual(todoCounts(board, TODAY), { todo: 1, doing: 1, done: 2, overdue: 1, doneToday: 1 });
});
