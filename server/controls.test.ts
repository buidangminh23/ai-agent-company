import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentInfo } from "../shared/types.ts";
import type { ControlCapability, ControlSettingsChange } from "../shared/controls.ts";
import { CONTROL_UNVERIFIED, ControlBroker, ControlBrokerError } from "./controls.ts";
import type { NativeControlAdapter, NativeControlContext, NativeControlResult, NativeControlState } from "./controls.ts";

const base: AgentInfo = {
  id: "codex:local:thread-1", app: "codex", machine: "WORKSTATION", cwd: "C:\\work\\project", sessionId: "thread-1",
  title: "Development", project: "Project", state: "working", detail: "Working", role: null, parentId: null,
  updatedAt: "2026-11-02T12:00:00Z", pending: null,
};
const claude: AgentInfo = { ...base, id: "claude:local:session-1", app: "claude", sessionId: "session-1" };
const antigravity: AgentInfo = { ...base, id: "antigravity:local:conv-1", app: "antigravity", sessionId: "conv-1" };
const child: AgentInfo = { ...base, id: "codex:local:child", parentId: base.id };

function state(): NativeControlState {
  return {
    approvals: { available: true, reason: "" },
    questions: { available: true, reason: "" },
    stop: { available: true, reason: "", warning: "Dừng lượt sẽ tự từ chối mọi yêu cầu đang chờ" },
    settings: { available: true, reason: "", model: "gpt-6", effort: "medium", models: [{ id: "gpt-6", label: "GPT-6", efforts: ["low", "medium", "high"] }, { id: "gpt-6-mini", label: "GPT-6 mini", efforts: ["low"] }] },
  };
}

function fixture(app: "codex" | "claude" = "codex") {
  const calls = { state: 0, stop: 0, settings: 0, author: "", changes: [] as ControlSettingsChange[] };
  const current = { value: state() as unknown, result: { status: "done" } as NativeControlResult };
  const adapter: NativeControlAdapter = {
    app,
    async state() { calls.state++; return structuredClone(current.value) as NativeControlState; },
    async stop(_agent, context: NativeControlContext) { calls.stop++; calls.author = context.author; return current.result; },
    async settings(_agent, change, context) { calls.settings++; calls.author = context.author; calls.changes.push(change); return current.result; },
  };
  return { calls, current, adapter };
}

function stop(agent = base) {
  return { requestId: randomUUID(), agentId: agent.id, machine: agent.machine, action: "stop" as const };
}

function settings(change: ControlSettingsChange, agent = base) {
  return { requestId: randomUUID(), agentId: agent.id, machine: agent.machine, action: "settings" as const, settings: change };
}

function status(code: number) {
  return (error: unknown) => error instanceof ControlBrokerError && error.statusCode === code;
}

test("stop is sent once with human identity and replays the stored receipt", async () => {
  const { calls, adapter } = fixture();
  const broker = new ControlBroker({ adapters: [adapter], file: ":memory:" });
  try {
    const request = stop();
    const receipt = await broker.submit(request, [base]);
    assert.equal(receipt.status, "done");
    assert.equal(receipt.action, "stop");
    assert.equal(calls.author, "human-web");
    assert.deepEqual(await broker.submit(request, [base]), receipt);
    assert.deepEqual(broker.receipt(request.requestId), receipt);
    assert.deepEqual(broker.receipt(request.requestId.toUpperCase()), receipt);
    assert.equal(calls.stop, 1);
    await assert.rejects(broker.submit({ ...request, action: "settings", settings: { model: "gpt-6" } }, [base]), status(409));
    assert.equal(calls.stop + calls.settings, 1);
    assert.equal(broker.receipt(randomUUID()), null);
    assert.throws(() => broker.receipt("wrong"), status(400));
  } finally { broker.close(); }
});

test("concurrent duplicates and competing requests on one agent have exactly one native call", async () => {
  const { calls, adapter } = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const original = adapter.stop;
  adapter.stop = async (agent, context) => { await wait; return original(agent, context); };
  const broker = new ControlBroker({ adapters: [adapter], file: ":memory:" });
  try {
    const request = stop();
    const first = broker.submit(request, [base]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await broker.submit(request, [base]);
    assert.equal(second.status, "pending");
    await assert.rejects(broker.submit(stop(), [base]), status(409));
    release();
    assert.equal((await first).status, "done");
    assert.equal(calls.stop, 1);
    assert.equal((await broker.submit(stop(), [base])).status, "done");
    assert.equal(calls.stop, 2);
  } finally { release(); broker.close(); }
});

test("settings are validated against the freshly read model list before calling the adapter", async (t) => {
  const cases: [string, ControlSettingsChange, string][] = [
    ["model only", { model: "gpt-6-mini" }, "done"],
    ["effort for current model", { effort: "high" }, "done"],
    ["model and effort", { model: "gpt-6-mini", effort: "low" }, "done"],
    ["unknown model", { model: "gpt-9" }, "rejected"],
    ["effort not supported by new model", { model: "gpt-6-mini", effort: "high" }, "rejected"],
    ["unknown effort", { effort: "max" }, "rejected"],
  ];
  for (const [name, change, expected] of cases) await t.test(name, async () => {
    const { calls, adapter } = fixture();
    const broker = new ControlBroker({ adapters: [adapter], file: ":memory:" });
    try {
      assert.equal((await broker.submit(settings(change), [base])).status, expected);
      assert.equal(calls.settings, expected === "done" ? 1 : 0);
      if (expected === "done") assert.deepEqual(calls.changes[0], change);
    } finally { broker.close(); }
  });
});

test("invalid input never reads or calls the adapter", async (t) => {
  const bodies: [string, unknown][] = [
    ["not object", "stop"],
    ["array", []],
    ["request id", { ...stop(), requestId: "wrong" }],
    ["agent id", { ...stop(), agentId: "" }],
    ["machine", { ...stop(), machine: "OTHER" }],
    ["action", { ...stop(), action: "approve" }],
    ["stop with settings", { ...stop(), settings: { model: "gpt-6" } }],
    ["settings missing", { ...stop(), action: "settings" }],
    ["settings empty", settings({})],
    ["settings extra key", { ...settings({ model: "gpt-6" }), settings: { model: "gpt-6", activeTurnId: "x" } }],
    ["long model", settings({ model: "a".repeat(201) })],
    ["nul effort", settings({ effort: "lo\0w" })],
    ["blank model", settings({ model: " " })],
    ["number effort", { ...settings({}), settings: { effort: 3 } }],
  ];
  for (const [name, value] of bodies) await t.test(name, async () => {
    const { calls, adapter } = fixture();
    const broker = new ControlBroker({ adapters: [adapter], file: ":memory:" });
    try {
      await assert.rejects(broker.submit(value, [base]), status(400));
      assert.equal(calls.state + calls.stop + calls.settings, 0);
    } finally { broker.close(); }
  });
});

test("unknown, child, foreign-machine and antigravity targets are refused before any receipt", async () => {
  const { calls, adapter } = fixture();
  const broker = new ControlBroker({ adapters: [adapter], file: ":memory:" });
  try {
    await assert.rejects(broker.submit(stop(), []), status(409));
    await assert.rejects(broker.submit(stop(child), [child]), status(409));
    await assert.rejects(broker.submit({ ...stop(), machine: "LAPTOP" }, [base]), status(409));
    await assert.rejects(broker.submit(stop(antigravity), [antigravity]), status(409));
    await assert.rejects(broker.submit(stop(claude), [claude]), status(409));
    assert.equal(calls.state + calls.stop, 0);
  } finally { broker.close(); }
});

test("stale or unverifiable state is rejected without a native call", async (t) => {
  const mutations: [string, (current: ReturnType<typeof fixture>["current"]) => void][] = [
    ["stop unavailable", (current) => { (current.value as NativeControlState).stop.available = false; }],
    ["malformed state", (current) => { current.value = { approvals: true }; }],
    ["bad model list", (current) => { (current.value as NativeControlState).settings.models = [{ id: "", label: "x", efforts: [] }]; }],
    ["state throws", (current) => { current.value = undefined; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const { calls, current, adapter } = fixture();
    mutate(current);
    if (name === "state throws") adapter.state = async () => { calls.state++; throw new Error("native"); };
    const broker = new ControlBroker({ adapters: [adapter], file: ":memory:" });
    try {
      const request = stop();
      assert.equal((await broker.submit(request, [base])).status, "rejected");
      assert.equal(calls.stop, 0);
      assert.equal((await broker.submit(request, [base])).status, "rejected");
      assert.equal(calls.stop, 0);
    } finally { broker.close(); }
  });
  await t.test("adapter reports stale", async () => {
    const { calls, current, adapter } = fixture();
    current.result = { status: "stale", detail: "Lượt đã kết thúc" };
    const broker = new ControlBroker({ adapters: [adapter], file: ":memory:" });
    try {
      const receipt = await broker.submit(stop(), [base]);
      assert.equal(receipt.status, "rejected");
      assert.match(receipt.detail, /Lượt đã kết thúc/);
      assert.equal(calls.stop, 1);
    } finally { broker.close(); }
  });
});

test("timeout and unknown results persist unknown and are never resent after restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-controls-"));
  const file = path.join(directory, "controls.sqlite");
  const { calls, current, adapter } = fixture();
  adapter.stop = async () => { calls.stop++; return await new Promise<NativeControlResult>(() => {}); };
  let broker = new ControlBroker({ adapters: [adapter], file, timeoutMs: 20 });
  try {
    const request = stop();
    assert.equal((await broker.submit(request, [base])).status, "unknown");
    broker.close();
    broker = new ControlBroker({ adapters: [adapter], file, timeoutMs: 20 });
    assert.equal((await broker.submit(request, [base])).status, "unknown");
    assert.equal(calls.stop, 1);
    current.result = { status: "unknown" };
    const ambiguous = settings({ model: "gpt-6-mini" });
    assert.equal((await broker.submit(ambiguous, [base])).status, "unknown");
    assert.equal((await broker.submit(ambiguous, [base])).status, "unknown");
    assert.equal(calls.settings, 1);
    adapter.settings = async () => { calls.settings++; throw new Error("transport"); };
    const failed = settings({ effort: "low" });
    assert.equal((await broker.submit(failed, [base])).status, "unknown");
    assert.equal(calls.settings, 2);
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("pending receipts from an interrupted process become unknown on startup without resend", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-controls-"));
  const file = path.join(directory, "controls.sqlite");
  const { calls, adapter } = fixture();
  let broker = new ControlBroker({ adapters: [adapter], file });
  try {
    const request = stop();
    await broker.submit(request, [base]);
    broker.close();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE receipts SET status = 'pending' WHERE requestId = ?").run(request.requestId);
    db.close();
    broker = new ControlBroker({ adapters: [adapter], file });
    const receipt = await broker.submit(request, [base]);
    assert.equal(receipt.status, "unknown");
    assert.equal(calls.stop, 1);
    assert.equal((await broker.submit(stop(), [base])).status, "done");
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unavailable durable storage fails closed and disables stop and settings", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-controls-"));
  const { calls, adapter } = fixture();
  const broker = new ControlBroker({ adapters: [adapter], file: directory });
  try {
    await assert.rejects(broker.submit(stop(), [base]), status(503));
    assert.equal(calls.stop, 0);
    const [shown] = (await broker.list([base])).agents;
    assert.equal(shown.stop.available, false);
    assert.equal(shown.settings.available, false);
    assert.equal(shown.approvals.available, true);
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("list merges adapter state with send capability and explains antigravity limits", async () => {
  const codex = fixture();
  const sendCalls: string[][] = [];
  const send = async (agents: AgentInfo[]) => { sendCalls.push(agents.map((agent) => agent.id)); return new Map<string, ControlCapability>([[base.id, { available: true, reason: "" }], [antigravity.id, { available: true, reason: "" }]]); };
  const broker = new ControlBroker({ adapters: [codex.adapter], file: ":memory:", send });
  try {
    const list = await broker.list([base, child, claude, antigravity, { ...base, id: "other", app: "codex" as const, parentId: "parent" }]);
    assert.deepEqual(list.agents.map((agent) => agent.agentId), [base.id, claude.id, antigravity.id]);
    assert.deepEqual(sendCalls, [[base.id, claude.id, antigravity.id]]);
    const [codexState, claudeState, antigravityState] = list.agents;
    assert.equal(codexState.stop.available, true);
    assert.equal(codexState.settings.model, "gpt-6");
    assert.equal(codexState.send.available, true);
    assert.equal(claudeState.stop.available, false);
    assert.match(claudeState.stop.reason, /chưa có kênh điều khiển/);
    assert.equal(claudeState.send.available, false);
    assert.equal(antigravityState.send.available, true);
    for (const key of ["approvals", "questions", "stop", "settings"] as const) {
      assert.equal(antigravityState[key].available, false);
      assert.match(antigravityState[key].reason, /^Antigravity chưa có kênh .+ đã xác minh từ web; thao tác trong app$/);
    }
    assert.match(antigravityState.approvals.reason, /duyệt/);
    assert.match(antigravityState.questions.reason, /trả lời/);
    assert.match(antigravityState.stop.reason, /dừng/);
    assert.match(antigravityState.settings.reason, /đổi cài đặt/);
  } finally { broker.close(); }
});

test("failed or malformed adapter state makes every native capability unavailable", async (t) => {
  const variants: [string, (adapter: NativeControlAdapter) => void][] = [
    ["throws", (adapter) => { adapter.state = async () => { throw new Error("ipc"); }; }],
    ["times out", (adapter) => { adapter.state = async () => await new Promise<NativeControlState>(() => {}); }],
    ["malformed", (adapter) => { adapter.state = async () => ({ approvals: { available: "yes" } }) as unknown as NativeControlState; }],
    ["long reason", (adapter) => { adapter.state = async () => ({ ...state(), approvals: { available: false, reason: "a".repeat(501) } }); }],
  ];
  for (const [name, mutate] of variants) await t.test(name, async () => {
    const { adapter } = fixture();
    mutate(adapter);
    const broker = new ControlBroker({ adapters: [adapter], file: ":memory:", timeoutMs: 20 });
    try {
      const [shown] = (await broker.list([base])).agents;
      for (const key of ["approvals", "questions", "stop", "settings"] as const) {
        assert.equal(shown[key].available, false);
        assert.equal(shown[key].reason, CONTROL_UNVERIFIED);
      }
      assert.deepEqual(shown.settings.models, []);
      assert.equal(shown.send.available, false);
    } finally { broker.close(); }
  });
});

test("send callback failures and malformed entries report unavailable send", async () => {
  const { adapter } = fixture();
  const failing = new ControlBroker({ adapters: [adapter], file: ":memory:", send: async () => { throw new Error("bridge"); } });
  const malformed = new ControlBroker({ adapters: [adapter], file: ":memory:", send: async () => new Map([[base.id, { available: "yes" } as unknown as ControlCapability]]) });
  try {
    assert.equal((await failing.list([base])).agents[0].send.available, false);
    assert.equal((await malformed.list([base])).agents[0].send.available, false);
  } finally { failing.close(); malformed.close(); }
});
