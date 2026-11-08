import assert from "node:assert/strict";
import test from "node:test";
import { CommunicationsBoard, communicationMachines, communicationMessage } from "./communications-view.ts";
import type { AgentInfo, Snapshot } from "../shared/types.ts";

const NOW = "2026-11-02T08:00:00.000Z";
const agent = { id: "codex:mac:target", app: "codex", machine: "LAPTOP", title: "Build", project: "Company", state: "idle", parentId: null, updatedAt: NOW } as AgentInfo;
const snapshot = { generatedAt: NOW, agents: [agent], messages: [], machines: [{ id: "WORKSTATION", online: true, checkedAt: NOW }, { id: "LAPTOP", online: true, checkedAt: NOW }, { id: "SERVER", online: false, checkedAt: NOW }] } as unknown as Snapshot;

test("machine links follow machine order and a disconnected hub never claims online", () => {
  const connected = communicationMachines(snapshot, true);
  assert.ok(connected.indexOf("WORKSTATION") < connected.indexOf("LAPTOP"));
  assert.ok(connected.indexOf("LAPTOP") < connected.indexOf("SERVER"));
  assert.equal((connected.match(/data-online="true"/g) ?? []).length, 2);
  const disconnected = communicationMachines(snapshot, false);
  assert.equal((disconnected.match(/data-online="true"/g) ?? []).length, 0);
  assert.match(disconnected, /Chờ kết nối hub/);
});

test("unresolved messages are retained, escaped, and never presented as delivered", () => {
  const html = communicationMessage({ id: "m1", fromId: agent.id, toId: "", at: NOW, via: "agent-bridge", summary: "<script>alert(1)</script>", status: "accepted", targetLabel: '<img src="x">' }, snapshot);
  assert.match(html, /data-state="accepted"/);
  assert.doesNotMatch(html, /data-state="delivered"/);
  assert.match(html, /Chưa ghép được đúng phiên nhận/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script/);
  const human = communicationMessage({ id: "human", fromId: "human-web", toId: agent.id, at: NOW, via: "agent-bridge", summary: "Work", status: "delivered" }, snapshot);
  assert.match(human, /Sếp · Dashboard/);
  assert.doesNotMatch(human, /Phiên gửi không còn/);
});

test("live confirmed receipts survive delayed HTTP responses and clock skew", async () => {
  const originalFetch = globalThis.fetch;
  const receipt = { id: "live-receipt", targetAgentId: agent.id, targetMachine: agent.machine, summary: "Work", status: "accepted", at: NOW, updatedAt: NOW, detail: "Accepted", author: "human-web" };
  globalThis.fetch = async () => new Response(JSON.stringify({ generatedAt: NOW, targets: [], receipts: [receipt] }));
  try {
    const board = new CommunicationsBoard(() => {});
    await board.refresh();
    board.update({ ...snapshot, messages: [{ id: receipt.id, fromId: "human-web", toId: agent.id, targetMachine: agent.machine, summary: "Work", status: "replied", at: NOW, updatedAt: "2026-11-02T07:59:00.000Z", via: "agent-bridge", detail: "Verified reply" }] }, true);
    await board.refresh();
    assert.match(board.markup(), /data-state="replied"/);
    assert.doesNotMatch(board.markup(), /data-state="accepted"/);
    assert.match(board.markup(), /Verified reply/);
  } finally { globalThis.fetch = originalFetch; }
});

test("a failed POST stays uncertain and subsequent submissions cannot dispatch twice", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) } });
  let posts = 0;
  const payloads: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      posts++;
      payloads.push(JSON.parse(String(init.body)));
      throw new Error("Disconnected after dispatch");
    }
    return new Response(JSON.stringify({ generatedAt: NOW, targets: [{ agentId: agent.id, app: agent.app, machine: agent.machine, title: agent.title, project: agent.project, available: true, reason: "Ready" }], receipts: [] }), { status: 200 });
  };
  try {
    const board = new CommunicationsBoard(() => {});
    board.update(snapshot, true);
    await board.refresh();
    board.change({ dataset: { commTarget: "" }, value: `${agent.machine}:${agent.id}` } as unknown as HTMLSelectElement);
    board.input({ dataset: { commDraft: "" }, value: "A private work instruction", closest: () => null } as unknown as HTMLTextAreaElement);
    const form = { matches: () => true } as unknown as HTMLFormElement;
    board.submit(form);
    await new Promise((resolve) => setImmediate(resolve));
    board.submit(form);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(posts, 1);
    assert.equal(payloads[0].targetMachine, "LAPTOP");
    assert.equal(typeof payloads[0].requestId, "string");
    assert.match(board.markup(), /data-state="unknown"/);
    assert.match(board.markup(), /Kiểm tra biên nhận/);
    assert.doesNotMatch([...saved.values()].join(""), /A private work instruction/);
    const restored = new CommunicationsBoard(() => {});
    restored.update(snapshot, true);
    await restored.refresh();
    restored.submit(form);
    assert.equal(posts, 1);
    assert.match(restored.markup(), /data-state="unknown"/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("embedded communication shows four records and preserves composer and expansion state", () => {
  let changes = 0;
  const board = new CommunicationsBoard(() => { changes++; });
  const messages = Array.from({ length: 7 }, (_, index) => ({ id: `embedded-${index}`, fromId: agent.id, toId: agent.id, at: NOW, via: "agent-bridge" as const, summary: `Work ${index}`, status: "accepted" as const }));
  board.update({ ...snapshot, messages }, true);
  const click = (action: string) => board.click({ closest: () => ({ dataset: { commAction: action } }) } as unknown as Element);
  let html = board.markup(true);
  assert.doesNotMatch(html, /comm-intro|comm-machines|data-comm-form/);
  assert.equal((html.match(/<article class="comm-message"/g) ?? []).length, 4);
  assert.match(html, /Xem thêm 3 lượt/);
  assert.match(board.machineMarkup(), /comm-machines/);
  click("expand");
  assert.equal((board.markup(true).match(/<article class="comm-message"/g) ?? []).length, 7);
  assert.match(board.markup(true), /Thu gọn/);
  board.update({ ...snapshot, messages }, true);
  assert.equal((board.markup(true).match(/<article class="comm-message"/g) ?? []).length, 7);
  click("expand");
  assert.equal((board.markup(true).match(/<article class="comm-message"/g) ?? []).length, 4);
  board.openComposer();
  assert.match(board.markup(true), /data-comm-form/);
  board.input({ dataset: { commDraft: "" }, value: "Preserved instruction", closest: () => null } as unknown as HTMLTextAreaElement);
  click("compose");
  assert.doesNotMatch(board.markup(true), /data-comm-form/);
  click("compose");
  assert.match(board.markup(true), /Preserved instruction/);
  assert.ok(changes >= 5);
  assert.equal((board.markup().match(/<article class="comm-message"/g) ?? []).length, 7);
});

test("replay blocks programmatic dispatch and isolates historical messages from live receipts", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ generatedAt: NOW, targets: [{ agentId: agent.id, app: agent.app, machine: agent.machine, title: agent.title, project: agent.project, available: true, reason: "Ready" }], receipts: [{ id: "live-only", targetAgentId: agent.id, targetMachine: agent.machine, summary: "Current receipt", status: "accepted", at: NOW, updatedAt: NOW, detail: "Accepted", author: "human-web" }] });
  };
  try {
    const board = new CommunicationsBoard(() => {});
    board.update(snapshot, true);
    await board.refresh();
    board.change({ dataset: { commTarget: "" }, value: `${agent.machine}:${agent.id}` } as unknown as HTMLSelectElement);
    board.input({ dataset: { commDraft: "" }, value: "Do not send during replay", closest: () => null } as unknown as HTMLTextAreaElement);
    board.update(snapshot, true, true);
    board.openComposer();
    board.submit({ matches: () => true } as unknown as HTMLFormElement);
    await board.refresh();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1);
    const html = board.markup(true);
    assert.match(html, /Đang xem lại lịch sử; trở về Trực tiếp/);
    assert.match(html, /type="submit" class="ops-primary" disabled/);
    assert.doesNotMatch(html, /Current receipt/);
    board.update(snapshot, true);
    assert.match(board.markup(true), /Current receipt/);
    assert.match(board.markup(true), /type="submit" class="ops-primary" >/);
  } finally { globalThis.fetch = originalFetch; }
});
