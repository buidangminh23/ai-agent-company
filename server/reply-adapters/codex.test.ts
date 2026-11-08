import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInfo } from "../../shared/types.ts";
import { randomUUID } from "node:crypto";
import { ReplyBroker } from "../replies.ts";
import { CODEX_MAC_VERSIONS, CODEX_WINDOWS_VERSIONS, CodexReplyAdapter, codexApprovalDecision, codexDecisionOutcome, type CodexReplyWire } from "./codex.ts";

const THREAD = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const SIGNAL = new AbortController().signal;
const agent = { id: "codex-test", app: "codex", machine: "WORKSTATION", sessionId: THREAD, cwd: "C:\\Work\\App", pending: { question: "Pick one", options: ["A", "B"], askedAt: "2026-10-30T00:00:00Z", kind: "question" } } as AgentInfo;
const account = { fingerprint: "account-fingerprint", generation: "auth-generation" };
const makeCommand = (amendment?: unknown) => ({ id: "approval-7", method: "item/commandExecution/requestApproval", params: { threadId: THREAD, turnId: "turn-1", itemId: "item-1", startedAtMs: 1, command: "npm test", cwd: "C:\\Work\\App", reason: "Chạy test", commandActions: [], ...(amendment === undefined ? {} : { proposedExecpolicyAmendment: amendment }) } });
const makeFile = () => ({ id: 9, method: "item/fileChange/requestApproval", params: { threadId: THREAD, turnId: "turn-1", itemId: "item-2", startedAtMs: 1, grantRoot: "C:\\Work\\App\\src", reason: "Sửa file" } });
const makeRequest = () => ({ id: 44, method: "item/tool/requestUserInput", params: { threadId: THREAD, turnId: "turn-1", itemId: "item-q", isBlocking: true, questions: [{ id: "choice", question: "Pick one", isOther: true, options: [{ label: "A" }, { label: "B" }] }] } });

const ITEM_TYPES: Record<string, string> = { "item/commandExecution/requestApproval": "commandExecution", "item/fileChange/requestApproval": "fileChange" };
type Turn = { turnId: string; status: string; items: Record<string, unknown>[] };
function seedTurns(requests: unknown[]): Turn[] {
  const turns: Turn[] = [];
  for (const value of requests as { method: string; params: { turnId?: string; itemId?: string } }[]) {
    const type = ITEM_TYPES[value.method];
    if (!type || !value.params.turnId || !value.params.itemId) continue;
    let turn = turns.find((entry) => entry.turnId === value.params.turnId);
    if (!turn) turns.push(turn = { turnId: value.params.turnId, status: "inProgress", items: [] });
    turn.items.push({ type, id: value.params.itemId, status: "inProgress" });
  }
  return turns;
}

function fixture(requests: unknown[] = [makeRequest()]) {
  const state: Record<string, unknown> = { id: THREAD, hostId: "local", cwd: agent.cwd, requests, turns: seedTurns(requests) };
  let lateItem: Record<string, unknown> | null = null;
  let lateCountdown = 0;
  let snapshotsSent = 0;
  const sent: Record<string, unknown>[] = [];
  let currentAccount = { ...account };
  let mode = "answer";
  let wrongOwner = false;
  let openCount = 0;
  const adapter = new CodexReplyAdapter({ machine: "WORKSTATION", decisionPollMs: 1, account: () => currentAccount, now: () => 1700000000000, open: async () => {
    openCount++;
    const listeners = new Set<(message: Record<string, unknown>) => void>();
    const emit = (message: Record<string, unknown>) => { for (const listener of listeners) listener(structuredClone(message)); };
    const wire: CodexReplyWire = {
      version: "26.1027.3384.0", instanceId: "process-1", close() {},
      listen(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      send(message) {
        sent.push(message);
        const params = message.params as Record<string, unknown>;
        if (message.type === "request") {
          let result: unknown = {};
          if (message.method === "initialize") result = { clientId: CLIENT };
          if (message.method === "thread-owner-discovery") result = { supportsUntrustedAppInput: true };
          if (message.method === "thread-follower-command-approval-decision" || message.method === "thread-follower-file-approval-decision") {
            assert.equal(message.targetClientId, OWNER);
            assert.equal(message.version, 1);
            if (mode === "throw") throw new Error("transport ambiguous");
            const target = (state.requests as { id: unknown; method: string; params: { turnId?: string; itemId?: string } }[]).find((request) => request.id === params.requestId);
            if (mode !== "noop") state.requests = (state.requests as { id: unknown }[]).filter((request) => request.id !== params.requestId);
            const declined = params.decision === "decline" || params.decision === "cancel";
            const turn = (state.turns as Turn[]).find((entry) => entry.turnId === target?.params.turnId);
            const item = turn?.items.find((entry) => entry.id === target?.params.itemId);
            if (item && mode === "answer" && declined) item.status = "declined";
            if (item && mode === "mismatch") item.status = declined ? "completed" : "declined";
            if (item && mode === "otherItem") item.id = "item-other";
            if (turn && mode === "interrupted") turn.status = "interrupted";
            if (turn && item && mode === "finished") { item.status = "completed"; turn.status = "completed"; }
            if (item && mode === "lateDecline") { lateItem = item; lateCountdown = 2; }
            result = { ok: true };
          }
          if (message.method === "thread-follower-submit-user-input") {
            assert.equal(params.requestId, 44);
            assert.equal(message.targetClientId, OWNER);
            assert.equal(message.sourceClientId, CLIENT);
            assert.equal(message.version, 1);
            assert.equal(Object.hasOwn(message, "hostId"), false);
            if (mode === "throw") throw new Error("transport ambiguous");
            if (mode !== "noop") state.requests = [];
            if (mode === "answer") state.turns = [{ items: [{ type: "userInputResponse", requestId: 44, completed: true, answers: { choice: ["A"] } }] }];
            if (mode === "different") state.turns = [{ items: [{ type: "userInputResponse", requestId: 44, completed: true, answers: { choice: ["B"] } }] }];
            result = { ok: true };
          }
          queueMicrotask(() => emit({ type: "response", requestId: message.requestId, resultType: "success", method: message.method, handledByClientId: message.method === "initialize" ? CLIENT : OWNER, result }));
        }
        if (message.method === "thread-stream-following-changed" && params.following === true) snapshotsSent++;
        if (message.method === "thread-stream-following-changed" && params.following === true && lateItem && lateCountdown > 0 && --lateCountdown === 0) lateItem.status = "declined";
        if (message.method === "thread-stream-following-changed" && params.following === true) queueMicrotask(() => emit({ type: "broadcast", sourceClientId: wrongOwner ? CLIENT : OWNER, targetClientIds: [CLIENT], method: "thread-stream-state-changed", version: 11, params: { conversationId: THREAD, hostId: "local", change: { type: "snapshot", revision: 4, conversationState: state } } }));
      },
    };
    return wire;
  } });
  return { adapter, state, sent, setMode(value: string) { mode = value; }, changeAccount() { currentAccount = { fingerprint: "different", generation: "different" }; }, wrongOwner() { wrongOwner = true; }, opens: () => openCount, snapshots: () => snapshotsSent, submissions: () => sent.filter((message) => message.method === "thread-follower-submit-user-input"), decisions: () => sent.filter((message) => String(message.method).endsWith("-approval-decision")) };
}

test("Codex reads pending questions using its own registered client and targeted snapshots", async () => {
  const f = fixture();
  const questions = await f.adapter.list(agent, SIGNAL);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].identity.nativeRequestId, JSON.stringify([44, "turn-1", "item-q"]));
  assert.equal(questions[0].fields[0].allowFreeText, true);
  assert.equal((f.sent[0].params as Record<string, unknown>).clientType, "minh-spark-company-human-web");
  assert.equal(f.submissions().length, 0);
  assert.deepEqual(await f.adapter.list(agent, SIGNAL), questions);
});

test("Codex resolves typed native request and verifies matching native answer", async () => {
  const f = fixture();
  const [question] = await f.adapter.list(agent, SIGNAL);
  const result = await f.adapter.submit(question, { choice: ["A"] }, { author: "human-web", requestId: "web-1", signal: SIGNAL });
  assert.deepEqual(result, { status: "answered" });
  assert.equal(f.submissions().length, 1);
  assert.equal(f.opens(), 2);
});

test("Codex rejects changed account, request contents, cwd and native request identity without sending", async () => {
  for (const change of ["account", "request", "cwd", "id"]) {
    const f = fixture();
    const [question] = await f.adapter.list(agent, SIGNAL);
    if (change === "account") f.changeAccount();
    if (change === "request") (f.state.requests as ReturnType<typeof makeRequest>[])[0].params.questions[0].question = "Changed";
    if (change === "cwd") f.state.cwd = "C:\\Other";
    if (change === "id") (f.state.requests as ReturnType<typeof makeRequest>[])[0].id = 45;
    assert.deepEqual(await f.adapter.submit(question, { choice: ["A"] }, { author: "human-web", requestId: "web-1", signal: SIGNAL }), { status: "stale" });
    assert.equal(f.submissions().length, 0);
  }
});

test("Codex keeps refusing secret input and skips approvals without a turn or item id", async () => {
  const f = fixture([{ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: THREAD, command: "ls" } }]);
  assert.deepEqual(await f.adapter.list(agent, SIGNAL), []);
  f.state.requests = [{ ...makeRequest(), params: { ...makeRequest().params, questions: [{ id: "secret", question: "Secret", isSecret: true }] } }];
  await assert.rejects(f.adapter.list(agent, SIGNAL));
  assert.equal(f.submissions().length, 0);
});

test("Codex acknowledgement, deletion alone and different human answer remain unknown", async () => {
  for (const mode of ["noop", "deleted", "different", "throw"]) {
    const f = fixture();
    const [question] = await f.adapter.list(agent, SIGNAL);
    f.setMode(mode);
    assert.deepEqual(await f.adapter.submit(question, { choice: ["A"] }, { author: "human-web", requestId: "web-1", signal: SIGNAL }), { status: "unknown" });
    assert.equal(f.submissions().length, 1);
  }
});

test("Codex rejects unsupported answers and cross-machine sessions", async () => {
  const f = fixture();
  const [question] = await f.adapter.list(agent, SIGNAL);
  assert.deepEqual(await f.adapter.submit(question, { unexpected: ["A"] }, { author: "human-web", requestId: "web-1", signal: SIGNAL }), { status: "stale" });
  await assert.rejects(f.adapter.list({ ...agent, machine: "LAPTOP" }, SIGNAL));
  assert.equal(f.submissions().length, 0);
});

test("Codex does not accept snapshots from a different IPC client", async () => {
  const f = fixture();
  f.wrongOwner();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 35);
  await assert.rejects(f.adapter.list(agent, controller.signal));
  assert.equal(f.submissions().length, 0);
});

const CONTEXT = { author: "human-web" as const, requestId: "web-1", signal: SIGNAL };

test("Codex pins the verified Windows and Mac Desktop builds", () => {
  assert.deepEqual(CODEX_WINDOWS_VERSIONS, ["26.1027.3384.0"]);
  assert.deepEqual(CODEX_MAC_VERSIONS, [{ version: "26.1027.51404", build: "23880" }]);
});

test("Codex lists command and file approvals with exact decisions, labels, title and detail", async () => {
  const f = fixture([makeRequest(), makeCommand(), makeFile()]);
  const [question, command, file] = await f.adapter.list(agent, SIGNAL);
  assert.equal(question.kind, "question");
  assert.equal(question.title, "Codex hỏi");
  assert.equal(question.detail, "");
  assert.equal(command.kind, "approval");
  assert.equal(command.title, "Codex xin chạy lệnh");
  assert.equal(command.detail, "Lệnh: npm test\nThư mục: C:\\Work\\App\nLý do: Chạy test");
  assert.equal(command.identity.nativeRequestId, JSON.stringify(["approval-7", "turn-1", "item-1"]));
  assert.deepEqual(command.fields, [{ id: "decision", text: "Quyết định của sếp", options: ["accept", "acceptForSession", "decline", "cancel"], multiSelect: false, allowFreeText: false, labels: { accept: "Cho phép", acceptForSession: "Cho phép cả phiên", decline: "Từ chối, Codex làm tiếp", cancel: "Từ chối và dừng lượt" } }]);
  assert.equal(file.title, "Codex xin sửa file");
  assert.equal(file.detail, "Thư mục xin quyền ghi: C:\\Work\\App\\src\nLý do: Sửa file");
  assert.deepEqual(file.fields[0].options, ["accept", "acceptForSession", "decline", "cancel"]);
  assert.deepEqual(file.fields[0].labels, { accept: "Cho phép", acceptForSession: "Cho phép mọi sửa file trong phiên", decline: "Từ chối, Codex làm tiếp", cancel: "Từ chối và dừng lượt" });
  const amended = fixture([makeCommand(["npm", "test"])]);
  const [rule] = await amended.adapter.list(agent, SIGNAL);
  assert.deepEqual(rule.fields[0].options, ["accept", "acceptForSession", "acceptWithExecpolicyAmendment", "decline", "cancel"]);
  assert.equal(rule.fields[0].labels?.acceptWithExecpolicyAmendment, "Luôn cho phép lệnh tương tự");
  assert.match(rule.detail, /Quy tắc đề xuất: npm test$/);
  for (const invalid of [[], [""], [1], "npm test"]) assert.equal((await fixture([makeCommand(invalid)]).adapter.list(agent, SIGNAL))[0].fields[0].options.includes("acceptWithExecpolicyAmendment"), false);
});

test("Codex builds approval decisions strictly and takes amendments only from the proposal", () => {
  const command = "item/commandExecution/requestApproval", file = "item/fileChange/requestApproval";
  for (const option of ["accept", "acceptForSession", "decline", "cancel"]) {
    assert.equal(codexApprovalDecision(command, {}, option), option);
    assert.equal(codexApprovalDecision(file, {}, option), option);
  }
  assert.deepEqual(codexApprovalDecision(command, { proposedExecpolicyAmendment: ["npm", "test"] }, "acceptWithExecpolicyAmendment"), { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } });
  assert.equal(codexApprovalDecision(command, {}, "acceptWithExecpolicyAmendment"), null);
  assert.equal(codexApprovalDecision(file, { proposedExecpolicyAmendment: ["npm"] }, "acceptWithExecpolicyAmendment"), null);
  for (const option of ["approve", "Accept", "toString", "__proto__", ""]) assert.equal(codexApprovalDecision(command, {}, option), null);
  assert.equal(codexApprovalDecision("item/tool/requestUserInput", {}, "accept"), null);
});

test("Codex submits approval decisions through the follower decision methods and verifies the request is gone", async () => {
  const f = fixture([makeCommand(["npm", "test"]), makeFile()]);
  const [command, file] = await f.adapter.list(agent, SIGNAL);
  assert.deepEqual(await f.adapter.submit(command, { decision: ["acceptWithExecpolicyAmendment"] }, CONTEXT), { status: "answered" });
  assert.deepEqual(await f.adapter.submit(file, { decision: ["cancel"] }, CONTEXT), { status: "answered" });
  const [commandCall, fileCall] = f.decisions();
  assert.equal(commandCall.method, "thread-follower-command-approval-decision");
  assert.deepEqual(commandCall.params, { conversationId: THREAD, requestId: "approval-7", decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } } });
  assert.equal(fileCall.method, "thread-follower-file-approval-decision");
  assert.deepEqual(fileCall.params, { conversationId: THREAD, requestId: 9, decision: "cancel" });
  assert.equal(f.submissions().length, 0);
});

test("Codex rejects unknown decisions and amendments without a proposal before sending", async () => {
  const f = fixture([makeCommand()]);
  const [command] = await f.adapter.list(agent, SIGNAL);
  for (const answers of [{ decision: ["approve"] }, { decision: ["acceptWithExecpolicyAmendment"] }, { decision: ["accept", "cancel"] }, { decision: [] }, { other: ["accept"] }, { decision: ["accept"], extra: ["x"] }] as Record<string, string[]>[]) assert.deepEqual(await f.adapter.submit(command, answers, CONTEXT), { status: "stale" }, JSON.stringify(answers));
  const forged = { ...command, fields: [{ ...command.fields[0], options: [...command.fields[0].options, "acceptWithExecpolicyAmendment"] }] };
  assert.deepEqual(await f.adapter.submit(forged, { decision: ["acceptWithExecpolicyAmendment"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await f.adapter.submit({ ...command, kind: "plan" }, { decision: ["accept"] }, CONTEXT), { status: "stale" });
  assert.deepEqual(await f.adapter.submit(command, { decision: ["accept"] }, { ...CONTEXT, author: "agent" as "human-web" }), { status: "stale" });
  assert.equal(f.decisions().length, 0);
});

test("Codex approval stays unknown when the request is still present, the transport is ambiguous or the item does not show the decision", async () => {
  for (const mode of ["noop", "throw", "mismatch", "otherItem", "interrupted"]) {
    const f = fixture([makeCommand()]);
    const [command] = await f.adapter.list(agent, SIGNAL);
    f.setMode(mode);
    assert.deepEqual(await f.adapter.submit(command, { decision: ["accept"] }, CONTEXT), { status: "unknown" }, mode);
    assert.equal(f.decisions().length, 1);
  }
  for (const mode of ["noop", "throw", "deleted", "mismatch", "otherItem"]) {
    const declined = fixture([makeFile()]);
    const [file] = await declined.adapter.list(agent, SIGNAL);
    declined.setMode(mode);
    assert.deepEqual(await declined.adapter.submit(file, { decision: ["decline"] }, CONTEXT), { status: "unknown" }, mode);
    assert.equal(declined.decisions().length, 1);
  }
  const changed = fixture([makeCommand()]);
  const [command] = await changed.adapter.list(agent, SIGNAL);
  (changed.state.requests as ReturnType<typeof makeCommand>[])[0].params.command = "rm -rf build";
  assert.deepEqual(await changed.adapter.submit(command, { decision: ["accept"] }, CONTEXT), { status: "stale" });
  assert.equal(changed.decisions().length, 0);
});

test("Codex opens the IPC channel only for a pending prompt or a turn active within 30 minutes", async () => {
  const now = 1700000000000;
  const base = { ...agent, pending: null, updatedAt: new Date(now - 60_000).toISOString() } as AgentInfo;
  for (const [candidate, probed] of [
    [{ ...base, state: "idle" }, false],
    [{ ...base, state: "working" }, true],
    [{ ...base, state: "thinking" }, true],
    [{ ...base, state: "waiting" }, true],
    [{ ...base, state: "working", updatedAt: new Date(now - 31 * 60_000).toISOString() }, false],
    [{ ...base, state: "working", updatedAt: "not a date" }, false],
    [{ ...base, state: "idle", pending: { question: "Allow?", options: [], askedAt: "2026-10-30T00:00:00Z", kind: "decision" } }, true],
  ] as [AgentInfo, boolean][]) {
    const f = fixture([makeCommand()]);
    const listed = await f.adapter.list(candidate, SIGNAL);
    assert.equal(f.opens(), probed ? 1 : 0, JSON.stringify(candidate));
    assert.equal(listed.length, probed ? 1 : 0);
  }
});

test("Codex approval is answered only when the matching thread item status agrees with the decision", async () => {
  for (const option of ["accept", "acceptForSession", "decline", "cancel"]) {
    const f = fixture([makeCommand(), makeFile()]);
    const [command, file] = await f.adapter.list(agent, SIGNAL);
    assert.deepEqual(await f.adapter.submit(command, { decision: [option] }, CONTEXT), { status: "answered" }, option);
    assert.deepEqual(await f.adapter.submit(file, { decision: [option] }, CONTEXT), { status: "answered" }, option);
  }
  const command = makeCommand(), file = makeFile();
  const state = (request: { method: string; params: { turnId: string; itemId: string } }, status: unknown, turnStatus = "inProgress", itemId = request.params.itemId, requests: unknown[] = []) => ({ requests, turns: [{ turnId: "turn-0", status: "completed", items: [] }, { turnId: request.params.turnId, status: turnStatus, items: [{ type: ITEM_TYPES[request.method], id: itemId, status }] }] });
  assert.equal(codexDecisionOutcome(state(command, "inProgress"), command, "accept"), "answered");
  assert.equal(codexDecisionOutcome(state(file, "inProgress"), file, "acceptForSession"), "answered");
  assert.equal(codexDecisionOutcome(state(command, "inProgress"), command, "acceptWithExecpolicyAmendment"), "answered");
  for (const status of ["completed", "failed"]) {
    assert.equal(codexDecisionOutcome(state(command, status, "completed"), command, "accept"), "answered", status);
    assert.equal(codexDecisionOutcome(state(command, status), command, "decline"), "mismatch", status);
  }
  assert.equal(codexDecisionOutcome(state(command, "inProgress", "interrupted"), command, "accept"), "mismatch");
  assert.equal(codexDecisionOutcome(state(command, "inProgress", "completed"), command, "accept"), "mismatch");
  assert.equal(codexDecisionOutcome(state(command, "inProgress"), command, "decline"), "pending");
  assert.equal(codexDecisionOutcome(state(command, "inProgress", "inProgress", "item-1", [command]), command, "accept"), "pending");
  assert.equal(codexDecisionOutcome(state(command, "declined", "inProgress", "item-1", [command]), command, "cancel"), "pending");
  assert.equal(codexDecisionOutcome(state(command, "declined"), command, "cancel"), "answered");
  assert.equal(codexDecisionOutcome(state(command, "declined"), command, "acceptWithExecpolicyAmendment"), "mismatch");
  assert.equal(codexDecisionOutcome(state(command, "declined", "inProgress", "item-other"), command, "decline"), "pending");
  assert.equal(codexDecisionOutcome(state(command, undefined), command, "accept"), "mismatch");
  assert.equal(codexDecisionOutcome({ requests: [], turns: [{ turnId: "turn-1", status: "inProgress", items: [{ type: "fileChange", id: "item-1", status: "declined" }] }] }, command, "decline"), "pending");
  assert.equal(codexDecisionOutcome(state(command, "completed"), { ...command, params: { ...command.params, itemId: undefined } }, "accept"), "mismatch");
  assert.equal(codexDecisionOutcome(state(command, "completed"), { ...command, method: "item/tool/requestUserInput" }, "accept"), "mismatch");
  assert.equal(codexDecisionOutcome(state(command, "completed"), command, "approve"), "mismatch");
});

test("Codex native identity carries turn and item ids so a reused JSON-RPC id with a new item is listed and answerable", async () => {
  const f = fixture([makeFile()]);
  const broker = new ReplyBroker({ adapters: [f.adapter], file: ":memory:" });
  try {
    const [first] = (await broker.list([agent])).questions;
    assert.equal(first.nativeRequestId, JSON.stringify([9, "turn-1", "item-2"]));
    assert.equal((await broker.answer({ requestId: randomUUID(), questionId: first.id, agentId: agent.id, answers: { decision: ["accept"] } }, [agent])).status, "answered");
    assert.equal((await broker.list([agent])).questions.length, 0);
    f.state.requests = [{ ...makeFile(), params: { ...makeFile().params, turnId: "turn-2", itemId: "item-3" } }];
    f.state.turns = [...(f.state.turns as Turn[]).map((turn) => ({ ...turn, status: "completed" })), ...seedTurns(f.state.requests as unknown[])];
    const listed = (await broker.list([agent])).questions;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].nativeRequestId, JSON.stringify([9, "turn-2", "item-3"]));
    assert.equal((await broker.answer({ requestId: randomUUID(), questionId: listed[0].id, agentId: agent.id, answers: { decision: ["decline"] } }, [agent])).status, "answered");
    assert.equal(f.decisions().length, 2);
    assert.equal((await broker.list([agent])).questions.length, 0);
  } finally { broker.close(); }
});

test("Codex accept is answered while the approved command keeps running in the active turn", async () => {
  for (const mode of ["deleted", "answer", "finished"]) {
    const f = fixture([makeCommand()]);
    const [command] = await f.adapter.list(agent, SIGNAL);
    assert.equal(((f.state.turns as Turn[])[0].items[0]).status, "inProgress");
    f.setMode(mode);
    assert.deepEqual(await f.adapter.submit(command, { decision: ["accept"] }, CONTEXT), { status: "answered" }, mode);
  }
});

test("Codex accept stays unknown when the turn was interrupted even though the item is still in progress", async () => {
  const f = fixture([makeCommand()]);
  const [command] = await f.adapter.list(agent, SIGNAL);
  f.setMode("interrupted");
  assert.deepEqual(await f.adapter.submit(command, { decision: ["acceptForSession"] }, CONTEXT), { status: "unknown" });
});

test("Codex decline that never turns declined stays unknown after a bounded number of snapshots", async () => {
  const f = fixture([makeCommand()]);
  const [command] = await f.adapter.list(agent, SIGNAL);
  const before = f.snapshots();
  f.setMode("deleted");
  const started = Date.now();
  assert.deepEqual(await f.adapter.submit(command, { decision: ["decline"] }, CONTEXT), { status: "unknown" });
  assert.ok(Date.now() - started < 4000);
  assert.ok(f.snapshots() - before <= 9, String(f.snapshots() - before));
  assert.ok(f.snapshots() - before >= 3);
});

test("Codex decline is answered once a later snapshot shows the item declined", async () => {
  const f = fixture([makeCommand()]);
  const [command] = await f.adapter.list(agent, SIGNAL);
  const before = f.snapshots();
  f.setMode("lateDecline");
  assert.deepEqual(await f.adapter.submit(command, { decision: ["decline"] }, CONTEXT), { status: "answered" });
  assert.equal(f.snapshots() - before, 3);
});

test("Codex decision polling stops when the request is aborted", async () => {
  const f = fixture([makeCommand()]);
  const [command] = await f.adapter.list(agent, SIGNAL);
  const controller = new AbortController();
  f.setMode("deleted");
  const slow = new CodexReplyAdapter({ machine: "WORKSTATION", decisionPollMs: 10_000, account: () => account, now: () => 1700000000000, open: (signal) => (f.adapter as unknown as { open: (signal: AbortSignal) => Promise<CodexReplyWire> }).open(signal) });
  setTimeout(() => controller.abort(), 40);
  const started = Date.now();
  assert.deepEqual(await slow.submit(command, { decision: ["decline"] }, { ...CONTEXT, signal: controller.signal }), { status: "unknown" });
  assert.ok(Date.now() - started < 1000);
});
