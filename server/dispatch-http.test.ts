import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { AgentInfo } from "../shared/types.ts";
import { DispatchBroker } from "./dispatch.ts";
import { createDispatchHandler, type DispatchHttpOptions } from "./dispatch-http.ts";

const agent: AgentInfo = { id: "codex:test", machine: "WORKSTATION", app: "codex", sessionId: "test", cwd: "C:/work", title: "Work", project: "Work", state: "idle", role: null, parentId: null, updatedAt: new Date().toISOString(), detail: "", pending: null };
const token = "fixture-token";
async function fixture(overrides: Partial<DispatchHttpOptions> = {}) {
  let sends = 0;
  const broker = new DispatchBroker({ file: ":memory:", adapter: { inspect: async () => ({ available: true, reason: "Ready" }), send: async () => { sends++; return { status: "accepted", detail: "Accepted" }; } } });
  let handler: ReturnType<typeof createDispatchHandler>;
  const server = http.createServer((req, res) => { if (!handler(req, res)) res.writeHead(404).end(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${host}`;
  handler = createDispatchHandler({ broker, self: agent.machine, getAgents: () => [agent], getLocalAgents: async () => [agent], token, remoteToken: token, allowedHosts: [host], collectors: new Map(), timeoutMs: 1000, ...overrides });
  const headers = { "content-type": "application/json", "x-msc-token": token, "x-msc-communication": "human-web", origin };
  const body = { requestId: randomUUID(), targetAgentId: agent.id, targetMachine: agent.machine, message: "Verify the fixture" };
  return { origin, headers, body, broker, sends: () => sends, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); broker.close(); } };
}

test("communications requires token, same-origin human action and internal header auth", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.origin}/api/communications`)).status, 401);
    assert.equal((await fetch(`${app.origin}/api/communications`, { headers: { cookie: `msc_token=${token}` } })).status, 200);
    assert.equal((await fetch(`${app.origin}/collector/communications`, { headers: { cookie: `msc_token=${token}` } })).status, 401);
    for (const headers of [{ ...app.headers, origin: "https://attacker.test" }, { ...app.headers, "x-msc-communication": "" }, { ...app.headers, "sec-fetch-site": "cross-site" }]) assert.equal((await fetch(`${app.origin}/api/communications`, { method: "POST", headers, body: JSON.stringify(app.body) })).status, 403);
    assert.equal(app.sends(), 0);
  } finally { await app.close(); }
});

test("explicit communication submits exactly once and reads its receipt", async () => {
  const app = await fixture();
  try {
    for (let count = 0; count < 2; count++) {
      const response = await fetch(`${app.origin}/api/communications`, { method: "POST", headers: app.headers, body: JSON.stringify(app.body) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "accepted");
    }
    assert.equal(app.sends(), 1);
    assert.equal((await (await fetch(`${app.origin}/api/communications/${app.body.requestId}`, { headers: app.headers })).json()).id, app.body.requestId);
  } finally { await app.close(); }
});

test("remote ambiguity persists at the hub and a repeated POST cannot forward again", async () => {
  let forwards = 0;
  const remoteAgent = { ...agent, machine: "LAPTOP" as const };
  const app = await fixture({ getAgents: () => [remoteAgent], collectors: new Map([["LAPTOP", "http://remote:5190"]]), fetch: async (_url, init) => { forwards++; assert.equal(init?.redirect, "error"); throw new Error("lost response"); } });
  try {
    const body = { ...app.body, targetMachine: remoteAgent.machine };
    for (let count = 0; count < 2; count++) {
      const response = await fetch(`${app.origin}/api/communications`, { method: "POST", headers: app.headers, body: JSON.stringify(body) });
      assert.equal((await response.json()).status, "unknown");
    }
    assert.equal(forwards, 1);
    assert.equal(app.broker.receipt(body.requestId)?.status, "unknown");
  } finally { await app.close(); }
});

test("malformed and oversized requests cannot dispatch; offline destination cannot forward", async () => {
  const app = await fixture({ collectors: new Map([["LAPTOP", "http://remote:5190"]]), isMachineOnline: () => false });
  try {
    assert.equal((await fetch(`${app.origin}/api/communications`, { method: "POST", headers: app.headers, body: "{" })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/communications`, { method: "POST", headers: app.headers, body: "x".repeat(66000) })).status, 413);
    assert.equal((await fetch(`${app.origin}/api/communications`, { method: "POST", headers: app.headers, body: JSON.stringify({ ...app.body, targetMachine: "LAPTOP" }) })).status, 409);
    assert.equal(app.sends(), 0);
  } finally { await app.close(); }
});

test("remote receipt reads preserve stronger hub evidence instead of returning a stale acknowledgement", async () => {
  const remoteAgent = { ...agent, machine: "LAPTOP" as const };
  let remoteReceipt: any;
  const app = await fixture({ getAgents: () => [remoteAgent], collectors: new Map([["LAPTOP", "http://remote:5190"]]), fetch: async () => Response.json(remoteReceipt) });
  try {
    const body = { ...app.body, targetMachine: remoteAgent.machine };
    const at = new Date().toISOString();
    remoteReceipt = { id: body.requestId, status: "accepted", targetAgentId: agent.id, targetMachine: remoteAgent.machine, summary: "Fixture", at, updatedAt: at, detail: "Accepted", author: "human-web" };
    await fetch(`${app.origin}/api/communications`, { method: "POST", headers: app.headers, body: JSON.stringify(body) });
    app.broker.reconcile({ ...remoteReceipt, status: "replied", detail: "Confirmed final response" });
    const response = await fetch(`${app.origin}/api/communications/${body.requestId}?machine=LAPTOP`, { headers: app.headers });
    assert.equal((await response.json()).status, "replied");
    remoteReceipt = { generatedAt: at, targets: [], receipts: [remoteReceipt] };
    const list = await (await fetch(`${app.origin}/api/communications`, { headers: app.headers })).json();
    assert.equal(list.receipts[0].status, "replied");
  } finally { await app.close(); }
});
