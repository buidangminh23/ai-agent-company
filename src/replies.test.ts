import assert from "node:assert/strict";
import test from "node:test";
import { pressOptionKey, ReplyControls } from "./replies.ts";
import type { AgentInfo } from "../shared/types.ts";
import type { ReplyList, ReplyQuestion } from "../shared/replies.ts";

const NOW = "2026-11-02T08:00:00.000Z";
const claude = { id: "claude:mac:session", app: "claude", machine: "LAPTOP", title: "Build", project: "Company", state: "waiting", parentId: null, updatedAt: NOW, pending: { askedAt: NOW, text: "?" } } as unknown as AgentInfo;
const codex = { ...claude, id: "codex:mac:thread", app: "codex" } as unknown as AgentInfo;
const approval: ReplyQuestion = { id: "a".repeat(64), kind: "approval", title: "Bash <rm>", detail: "rm -rf <script>alert(1)</script>", agentId: claude.id, app: "claude", machine: "LAPTOP", threadId: "s", nativeRequestId: "n1", askedAt: NOW, fields: [{ id: "decision", text: "Quyết định", options: ["allow", "allow-always", "deny", "deny-stop"], multiSelect: false, allowFreeText: false, labels: { allow: "Cho phép", "allow-always": "Luôn cho phép (theo gợi ý của Claude)", deny: "Từ chối", "deny-stop": "Từ chối và dừng lượt" } }, { id: "feedback", text: "Góp ý", options: [], multiSelect: false, allowFreeText: true, optional: true }] };
const plan: ReplyQuestion = { ...approval, id: "b".repeat(64), kind: "plan", title: "Kế hoạch", detail: "## Bước\n- Sửa <b>file</b>", nativeRequestId: "n2", fields: [{ id: "decision", text: "Quyết định", options: ["revise"], multiSelect: false, allowFreeText: false, labels: { revise: "Yêu cầu sửa kế hoạch" } }, approval.fields[1]] };
const question: ReplyQuestion = { ...approval, id: "c".repeat(64), kind: "question", title: "Chọn màu", detail: "", agentId: codex.id, app: "codex", nativeRequestId: "n3", fields: [{ id: "color", text: "Màu nào?", options: ["red", "blue"], multiSelect: false, allowFreeText: false, labels: { red: "Đỏ <đậm>", blue: "Xanh" } }] };

function target(dataset: Record<string, string>): Element {
  return { dataset, closest(selector: string) { const name = selector.slice(6, -1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()); return name in dataset ? this : null; } } as unknown as Element;
}

async function harness(list: ReplyList, post: (body: Record<string, unknown>, saved: Map<string, string>) => Response | Promise<Response>, run: (controls: ReplyControls, posts: Record<string, unknown>[], saved: Map<string, string>) => Promise<void>, storageFails = false): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { if (storageFails) throw new Error("quota"); saved.set(key, value); } } });
  const posts: Record<string, unknown>[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      assert.equal((init.headers as Record<string, string>)["x-msc-reply"], "human-web");
      posts.push(body);
      return post(body, saved);
    }
    return new Response(JSON.stringify(list));
  };
  try {
    const controls = new ReplyControls(() => {});
    await controls.refresh();
    await run(controls, posts, saved);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const list = (questions: ReplyQuestion[], unavailable: ReplyList["unavailable"] = []): ReplyList => ({ generatedAt: NOW, questions, unavailable });

test("approval, plan and question cards render by kind with labels and escaping", async () => {
  await harness(list([approval, plan, question]), () => new Response("{}"), async (controls) => {
    const html = controls.markup(claude, true);
    assert.match(html, /data-kind="approval"/);
    assert.match(html, /<pre class="ops-reply-detail"[^>]*>rm -rf &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/pre>/);
    assert.match(html, /Bash &lt;rm&gt;/);
    assert.doesNotMatch(html, /<script|<rm>/);
    assert.match(html, /data-reply-value="deny-stop" data-tone="stop"[^>]*>Từ chối và dừng lượt</);
    assert.match(html, /data-reply-value="deny" data-tone="deny"/);
    assert.match(html, /data-reply-value="allow" data-tone="primary"[^>]*>Cho phép</);
    assert.match(html, /Lý do \/ góp ý cho agent \(không bắt buộc\)/);
    assert.match(html, /<small>Claude · LAPTOP<\/small>/);
    assert.match(html, /Ai trả lời trước \(web hoặc app\) sẽ được áp dụng/);
    assert.match(html, /data-kind="plan"/);
    assert.match(html, /<h4>Bước<\/h4><ul><li>Sửa &lt;b&gt;file&lt;\/b&gt;<\/li><\/ul>/);
    assert.match(html, />Yêu cầu sửa kế hoạch</);
    assert.match(html, /Duyệt kế hoạch thực hiện trong ứng dụng Claude; Claude không cho hook tự duyệt kế hoạch\./);
    const codexHtml = controls.markup(codex, true);
    assert.match(codexHtml, /data-kind="question"/);
    assert.match(codexHtml, /Chọn màu/);
    assert.match(codexHtml, /value="red"[^>]*>.*?<span class="cq-label">Đỏ &lt;đậm&gt;</);
    assert.match(codexHtml, /Codex · LAPTOP/);
    assert.equal(controls.markup(claude, false), "");
  });
});

test("an agent without a verified question shows the broker reason, never a hard-coded Claude note", async () => {
  await harness(list([], [{ agentId: claude.id, app: "claude", machine: "LAPTOP", reason: "Chưa cài hook <Claude>." }]), () => new Response("{}"), async (controls) => {
    controls.markup(claude, true);
    await settle(); await settle();
    const html = controls.markup(claude, true);
    assert.match(html, /Chưa cài hook &lt;Claude&gt;\./);
    assert.doesNotMatch(html, /chưa hỗ trợ/);
  });
});

test("a decision button sends exactly one POST and omits empty optional feedback", async () => {
  await harness(list([approval]), (body) => new Response(JSON.stringify({ requestId: body.requestId, questionId: approval.id, agentId: claude.id, status: "answered", createdAt: NOW, updatedAt: NOW, detail: "Đã áp dụng" })), async (controls, posts, saved) => {
    controls.click(target({ replyDecision: approval.id, replyValue: "deny" }), true);
    controls.click(target({ replyDecision: approval.id, replyValue: "allow" }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].answers, { decision: ["deny"] });
    assert.equal(posts[0].questionId, approval.id);
    assert.match(String(posts[0].requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(saved.get("msc-reply-receipts") ?? "", /"status":"answered"/);
    assert.match(controls.markup(claude, true), /Đã gửi quyết định/);
  });
});

test("feedback text is sent with the decision and an unknown value is never sent", async () => {
  await harness(list([plan]), (body) => new Response(JSON.stringify({ requestId: body.requestId, questionId: plan.id, agentId: claude.id, status: "answered", createdAt: NOW, updatedAt: NOW, detail: "ok" })), async (controls, posts) => {
    controls.click(target({ replyDecision: plan.id, replyValue: "approve" }), true);
    await settle();
    assert.equal(posts.length, 0);
    controls.input({ dataset: { replyText: `${plan.id}:feedback` }, value: "Thêm bước kiểm thử", closest: () => null } as unknown as HTMLTextAreaElement);
    controls.click(target({ replyDecision: plan.id, replyValue: "revise" }), false);
    await settle();
    assert.equal(posts.length, 0);
    controls.click(target({ replyDecision: plan.id, replyValue: "revise" }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].answers, { decision: ["revise"], feedback: ["Thêm bước kiểm thử"] });
  });
});

test("a failed POST stays unknown, keeps the receipt saved before dispatch, and cannot resend", async () => {
  let savedBeforePost = "";
  await harness(list([approval]), (_body, saved) => { savedBeforePost = saved.get("msc-reply-receipts") ?? ""; throw new Error("Disconnected after dispatch"); }, async (controls, posts, saved) => {
    controls.click(target({ replyDecision: approval.id, replyValue: "allow" }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.match(savedBeforePost, /"status":"pending"/);
    assert.match(saved.get("msc-reply-receipts") ?? "", /"status":"unknown"/);
    const html = controls.markup(claude, true);
    assert.match(html, /Đang xác minh kết quả/);
    assert.match(html, /Kiểm tra biên nhận/);
    assert.doesNotMatch(html, /data-reply-decision=/);
    controls.click(target({ replyDecision: approval.id, replyValue: "allow" }), true);
    await settle();
    const restored = new ReplyControls(() => {});
    await restored.refresh();
    restored.click(target({ replyDecision: approval.id, replyValue: "deny" }), true);
    await settle();
    assert.equal(posts.length, 1);
  });
});

test("receipt storage failure blocks the POST entirely", async () => {
  await harness(list([approval]), () => new Response("{}"), async (controls, posts) => {
    controls.click(target({ replyDecision: approval.id, replyValue: "allow" }), true);
    await settle();
    assert.equal(posts.length, 0);
    assert.match(controls.markup(claude, true), /Không lưu được biên nhận/);
  }, true);
});

const codexApproval: ReplyQuestion = { ...approval, id: "d".repeat(64), app: "codex", agentId: codex.id, nativeRequestId: "n4", fields: [{ id: "decision", text: "Quyết định", options: ["accept", "decline", "cancel"], multiSelect: false, allowFreeText: false, labels: { accept: "Cho phép", decline: "Từ chối", cancel: "Từ chối và dừng lượt" } }] };
const answered = (questionId: string) => (body: Record<string, unknown>) => new Response(JSON.stringify({ requestId: body.requestId, questionId, agentId: body.agentId, status: "answered", createdAt: NOW, updatedAt: NOW, detail: "ok" }));

test("Codex cancel needs a confirmation inside the card before anything is sent", async () => {
  await harness(list([codexApproval]), answered(codexApproval.id), async (controls, posts) => {
    controls.click(target({ replyConfirm: codexApproval.id, replyValue: "cancel" }), true);
    controls.click(target({ replyDecision: codexApproval.id, replyValue: "cancel" }), true);
    await settle();
    assert.equal(posts.length, 0);
    const confirming = controls.markup(codex, true);
    assert.match(confirming, /Từ chối và dừng lượt: Codex Desktop tự từ chối mọi yêu cầu duyệt và gửi câu trả lời trống cho mọi câu hỏi khác đang chờ trong chat này\./);
    assert.match(confirming, /data-reply-confirm="d{64}" data-reply-value="cancel"[^>]*>Xác nhận</);
    assert.match(confirming, /data-reply-cancel="d{64}"[^>]*>Huỷ</);
    assert.doesNotMatch(confirming, /data-reply-decision=/);
    controls.click(target({ replyCancel: codexApproval.id }), true);
    assert.match(controls.markup(codex, true), /data-reply-value="cancel" data-tone="stop"/);
    controls.click(target({ replyConfirm: codexApproval.id, replyValue: "cancel" }), true);
    await settle();
    assert.equal(posts.length, 0);
    controls.click(target({ replyDecision: codexApproval.id, replyValue: "cancel" }), true);
    controls.click(target({ replyConfirm: codexApproval.id, replyValue: "decline" }), true);
    await settle();
    assert.equal(posts.length, 0);
    controls.click(target({ replyConfirm: codexApproval.id, replyValue: "cancel" }), false);
    await settle();
    assert.equal(posts.length, 0);
    controls.click(target({ replyConfirm: codexApproval.id, replyValue: "cancel" }), true);
    controls.click(target({ replyConfirm: codexApproval.id, replyValue: "cancel" }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].answers, { decision: ["cancel"] });
  });
});

test("Claude deny-stop shows its own warning and other decisions still send on one click", async () => {
  await harness(list([approval, codexApproval]), (body) => answered(String(body.questionId))(body), async (controls, posts) => {
    controls.click(target({ replyDecision: approval.id, replyValue: "deny-stop" }), true);
    await settle();
    assert.equal(posts.length, 0);
    const html = controls.markup(claude, true);
    assert.match(html, /Từ chối và dừng lượt: Claude dừng ngay lượt đang chạy\./);
    assert.doesNotMatch(html, /Codex Desktop tự từ chối/);
    controls.click(target({ replyDecision: codexApproval.id, replyValue: "decline" }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].answers, { decision: ["decline"] });
    controls.click(target({ replyConfirm: approval.id, replyValue: "deny-stop" }), true);
    await settle();
    await settle();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].answers, { decision: ["deny-stop"] });
  });
});

test("question options render as numbered rows with descriptions, and the free-text row stays last", async () => {
  const described: ReplyQuestion = { ...question, fields: [{ id: "color", text: "Chọn <màu>", options: ["Xanh", "Đỏ"], multiSelect: false, allowFreeText: true, descriptions: { Xanh: "Màu <mát>" }, header: "Màu" }] };
  await harness(list([described]), () => new Response("{}"), async (controls) => {
    const html = controls.markup(codex, true);
    assert.match(html, /<span class="cq-chip">Màu<\/span><span>Chọn &lt;màu&gt;<\/span>/);
    assert.match(html, /<span class="cq-index" aria-hidden="true">1<\/span><span class="cq-text"><span class="cq-label">Xanh<\/span><span class="cq-desc">Màu &lt;mát&gt;<\/span>/);
    assert.match(html, /<span class="cq-index" aria-hidden="true">2<\/span><span class="cq-text"><span class="cq-label">Đỏ<\/span><\/span>/);
    assert.ok(html.indexOf("cq-other") > html.lastIndexOf("cq-option"));
    assert.doesNotMatch(html, /ops-reply-lead/);
  });
});

test("digit keys pick the matching option only inside the question, never while typing", () => {
  const clicks: string[] = [];
  const option = (name: string) => ({ click: () => clicks.push(name), focus: () => {} });
  const field = { querySelectorAll: () => [option("first"), option("second")] };
  const event = (key: string, inside: Record<string, unknown> | null, typing = false) => ({ key, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, target: { closest: (selector: string) => selector === ".cq-field" ? inside : typing } }) as unknown as KeyboardEvent;
  assert.equal(pressOptionKey(event("2", field)), true);
  assert.deepEqual(clicks, ["second"]);
  assert.equal(pressOptionKey(event("3", field)), false);
  assert.equal(pressOptionKey(event("1", null)), false);
  assert.equal(pressOptionKey(event("1", field, true)), false);
  assert.equal(pressOptionKey(event("a", field)), false);
  assert.deepEqual(clicks, ["second"]);
});

test("an answered question stays quiet until the snapshot catches up, but a newer question shows", async () => {
  const data = list([approval]);
  await harness(data, (body) => { data.questions = []; return answered(approval.id)(body); }, async (controls) => {
    const earlier = { ...claude, pending: { askedAt: new Date(Date.now() - 5_000).toISOString(), text: "?" } } as unknown as AgentInfo;
    assert.equal(controls.settling(earlier), false);
    controls.click(target({ replyDecision: approval.id, replyValue: "allow" }), true);
    await settle(); await settle(); await settle(); await settle();
    assert.equal(controls.hasQuestion(claude.id), false);
    assert.equal(controls.settling(earlier), true);
    const html = controls.markup(earlier, true);
    assert.match(html, /Đã gửi quyết định/);
    assert.doesNotMatch(html, /Chưa có câu hỏi native/);
    const newer = { ...claude, pending: { askedAt: new Date(Date.now() + 5_000).toISOString(), text: "?" } } as unknown as AgentInfo;
    assert.equal(controls.settling(newer), false);
    controls.markup(newer, true);
    await settle(); await settle();
    assert.match(controls.markup(newer, true), /Chưa có câu hỏi native/);
  });
});

test("a question just seen in the snapshot fetches at once and shows no fallback until that fetch ends", async () => {
  const data = list([]);
  await harness(data, () => new Response("{}"), async (controls) => {
    const fresh = { ...claude, pending: { askedAt: "2026-11-05T09:00:00.000Z", text: "?", kind: "question" } } as unknown as AgentInfo;
    data.questions = [approval];
    const before = controls.markup(fresh, true);
    assert.match(before, /Đang lấy câu hỏi từ phiên này/);
    assert.doesNotMatch(before, /Chưa có câu hỏi native/);
    assert.equal(controls.awaiting(fresh), true);
    await settle(); await settle();
    assert.equal(controls.awaiting(fresh), false);
    assert.match(controls.markup(fresh, true), /data-kind="approval"/);
  });
});

test("a question the channel cannot verify falls back to the reason once the fetch has answered", async () => {
  await harness(list([]), () => new Response("{}"), async (controls) => {
    const fresh = { ...claude, pending: { askedAt: "2026-11-05T09:00:00.000Z", text: "?", kind: "question" } } as unknown as AgentInfo;
    controls.markup(fresh, true);
    await settle(); await settle();
    assert.equal(controls.awaiting(fresh), false);
    assert.match(controls.markup(fresh, true), /Chưa có câu hỏi native/);
  });
});
