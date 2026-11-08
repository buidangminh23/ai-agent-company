import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { AgentInfo, MachineId } from "../shared/types.ts";
import type { AgentControlState, ControlList, ControlReceipt, ControlSubmission } from "../shared/controls.ts";
import { createControlHandler } from "./control-http.ts";
import type { ControlHttpOptions } from "./control-http.ts";

const TOKEN = "test-access-token";
const SELF: MachineId = "WORKSTATION";
const REMOTE: MachineId = "LAPTOP";
const COLLECTOR = "http://100.80.0.2:5190";
const agent: AgentInfo = {
  id: "agent-1", app: "codex", machine: SELF, cwd: "C:\\work", sessionId: "session-1", title: "Test", project: "Test",
  state: "working", detail: "Working", role: null, parentId: null, updatedAt: "2026-11-02T12:00:00Z", pending: null,
};
const remoteAgent: AgentInfo = { ...agent, machine: REMOTE };

function stopBody(machine: MachineId = SELF, agentId = agent.id) {
  return { requestId: randomUUID(), agentId, machine, action: "stop" };
}

function settingsBody(machine: MachineId = SELF, settings: unknown = { model: "gpt-5.5", effort: "high" }) {
  return { requestId: randomUUID(), agentId: agent.id, machine, action: "settings", settings };
}

function receipt(body: ControlSubmission, status: ControlReceipt["status"] = "done"): ControlReceipt {
  return { requestId: body.requestId, agentId: body.agentId, action: body.action, status, createdAt: "2026-11-02T12:00:00Z", updatedAt: "2026-11-02T12:00:00Z", detail: "Ứng dụng gốc đã xác nhận thao tác" };
}

function controlEntry(machine: MachineId = REMOTE, agentId = agent.id): AgentControlState {
  return {
    agentId, app: "codex", machine,
    approvals: { available: true, reason: "" }, questions: { available: true, reason: "" }, send: { available: true, reason: "" },
    stop: { available: true, reason: "", warning: "Dừng lượt sẽ tự từ chối các yêu cầu đang chờ" },
    settings: { available: true, reason: "", model: "gpt-5.5", effort: "high", models: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "high"] }] },
  };
}

async function fixture(overrides: Partial<ControlHttpOptions> = {}) {
  const state = { sends: 0, reads: 0, submitted: [] as ControlSubmission[], localAgents: [agent], agents: [agent], receipts: new Map<string, ControlReceipt>() };
  let handler!: ReturnType<typeof createControlHandler>;
  const server = http.createServer((req, res) => { if (!handler(req, res)) res.writeHead(404).end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${authority}`;
  handler = createControlHandler({
    self: SELF, token: TOKEN, remoteToken: TOKEN, allowedHosts: [authority], collectors: new Map(),
    getAgents: () => state.agents,
    getLocalAgents: async () => { state.reads++; return state.localAgents; },
    broker: {
      list: async (agents) => ({ generatedAt: "now", agents: agents.map((item) => controlEntry(item.machine, item.id)) }),
      submit: async (value, agents) => {
        state.sends++;
        assert.deepEqual(agents, state.localAgents);
        const body = value as ControlSubmission;
        state.submitted.push(body);
        const result = receipt(body);
        state.receipts.set(result.requestId, result);
        return result;
      },
      receipt: (id) => state.receipts.get(id) ?? null,
    },
    ...overrides,
  });
  return {
    state, origin,
    headers: { "content-type": "application/json", "x-msc-token": TOKEN, "x-msc-control": "human-web", origin },
    post: (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-msc-token": TOKEN, "x-msc-control": "human-web", origin, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test("browser routes require a configured token by header or single cookie and an allowed Host", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.origin}/api/agent-controls`)).status, 401);
    assert.equal((await fetch(`${app.origin}/api/agent-controls`, { headers: { cookie: `msc_token=${TOKEN}` } })).status, 200);
    assert.equal((await fetch(`${app.origin}/api/agent-controls`, { headers: { cookie: "msc_token=%invalid" } })).status, 401);
    assert.equal((await fetch(`${app.origin}/api/agent-controls`, { headers: { cookie: `msc_token=${TOKEN}; msc_token=${TOKEN}` } })).status, 401);
    assert.equal((await fetch(`${app.origin}/api/agent-controls`, { headers: { "x-msc-token": "wrong" } })).status, 401);
    const rebound = await new Promise<number>((resolve, reject) => {
      http.get(`${app.origin}/api/agent-controls`, { headers: { "x-msc-token": TOKEN, host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode!); }).on("error", reject);
    });
    assert.equal(rebound, 403);
    assert.equal(app.state.reads, 1);
  } finally { await app.close(); }
  const disabled = await fixture({ token: "" });
  try { assert.equal((await fetch(`${disabled.origin}/api/agent-controls`, { headers: { "x-msc-token": TOKEN } })).status, 401); }
  finally { await disabled.close(); }
});

test("local list rereads fresh local agents and only returns this machine", async () => {
  const app = await fixture();
  app.state.localAgents = [agent];
  app.state.agents = [agent, remoteAgent];
  try {
    const list = await (await fetch(`${app.origin}/api/agent-controls`, { headers: { "x-msc-token": TOKEN } })).json() as ControlList;
    assert.equal(app.state.reads, 1);
    assert.deepEqual(list.agents.map((entry) => [entry.agentId, entry.machine]), [[agent.id, SELF]]);
  } finally { await app.close(); }
});

test("browser write accepts same-origin stop and settings, rereads agents and serves receipts", async () => {
  const app = await fixture();
  try {
    const body = stopBody();
    const response = await app.post("/api/agent-controls", body);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as ControlReceipt).requestId, body.requestId);
    const settings = settingsBody(SELF, { effort: "low" });
    assert.equal((await app.post("/api/agent-controls", { ...settings, extra: "drop" }, { "sec-fetch-site": "same-origin" })).status, 200);
    assert.deepEqual(app.state.submitted[1], { requestId: settings.requestId, agentId: agent.id, machine: SELF, action: "settings", settings: { effort: "low" } });
    assert.equal(app.state.reads, 2);
    assert.equal(app.state.sends, 2);
    const lookup = await fetch(`${app.origin}/api/agent-controls/${body.requestId}?machine=${SELF}`, { headers: { "x-msc-token": TOKEN } });
    assert.equal((await lookup.json() as ControlReceipt).status, "done");
    assert.equal(await (await fetch(`${app.origin}/api/agent-controls/${randomUUID()}?machine=${SELF}`, { headers: { "x-msc-token": TOKEN } })).json(), null);
    assert.equal((await fetch(`${app.origin}/api/agent-controls/${body.requestId}`, { headers: { "x-msc-token": TOKEN } })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/agent-controls/not-a-uuid?machine=${SELF}`, { headers: { "x-msc-token": TOKEN } })).status, 400);
    assert.equal((await fetch(`${app.origin}/other`)).status, 404);
  } finally { await app.close(); }
});

test("browser write rejects cross-origin, missing origin, missing human header and foreign fetch site", async () => {
  const app = await fixture();
  try {
    const changes: Record<string, string>[] = [{ origin: "https://attacker.example" }, { origin: "" }, { "x-msc-control": "" }, { "x-msc-control": "agent" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: `${app.origin}/path` }, { origin: app.origin.replace("127.0.0.1", "localhost") }];
    for (const change of changes) assert.equal((await app.post("/api/agent-controls", stopBody(), change)).status, 403, JSON.stringify(change));
    assert.equal((await fetch(`${app.origin}/api/agent-controls`, { method: "POST", headers: { "content-type": "application/json", "x-msc-control": "human-web", origin: app.origin }, body: JSON.stringify(stopBody()) })).status, 401);
    assert.equal(app.state.sends, 0);
  } finally { await app.close(); }
});

test("collector endpoints require header token and never accept a browser cookie alone", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.origin}/collector/agent-controls`, { headers: { cookie: `msc_token=${TOKEN}` } })).status, 401);
    assert.equal((await fetch(`${app.origin}/collector/agent-controls`, { method: "POST", headers: { cookie: `msc_token=${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(stopBody()) })).status, 401);
    const list = await fetch(`${app.origin}/collector/agent-controls`, { headers: { "x-msc-token": TOKEN } });
    assert.equal(list.status, 200);
    assert.equal(((await list.json()) as ControlList).agents.length, 1);
    const body = stopBody();
    assert.equal((await fetch(`${app.origin}/collector/agent-controls`, { method: "POST", headers: { "x-msc-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) })).status, 200);
    assert.equal((await fetch(`${app.origin}/collector/agent-controls`, { method: "POST", headers: { "x-msc-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(stopBody(REMOTE)) })).status, 409);
    assert.equal(((await (await fetch(`${app.origin}/collector/agent-controls/${body.requestId}`, { headers: { "x-msc-token": TOKEN } })).json()) as ControlReceipt).status, "done");
    assert.equal((await fetch(`${app.origin}/collector/agent-controls/${body.requestId}?machine=${REMOTE}`, { headers: { "x-msc-token": TOKEN } })).status, 409);
    assert.equal((await fetch(`${app.origin}/collector/agent-controls/${body.requestId}`, { headers: { cookie: `msc_token=${TOKEN}` } })).status, 401);
    assert.equal(app.state.sends, 1);
  } finally { await app.close(); }
});

test("unsupported media, oversized bodies, malformed JSON, invalid actions and methods cannot send", async () => {
  const app = await fixture();
  try {
    assert.equal((await app.post("/api/agent-controls", stopBody(), { "content-type": "text/plain" })).status, 415);
    assert.equal((await app.post("/api/agent-controls", stopBody(), { "content-encoding": "gzip" })).status, 415);
    assert.equal((await app.post("/api/agent-controls", { ...stopBody(), extra: "x".repeat(17 * 1024) })).status, 413);
    assert.equal((await app.post("/api/agent-controls", "{")).status, 400);
    assert.equal((await app.post("/api/agent-controls", "[]")).status, 400);
    const invalid: unknown[] = [
      { ...stopBody(), requestId: "not-a-uuid" },
      { ...stopBody(), machine: "OTHER" },
      { ...stopBody(), action: "approve" },
      { ...stopBody(), agentId: "a".repeat(301) },
      { ...stopBody(), settings: { model: "gpt-5.5" } },
      settingsBody(SELF, {}),
      settingsBody(SELF, { model: "gpt-5.5", url: "http://attacker.example" }),
      settingsBody(SELF, { model: "a".repeat(201) }),
      settingsBody(SELF, { effort: "hi\0gh" }),
      settingsBody(SELF, "gpt-5.5"),
    ];
    for (const body of invalid) assert.equal((await app.post("/api/agent-controls", body)).status, 400, JSON.stringify(body).slice(0, 120));
    assert.equal((await fetch(`${app.origin}/api/agent-controls`, { method: "PUT", headers: app.headers, body: "{}" })).status, 405);
    assert.equal((await fetch(`${app.origin}/api/agent-controls/${randomUUID()}`, { method: "POST", headers: app.headers, body: "{}" })).status, 405);
    assert.equal(app.state.sends, 0);
  } finally { await app.close(); }
});

test("incomplete incoming bodies time out and oversized chunked bodies are bounded", async () => {
  const app = await fixture({ timeoutMs: 30 });
  try {
    const post = (chunk: string) => new Promise<number>((resolve, reject) => {
      const req = http.request(`${app.origin}/api/agent-controls`, { method: "POST", headers: app.headers }, (response) => { response.resume(); resolve(response.statusCode!); });
      req.on("error", reject);
      req.write(chunk);
    });
    assert.equal(await post("{"), 408);
    assert.equal(await post("x".repeat(17 * 1024)), 413);
    assert.equal(app.state.sends, 0);
  } finally { await app.close(); }
});

test("fresh-agent read timeout prevents local dispatch", async () => {
  let sends = 0;
  const app = await fixture({
    timeoutMs: 20,
    getLocalAgents: async () => await new Promise(() => {}),
    broker: { list: async () => ({ generatedAt: "now", agents: [] }), submit: async (value) => { sends++; return receipt(value as ControlSubmission); }, receipt: () => null },
  });
  try {
    assert.equal((await app.post("/api/agent-controls", stopBody())).status, 503);
    assert.equal((await fetch(`${app.origin}/api/agent-controls`, { headers: { "x-msc-token": TOKEN } })).status, 503);
    assert.equal(sends, 0);
  } finally { await app.close(); }
});

test("remote forwarding uses only the configured collector, sanitized body and verified agent binding", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(receipt(JSON.parse(init!.body as string)));
  };
  const app = await fixture({ collectors: new Map([[REMOTE, COLLECTOR], ["SERVER", "http://user:pass@100.80.0.3:5190/"]]), fetch: fakeFetch });
  app.state.agents = [remoteAgent, { ...agent, id: "child", machine: REMOTE, parentId: agent.id }, { ...agent, id: "ag", app: "antigravity", machine: REMOTE }, { ...agent, machine: "SERVER" }];
  try {
    const body = settingsBody(REMOTE, { model: "gpt-5.5", effort: "high" });
    const response = await app.post("/api/agent-controls", { ...body, url: "http://attacker.example" });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as ControlReceipt).status, "done");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${COLLECTOR}/collector/agent-controls`);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(calls[0].init?.redirect, "error");
    assert.equal((calls[0].init?.headers as Record<string, string>)["x-msc-token"], TOKEN);
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), { requestId: body.requestId, agentId: agent.id, machine: REMOTE, action: "settings", settings: { model: "gpt-5.5", effort: "high" } });
    for (const rejected of [stopBody(REMOTE, "child"), stopBody(REMOTE, "ag"), stopBody(REMOTE, "unknown"), stopBody("SERVER")]) assert.equal((await app.post("/api/agent-controls", rejected)).status, 409);
    app.state.agents = [agent];
    assert.equal((await app.post("/api/agent-controls", stopBody(REMOTE))).status, 409);
    assert.equal(calls.length, 1);
    assert.equal(app.state.sends, 0);
  } finally { await app.close(); }
});

test("remote writes are refused before sending when the machine is offline or no collector token exists", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return Response.json(null); };
  const offline = await fixture({ collectors: new Map([[REMOTE, COLLECTOR]]), fetch: fakeFetch, isMachineOnline: () => false });
  offline.state.agents = [remoteAgent];
  try { assert.equal((await offline.post("/api/agent-controls", stopBody(REMOTE))).status, 409); }
  finally { await offline.close(); }
  const tokenless = await fixture({ collectors: new Map([[REMOTE, COLLECTOR]]), fetch: fakeFetch, remoteToken: "" });
  tokenless.state.agents = [remoteAgent];
  try {
    const response = await tokenless.post("/api/agent-controls", stopBody(REMOTE));
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { status?: string }).status, undefined);
  } finally { await tokenless.close(); }
  assert.equal(calls, 0);
});

test("remote ambiguous delivery is unknown with requestId and never automatically retried", async () => {
  let calls = 0;
  let mode = "throw";
  const fakeFetch: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string) as ControlSubmission;
    if (mode === "throw") throw new Error("transport secret must not leak");
    if (mode === "server") return Response.json({ error: "boom" }, { status: 500 });
    if (mode === "mismatch") return Response.json({ ...receipt(body), agentId: "other" });
    if (mode === "action") return Response.json({ ...receipt(body), action: "settings" });
    if (mode === "request") return Response.json(receipt({ ...body, requestId: randomUUID() }));
    if (mode === "status") return Response.json({ ...receipt(body), status: "sent" });
    return new Response("x".repeat(513 * 1024));
  };
  const app = await fixture({ collectors: new Map([[REMOTE, COLLECTOR]]), fetch: fakeFetch });
  app.state.agents = [remoteAgent];
  try {
    for (const next of ["throw", "server", "mismatch", "action", "request", "status", "large"]) {
      mode = next;
      const before = calls;
      const body = stopBody(REMOTE);
      const response = await app.post("/api/agent-controls", body);
      assert.equal(response.status, 502, next);
      const result = await response.json() as { status: string; requestId: string };
      assert.equal(result.status, "unknown");
      assert.equal(result.requestId, body.requestId);
      assert.equal(JSON.stringify(result).includes("secret"), false);
      assert.equal(calls - before, 1);
    }
  } finally { await app.close(); }
});

test("remote definite refusals pass through without being reported as unknown", async () => {
  let status = 409;
  const fakeFetch: typeof fetch = async () => Response.json({ error: "remote detail" }, { status });
  const app = await fixture({ collectors: new Map([[REMOTE, COLLECTOR]]), fetch: fakeFetch });
  app.state.agents = [remoteAgent];
  try {
    const conflict = await app.post("/api/agent-controls", stopBody(REMOTE));
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { status?: string }).status, undefined);
    status = 401;
    const denied = await app.post("/api/agent-controls", stopBody(REMOTE));
    assert.equal(denied.status, 503);
    assert.equal(((await denied.json()) as { status?: string }).status, undefined);
    assert.equal((await fetch(`${app.origin}/api/agent-controls/${randomUUID()}?machine=${REMOTE}`, { headers: { "x-msc-token": TOKEN } })).status, 503);
  } finally { await app.close(); }
});

test("remote receipts are fetched from the configured collector and validated", async () => {
  const calls: string[] = [];
  let mode = "valid";
  const requestId = randomUUID();
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push(`${init?.method} ${String(url)}`);
    const row = receipt({ requestId, agentId: agent.id, machine: REMOTE, action: "stop" }, "unknown");
    if (mode === "null") return Response.json(null);
    if (mode === "foreign") return Response.json({ ...row, requestId: randomUUID() });
    if (mode === "action") return Response.json({ ...row, action: "approve" });
    return Response.json({ ...row, detail: "x".repeat(900), extra: "drop" });
  };
  const app = await fixture({ collectors: new Map([[REMOTE, COLLECTOR]]), fetch: fakeFetch });
  try {
    const read = () => fetch(`${app.origin}/api/agent-controls/${requestId}?machine=${REMOTE}`, { headers: { "x-msc-token": TOKEN } });
    const valid = await read();
    assert.equal(valid.status, 200);
    const shown = await valid.json() as ControlReceipt & { extra?: string };
    assert.equal(shown.status, "unknown");
    assert.equal(shown.detail.length, 500);
    assert.equal(shown.extra, undefined);
    assert.deepEqual(calls, [`GET ${COLLECTOR}/collector/agent-controls/${requestId}`]);
    mode = "null";
    assert.equal(await (await read()).json(), null);
    for (const next of ["foreign", "action"]) { mode = next; assert.equal((await read()).status, 502, next); }
    assert.equal((await fetch(`${app.origin}/api/agent-controls/${requestId}?machine=SERVER`, { headers: { "x-msc-token": TOKEN } })).status, 409);
    assert.equal(calls.length, 4);
  } finally { await app.close(); }
});

test("remote lists ignore offline machines, keep only known top-level agents and reject foreign or oversized payloads", async () => {
  let calls = 0;
  let mode = "valid";
  const fakeFetch: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), `${COLLECTOR}/collector/agent-controls`);
    assert.equal(init?.redirect, "error");
    if (mode === "large") return new Response("x".repeat(513 * 1024));
    if (mode === "foreign") return Response.json({ generatedAt: "now", agents: [controlEntry(SELF)] });
    if (mode === "settings") return Response.json({ generatedAt: "now", agents: [{ ...controlEntry(), settings: { ...controlEntry().settings, models: [{ id: "gpt", label: "GPT", efforts: ["high", "high"] }] } }] });
    if (mode === "error") return Response.json({ error: "boom" }, { status: 500 });
    return Response.json({ generatedAt: "now", agents: [{ ...controlEntry(), extra: "drop" }, controlEntry(REMOTE, "unknown-agent"), controlEntry(REMOTE, "child")] });
  };
  let online = false;
  const app = await fixture({ collectors: new Map([[REMOTE, COLLECTOR]]), fetch: fakeFetch, isMachineOnline: (machine) => machine === REMOTE && online });
  app.state.agents = [agent, remoteAgent, { ...agent, id: "child", machine: REMOTE, parentId: agent.id }, { ...agent, id: "ag", app: "antigravity", machine: REMOTE }];
  try {
    const read = async () => await (await fetch(`${app.origin}/api/agent-controls`, { headers: { "x-msc-token": TOKEN } })).json() as ControlList;
    assert.deepEqual((await read()).agents.map((entry) => entry.machine), [SELF]);
    assert.equal(calls, 0);
    online = true;
    const valid = (await read()).agents.filter((entry) => entry.machine === REMOTE);
    assert.equal(valid.length, 1);
    assert.equal(valid[0].agentId, agent.id);
    assert.equal(valid[0].stop.available, true);
    assert.equal(JSON.stringify(valid[0]).includes("drop"), false);
    for (const next of ["foreign", "settings", "large", "error"]) {
      mode = next;
      const remote: AgentControlState[] = (await read()).agents.filter((entry) => entry.machine === REMOTE);
      assert.deepEqual(remote.map((entry) => entry.agentId).sort(), ["ag", agent.id], next);
      assert.ok(remote.every((entry) => !entry.stop.available && !entry.settings.available && !entry.send.available && !entry.approvals.available && entry.stop.reason.length > 0), next);
    }
    assert.equal(calls, 5);
  } finally { await app.close(); }
});

test("collector list served to a hub never includes remote machines", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; return Response.json({ generatedAt: "now", agents: [controlEntry()] }); };
  const app = await fixture({ collectors: new Map([[REMOTE, COLLECTOR]]), fetch: fakeFetch, isMachineOnline: () => true });
  app.state.agents = [agent, remoteAgent];
  try {
    const list = await (await fetch(`${app.origin}/collector/agent-controls`, { headers: { "x-msc-token": TOKEN } })).json() as ControlList;
    assert.deepEqual(list.agents.map((entry) => entry.machine), [SELF]);
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test("redirect responses never forward collector credentials to another destination", async () => {
  let destinationCalls = 0;
  const destination = http.createServer((_req, res) => { destinationCalls++; res.end("{}"); });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(destination.address() as AddressInfo).port}`;
  const collector = http.createServer((_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const app = await fixture({ collectors: new Map([[REMOTE, `http://127.0.0.1:${(collector.address() as AddressInfo).port}`]]), isMachineOnline: () => true });
  app.state.agents = [remoteAgent];
  try {
    const response = await app.post("/api/agent-controls", stopBody(REMOTE));
    assert.equal(response.status, 502);
    assert.equal(((await response.json()) as { status: string }).status, "unknown");
    const list = await (await fetch(`${app.origin}/api/agent-controls`, { headers: { "x-msc-token": TOKEN } })).json() as ControlList;
    assert.equal(list.agents.find((entry) => entry.machine === REMOTE)?.stop.available, false);
    assert.equal((await fetch(`${app.origin}/api/agent-controls/${randomUUID()}?machine=${REMOTE}`, { headers: { "x-msc-token": TOKEN } })).status, 502);
    assert.equal(destinationCalls, 0);
  } finally {
    await app.close();
    for (const server of [collector, destination]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});
