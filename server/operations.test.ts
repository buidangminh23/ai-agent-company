import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AgentInfo, Snapshot, QuotaRow } from "../shared/types.ts";
import { deriveOperations, fileConflicts, quotaForecast, taskCard, type HistoryCoverage } from "../shared/operations.ts";
import { OperationsStore, vietnamDayRange } from "./operations.ts";

const now = Date.parse("2026-10-30T12:00:00Z");
const at = (minutes = 0) => new Date(now + minutes * 60_000).toISOString();
const coverage: HistoryCoverage = { from: null, to: null, retentionDays: 7, persistent: true, note: "test" };

function agent(id = "a", changes: Partial<AgentInfo> = {}): AgentInfo {
  return { id, app: "codex", machine: "WORKSTATION", title: "Task", project: "Company", role: null, state: "working", detail: "Writing file", parentId: null, updatedAt: at(), pending: null, cwd: "C:\\Work\\Company", files: [], ...changes };
}

function snapshot(agents: AgentInfo[] = [agent()], minute = 0): Snapshot {
  return {
    generatedAt: at(minute), agents, messages: [],
    machines: [{ id: "WORKSTATION", online: true, source: "local", cpu: 1, cpuModel: "test", cores: 4, memUsed: 1, memTotal: 2, netRxBps: 0, netTxBps: 0, diskUsed: 1, diskTotal: 2, gpu: null, os: "win32", lanIp: null, tailscaleIp: null, uptimeSec: 1, checkedAt: at(minute) }],
    sites: [], quota: { connected: false, rows: [], fetchedAt: null }, activity: { tasksToday: 1, activeProjects: 1, agentsWorking: 1, machinesOnline: 1, machinesTotal: 1 },
    skills: { connected: false, note: "", total: 0, groups: [] }, projects: { connected: false, note: "", repos: [], fetchedAt: null },
  };
}

test("end of turn remains review until explicit verification", () => {
  const done = agent("a", { state: "idle", outcome: { status: "completed", at: at(), summary: "Turn ended", verified: false } });
  assert.equal(taskCard(done, true).stage, "review");
  assert.equal(taskCard({ ...done, outcome: { ...done.outcome!, verified: true } }, true).stage, "completed");
  assert.equal(taskCard(agent("b", { detail: "npm test", state: "thinking" }), true).stage, "working");
  assert.equal(taskCard(agent("b", { detail: "npm test" }), true).stage, "testing");
});

test("collector loss does not label its stale agent as stalled", () => {
  const snap = snapshot([agent("a", { lastActivityAt: at(-20) })]);
  assert.equal(deriveOperations(snap, coverage).attention[0].kind, "stalled");
  snap.machines[0].online = false;
  const items = deriveOperations(snap, coverage).attention;
  assert.deepEqual(items.map((i) => i.kind), ["offline"]);
});

test("repeated tool errors are surfaced only with recent explicit evidence", () => {
  const snap = snapshot([agent("a", { repeatedError: { count: 3, at: at(-1), summary: "Tool failed" } })]);
  assert.ok(deriveOperations(snap, coverage).attention.some((i) => i.id === "repeated:a"));
  snap.agents[0].repeatedError!.at = at(-40);
  assert.ok(!deriveOperations(snap, coverage).attention.some((i) => i.id === "repeated:a"));
});

test("write conflicts require same machine and checkout, fresh distinct writers", () => {
  const agents = [agent("a", { files: [{ path: "src/../src/file.ts", at: at(-1) }] }), agent("b", { cwd: "c:/work/company", files: [{ path: "C:/Work/Company/src/file.ts", at: at(-2) }] })];
  const machines = snapshot().machines;
  assert.equal(fileConflicts(agents, machines, now).length, 1);
  agents[1].cwd = "C:/Work/Other";
  assert.equal(fileConflicts(agents, machines, now).length, 0);
  agents[1].cwd = agents[0].cwd;
  agents[1].files![0].at = at(-11);
  assert.equal(fileConflicts(agents, machines, now).length, 0);
  assert.equal(fileConflicts([agents[0], agents[0]], machines, now).length, 0);
});

test("quota projection needs enough unique samples and resets on refills", () => {
  const row: QuotaRow = { app: "codex", account: "primary", window: "5h", remaining: 50, resetsAt: at(120) };
  const samples = [-20, -10, 0].map((m, i) => ({ at: at(m), row: { ...row, remaining: 70 - 10 * i } }));
  const forecast = quotaForecast(row, samples, now);
  assert.equal(forecast.pointsPerHour, 60);
  assert.equal(forecast.exhaustedAt, at(50));
  assert.equal(forecast.beforeReset, true);
  assert.equal(quotaForecast(row, samples.slice(1), now).exhaustedAt, null);
  assert.equal(quotaForecast(row, [samples[0], samples[0], samples[2]], now).exhaustedAt, null);
  assert.equal(quotaForecast({ ...row, resetsAt: at(300) }, samples, now).exhaustedAt, null);
  samples[1].row.remaining = 95;
  assert.equal(quotaForecast(row, samples, now).exhaustedAt, null);
  assert.equal(quotaForecast({ ...row, remaining: NaN }, samples, now).exhaustedAt, null);
});

test("Vietnam report dates use UTC+7 and reject nonexistent dates", () => {
  assert.deepEqual(vietnamDayRange("2026-10-30"), { from: "2026-10-29T17:00:00.000Z", to: "2026-10-30T16:59:59.999Z" });
  assert.throws(() => vietnamDayRange("2026-02-30"));
});

test("durable observations deduplicate, retain bounded frames, filter and reload", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "msc-operations-"));
  const file = path.join(dir, "history.sqlite");
  let store = new OperationsStore({ file, maxFrames: 2, maxEvents: 4 });
  try {
    for (let i = 0; i < 5; i++) {
      const snap = snapshot([agent("a", { detail: `step ${i}`, updatedAt: at(i) })], i);
      store.observe(snap);
      store.observe(snap);
    }
    const range = { from: at(-1), to: at(10) };
    const result = store.history(range);
    assert.equal(result.events.length, 4);
    assert.equal(new Set(result.events.map((e) => e.detail)).size, 4);
    assert.equal(store.replay(range).frames.length, 2);
    assert.equal(store.history({ ...range, project: "Other" }).events.length, 0);
    assert.equal(store.report("2026-10-30", { project: "Company" }).unfinished.length, 1);
    store.close();
    store = new OperationsStore({ file });
    assert.equal(store.replay(range).frames.length, 2);
    assert.equal(store.coverage().persistent, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retention removes old frames and events", () => {
  const store = new OperationsStore({ file: ":memory:", retentionDays: 1 });
  try {
    store.observe(snapshot());
    store.observe(snapshot([agent("b", { updatedAt: at(2 * 1440) })], 2 * 1440));
    assert.equal(store.history({ from: at(-1), to: at(1) }).events.length, 0);
    assert.equal(store.replay({ from: at(-1), to: at(1) }).frames.length, 0);
  } finally { store.close(); }
});

test("history and replay redact credential-shaped narrative and access-bearing URL queries", () => {
  const store = new OperationsStore({ file: ":memory:" });
  try {
    store.observe(snapshot([agent("a", { detail: "token=secret-value", progress: "Visit https://example.com/report?token=access-value", pending: { question: "password=private-password", options: [], askedAt: at() } })]));
    const range = { from: at(-1), to: at(1) };
    const payload = JSON.stringify([store.history(range), store.replay(range)]);
    assert.ok(!payload.includes("secret-value"));
    assert.ok(!payload.includes("access-value"));
    assert.ok(!payload.includes("private-password"));
  } finally { store.close(); }
});

test("human verification is idempotent, exact-turn scoped and persisted", () => {
  const store = new OperationsStore({ file: ":memory:" });
  try {
    const a = agent("a", { state: "idle", outcome: { status: "completed", at: at(), summary: "Turn ended" } });
    const snap = snapshot([a]);
    store.observe(snap);
    store.verify(snap, "a", at(), "Tests passed and UI checked");
    store.verify(snap, "a", at(), "duplicate should not change evidence");
    const card = store.operations(snap).tasks[0];
    assert.equal(card.stage, "completed");
    assert.match(card.evidence, /Tests passed/);
    assert.throws(() => store.verify(snap, "a", at(1), "wrong turn"));
    a.outcome!.at = at(1);
    assert.equal(store.operations(snap).tasks[0].stage, "review");
    snap.machines[0].online = false;
    assert.throws(() => store.verify(snap, "a", at(1), "offline"));
  } finally { store.close(); }
});

test("API rejects cross-origin verification and invalid date ranges", async () => {
  const store = new OperationsStore({ file: ":memory:" });
  const snap = snapshot([agent("a", { state: "idle", outcome: { status: "completed", at: at(), summary: "Done" } })]);
  const server = http.createServer((req, res) => {
    if (!store.handle(req, res, new URL(req.url!, "http://test"), snap)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const body = JSON.stringify({ agentId: "a", outcomeAt: at(), evidence: "Test confirmed" });
    const blocked = await fetch(`${base}/api/tasks/verify`, { method: "POST", headers: { origin: "https://attacker.test", "content-type": "application/json" }, body });
    assert.equal(blocked.status, 403);
    const success = await fetch(`${base}/api/tasks/verify`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body });
    assert.equal(success.status, 200);
    const invalid = await fetch(`${base}/api/history?from=bad`);
    assert.equal(invalid.status, 400);
    const tooLong = await fetch(`${base}/api/history?from=2026-01-01&to=2026-02-01`);
    assert.equal(tooLong.status, 400);
    const report = await fetch(`${base}/api/report?date=2026-02-30`);
    assert.equal(report.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
