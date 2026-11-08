import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentInfo } from "../shared/types.ts";
import type { ReplySubmission } from "../shared/replies.ts";
import { ReplyBroker, ReplyBrokerError, replyQuestionId } from "./replies.ts";
import type { NativeReplyAdapter, NativeReplyQuestion } from "./replies.ts";

const agent: AgentInfo = {
  id: "codex:local:session-1", app: "codex", machine: "WORKSTATION", cwd: "C:\\work\\project", sessionId: "session-1",
  title: "Development", project: "Project", state: "waiting", detail: "Waiting", role: null, parentId: null,
  updatedAt: "2026-10-30T12:00:00Z", pending: null,
};

function question(): NativeReplyQuestion {
  return {
    kind: "question", title: "Codex hỏi sếp", detail: "", agentId: agent.id, app: "codex", machine: agent.machine,
    identity: { accountId: "account-1", cwd: agent.cwd!, sessionId: agent.sessionId!, threadId: "thread-1", nativeRequestId: "native-1", version: "version-1" },
    askedAt: "2026-10-30T12:00:00Z",
    fields: [{ id: "choice", text: "Choose a color", options: ["Blue", "Red"], multiSelect: false, allowFreeText: false }],
  };
}

function fixture() {
  const state = { questions: [question()], sends: 0, listed: 0, author: "" };
  const adapter: NativeReplyAdapter = {
    app: "codex",
    async list() { state.listed++; return state.questions; },
    async submit(_question, _answers, context) { state.sends++; state.author = context.author; return { status: "answered" }; },
  };
  return { state, adapter };
}

function body(native = question()): ReplySubmission {
  return { requestId: randomUUID(), questionId: replyQuestionId(native), agentId: native.agentId, answers: { choice: ["Blue"] } };
}

function status(code: number) {
  return (error: unknown) => error instanceof ReplyBrokerError && error.statusCode === code;
}

test("lists a verified ordinary question and submits human identity once", async () => {
  const { state, adapter } = fixture();
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    const listed = await broker.list([agent]);
    assert.equal(listed.questions.length, 1);
    assert.equal(JSON.stringify(listed).includes("account-1"), false);
    const request = body();
    const receipt = await broker.answer(request, [agent]);
    assert.equal(receipt.status, "answered");
    assert.equal(state.author, "human-web");
    assert.deepEqual(await broker.answer(request, [agent]), receipt);
    assert.deepEqual(broker.receipt(request.requestId), receipt);
    assert.equal(state.sends, 1);
    assert.equal((await broker.list([agent])).questions.length, 0);
    await assert.rejects(broker.answer({ ...request, answers: { choice: ["Red"] } }, [agent]), status(409));
    await assert.rejects(broker.answer({ ...request, requestId: randomUUID() }, [agent]), status(409));
  } finally { broker.close(); }
});

test("concurrent duplicate and competing requests have exactly one sender", async () => {
  const { state, adapter } = fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  adapter.list = async () => { await wait; return state.questions; };
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    const request = body();
    const first = broker.answer(request, [agent]);
    const second = broker.answer(request, [agent]);
    const competing = assert.rejects(broker.answer({ ...request, requestId: randomUUID() }, [agent]), status(409));
    release();
    assert.equal((await first).status, "answered");
    assert.equal((await second).status, "pending");
    await competing;
    assert.equal(state.sends, 1);
  } finally { release(); broker.close(); }
});

test("a corrected answer can use a new UUID after invalid input without changing old receipt", async () => {
  const { state, adapter } = fixture();
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    const invalid = { ...body(), answers: { choice: ["Invalid"] } };
    const rejected = await broker.answer(invalid, [agent]);
    assert.equal(rejected.status, "rejected");
    assert.equal(state.sends, 0);
    assert.deepEqual(await broker.answer(invalid, [agent]), rejected);
    assert.equal((await broker.list([agent])).questions.length, 1);
    await assert.rejects(broker.answer({ ...invalid, answers: { choice: ["Blue"] } }, [agent]), status(409));
    assert.equal((await broker.answer(body(), [agent])).status, "answered");
    assert.deepEqual(broker.receipt(invalid.requestId), rejected);
    assert.equal(state.sends, 1);
  } finally { broker.close(); }
});

test("native answer or changed identity makes the displayed question stale", async (t) => {
  const mutations: [string, (state: ReturnType<typeof fixture>["state"]) => void][] = [
    ["answered in app", (state) => { state.questions = []; }],
    ["account", (state) => { state.questions[0].identity.accountId = "other-account"; }],
    ["cwd", (state) => { state.questions[0].identity.cwd = "C:\\other"; }],
    ["session", (state) => { state.questions[0].identity.sessionId = "other-session"; }],
    ["thread", (state) => { state.questions[0].identity.threadId = "other-thread"; }],
    ["request", (state) => { state.questions[0].identity.nativeRequestId = "other-request"; }],
    ["version", (state) => { state.questions[0].identity.version = "new-version"; }],
    ["question", (state) => { state.questions[0].fields[0].text = "Different question"; }],
    ["machine", (state) => { state.questions[0].machine = "LAPTOP"; }],
    ["permission", (state) => { Object.assign(state.questions[0], { kind: "permission" }); }],
    ["kind", (state) => { state.questions[0].kind = "approval"; }],
    ["title", (state) => { state.questions[0].title = "Tiêu đề khác"; }],
    ["detail", (state) => { state.questions[0].detail = "Chi tiết khác"; }],
    ["labels", (state) => { state.questions[0].fields[0].labels = { Blue: "Xanh" }; }],
    ["optional", (state) => { state.questions[0].fields[0].optional = true; }],
    ["missing identity", (state) => { Object.assign(state.questions[0], { identity: {} }); }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const { state, adapter } = fixture();
    const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
    try {
      const request = body();
      mutate(state);
      assert.equal((await broker.answer(request, [agent])).status, "rejected");
      assert.equal(state.sends, 0);
    } finally { broker.close(); }
  });
});

test("adapter catches native race after broker reread", async () => {
  const { state, adapter } = fixture();
  adapter.submit = async () => ({ status: "stale" });
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    assert.equal((await broker.answer(body(), [agent])).status, "rejected");
    assert.equal(state.sends, 0);
  } finally { broker.close(); }
});

test("invalid answers, unavailable adapters and malformed bodies never send", async (t) => {
  for (const answers of [{ choice: ["Invalid"] }, { choice: ["Blue", "Red"] }, { choice: ["Blue"], extra: ["Red"] }]) {
    await t.test(JSON.stringify(answers), async () => {
      const { state, adapter } = fixture();
      const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
      try {
        assert.equal((await broker.answer({ ...body(), answers }, [agent])).status, "rejected");
        assert.equal(state.sends, 0);
      } finally { broker.close(); }
    });
  }
  const broker = new ReplyBroker({ adapters: [], file: ":memory:" });
  try {
    await assert.rejects(broker.answer(body(), [agent]), status(409));
    await assert.rejects(broker.answer({ ...body(), requestId: "wrong" }, [agent]), status(400));
    await assert.rejects(broker.answer({ ...body(), answers: { choice: ["a".repeat(4001)] } }, [agent]), status(400));
    assert.equal((await broker.list([agent])).unavailable.length, 1);
  } finally { broker.close(); }
});

test("free text and multiple choices obey each field schema", async () => {
  const { state, adapter } = fixture();
  state.questions[0].fields = [
    { id: "choice", text: "Choose colors", options: ["Blue", "Red"], multiSelect: true, allowFreeText: false },
    { id: "reason", text: "Why?", options: [], multiSelect: false, allowFreeText: true },
  ];
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    const request = { ...body(state.questions[0]), answers: { choice: ["Blue", "Red"], reason: ["For readability"] } };
    assert.equal((await broker.answer(request, [agent])).status, "answered");
    assert.equal(state.sends, 1);
  } finally { broker.close(); }
});

test("timeout persists unknown without answer text or automatic resend after restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-replies-"));
  const file = path.join(directory, "replies.sqlite");
  const { state, adapter } = fixture();
  state.questions[0].fields[0].allowFreeText = true;
  const request = { ...body(state.questions[0]), answers: { choice: ["private-answer-should-not-be-stored"] } };
  adapter.submit = async () => { state.sends++; return await new Promise(() => {}); };
  let broker = new ReplyBroker({ adapters: [adapter], file, timeoutMs: 20 });
  try {
    assert.equal((await broker.answer(request, [agent])).status, "unknown");
    broker.close();
    assert.equal(readFileSync(file).includes(Buffer.from(request.answers.choice[0])), false);
    broker = new ReplyBroker({ adapters: [adapter], file, timeoutMs: 20 });
    assert.equal((await broker.answer(request, [agent])).status, "unknown");
    assert.equal((await broker.list([agent])).questions.length, 0);
    await assert.rejects(broker.answer({ ...request, requestId: randomUUID() }, [agent]), status(409));
    state.questions[0].identity.version = "version-2";
    state.questions[0].fields[0].text = "Updated question wording";
    assert.equal((await broker.list([agent])).questions.length, 0);
    const changedQuestionRequest = { ...body(state.questions[0]), answers: request.answers };
    assert.equal((await broker.answer(changedQuestionRequest, [agent])).status, "rejected");
    assert.equal(state.sends, 1);
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("durable pending receipt from interrupted process cannot resend", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-replies-"));
  const file = path.join(directory, "replies.sqlite");
  const { state, adapter } = fixture();
  const request = body();
  let broker = new ReplyBroker({ adapters: [adapter], file });
  try {
    await broker.answer(request, [agent]);
    broker.close();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE receipts SET status = 'pending' WHERE requestId = ?").run(request.requestId);
    db.close();
    state.sends = 0;
    broker = new ReplyBroker({ adapters: [adapter], file });
    assert.equal((await broker.answer(request, [agent])).status, "pending");
    assert.equal(state.sends, 0);
    await assert.rejects(broker.answer({ ...request, requestId: randomUUID() }, [agent]), status(409));
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("unavailable durable storage fails closed before any native operation", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-replies-"));
  const { state, adapter } = fixture();
  const broker = new ReplyBroker({ adapters: [adapter], file: directory });
  try {
    await assert.rejects(broker.answer(body(), [agent]), status(503));
    assert.equal((await broker.list([agent])).questions.length, 0);
    assert.equal(state.listed, 0);
    assert.equal(state.sends, 0);
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("public questions carry kind, title, detail, labels and optional flags", async () => {
  const { state, adapter } = fixture();
  state.questions[0] = { ...question(), kind: "approval", title: "Claude xin chạy lệnh", detail: "npm test", fields: [
    { id: "decision", text: "Quyết định", options: ["allow", "deny"], multiSelect: false, allowFreeText: false, labels: { deny: "Từ chối", allow: "Cho phép" } },
    { id: "feedback", text: "Ghi chú", options: [], multiSelect: false, allowFreeText: true, optional: true },
  ] };
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    const [shown] = (await broker.list([agent])).questions;
    assert.equal(shown.kind, "approval");
    assert.equal(shown.title, "Claude xin chạy lệnh");
    assert.equal(shown.detail, "npm test");
    assert.deepEqual(shown.fields[0].labels, { allow: "Cho phép", deny: "Từ chối" });
    assert.equal(shown.fields[1].optional, true);
    assert.equal(shown.fields[0].optional, undefined);
    assert.equal(shown.id, replyQuestionId(state.questions[0]));
  } finally { broker.close(); }
});

test("optional fields may be omitted or blank while required fields stay mandatory", async (t) => {
  const fields = () => [
    { id: "decision", text: "Quyết định", options: ["allow", "deny"], multiSelect: false, allowFreeText: false },
    { id: "feedback", text: "Ghi chú", options: [], multiSelect: false, allowFreeText: true, optional: true },
  ];
  const cases: [string, Record<string, string[]>, string, string[] | undefined][] = [
    ["omitted", { decision: ["deny"] }, "answered", undefined],
    ["empty array", { decision: ["deny"], feedback: [] }, "answered", undefined],
    ["blank text", { decision: ["deny"], feedback: ["  "] }, "answered", undefined],
    ["filled", { decision: ["deny"], feedback: ["Làm lại"] }, "answered", ["Làm lại"]],
    ["missing required", { feedback: ["Làm lại"] }, "rejected", undefined],
    ["blank required", { decision: [""], feedback: ["Làm lại"] }, "rejected", undefined],
  ];
  for (const [name, answers, expected, feedback] of cases) await t.test(name, async () => {
    const { state, adapter } = fixture();
    let sent: Record<string, string[]> | undefined;
    adapter.submit = async (_question, given) => { state.sends++; sent = given; return { status: "answered" }; };
    state.questions[0].fields = fields();
    const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
    try {
      assert.equal((await broker.answer({ ...body(state.questions[0]), answers }, [agent])).status, expected);
      assert.equal(state.sends, expected === "answered" ? 1 : 0);
      if (sent) assert.deepEqual(sent.feedback, feedback);
    } finally { broker.close(); }
  });
});

test("questions with invalid kind, title, detail, labels or optional flags are never listed or sent", async (t) => {
  const mutations: [string, (native: NativeReplyQuestion) => void][] = [
    ["kind", (native) => { Object.assign(native, { kind: "permission" }); }],
    ["empty title", (native) => { native.title = " "; }],
    ["long title", (native) => { native.title = "a".repeat(301); }],
    ["long detail", (native) => { native.detail = "a".repeat(8001); }],
    ["detail type", (native) => { Object.assign(native, { detail: null }); }],
    ["nul detail", (native) => { native.detail = "a\0b"; }],
    ["label key", (native) => { native.fields[0].labels = { Green: "Xanh lá" }; }],
    ["label length", (native) => { native.fields[0].labels = { Blue: "a".repeat(201) }; }],
    ["label type", (native) => { Object.assign(native.fields[0], { labels: ["Blue"] }); }],
    ["optional type", (native) => { Object.assign(native.fields[0], { optional: "yes" }); }],
    ["only optional", (native) => { native.fields[0].optional = true; }],
  ];
  for (const [name, mutate] of mutations) await t.test(name, async () => {
    const { state, adapter } = fixture();
    mutate(state.questions[0]);
    const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
    try {
      assert.equal((await broker.list([agent])).questions.length, 0);
      assert.equal((await broker.answer(body(state.questions[0]), [agent])).status, "rejected");
      assert.equal(state.sends, 0);
    } finally { broker.close(); }
  });
});

test("answer values must be strings without NUL and at least one answer entry", async () => {
  const { state, adapter } = fixture();
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    await assert.rejects(broker.answer({ ...body(), answers: { choice: [1 as unknown as string] } }, [agent]), status(400));
    await assert.rejects(broker.answer({ ...body(), answers: { choice: ["a\0b"] } }, [agent]), status(400));
    await assert.rejects(broker.answer({ ...body(), answers: {} }, [agent]), status(400));
    assert.equal(state.sends, 0);
  } finally { broker.close(); }
});

test("a reused native request id with a different version is a new prompt once the earlier one was answered", async () => {
  const { state, adapter } = fixture();
  const broker = new ReplyBroker({ adapters: [adapter], file: ":memory:" });
  try {
    assert.equal((await broker.answer(body(), [agent])).status, "answered");
    assert.equal((await broker.list([agent])).questions.length, 0);
    state.questions[0].identity.version = "version-2";
    state.questions[0].fields[0].text = "Choose another color";
    const listed = await broker.list([agent]);
    assert.equal(listed.questions.length, 1);
    assert.equal(listed.questions[0].nativeRequestId, "native-1");
    assert.equal((await broker.answer(body(state.questions[0]), [agent])).status, "answered");
    assert.equal(state.sends, 2);
    assert.equal((await broker.list([agent])).questions.length, 0);
  } finally { broker.close(); }
});

test("legacy unversioned native claims still hold an unresolved send", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-replies-"));
  const file = path.join(directory, "replies.sqlite");
  const { state, adapter } = fixture();
  adapter.submit = async () => { state.sends++; return { status: "unknown" }; };
  let broker = new ReplyBroker({ adapters: [adapter], file });
  try {
    const request = body();
    assert.equal((await broker.answer(request, [agent])).status, "unknown");
    broker.close();
    const db = new DatabaseSync(file);
    const native = question();
    const legacy = createHash("sha256").update(JSON.stringify([native.app, native.machine, native.identity.accountId, "c:\\work\\project", native.identity.sessionId, native.identity.threadId, native.identity.nativeRequestId])).digest("hex");
    db.exec("DELETE FROM nativeBases");
    db.prepare("UPDATE nativeClaims SET nativeKey = ? WHERE requestId = ?").run(legacy, request.requestId);
    db.close();
    broker = new ReplyBroker({ adapters: [adapter], file });
    state.questions[0].identity.version = "version-2";
    assert.equal((await broker.list([agent])).questions.length, 0);
    assert.equal((await broker.answer(body(state.questions[0]), [agent])).status, "rejected");
    assert.equal(state.sends, 1);
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an attempt the adapter rejected before sending releases its native claim so the prompt can be answered again", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-replies-"));
  const file = path.join(directory, "replies.sqlite");
  const { state, adapter } = fixture();
  let stale = true;
  adapter.submit = async () => { if (stale) return { status: "stale" }; state.sends++; return { status: "answered" }; };
  let broker = new ReplyBroker({ adapters: [adapter], file });
  try {
    const first = body();
    assert.equal((await broker.answer(first, [agent])).status, "rejected");
    const db = new DatabaseSync(file);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM nativeClaims WHERE requestId = ?").get(first.requestId) as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM nativeBases WHERE requestId = ?").get(first.requestId) as { count: number }).count, 0);
    db.close();
    broker.close();
    broker = new ReplyBroker({ adapters: [adapter], file });
    const listed = await broker.list([agent]);
    assert.equal(listed.questions.length, 1);
    assert.equal(listed.questions[0].id, first.questionId);
    assert.equal((await broker.answer(first, [agent])).status, "rejected");
    stale = false;
    const second = body();
    assert.notEqual(second.requestId, first.requestId);
    assert.equal((await broker.answer(second, [agent])).status, "answered");
    assert.equal(state.sends, 1);
    assert.equal((await broker.list([agent])).questions.length, 0);
    await assert.rejects(broker.answer(body(), [agent]), status(409));
    assert.equal(state.sends, 1);
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a rejected receipt left with a stale exact claim no longer blocks the prompt", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "msc-replies-"));
  const file = path.join(directory, "replies.sqlite");
  const { state, adapter } = fixture();
  adapter.submit = async () => ({ status: "stale" });
  let broker = new ReplyBroker({ adapters: [adapter], file });
  try {
    const first = body();
    assert.equal((await broker.answer(first, [agent])).status, "rejected");
    broker.close();
    const native = question();
    const exact = createHash("sha256").update(JSON.stringify([native.app, native.machine, native.identity.accountId, "c:\\work\\project", native.identity.sessionId, native.identity.threadId, native.identity.nativeRequestId, native.identity.version])).digest("hex");
    const db = new DatabaseSync(file);
    db.prepare("INSERT INTO nativeClaims (nativeKey,requestId) VALUES (?,?)").run(exact, first.requestId);
    db.close();
    broker = new ReplyBroker({ adapters: [adapter], file });
    assert.equal((await broker.list([agent])).questions.length, 1);
    adapter.submit = async () => { state.sends++; return { status: "answered" }; };
    assert.equal((await broker.answer(body(), [agent])).status, "answered");
    assert.equal(state.sends, 1);
  } finally { broker.close(); rmSync(directory, { recursive: true, force: true }); }
});
