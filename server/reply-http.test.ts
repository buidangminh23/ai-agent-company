import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { AgentInfo, MachineId } from "../shared/types.ts";
import type { ReplyList, ReplyReceipt, ReplySubmission } from "../shared/replies.ts";
import { createReplyHandler } from "./reply-http.ts";
import type { ReplyHttpOptions } from "./reply-http.ts";

const TOKEN = "test-access-token";
const SELF: MachineId = "WORKSTATION";
const REMOTE: MachineId = "LAPTOP";
const agent: AgentInfo = {
  id: "agent-1", app: "codex", machine: SELF, cwd: "C:\\work", sessionId: "session-1", title: "Test", project: "Test",
  state: "waiting", detail: "Waiting", role: null, parentId: null, updatedAt: "2026-10-30T12:00:00Z", pending: null,
};

function requestBody(machine: MachineId = SELF) {
  return { requestId: randomUUID(), questionId: "a".repeat(64), agentId: agent.id, answers: { question: ["Yes"] }, machine };
}

function receipt(body: ReplySubmission): ReplyReceipt {
  return { requestId: body.requestId, questionId: body.questionId, agentId: body.agentId, status: "answered", createdAt: "2026-10-30T12:00:00Z", updatedAt: "2026-10-30T12:00:00Z", detail: "Confirmed" };
}

async function fixture(overrides: Partial<ReplyHttpOptions> = {}) {
  const state = { sends: 0, reads: 0, localAgents: [agent], agents: [agent], receipts: new Map<string, ReplyReceipt>() };
  let handler!: ReturnType<typeof createReplyHandler>;
  const server = http.createServer((req, res) => { if (!handler(req, res)) res.writeHead(404).end(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const authority = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const origin = `http://${authority}`;
  handler = createReplyHandler({
    self: SELF, token: TOKEN, remoteToken: TOKEN, allowedHosts: [authority], collectors: new Map(),
    getAgents: () => state.agents,
    getLocalAgents: async () => { state.reads++; return state.localAgents; },
    broker: {
      list: async () => ({ generatedAt: "now", questions: [], unavailable: [] }),
      answer: async (value, agents) => {
        state.sends++;
        assert.deepEqual(agents, state.localAgents);
        const result = receipt(value as ReplySubmission);
        state.receipts.set(result.requestId, result);
        return result;
      },
      receipt: (id) => state.receipts.get(id) ?? null,
    },
    ...overrides,
  });
  return {
    state, origin,
    headers: { "content-type": "application/json", "x-msc-token": TOKEN, "x-msc-reply": "human-web", origin },
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test("browser routes require a configured nonempty token even over loopback", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.origin}/api/reply-questions`)).status, 401);
    assert.equal((await fetch(`${app.origin}/api/reply-questions`, { headers: { cookie: `msc_token=${TOKEN}` } })).status, 200);
    assert.equal((await fetch(`${app.origin}/api/reply-questions`, { headers: { cookie: "msc_token=%invalid" } })).status, 401);
    const rebound = await new Promise<number>((resolve, reject) => {
      http.get(`${app.origin}/api/reply-questions`, { headers: { "x-msc-token": TOKEN, host: "attacker.example" } }, (response) => { response.resume(); resolve(response.statusCode!); }).on("error", reject);
    });
    assert.equal(rebound, 403);
  } finally { await app.close(); }
  const disabled = await fixture({ token: "" });
  try { assert.equal((await fetch(`${disabled.origin}/api/reply-questions`, { headers: { "x-msc-token": TOKEN } })).status, 401); }
  finally { await disabled.close(); }
});

test("browser write accepts same-origin HTTP without fetch metadata and rereads agents", async () => {
  const app = await fixture();
  try {
    const body = requestBody();
    const response = await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as ReplyReceipt).requestId, body.requestId);
    assert.equal(app.state.reads, 1);
    assert.equal(app.state.sends, 1);
    const lookup = await fetch(`${app.origin}/api/replies/${body.requestId}?machine=${SELF}`, { headers: { "x-msc-token": TOKEN } });
    assert.equal((await lookup.json() as ReplyReceipt).status, "answered");
    assert.equal((await fetch(`${app.origin}/other`)).status, 404);
  } finally { await app.close(); }
});

test("browser write rejects cross-origin, missing origin, missing human header and foreign fetch site", async () => {
  const app = await fixture();
  try {
    const changes: Record<string, string>[] = [{ origin: "https://attacker.example" }, { origin: "" }, { "x-msc-reply": "" }, { "sec-fetch-site": "cross-site" }, { origin: `${app.origin}/path` }];
    for (const change of changes) {
      const response = await fetch(`${app.origin}/api/replies`, { method: "POST", headers: { ...app.headers, ...change }, body: JSON.stringify(requestBody()) });
      assert.equal(response.status, 403);
    }
    assert.equal(app.state.sends, 0);
  } finally { await app.close(); }
});

test("collector endpoints require header token and never accept browser cookie alone", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.origin}/collector/reply-questions`, { headers: { cookie: `msc_token=${TOKEN}` } })).status, 401);
    assert.equal((await fetch(`${app.origin}/collector/reply-questions`, { headers: { "x-msc-token": TOKEN } })).status, 200);
    const response = await fetch(`${app.origin}/collector/replies`, { method: "POST", headers: { "x-msc-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(requestBody()) });
    assert.equal(response.status, 200);
    assert.equal((await fetch(`${app.origin}/collector/replies`, { method: "POST", headers: { "x-msc-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(requestBody(REMOTE)) })).status, 409);
    assert.equal(app.state.sends, 1);
  } finally { await app.close(); }
});

test("unsupported media, oversized bodies, malformed JSON and methods cannot send", async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.origin}/api/replies`, { method: "POST", headers: { ...app.headers, "content-type": "text/plain" }, body: JSON.stringify(requestBody()) })).status, 415);
    assert.equal((await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: JSON.stringify({ ...requestBody(), extra: "x".repeat(33000) }) })).status, 413);
    assert.equal((await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: "{" })).status, 400);
    assert.equal((await fetch(`${app.origin}/api/replies`, { headers: { "x-msc-token": TOKEN } })).status, 405);
    assert.equal(app.state.sends, 0);
  } finally { await app.close(); }
});

test("remote forwarding uses only configured machine and validates agent binding", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json(receipt(JSON.parse(init!.body as string)));
  };
  const app = await fixture({ collectors: new Map([[REMOTE, "http://100.80.0.2:5190"]]), fetch: fakeFetch });
  app.state.agents = [{ ...agent, machine: REMOTE }];
  try {
    const body = requestBody(REMOTE);
    assert.equal((await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: JSON.stringify({ ...body, url: "http://attacker.example" }) })).status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://100.80.0.2:5190/collector/replies");
    assert.equal(calls[0].init?.redirect, "error");
    assert.equal((calls[0].init?.headers as Record<string, string>)["x-msc-token"], TOKEN);
    assert.equal((calls[0].init?.body as string).includes("attacker"), false);
    app.state.agents = [agent];
    assert.equal((await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: JSON.stringify(requestBody(REMOTE)) })).status, 409);
    assert.equal(calls.length, 1);
  } finally { await app.close(); }
});

test("incomplete incoming bodies time out and oversized chunked bodies are bounded", async () => {
  const app = await fixture({ timeoutMs: 30 });
  try {
    const post = (chunk: string) => new Promise<number>((resolve, reject) => {
      const req = http.request(`${app.origin}/api/replies`, { method: "POST", headers: app.headers }, (response) => { response.resume(); resolve(response.statusCode!); });
      req.on("error", reject);
      req.write(chunk);
    });
    assert.equal(await post("{"), 408);
    assert.equal(await post("x".repeat(33000)), 413);
    assert.equal(app.state.sends, 0);
  } finally { await app.close(); }
});

test("fresh-agent read timeout prevents local dispatch", async () => {
  let sends = 0;
  const app = await fixture({
    timeoutMs: 20,
    getLocalAgents: async () => await new Promise(() => {}),
    broker: { list: async () => ({ generatedAt: "now", questions: [], unavailable: [] }), answer: async (value) => { sends++; return receipt(value as ReplySubmission); }, receipt: () => null },
  });
  try {
    assert.equal((await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: JSON.stringify(requestBody()) })).status, 503);
    assert.equal(sends, 0);
  } finally { await app.close(); }
});

test("remote ambiguous delivery is unknown with requestId and never automatically retried", async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => { calls++; throw new Error("transport secret must not leak"); };
  const app = await fixture({ collectors: new Map([[REMOTE, "http://100.80.0.2:5190"]]), fetch: fakeFetch });
  app.state.agents = [{ ...agent, machine: REMOTE }];
  try {
    const body = requestBody(REMOTE);
    const response = await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: JSON.stringify(body) });
    assert.equal(response.status, 502);
    const result = await response.json() as { status: string; requestId: string };
    assert.equal(result.status, "unknown");
    assert.equal(result.requestId, body.requestId);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("remote lists ignore offline machines and reject foreign machine payloads and oversized responses", async () => {
  let calls = 0;
  let mode = "foreign";
  const fakeFetch: typeof fetch = async () => {
    calls++;
    const list: ReplyList = { generatedAt: "now", questions: [{ id: "a".repeat(64), kind: "question", title: "Câu hỏi", detail: "", agentId: agent.id, app: "codex", machine: SELF, threadId: "thread", nativeRequestId: "native", askedAt: "now", fields: [{ id: "field", text: "Question", options: ["Yes"], multiSelect: false, allowFreeText: false }] }], unavailable: [] };
    return mode === "large" ? new Response("x".repeat(513 * 1024)) : Response.json(list);
  };
  let online = false;
  const app = await fixture({ collectors: new Map([[REMOTE, "http://100.80.0.2:5190"]]), fetch: fakeFetch, isMachineOnline: () => online });
  app.state.agents = [{ ...agent, machine: REMOTE }];
  try {
    const read = async () => await (await fetch(`${app.origin}/api/reply-questions`, { headers: { "x-msc-token": TOKEN } })).json() as ReplyList;
    assert.equal((await read()).questions.length, 0);
    assert.equal(calls, 0);
    online = true;
    assert.equal((await read()).unavailable.length, 1);
    mode = "large";
    assert.equal((await read()).unavailable.length, 1);
    assert.equal(calls, 2);
  } finally { await app.close(); }
});

test("redirect responses never forward collector credentials to another destination", async () => {
  let destinationCalls = 0;
  const destination = http.createServer((_req, res) => { destinationCalls++; res.end("{}"); });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${(destination.address() as AddressInfo).port}`;
  const collector = http.createServer((_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  const app = await fixture({ collectors: new Map([[REMOTE, `http://127.0.0.1:${(collector.address() as AddressInfo).port}`]]) });
  app.state.agents = [{ ...agent, machine: REMOTE }];
  try {
    const response = await fetch(`${app.origin}/api/replies`, { method: "POST", headers: app.headers, body: JSON.stringify(requestBody(REMOTE)) });
    assert.equal(response.status, 502);
    assert.equal(destinationCalls, 0);
  } finally {
    await app.close();
    for (const server of [collector, destination]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("remote lists pass through kind, title, detail, labels and optional fields within limits", async (t) => {
  const valid = () => ({ id: "b".repeat(64), kind: "approval", title: "Claude xin chạy lệnh", detail: "npm test", agentId: agent.id, app: "codex", machine: REMOTE, threadId: "thread", nativeRequestId: "native", askedAt: "2026-11-02T00:00:00Z", extra: "drop", fields: [
    { id: "decision", text: "Quyết định", options: ["allow", "deny"], multiSelect: false, allowFreeText: false, labels: { deny: "Từ chối", allow: "Cho phép" }, secret: "drop" },
    { id: "feedback", text: "Ghi chú", options: [], multiSelect: false, allowFreeText: true, optional: true },
  ] });
  const cases: [string, (question: ReturnType<typeof valid>) => void, boolean][] = [
    ["valid", () => {}, true],
    ["kind", (question) => { question.kind = "permission"; }, false],
    ["empty title", (question) => { question.title = ""; }, false],
    ["long title", (question) => { question.title = "a".repeat(301); }, false],
    ["long detail", (question) => { question.detail = "a".repeat(8001); }, false],
    ["missing detail", (question) => { Object.assign(question, { detail: undefined }); }, false],
    ["label key", (question) => { Object.assign(question.fields[0], { labels: { maybe: "Có thể" } }); }, false],
    ["label length", (question) => { question.fields[0].labels!.allow = "a".repeat(201); }, false],
    ["optional type", (question) => { Object.assign(question.fields[1], { optional: "yes" }); }, false],
  ];
  for (const [name, mutate, accepted] of cases) await t.test(name, async () => {
    const question = valid();
    mutate(question);
    const fakeFetch: typeof fetch = async () => Response.json({ generatedAt: "now", questions: [question], unavailable: [] });
    const app = await fixture({ collectors: new Map([[REMOTE, "http://100.80.0.2:5190"]]), fetch: fakeFetch });
    app.state.agents = [{ ...agent, machine: REMOTE }];
    try {
      const list = await (await fetch(`${app.origin}/api/reply-questions`, { headers: { "x-msc-token": TOKEN } })).json() as ReplyList;
      assert.equal(list.questions.length, accepted ? 1 : 0);
      assert.equal(list.unavailable.length, accepted ? 0 : 1);
      if (accepted) {
        const [shown] = list.questions;
        assert.equal(shown.kind, "approval");
        assert.equal(shown.title, "Claude xin chạy lệnh");
        assert.equal(shown.detail, "npm test");
        assert.deepEqual(shown.fields[0], { id: "decision", text: "Quyết định", options: ["allow", "deny"], multiSelect: false, allowFreeText: false, labels: { allow: "Cho phép", deny: "Từ chối" } });
        assert.equal(shown.fields[1].optional, true);
        assert.equal(JSON.stringify(shown).includes("drop"), false);
      }
    } finally { await app.close(); }
  });
});
