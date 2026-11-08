import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LOCAL_CALENDAR, LocalEventError, LocalEventStore, validateInput } from "./local-events.ts";

const base = { title: "Họp nhóm", start: "2026-11-02T02:00:00.000Z", end: "2026-11-02T03:00:00.000Z", allDay: false, location: "Phòng 301", description: "Chuẩn bị số liệu" };

function tempStore(): { store: LocalEventStore; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "msc-events-"));
  const file = path.join(dir, "nested", "events.json");
  return { store: new LocalEventStore(file), file };
}

test("validation trims text and rejects missing titles, reversed times and oversized spans", () => {
  assert.equal(validateInput({ ...base, title: "  Họp  " }).title, "Họp");
  assert.throws(() => validateInput({ ...base, title: "   " }), LocalEventError);
  assert.throws(() => validateInput({ ...base, end: base.start }), /sau giờ bắt đầu/);
  assert.throws(() => validateInput({ ...base, end: "2028-01-01T00:00:00.000Z" }), /1 năm/);
  assert.throws(() => validateInput({ ...base, start: "not a date" }), /Thời gian/);
  assert.throws(() => validateInput(null), LocalEventError);
  assert.equal(validateInput({ ...base, allDay: "yes" }).allDay, false);
});

test("store creates, lists by range, updates and deletes, persisting to disk", () => {
  const { store, file } = tempStore();
  const created = store.create(validateInput(base), Date.parse("2026-11-01T00:00:00Z"));
  assert.ok(fs.existsSync(file));
  const listed = store.list(Date.parse("2026-11-02T00:00:00Z"), Date.parse("2026-11-03T00:00:00Z"));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, `local:${created.id}`);
  assert.equal(listed[0].calendar, LOCAL_CALENDAR);
  assert.equal(listed[0].local, true);
  assert.equal(store.list(Date.parse("2026-11-03T00:00:00Z"), Date.parse("2026-11-04T00:00:00Z")).length, 0);
  const reread = new LocalEventStore(file);
  const updated = reread.update(created.id, validateInput({ ...base, title: "Họp đã dời" }));
  assert.equal(updated?.title, "Họp đã dời");
  assert.equal(updated?.createdAt, created.createdAt);
  assert.equal(reread.update("missing", validateInput(base)), null);
  assert.equal(reread.remove(created.id), true);
  assert.equal(reread.remove(created.id), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
});
