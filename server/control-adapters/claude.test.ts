import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInfo } from "../../shared/types.ts";
import { CLAUDE_SETTINGS_REASON, CLAUDE_STOP_FLAGGED, CLAUDE_STOP_INTERRUPTED, CLAUDE_STOP_WARNING, createClaudeControlAdapter } from "./claude.ts";

const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const SIGNAL = new AbortController().signal;
const CONTEXT = { author: "human-web" as const, requestId: "11111111-1111-4111-8111-111111111111", signal: SIGNAL };
const agent = { id: "claude-a", app: "claude", machine: "SERVER", parentId: null, sessionId: SESSION, cwd: "C:\\Work", state: "working", model: "claude-opus-5-5" } as AgentInfo;

function fixture(installed = { permission: true, stop: true }, waiting = 0) {
  const calls: string[] = [];
  const registry = {
    installed: () => ({ ...installed }),
    pending: (sessionId: string) => Array.from({ length: sessionId === SESSION ? waiting : 0 }, (_, index) => ({ id: `p${index}`, sessionId, cwd: "C:\\Work", toolName: "Bash", toolInput: {}, suggestions: null, receivedAt: "2026-11-03T00:00:00.000Z" })),
    stop: (sessionId: string) => { calls.push(`stop:${sessionId}`); return { interrupted: waiting > 0 }; },
    clearStop: (sessionId: string) => { calls.push(`clear:${sessionId}`); },
  };
  return { adapter: createClaudeControlAdapter(registry, "SERVER"), calls, installed };
}

test("reports hook capabilities and keeps settings unavailable", async () => {
  const { adapter, installed } = fixture({ permission: false, stop: false });
  const missing = await adapter.state(agent, SIGNAL);
  assert.deepEqual(missing.approvals, { available: false, reason: "Chưa cài hook điều khiển Claude trên Máy chủ; chạy node server/claude-hook/install.mjs trên máy đó" });
  assert.deepEqual(missing.questions, missing.approvals);
  assert.equal(missing.stop.available, false);
  assert.equal(missing.stop.warning, CLAUDE_STOP_WARNING);
  assert.deepEqual(missing.settings, { available: false, reason: CLAUDE_SETTINGS_REASON, model: "claude-opus-5-5", effort: null, models: [] });
  installed.permission = true;
  installed.stop = true;
  const ready = await adapter.state(agent, SIGNAL);
  assert.deepEqual([ready.approvals.available, ready.questions.available, ready.stop.available], [true, true, true]);
  assert.equal(ready.settings.available, false);
});

test("idle sessions cannot be stopped and a heuristic idle never clears a pending stop flag", async () => {
  const { adapter, calls } = fixture();
  const idle = { ...agent, state: "idle" } as AgentInfo;
  const state = await adapter.state(idle, SIGNAL);
  assert.equal(state.stop.available, false);
  assert.match(state.stop.reason, /rảnh/);
  assert.deepEqual(calls, []);
  assert.equal((await adapter.stop(idle, CONTEXT)).status, "stale");
  assert.deepEqual(calls, []);
  assert.deepEqual(await adapter.stop(agent, CONTEXT), { status: "unknown", detail: CLAUDE_STOP_FLAGGED });
  await adapter.state(idle, SIGNAL);
  await adapter.state(agent, SIGNAL);
  assert.deepEqual(calls, [`stop:${SESSION}`]);
});

test("stop writes the flag through the registry only for eligible sessions", async () => {
  const { adapter, calls } = fixture();
  assert.deepEqual(await adapter.stop(agent, CONTEXT), { status: "unknown", detail: CLAUDE_STOP_FLAGGED });
  assert.deepEqual(calls, [`stop:${SESSION}`]);
  assert.equal((await adapter.stop({ ...agent, machine: "WORKSTATION" } as AgentInfo, CONTEXT)).status, "stale");
  assert.equal((await adapter.stop({ ...agent, parentId: "x" } as AgentInfo, CONTEXT)).status, "stale");
  const aborted = new AbortController();
  aborted.abort();
  assert.equal((await adapter.stop(agent, { ...CONTEXT, signal: aborted.signal })).status, "stale");
  assert.equal(calls.length, 1);
  const notInstalled = fixture({ permission: true, stop: false });
  assert.equal((await notInstalled.adapter.stop(agent, CONTEXT)).status, "stale");
  assert.deepEqual(notInstalled.calls, []);
});

test("settings changes are never sent", async () => {
  const { adapter } = fixture();
  assert.deepEqual(await adapter.settings(agent, { model: "x" }, CONTEXT), { status: "stale", detail: CLAUDE_SETTINGS_REASON });
});

test("a hook that is already holding a request proves the channel even when settings were configured per session", async () => {
  const { adapter, calls } = fixture({ permission: false, stop: false }, 1);
  const state = await adapter.state({ ...agent, state: "waiting" }, SIGNAL);
  assert.equal(state.approvals.available, true);
  assert.equal(state.questions.available, true);
  assert.equal(state.stop.available, true);
  assert.deepEqual(await adapter.stop({ ...agent, state: "waiting" }, CONTEXT), { status: "done", detail: CLAUDE_STOP_INTERRUPTED });
  assert.deepEqual(calls, [`stop:${SESSION}`]);
  const none = fixture({ permission: false, stop: false }, 0);
  assert.equal((await none.adapter.state(agent, SIGNAL)).stop.available, false);
  assert.equal((await none.adapter.stop(agent, CONTEXT)).status, "stale");
});

test("stop reports an invalid session id as stale without claiming success", async () => {
  const registry = { installed: () => ({ permission: true, stop: true }), pending: () => [], stop: () => null, clearStop: () => {} };
  const adapter = createClaudeControlAdapter(registry, "SERVER");
  assert.equal((await adapter.stop(agent, CONTEXT)).status, "stale");
});
