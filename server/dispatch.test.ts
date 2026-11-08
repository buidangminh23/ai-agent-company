import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DispatchBroker, DispatchError, validateDispatch, type DispatchAdapter } from "./dispatch.ts";
import type { AgentInfo } from "../shared/types.ts";

const agent: AgentInfo = { id: "codex:test", machine: "WORKSTATION", app: "codex", sessionId: "test", cwd: "C:/work", title: "Work", project: "Work", state: "idle", role: null, parentId: null, updatedAt: new Date().toISOString(), detail: "", pending: null };
const submission = () => ({ requestId: randomUUID(), targetAgentId: agent.id, targetMachine: agent.machine, message: "Please verify the change" });
const adapter: DispatchAdapter = { inspect: async () => ({ available: true, reason: "Ready" }), send: async () => ({ status: "accepted", detail: "Accepted" }) };

test("dispatch validates bounded messages and target identities", () => {
  for (const change of [{ requestId: "bad" }, { message: " " }, { message: "x".repeat(16001) }, { message: "x\0" }, { targetMachine: "arbitrary-host" }, { targetAgentId: "" }]) assert.throws(() => validateDispatch({ ...submission(), ...change }), DispatchError);
});

test("dispatch persists before sending, identifies human sender and is idempotent", async () => {
  let sends = 0;
  const broker = new DispatchBroker({ file: ":memory:", adapter: { ...adapter, send: async (_agent, text, id) => {
    sends++;
    assert.equal(broker.receipt(id)?.status, "sending");
    assert.match(text, /^\[Human via AI Agent Company/);
    return { status: "accepted", detail: "Accepted" };
  } }, onChange: () => { throw new Error("UI disconnected"); } });
  try {
    const body = submission();
    assert.equal((await broker.submit(body, [agent])).status, "accepted");
    assert.equal((await broker.submit(body, [agent])).status, "accepted");
    assert.equal(sends, 1);
    await assert.rejects(() => broker.submit({ ...body, message: "Different" }, [agent]), /được dùng/);
  } finally { broker.close(); }
});

test("dispatch refuses ambiguous, child and missing session destinations before sending", async () => {
  const broker = new DispatchBroker({ file: ":memory:", adapter });
  try {
    for (const agents of [[], [agent, agent], [{ ...agent, parentId: "parent" }], [{ ...agent, sessionId: undefined }]]) await assert.rejects(() => broker.submit(submission(), agents), /phiên đích/);
    assert.equal(broker.receipts().length, 0);
  } finally { broker.close(); }
});

test("an unconfirmed native send is never retried including after restart", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "msc-dispatch-test-"));
  const file = path.join(dir, "test.sqlite");
  let sends = 0;
  const failed = { ...adapter, send: async () => { sends++; throw new Error("socket disappeared"); } };
  const body = submission();
  const first = new DispatchBroker({ file, adapter: failed });
  assert.equal((await first.submit(body, [agent])).status, "unknown");
  first.close();
  const second = new DispatchBroker({ file, adapter: failed });
  try { assert.equal((await second.submit(body, [agent])).status, "unknown"); assert.equal(sends, 1); }
  finally { second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("inspection hangs are unsent; send hangs remain unknown and bounded", async () => {
  const never = () => new Promise<never>(() => {});
  const inspection = new DispatchBroker({ file: ":memory:", timeoutMs: 15, adapter: { ...adapter, inspect: never } });
  try { assert.equal((await inspection.submit(submission(), [agent])).status, "failed"); }
  finally { inspection.close(); }
  const sending = new DispatchBroker({ file: ":memory:", timeoutMs: 15, adapter: { ...adapter, send: never } });
  try { assert.equal((await sending.submit(submission(), [agent])).status, "unknown"); }
  finally { sending.close(); }
});

test("known preflight refusal is failed; reconciliation binds receipt to its original machine", async () => {
  const broker = new DispatchBroker({ file: ":memory:", adapter: { ...adapter, send: async () => { throw Object.assign(new Error("refused"), { sent: false }); } } });
  try {
    assert.equal((await broker.submit(submission(), [agent])).status, "failed");
    const body = submission();
    const receipt = await broker.submit(body, [agent], async () => { throw new Error("unknown remote result"); });
    assert.equal(broker.reconcile({ ...receipt, targetMachine: "LAPTOP", status: "delivered" })?.status, "unknown");
    assert.equal(broker.reconcile({ ...receipt, updatedAt: new Date(Date.now() + 1000).toISOString(), status: "delivered" })?.status, "delivered");
  } finally { broker.close(); }
});

test("late positive delivery evidence wins despite remote clock skew and never regresses", async () => {
  const broker = new DispatchBroker({ file: ":memory:", adapter });
  try {
    const body = submission();
    const receipt = await broker.submit(body, [agent]);
    const old = new Date(Date.now() - 60000).toISOString();
    assert.equal(broker.reconcile({ ...receipt, status: "delivered", updatedAt: old })?.status, "delivered");
    assert.equal(broker.reconcile({ ...receipt, status: "accepted", updatedAt: new Date(Date.now() + 60000).toISOString() })?.status, "delivered");
    assert.equal(broker.reconcile({ ...receipt, status: "replied", updatedAt: old })?.status, "replied");
  } finally { broker.close(); }
});

test("checking a receipt reads new evidence without resending and binds the target", async () => {
  let sends = 0;
  let checks = 0;
  const broker = new DispatchBroker({ file: ":memory:", adapter: {
    ...adapter,
    send: async () => { sends++; return { status: "accepted", detail: "Accepted" }; },
    check: async (_agent, id) => { checks++; assert.ok(broker.receipt(id)); return { status: "replied", detail: "Observed final response" }; },
  } });
  try {
    const body = submission();
    await broker.submit(body, [agent]);
    await broker.refresh([{ ...agent, machine: "LAPTOP" }], body.requestId);
    assert.equal(checks, 0);
    await broker.refresh([agent], body.requestId);
    assert.equal(broker.receipt(body.requestId)?.status, "replied");
    await broker.refresh([agent], body.requestId);
    assert.equal(checks, 1);
    assert.equal(sends, 1);
  } finally { broker.close(); }
});

test("queued native requests are polled to acceptance without sending a second message", async () => {
  let sends = 0;
  let checks = 0;
  const broker = new DispatchBroker({ file: ":memory:", adapter: {
    ...adapter,
    send: async () => { sends++; return { status: "queued", detail: "Native delivery pending" }; },
    check: async () => { checks++; return { status: "accepted", detail: "Native delivery accepted" }; },
  } });
  try {
    const body = submission();
    assert.equal((await broker.submit(body, [agent])).status, "queued");
    await broker.refresh([agent], body.requestId);
    assert.equal(broker.receipt(body.requestId)?.status, "accepted");
    assert.equal(sends, 1);
    assert.equal(checks, 1);
  } finally { broker.close(); }
});

test("Codex delivery evidence requires the exact marked user turn and a completed final response", async () => {
  const { codexDispatchEvidence } = await import("./dispatch-bridge.ts");
  const target = { ...agent, cwd: process.cwd() };
  const requestId = randomUUID();
  const user = { type: "userMessage", content: [{ type: "text", text: `[Human via AI Agent Company · ${requestId}]\nVerify fixture` }] };
  const final = { type: "agentMessage", phase: "final", text: "Verified." };
  const result = (status: string, items: unknown[]) => ({ thread: { id: target.sessionId, cwd: target.cwd }, turns: [{ status, items }] });
  assert.equal(codexDispatchEvidence(result("completed", [final]), target, requestId), null);
  assert.equal(codexDispatchEvidence(result("completed", [user, final]), target, randomUUID()), null);
  assert.equal(codexDispatchEvidence(result("inProgress", [user, final]), target, requestId)?.status, "delivered");
  assert.equal(codexDispatchEvidence(result("completed", [user, { ...final, phase: "commentary" }]), target, requestId)?.status, "delivered");
  assert.equal(codexDispatchEvidence(result("completed", [user, final]), target, requestId)?.status, "replied");
  assert.equal(codexDispatchEvidence(result("completed", [user, final]), { ...target, sessionId: "wrong" }, requestId), null);
});
