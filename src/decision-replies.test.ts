import assert from "node:assert/strict";
import test from "node:test";
import { decisionKey, DecisionReplies } from "./decision-replies.ts";
import type { AgentInfo } from "../shared/types.ts";
import type { DispatchTarget } from "../shared/dispatch.ts";

const NOW = "2026-11-05T08:00:00.000Z";
const agent = { id: "claude:SERVER:841", app: "claude", machine: "SERVER", title: "Hàng chờ", project: "Demo", state: "idle", parentId: null, updatedAt: NOW, pending: { question: "Dàn hàng chờ hết bề ngang?", options: ["Có, sửa luôn", "<b>Để vậy đã</b>"], askedAt: NOW, kind: "decision" } } as unknown as AgentInfo;
const key = decisionKey(agent);
const target = (available: boolean, reason = "Đã xác minh"): DispatchTarget => ({ agentId: agent.id, app: "claude", machine: agent.machine, title: "x", project: "y", available, reason });

function button(dataset: Record<string, string>): Element {
  return { dataset, closest(selector: string) { const name = selector.slice(6, -1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()); return name in dataset ? this : null; } } as unknown as Element;
}

async function harness(targets: DispatchTarget[], post: (body: Record<string, unknown>) => Response, run: (replies: DecisionReplies, posts: Record<string, unknown>[], saved: Map<string, string>) => Promise<void>): Promise<void> {
  const originalFetch = globalThis.fetch;
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const clipboard = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const saved = new Map<string, string>();
  const posts: Record<string, unknown>[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (name: string) => saved.get(name) ?? null, setItem: (name: string, value: string) => { saved.set(name, value); } } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  globalThis.fetch = async (_input, init) => {
    if (init?.method !== "POST") return new Response(JSON.stringify({ generatedAt: NOW, targets, receipts: [] }));
    assert.equal((init.headers as Record<string, string>)["x-msc-communication"], "human-web");
    const body = JSON.parse(String(init.body));
    posts.push(body);
    return post(body);
  };
  try {
    const replies = new DecisionReplies(() => {});
    await replies.refresh();
    await run(replies, posts, saved);
  } finally {
    globalThis.fetch = originalFetch;
    if (storage) Object.defineProperty(globalThis, "localStorage", storage); else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (clipboard) Object.defineProperty(globalThis, "navigator", clipboard);
    delete (globalThis as { isSecureContext?: unknown }).isSecureContext;
    delete (globalThis as { window?: unknown }).window;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const receipt = (body: Record<string, unknown>, status = "delivered") => new Response(JSON.stringify({ id: body.requestId, status, targetAgentId: agent.id, targetMachine: agent.machine, summary: "", at: NOW, updatedAt: NOW, detail: "Claude xác nhận nhận tin nhắn", author: "human-web" }));

test("a decision renders primary and secondary buttons with escaped labels", async () => {
  await harness([target(true)], receipt, async (replies) => {
    const html = replies.markup(agent, true);
    assert.match(html, /data-tone="primary"[^>]*data-decide-index="0"[^>]*>Có, sửa luôn</);
    assert.match(html, /data-tone="neutral"[^>]*data-decide-index="1"[^>]*>&lt;b&gt;Để vậy đã&lt;\/b&gt;</);
    assert.match(html, /Gửi thành tin nhắn vào đúng chat\. Claude nhận như tin từ phiên khác, không tính là sếp duyệt/);
    assert.doesNotMatch(html, /danh nghĩa của sếp/);
    assert.match(html, /data-decide-custom="[^"]+"[^>]*>Gửi tin nhắn</);
    assert.doesNotMatch(html, /Mở chat gốc/);
    assert.match(replies.markup(agent, true, "codex://threads/abc"), /<a class="cq-btn" href="codex:\/\/threads\/abc"[^>]*>Mở chat gốc</);
  });
});

test("clicking an option sends that label once to the right session and shows the receipt", async () => {
  await harness([target(true)], receipt, async (replies, posts) => {
    replies.markup(agent, true);
    const click = button({ decide: key, decideIndex: "0" });
    assert.equal(replies.click(click, true), true);
    replies.click(click, true);
    await settle(); await settle();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].message, "Có, sửa luôn");
    assert.equal(posts[0].targetAgentId, agent.id);
    assert.equal(posts[0].targetMachine, agent.machine);
    const html = replies.markup(agent, true);
    assert.match(html, /Đã tới chat: “Có, sửa luôn”/);
    assert.match(html, /không tính là sếp duyệt/);
    assert.doesNotMatch(html, /data-decide="/);
  });
});

test("an unavailable channel copies instead of sending and states the real reason", async () => {
  await harness([target(false, "Claude chưa cho phép nhận tin từ kênh bên ngoài")], receipt, async (replies, posts) => {
    const html = replies.markup(agent, true);
    assert.match(html, /Claude chưa cho phép nhận tin từ kênh bên ngoài\. Bấm để chép rồi dán vào Claude trên SERVER\./);
    replies.click(button({ decide: key, decideIndex: "0" }), true);
    await settle(); await settle();
    assert.equal(posts.length, 0);
    assert.match(replies.markup(agent, true), /Đã chép “Có, sửa luôn”/);
  });
});

test("a rejected send can be tried again; an uncertain send cannot", async () => {
  let reply: (body: Record<string, unknown>) => Response = () => new Response(JSON.stringify({ error: "Máy đích từ chối" }), { status: 409 });
  await harness([target(true)], (body) => reply(body), async (replies, posts) => {
    replies.markup(agent, true);
    const click = button({ decide: key, decideIndex: "0" });
    replies.click(click, true);
    await settle(); await settle();
    assert.match(replies.markup(agent, true), /Máy đích từ chối/);
    reply = () => new Response("not json", { status: 502 });
    replies.click(click, true);
    await settle(); await settle();
    assert.equal(posts.length, 2);
    assert.match(replies.markup(agent, true), /Chưa xác nhận được/);
    replies.click(click, true);
    await settle(); await settle();
    assert.equal(posts.length, 2);
  });
});

test("a question waiting in a session without the hook never goes through the send channel", async () => {
  const waiting = { ...agent, state: "waiting", pending: { ...agent.pending!, kind: "question" } } as AgentInfo;
  await harness([target(true)], receipt, async (replies, posts) => {
    assert.match(replies.markup(waiting, true), /chưa nối kênh trả lời trực tiếp/);
    replies.click(button({ decide: decisionKey(waiting), decideIndex: "0" }), true);
    await settle(); await settle();
    assert.equal(posts.length, 0);
  });
});

async function earlyClick(listed: DispatchTarget[], run: (replies: DecisionReplies, posts: Record<string, unknown>[], clipboard: string[], release: () => void) => Promise<void>): Promise<void> {
  const clipboard: string[] = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const posts: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const browser = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (value: string) => { clipboard.push(value); } } } });
  Object.defineProperty(globalThis, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      return receipt(body);
    }
    await held;
    return new Response(JSON.stringify({ generatedAt: NOW, targets: listed, receipts: [] }));
  };
  try {
    await run(new DecisionReplies(() => {}), posts, clipboard, release);
  } finally {
    globalThis.fetch = originalFetch;
    if (storage) Object.defineProperty(globalThis, "localStorage", storage); else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (browser) Object.defineProperty(globalThis, "navigator", browser);
    delete (globalThis as { isSecureContext?: unknown }).isSecureContext;
    delete (globalThis as { window?: unknown }).window;
  }
}

test("a click while the channel is still being checked waits, then sends once without copying", async () => {
  await earlyClick([target(true)], async (replies, posts, clipboard, release) => {
    const html = replies.markup(agent, true);
    assert.match(html, /Đang kiểm tra kênh gửi/);
    assert.doesNotMatch(html, /Bấm để chép/);
    assert.match(html, /data-decide-custom="[^"]+"[^>]*>Gửi tin nhắn</);
    const click = button({ decide: key, decideIndex: "0" });
    replies.click(click, true);
    replies.click(click, true);
    await settle();
    assert.equal(posts.length, 0);
    assert.match(replies.markup(agent, true), /Đang kiểm tra kênh gửi cho “Có, sửa luôn”/);
    release();
    await settle(); await settle(); await settle(); await settle();
    assert.equal(posts.length, 1);
    assert.equal(posts[0].message, "Có, sửa luôn");
    assert.deepEqual(clipboard, []);
  });
});

test("a click while checking ends on the real reason when the channel turns out closed, and copies nothing", async () => {
  await earlyClick([target(false, "Claude chưa cho phép nhận tin từ kênh bên ngoài")], async (replies, posts, clipboard, release) => {
    replies.markup(agent, true);
    replies.click(button({ decide: key, decideIndex: "0" }), true);
    release();
    await settle(); await settle(); await settle(); await settle();
    assert.equal(posts.length, 0);
    assert.deepEqual(clipboard, []);
    const html = replies.markup(agent, true);
    assert.match(html, /Claude chưa cho phép nhận tin từ kênh bên ngoài/);
    assert.match(html, /data-decide-custom="[^"]+"[^>]*>Chép</);
  });
});

test("replay mode and an empty free-text answer never send", async () => {
  await harness([target(true)], receipt, async (replies, posts) => {
    replies.markup(agent, true);
    replies.click(button({ decide: key, decideIndex: "0" }), false);
    replies.click(button({ decideCustom: key }), true);
    await settle();
    assert.equal(posts.length, 0);
    assert.match(replies.markup(agent, true), /Nhập câu trả lời trước đã/);
  });
});
