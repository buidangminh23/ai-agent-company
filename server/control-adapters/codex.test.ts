import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AgentInfo } from "../../shared/types.ts";
import type { CodexReplyWire } from "../reply-adapters/codex.ts";
import { CODEX_STOP_WARNING, CodexControlAdapter, codexActiveTurn, parseCodexModels, readCodexModels } from "./codex.ts";

type Data = Record<string, unknown>;
const THREAD = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const SIGNAL = new AbortController().signal;
const CONTEXT = { author: "human-web" as const, requestId: "44444444-4444-4444-8444-444444444444", signal: SIGNAL };
const agent = { id: "codex-a", app: "codex", machine: "WORKSTATION", parentId: null, sessionId: THREAD, cwd: "C:\\Work\\App", state: "working", model: "gpt-6-sol", updatedAt: "2026-11-03T00:00:00Z", pending: null } as AgentInfo;
const account = { fingerprint: "account-fingerprint", generation: "auth-generation" };
const NOW = Date.parse(agent.updatedAt) + 60_000;
const MODELS = [{ id: "gpt-6-sol", label: "GPT-6 Sol", efforts: ["low", "medium", "high"] }, { id: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["medium", "xhigh"] }];

function fixture(options: { turns?: Data[]; models?: typeof MODELS; settings?: Data | null } = {}) {
  const state: Data = { id: THREAD, hostId: "local", cwd: agent.cwd, requests: [], turns: options.turns ?? [{ turnId: "turn-1", status: "completed" }, { turnId: "turn-2", status: "inProgress" }] };
  const sent: Data[] = [];
  let interrupt: "interrupt" | "ignore" | "other" | "none" | "throw" = "interrupt";
  let applied: unknown = true;
  let accountReads = 0;
  let rotating = false;
  let opens = 0;
  let failOpen = false;
  const adapter = new CodexControlAdapter({ machine: "WORKSTATION", now: () => NOW, account: () => rotating ? { ...account, generation: `rotated-${++accountReads}` } : account, models: () => structuredClone(options.models ?? MODELS), open: async () => {
    opens++;
    if (failOpen) throw new Error("unverified");
    const listeners = new Set<(message: Data) => void>();
    const emit = (message: Data) => { for (const listener of listeners) listener(structuredClone(message)); };
    const wire: CodexReplyWire = {
      version: "26.1027.3384.0", instanceId: "process-1", close() {},
      listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      send(message) {
        sent.push(structuredClone(message));
        const params = message.params as Data;
        if (message.type === "request") {
          let result: unknown = {};
          if (message.method === "initialize") result = { clientId: CLIENT };
          if (message.method === "thread-follower-read-model-settings") result = { settings: options.settings === undefined ? { model: "gpt-6-sol", reasoningEffort: "medium", mode: "default" } : options.settings };
          if (message.method === "thread-follower-interrupt-turn") {
            if (interrupt === "throw") throw new Error("transport ambiguous");
            const turns = state.turns as Data[];
            const active = [...turns].reverse().find((turn) => turn.turnId != null);
            const matched = active?.turnId === params.expectedTurnId && active?.status === "inProgress";
            if (interrupt === "interrupt" && matched) active!.status = "interrupted";
            result = { interruptedTurnId: interrupt === "other" ? "turn-9" : interrupt === "none" || !matched ? null : params.expectedTurnId, ok: true };
          }
          if (message.method === "thread-follower-update-thread-settings") result = { applied };
          queueMicrotask(() => emit({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, handledByClientId: message.method === "initialize" ? CLIENT : OWNER, result }));
        }
        if (message.method === "thread-stream-following-changed" && params.following === true) queueMicrotask(() => emit({ type: "broadcast", sourceClientId: OWNER, targetClientIds: [CLIENT], method: "thread-stream-state-changed", version: 11, params: { conversationId: THREAD, hostId: "local", change: { type: "snapshot", revision: 2, conversationState: state } } }));
      },
    };
    return wire;
  } });
  return {
    adapter, state, sent,
    setInterrupt(value: typeof interrupt) { interrupt = value; },
    setApplied(value: unknown) { applied = value; },
    rotateAccount() { rotating = true; },
    failOpen() { failOpen = true; },
    opens: () => opens,
    calls: (method: string) => sent.filter((message) => message.method === method),
  };
}

test("parses only listed Codex models with unique efforts and reads them from an injectable file", () => {
  const raw = { models: [{ slug: "gpt-6-sol", display_name: "GPT-6 Sol", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "high" }] }, { slug: "hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] }, { slug: "gpt-6-sol", visibility: "list" }, { slug: "", visibility: "list" }, { slug: "plain", visibility: "list" }] };
  assert.deepEqual(parseCodexModels(raw), [{ id: "gpt-6-sol", label: "GPT-6 Sol", efforts: ["low", "high"] }, { id: "plain", label: "plain", efforts: [] }]);
  assert.throws(() => parseCodexModels({ models: "nope" }));
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-models-"));
  try {
    const file = path.join(directory, "models_cache.json");
    writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual(readCodexModels(file).map((model) => model.id), ["gpt-6-sol", "plain"]);
    assert.throws(() => readCodexModels("relative/models_cache.json"));
    assert.throws(() => readCodexModels(path.join(directory, "missing.json")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const adapter = new CodexControlAdapter({ machine: "WORKSTATION", modelsFile: path.join(directory, "missing.json"), open: async () => { throw new Error("offline"); }, account: () => account });
  return adapter.state(agent, SIGNAL).then((state) => assert.deepEqual(state.settings.models, []));
});

test("finds the active turn the same way Codex Desktop does: the last turn with an id must be in progress", () => {
  assert.equal(codexActiveTurn({ turns: [{ turnId: "a", status: "completed" }, { turnId: "b", status: "inProgress" }, { turnId: null, status: "inProgress" }] }), "b");
  assert.equal(codexActiveTurn({ turns: [{ turnId: "a", status: "inProgress" }, { turnId: "b", status: "completed" }] }), null);
  assert.equal(codexActiveTurn({ turns: [] }), null);
  assert.equal(codexActiveTurn({}), null);
});

test("reports stop and settings from a verified snapshot and model settings", async () => {
  const f = fixture();
  const state = await f.adapter.state(agent, SIGNAL);
  assert.deepEqual(state.stop, { available: true, reason: "", warning: CODEX_STOP_WARNING });
  assert.deepEqual(state.settings, { available: true, reason: "", model: "gpt-6-sol", effort: "medium", models: MODELS });
  assert.equal(state.approvals.available, true);
  assert.equal(f.calls("thread-follower-read-model-settings")[0].version, 1);
  assert.equal(f.calls("thread-follower-interrupt-turn").length, 0);
  const idle = fixture({ turns: [{ turnId: "turn-1", status: "completed" }] });
  const idleState = await idle.adapter.state(agent, SIGNAL);
  assert.equal(idleState.stop.available, false);
  assert.equal(idleState.stop.reason, "Codex không có lượt nào đang chạy trong chat này");
  assert.equal(idleState.settings.available, true);
});

test("marks controls unavailable when the channel, account or model list cannot be verified", async () => {
  const offline = fixture();
  offline.failOpen();
  const unverified = await offline.adapter.state(agent, SIGNAL);
  assert.equal(unverified.stop.available, false);
  assert.equal(unverified.settings.available, false);
  assert.equal(unverified.approvals.available, false);
  assert.equal(unverified.stop.warning, CODEX_STOP_WARNING);
  const noModels = await fixture({ models: [] }).adapter.state(agent, SIGNAL);
  assert.equal(noModels.settings.available, false);
  assert.match(noModels.settings.reason, /models_cache\.json/);
  const noSettings = await fixture({ settings: null }).adapter.state(agent, SIGNAL);
  assert.equal(noSettings.settings.available, false);
  const remote = fixture();
  const other = await remote.adapter.state({ ...agent, machine: "LAPTOP" }, SIGNAL);
  assert.equal(other.stop.available, false);
  assert.equal(remote.opens(), 0);
  const rotated = fixture();
  rotated.rotateAccount();
  assert.equal((await rotated.adapter.state(agent, SIGNAL)).stop.available, false);
  assert.equal((await rotated.adapter.stop(agent, CONTEXT)).status, "stale");
  assert.equal((await rotated.adapter.settings(agent, { model: "gpt-6-sol" }, CONTEXT)).status, "stale");
  assert.equal(rotated.calls("thread-follower-interrupt-turn").length + rotated.calls("thread-follower-update-thread-settings").length, 0);
  const cwd = fixture();
  cwd.state.cwd = "C:\\Other";
  assert.equal((await cwd.adapter.state(agent, SIGNAL)).stop.available, false);
});

test("stops the running turn once with user-stop and the expected turn id, then verifies it ended", async () => {
  const f = fixture();
  const result = await f.adapter.stop(agent, CONTEXT);
  assert.equal(result.status, "done");
  assert.ok(result.detail?.includes(CODEX_STOP_WARNING));
  const [call] = f.calls("thread-follower-interrupt-turn");
  assert.equal(call.version, 4);
  assert.equal(call.targetClientId, OWNER);
  assert.deepEqual(call.params, { conversationId: THREAD, mode: "user-stop", expectedTurnId: "turn-2" });
  assert.equal(f.calls("thread-follower-interrupt-turn").length, 1);
});

test("does not send stop without an active turn, a human author or a local chat", async () => {
  const idle = fixture({ turns: [{ turnId: "turn-1", status: "completed" }] });
  assert.equal((await idle.adapter.stop(agent, CONTEXT)).status, "stale");
  assert.equal(idle.calls("thread-follower-interrupt-turn").length, 0);
  const robot = fixture();
  assert.equal((await robot.adapter.stop(agent, { ...CONTEXT, author: "agent" as "human-web" })).status, "stale");
  assert.equal((await robot.adapter.stop({ ...agent, sessionId: "not-a-uuid" }, CONTEXT)).status, "stale");
  assert.equal(robot.opens(), 0);
  const offline = fixture();
  offline.failOpen();
  assert.equal((await offline.adapter.stop(agent, CONTEXT)).status, "stale");
});

test("stop results that cannot be verified stay unknown, and a turn that already ended is stale", async () => {
  for (const [mode, status] of [["ignore", "unknown"], ["other", "unknown"], ["throw", "unknown"], ["none", "stale"]] as const) {
    const f = fixture();
    f.setInterrupt(mode);
    assert.equal((await f.adapter.stop(agent, CONTEXT)).status, status, mode);
    assert.equal(f.calls("thread-follower-interrupt-turn").length, 1);
  }
});

test("updates model and effort for the next turn only after the Codex model list allows them", async () => {
  const f = fixture();
  const result = await f.adapter.settings(agent, { model: "gpt-6-astra", effort: "xhigh" }, CONTEXT);
  assert.equal(result.status, "done");
  const [call] = f.calls("thread-follower-update-thread-settings");
  assert.equal(call.version, 2);
  assert.deepEqual(call.params, { conversationId: THREAD, threadSettings: { model: "gpt-6-astra", effort: "xhigh" } });
  const effortOnly = fixture();
  assert.equal((await effortOnly.adapter.settings(agent, { effort: "high" }, CONTEXT)).status, "done");
  assert.deepEqual(effortOnly.calls("thread-follower-update-thread-settings")[0].params, { conversationId: THREAD, threadSettings: { effort: "high" } });
});

test("rejects settings outside the model list without sending", async () => {
  for (const change of [{ model: "gpt-unknown" }, { model: "gpt-6-sol", effort: "xhigh" }, { effort: "ultra" }, {}, { model: "" }]) {
    const f = fixture();
    assert.equal((await f.adapter.settings(agent, change, CONTEXT)).status, "stale", JSON.stringify(change));
    assert.equal(f.calls("thread-follower-update-thread-settings").length, 0);
  }
  const noModels = fixture({ models: [] });
  assert.equal((await noModels.adapter.settings(agent, { model: "gpt-6-sol" }, CONTEXT)).status, "stale");
  assert.equal(noModels.opens(), 0);
  const unknownCurrent = fixture({ settings: null });
  assert.equal((await unknownCurrent.adapter.settings(agent, { effort: "high" }, CONTEXT)).status, "stale");
  assert.equal(unknownCurrent.calls("thread-follower-update-thread-settings").length, 0);
});

test("settings are done only when Codex reports applied true", async () => {
  for (const applied of [false, null, "true"]) {
    const f = fixture();
    f.setApplied(applied);
    assert.equal((await f.adapter.settings(agent, { model: "gpt-6-sol" }, CONTEXT)).status, "unknown");
    assert.equal(f.calls("thread-follower-update-thread-settings").length, 1);
  }
});

test("does not open the follower channel for a Codex chat idle longer than 30 minutes", async () => {
  for (const [updatedAt, state] of [[new Date(NOW - 31 * 60_000).toISOString(), "idle"], ["not a date", "idle"]] as const) {
    const f = fixture();
    const result = await f.adapter.state({ ...agent, updatedAt, state }, SIGNAL);
    assert.equal(f.opens(), 0, updatedAt);
    for (const control of [result.approvals, result.questions, result.stop, result.settings]) {
      assert.equal(control.available, false);
      assert.equal(control.reason, "Phiên Codex đã lâu không hoạt động; mở chat trong Codex Desktop để thao tác");
    }
    assert.deepEqual(result.settings.models, MODELS);
  }
  for (const state of ["idle", "working"] as const) {
    const f = fixture();
    assert.equal((await f.adapter.state({ ...agent, state, updatedAt: new Date(NOW - 29 * 60_000).toISOString() }, SIGNAL)).approvals.available, true, state);
    assert.equal(f.opens(), 1);
  }
});

test("keeps Stop available for a running Codex turn that has been silent longer than 30 minutes", async () => {
  const silent = new Date(NOW - 3 * 60 * 60_000).toISOString();
  for (const candidate of [{ ...agent, state: "working", updatedAt: silent }, { ...agent, state: "thinking", updatedAt: silent }, { ...agent, state: "waiting", updatedAt: "not a date" }, { ...agent, state: "idle", updatedAt: silent, pending: { question: "Allow?", options: [], askedAt: "2026-11-03T00:00:00Z", kind: "decision" } }] as AgentInfo[]) {
    const f = fixture();
    const result = await f.adapter.state(candidate, SIGNAL);
    assert.equal(f.opens(), 1, JSON.stringify(candidate));
    assert.equal(result.stop.available, true, candidate.state);
    assert.equal(result.approvals.available, true);
  }
  const f = fixture();
  assert.equal((await f.adapter.state({ ...agent, state: "idle", updatedAt: silent }, SIGNAL)).stop.available, false);
  assert.equal(f.opens(), 0);
});
