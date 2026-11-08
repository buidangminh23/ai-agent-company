import assert from "node:assert/strict";
import test from "node:test";
import { AgentControls } from "./agent-controls.ts";
import type { AgentInfo } from "../shared/types.ts";
import type { AgentControlState, ControlList } from "../shared/controls.ts";

const NOW = "2026-11-02T08:00:00.000Z";
const agent = { id: "codex:mac:thread", app: "codex", machine: "LAPTOP", title: "Build", project: "Company", state: "working", parentId: null, updatedAt: NOW, pending: null } as unknown as AgentInfo;
const KEY = `${agent.machine}|${agent.id}`;
const state: AgentControlState = { agentId: agent.id, app: "codex", machine: "LAPTOP", approvals: { available: true, reason: "" }, questions: { available: true, reason: "" }, send: { available: false, reason: "Đang có lượt <chạy>." }, stop: { available: true, reason: "", warning: "Dừng lượt sẽ tự từ chối <mọi> yêu cầu đang chờ." }, settings: { available: true, reason: "", model: "gpt-a", effort: "high", models: [{ id: "gpt-a", label: "GPT A", efforts: ["low", "high"] }, { id: "gpt-b", label: "GPT <B>", efforts: ["medium", "xhigh"] }] } };
const controlList = (agents: AgentControlState[]): ControlList => ({ generatedAt: NOW, agents });

function target(dataset: Record<string, string>): Element {
  return { dataset, closest(selector: string) { const name = selector.slice(6, -1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()); return name in dataset ? this : null; } } as unknown as Element;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function harness(list: ControlList, post: (body: Record<string, unknown>, saved: Map<string, string>) => Response | Promise<Response>, run: (controls: AgentControls, posts: Record<string, unknown>[], saved: Map<string, string>) => Promise<void>, storageFails = false, options: { seed?: unknown[]; lookup?: (url: string) => Response } = {}): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map<string, string>();
  if (options.seed) saved.set("msc-control-receipts", JSON.stringify(options.seed));
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { if (storageFails) throw new Error("quota"); saved.set(key, value); } } });
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    if (init?.method === "POST") {
      assert.equal(String(input), "/api/agent-controls");
      assert.equal((init.headers as Record<string, string>)["x-msc-control"], "human-web");
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return post(body, saved);
    }
    if (options.lookup && String(input).startsWith("/api/agent-controls/")) return options.lookup(String(input));
    return new Response(JSON.stringify(list));
  };
  try {
    const controls = new AgentControls(() => {});
    await controls.refresh();
    await run(controls, posts, saved);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

const accept = (body: Record<string, unknown>) => new Response(JSON.stringify({ requestId: body.requestId, agentId: body.agentId, action: body.action, status: "done", createdAt: NOW, updatedAt: NOW, detail: "Đã dừng lượt." }));

test("stop requires a warning confirmation step and sends one stop POST after the receipt is saved", async () => {
  let savedBeforePost = "";
  await harness(controlList([state]), (body, saved) => { savedBeforePost = saved.get("msc-control-receipts") ?? ""; return accept(body); }, async (controls, posts, saved) => {
    const initial = controls.markup(agent, true);
    assert.match(initial, />Dừng lượt</);
    assert.doesNotMatch(initial, /Xác nhận dừng/);
    controls.click(target({ controlStop: KEY }), true);
    await settle();
    assert.equal(posts.length, 0);
    const confirming = controls.markup(agent, true);
    assert.match(confirming, /Dừng lượt sẽ tự từ chối &lt;mọi&gt; yêu cầu đang chờ\./);
    assert.match(confirming, /Xác nhận dừng/);
    assert.match(confirming, />Huỷ</);
    controls.click(target({ controlStopCancel: KEY }), true);
    assert.doesNotMatch(controls.markup(agent, true), /Xác nhận dừng/);
    controls.click(target({ controlStopConfirm: KEY }), true);
    await settle();
    assert.equal(posts.length, 0);
    controls.click(target({ controlStop: KEY }), true);
    controls.click(target({ controlStopConfirm: KEY }), true);
    controls.click(target({ controlStopConfirm: KEY }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual({ ...posts[0], requestId: "" }, { requestId: "", agentId: agent.id, machine: agent.machine, action: "stop" });
    assert.match(String(posts[0].requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(savedBeforePost, new RegExp(`"requestId":"${posts[0].requestId}".*"status":"pending"`));
    assert.match(saved.get("msc-control-receipts") ?? "", /"status":"done"/);
    assert.match(controls.markup(agent, true), /Đã áp dụng/);
  });
});

test("settings filter efforts by the chosen model and send the selected pair", async () => {
  await harness(controlList([state]), accept, async (controls, posts) => {
    const html = controls.markup(agent, true);
    assert.match(html, /Hiện tại: <strong>GPT A · high<\/strong>/);
    assert.match(html, /<option value="high" selected>high<\/option>/);
    assert.match(html, /GPT &lt;B&gt;/);
    controls.click(target({ controlApply: KEY }), true);
    await settle();
    assert.equal(posts.length, 0);
    assert.match(controls.markup(agent, true), /chưa gửi gì/);
    assert.equal(controls.input({ dataset: { controlModel: KEY }, value: "gpt-b" } as unknown as HTMLSelectElement), true);
    const filtered = controls.markup(agent, true);
    assert.match(filtered, /<option value="medium" selected>medium<\/option><option value="xhigh" >xhigh<\/option><\/select>/);
    assert.doesNotMatch(filtered, /value="low"/);
    controls.change({ dataset: { controlEffort: KEY }, value: "xhigh" } as unknown as HTMLSelectElement);
    controls.click(target({ controlApply: KEY }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].settings, { model: "gpt-b", effort: "xhigh" });
    assert.equal(posts[0].action, "settings");
  });
});

test("unavailable capabilities list their reasons and failed POSTs stay unknown", async () => {
  await harness(controlList([{ ...state, stop: { available: false, reason: "Không có lượt đang chạy.", warning: "" }, settings: { ...state.settings, available: false, reason: "Chưa đọc được model." } }]), () => { throw new Error("Disconnected after dispatch"); }, async (controls) => {
    const html = controls.markup(agent, true);
    assert.doesNotMatch(html, /data-control-stop=/);
    assert.doesNotMatch(html, /data-control-apply=/);
    assert.match(html, /Gửi lệnh mới:<\/b> Đang có lượt &lt;chạy&gt;\./);
    assert.match(html, /Dừng lượt:<\/b> Không có lượt đang chạy\./);
    assert.match(html, /Chưa đọc được model\./);
  });
  await harness(controlList([state]), () => { throw new Error("Disconnected after dispatch"); }, async (controls, posts, saved) => {
    controls.click(target({ controlStop: KEY }), true);
    controls.click(target({ controlStopConfirm: KEY }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.match(saved.get("msc-control-receipts") ?? "", /"status":"unknown"/);
    assert.match(controls.markup(agent, true), /Chưa xác nhận[\s\S]*Kiểm tra biên nhận/);
  });
});

test("replay mode renders nothing and never posts; storage failure blocks dispatch", async () => {
  await harness(controlList([state]), accept, async (controls, posts) => {
    assert.equal(controls.markup(agent, false), "");
    controls.click(target({ controlStop: KEY }), false);
    controls.click(target({ controlStopConfirm: KEY }), false);
    controls.click(target({ controlApply: KEY }), false);
    await settle();
    assert.equal(posts.length, 0);
    assert.equal(controls.click(target({ other: "x" }), true), false);
  });
  await harness(controlList([state]), accept, async (controls, posts) => {
    controls.click(target({ controlStop: KEY }), true);
    controls.click(target({ controlStopConfirm: KEY }), true);
    await settle();
    assert.equal(posts.length, 0);
    assert.match(controls.markup(agent, true), /Không lưu được biên nhận/);
  }, true);
});

const STALE = "Không tìm thấy biên nhận trên máy đích; kiểm tra trong ứng dụng gốc trước khi thao tác lại";
const pendingReceipt = (requestId: string, ageMs: number | null) => ({ requestId, agentId: agent.id, machine: agent.machine, action: "stop", status: "pending", detail: "Đang gửi lệnh dừng.", ...(ageMs === null ? {} : { createdAt: new Date(Date.now() - ageMs).toISOString() }) });
const OLD_ID = "11111111-1111-4111-8111-111111111111";
const LEGACY_ID = "22222222-2222-4222-8222-222222222222";
const RECENT_ID = "33333333-3333-4333-8333-333333333333";

test("a pending receipt older than 90 s that the server never stored turns unknown and stops blocking", async () => {
  const lookups: string[] = [];
  await harness(controlList([state]), accept, async (controls, posts, saved) => {
    await settle();
    assert.deepEqual(lookups.sort(), [LEGACY_ID, OLD_ID].map((id) => `/api/agent-controls/${id}?machine=${agent.machine}`).sort());
    const stored = JSON.parse(saved.get("msc-control-receipts") ?? "[]") as { requestId: string; status: string; detail: string; createdAt: string }[];
    for (const id of [OLD_ID, LEGACY_ID]) {
      const row = stored.find((item) => item.requestId === id)!;
      assert.equal(row.status, "unknown");
      assert.equal(row.detail, STALE);
      assert.ok(Number.isFinite(Date.parse(row.createdAt)));
    }
    const html = controls.markup(agent, true);
    assert.match(html, /Chưa xác nhận/);
    assert.doesNotMatch(html, /Đang dừng…/);
    assert.match(html, /data-control-stop="[^"]+" data-key="[^"]+" >Dừng lượt</);
    controls.click(target({ controlStop: KEY }), true);
    controls.click(target({ controlStopConfirm: KEY }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
  }, false, { seed: [pendingReceipt(OLD_ID, 120_000), pendingReceipt(LEGACY_ID, null)], lookup: (url) => { lookups.push(url); return new Response("null"); } });
});

test("a recent, server-held or unverifiable pending receipt keeps blocking", async () => {
  await harness(controlList([state]), accept, async (controls, posts) => {
    await settle();
    assert.match(controls.markup(agent, true), /Đang dừng…/);
    controls.click(target({ controlStop: KEY }), true);
    controls.click(target({ controlStopConfirm: KEY }), true);
    await settle();
    assert.equal(posts.length, 0);
  }, false, { seed: [pendingReceipt(RECENT_ID, 10_000)], lookup: () => new Response("null") });
  await harness(controlList([state]), accept, async (controls) => {
    await settle();
    assert.match(controls.markup(agent, true), /Đang dừng…/);
    controls.click(target({ controlReceipt: OLD_ID }), true);
    await settle();
    assert.match(controls.markup(agent, true), /Đang dừng…/);
  }, false, { seed: [pendingReceipt(OLD_ID, 120_000)], lookup: () => new Response(JSON.stringify({ requestId: OLD_ID, agentId: agent.id, action: "stop", status: "pending", createdAt: NOW, updatedAt: NOW, detail: "Máy đích đang dừng lượt." })) });
  await harness(controlList([state]), accept, async (controls) => {
    await settle();
    const html = controls.markup(agent, true);
    assert.match(html, /Đang dừng…/);
    assert.doesNotMatch(html, new RegExp(STALE));
  }, false, { seed: [pendingReceipt(OLD_ID, 120_000)], lookup: () => new Response("{}", { status: 503 }) });
});
