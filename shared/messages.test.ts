import assert from "node:assert/strict";
import { test } from "node:test";
import { findRecipient, messageStatus, messageStatusLabel, resolveMessages } from "./messages.ts";
import type { AgentInfo, SentMessage } from "./types.ts";

const at = "2026-11-02T01:00:00Z";
const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({ id, app: "codex", machine: "WORKSTATION", title: id, project: "work", role: null, state: "working", detail: "", parentId: null, updatedAt: at, pending: null, ...extra });
const message = (extra: Partial<SentMessage> = {}): SentMessage => ({ id: "message", at, via: "agent-bridge", summary: "Work", target: { app: "codex", keys: ["thread"] }, ...extra });

test("duplicate thread IDs across machines stay unresolved until the target machine is known", () => {
  const sender = agent("sender");
  const home = agent("home", { sessionId: "thread" });
  const mac = agent("mac", { machine: "LAPTOP", sessionId: "thread" });
  assert.equal(findRecipient(sender, message(), [sender, home, mac]), null);
  assert.equal(findRecipient(sender, message({ target: { app: "codex", keys: ["thread"], machine: "LAPTOP" } }), [sender, home, mac]), mac);
});

test("explicit unmatched keys cannot silently fall back to another task in the same directory", () => {
  const sender = agent("sender");
  const peer = agent("peer", { sessionId: "other-thread", cwd: "C:/Work" });
  assert.equal(findRecipient(sender, message({ target: { app: "codex", keys: ["missing"], cwd: "C:/Work" } }), [sender, peer]), null);
});

test("cwd matching is machine scoped and preserves Unix case sensitivity", () => {
  const sender = agent("sender");
  const home = agent("home", { cwd: "C:/Work" });
  const company = agent("company", { machine: "SERVER", cwd: "C:/Work" });
  const mac = agent("mac", { machine: "LAPTOP", cwd: "/Users/Dev/Work" });
  assert.equal(findRecipient(sender, message({ target: { app: "codex", keys: [], cwd: "c:\\work\\" } }), [sender, home, company]), home);
  assert.equal(findRecipient(sender, message({ target: { app: "codex", keys: [], cwd: "C:/Work", machine: "SERVER" } }), [sender, home, company]), company);
  assert.equal(findRecipient(sender, message({ target: { app: "codex", keys: [], cwd: "/Users/dev/work", machine: "LAPTOP" } }), [sender, mac]), null);
});

test("unresolved and failed attempts retain evidence without inventing receipt", () => {
  const sender = agent("sender", { sent: [message({ status: "failed", detail: "Transport failed", target: { app: "codex", keys: [], machine: "LAPTOP" } })] });
  const [resolved] = resolveMessages([sender]);
  assert.equal(resolved.toId, "");
  assert.equal(resolved.targetMachine, "LAPTOP");
  assert.equal(resolved.status, "failed");
  assert.equal(resolved.detail, "Transport failed");
  assert.match(resolved.targetLabel!, /chưa xác định/);
  assert.equal(messageStatus({}), "unknown");
  assert.notEqual(messageStatusLabel("accepted"), messageStatusLabel("delivered"));
});

test("duplicate observations resolve to the newest evidence under the original ID", () => {
  const sender = agent("sender", { sent: [message({ status: "queued" }), message({ status: "delivered", updatedAt: "2026-11-02T01:01:00Z", replyTo: "original" })] });
  const resolved = resolveMessages([sender]);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "delivered");
  assert.equal(resolved[0].replyTo, "original");
});

test("native task paths resolve only within the sending agent family", () => {
  const root = agent("root", { aliases: ["/root"] });
  const worker = agent("worker", { parentId: root.id, aliases: ["/root/worker"] });
  const otherRoot = agent("other-root", { aliases: ["/root"] });
  const otherWorker = agent("other-worker", { parentId: otherRoot.id, aliases: ["/root/worker"] });
  const all = [root, worker, otherRoot, otherWorker];
  assert.equal(findRecipient(root, message({ target: { app: "codex", keys: ["worker"] } }), all), worker);
  assert.equal(findRecipient(worker, message({ target: { app: "codex", keys: ["/root"] } }), all), root);
  assert.equal(findRecipient(root, message({ target: { app: "codex", keys: ["/root/worker"] } }), all), worker);
});
