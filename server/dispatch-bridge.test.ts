import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBridgeDispatchAdapter, type DispatchBridgeRuntime } from "./dispatch-bridge.ts";
import type { AgentInfo } from "../shared/types.ts";

const agent: AgentInfo = { id: "codex:test", machine: "WORKSTATION", app: "codex", sessionId: "test", cwd: process.cwd(), title: "Work", project: "Work", state: "idle", role: null, parentId: null, updatedAt: new Date().toISOString(), detail: "", pending: null };
function fixture() {
  const state = { replyPending: false, operations: [] as string[], changedAccount: false, threadId: "test", cwd: process.cwd(), response: { threadId: "test", status: "accepted" } as Record<string, unknown>, peers: 0, stopped: 0, replyStatus: "accepted", policy: "accept" };
  const runtime: DispatchBridgeRuntime = {
    accounts: {
      readBridgeAccounts: () => ({ claude: { fingerprint: "claude" } }),
      requireBridgeAccounts: () => ({ claude: "claude", codex: "codex" }),
      assertAccountIdentity: () => { if (state.changedAccount) throw Object.assign(new Error("Changed account"), { sent: false }); },
    },
    native: { NativeDesktopRelay: class {
      async requestDesktop(operation: string, args: { threadId: string }, options: { beforeSend: () => void; accountContext: unknown }) {
        options.beforeSend();
        assert.deepEqual(options.accountContext, { claude: "claude", codex: "codex" });
        assert.equal(args.threadId, agent.sessionId);
        state.operations.push(operation);
        return { result: operation === "read_thread" ? { thread: { id: state.threadId, cwd: state.cwd } } : state.response };
      }
    } },
    peer: {
      listClaudeSessions: () => [{ alive: true, entrypoint: "claude-desktop", sessionId: "test", cwd: process.cwd(), pid: 123, socket: "fixture" }],
      assertClaudeSessionProcess: () => {}, assertClaudeSessionCwd: () => {},
      PeerEndpoint: class {
        permissionMode = "";
        constructor(options: { name: string }) { state.peers++; assert.equal(options.name, "human-web-minh-spark-company"); }
        async start() {}
        stop() { state.stopped++; }
        async sendAndWait(_socket: string, _text: string, options: { beforeSend: () => void; permissionMode: string }) { options.beforeSend(); assert.equal(options.permissionMode, "prompting"); if (state.replyPending) throw Object.assign(new Error("earlier message"), { code: "PEER_REPLY_PENDING", sent: false }); return { msgId: randomUUID(), delivery: { status: state.replyStatus } }; }
        readDelivery() { return { status: state.replyStatus }; }
      },
    },
    desktop: { readClaudeDesktopContext: () => ({ status: "matched", accountFingerprint: "claude", taskId: "native-task" }) },
    inbound: { readClaudeInboundPolicy: () => ({ value: state.policy }) },
  };
  return { state, runtime, adapter: createBridgeDispatchAdapter({ load: async () => runtime }) };
}

test("Codex dispatch verifies exact native target and preserves accepted versus unknown outcomes", async () => {
  const { state, adapter } = fixture();
  assert.equal((await adapter.send(agent, "Human fixture", randomUUID())).status, "accepted");
  assert.deepEqual(state.operations, ["read_thread", "send_message_to_thread"]);
  state.response = { threadId: "wrong", status: "accepted" };
  assert.equal((await adapter.send(agent, "Human fixture", randomUUID())).status, "unknown");
  state.response = { threadId: "test", status: "waitingOnApproval" };
  assert.equal((await adapter.send(agent, "Human fixture", randomUUID())).status, "unknown");
});

test("Codex refuses mismatched thread, workspace and changed account before dispatch", async () => {
  for (const mutation of [(state: ReturnType<typeof fixture>["state"]) => state.threadId = "wrong", (state: ReturnType<typeof fixture>["state"]) => state.cwd = "missing/relative", (state: ReturnType<typeof fixture>["state"]) => state.changedAccount = true]) {
    const { state, adapter } = fixture();
    mutation(state);
    await assert.rejects(() => adapter.send(agent, "Human fixture", randomUUID()), { sent: false });
    assert.equal(state.operations.includes("send_message_to_thread"), false);
  }
});

test("Claude pending messages share one process endpoint and acceptance is not delivery", async () => {
  const { state, adapter } = fixture();
  const claude = { ...agent, app: "claude" as const };
  const first = randomUUID(), second = randomUUID();
  assert.equal((await adapter.send(claude, "First fixture", first)).status, "accepted");
  assert.equal((await adapter.send(claude, "Second fixture", second)).status, "accepted");
  assert.equal(state.peers, 1);
  assert.equal(state.stopped, 0);
  state.replyStatus = "reply_received";
  assert.equal((await adapter.check!(claude, first))?.status, "replied");
  assert.equal(state.stopped, 0);
  assert.equal((await adapter.check!(claude, second))?.status, "replied");
  assert.equal(state.stopped, 1);
});

test("Claude respects inbound policy and Antigravity remains unavailable without human transport", async () => {
  const { state, adapter } = fixture();
  state.policy = "hold";
  assert.equal((await adapter.inspect({ ...agent, app: "claude" })).available, false);
  await assert.rejects(() => adapter.send({ ...agent, app: "claude" }, "Fixture", randomUUID()), { sent: false });
  assert.equal(state.peers, 0);
  assert.equal((await adapter.inspect({ ...agent, app: "antigravity" })).available, false);
});

test("Antigravity verifies native human capability without borrowing an AI sender account", async () => {
  const { runtime, adapter } = fixture();
  const target = { ...agent, app: "antigravity" as const };
  runtime.accounts.readBridgeAccounts = () => { throw new Error("Must not read AI sender accounts"); };
  runtime.antigravity = {
    inspectHumanConversation: async (input: unknown) => {
      assert.deepEqual(input, { conversationId: agent.sessionId, cwd: agent.cwd });
      return { available: true, conversationId: agent.sessionId, cwd: agent.cwd, projectId: "project", surface: "desktop", status: "CASCADE_RUN_STATUS_IDLE" };
    },
    sendHumanMessage: async () => {}, readHumanReceipt: async () => {},
  };
  assert.equal((await adapter.inspect(target)).available, true);
  runtime.antigravity.inspectHumanConversation = async () => ({ available: true, conversationId: "wrong", cwd: agent.cwd, surface: "desktop" });
  assert.equal((await adapter.inspect(target)).available, false);
  runtime.antigravity.inspectHumanConversation = async () => { throw Object.assign(new Error("busy"), { code: "ANTIGRAVITY_RECIPIENT_BUSY" }); };
  assert.match((await adapter.inspect(target)).reason, /đang bận/);
});

test("Antigravity keeps native request identity, polls receipts and never converts acceptance to reply", async () => {
  const { runtime, adapter } = fixture();
  const target = { ...agent, app: "antigravity" as const };
  const requestId = randomUUID();
  let sends = 0;
  let status = "pending";
  const receipt = () => ({ requestId, conversationId: target.sessionId, cwd: target.cwd, surface: "desktop", sender: { provider: "human-web", id: "minh-spark-company" }, status });
  runtime.antigravity = {
    inspectHumanConversation: async () => {},
    sendHumanMessage: async (input: unknown) => { sends++; assert.deepEqual(input, { requestId, conversationId: target.sessionId, cwd: target.cwd, prompt: "Human fixture" }); return receipt(); },
    readHumanReceipt: async (input: unknown) => { assert.deepEqual(input, { requestId, conversationId: target.sessionId, cwd: target.cwd }); return receipt(); },
  };
  assert.equal((await adapter.send(target, "Human fixture", requestId)).status, "queued");
  status = "accepted";
  assert.equal((await adapter.check!(target, requestId))?.status, "accepted");
  status = "completed";
  assert.equal((await adapter.check!(target, requestId))?.status, "unknown");
  status = "failed";
  assert.equal((await adapter.check!(target, requestId))?.status, "failed");
  assert.equal(sends, 1);
});

test("Antigravity rejects unrelated receipts and preserves uncertain delivery errors", async () => {
  const { runtime, adapter } = fixture();
  const target = { ...agent, app: "antigravity" as const };
  const requestId = randomUUID();
  runtime.antigravity = {
    inspectHumanConversation: async () => {},
    sendHumanMessage: async () => { throw Object.assign(new Error("preflight"), { deliveryState: "not_sent" }); },
    readHumanReceipt: async () => ({ requestId, conversationId: target.sessionId, cwd: target.cwd, surface: "desktop", sender: { provider: "codex", id: "another-sender" }, status: "accepted" }),
  };
  await assert.rejects(() => adapter.send(target, "Human fixture", requestId), { sent: false });
  runtime.antigravity.sendHumanMessage = async () => { throw Object.assign(new Error("lost acknowledgement"), { deliveryState: "unknown" }); };
  await assert.rejects(() => adapter.send(target, "Human fixture", requestId), error => (error as { sent?: boolean }).sent !== false);
  await assert.rejects(() => adapter.check!(target, requestId), /identity mismatch/);
});

test("a Claude session still awaiting a reply says so instead of a generic refusal, then frees up", async () => {
  const { state, adapter } = fixture();
  const claudeAgent = { ...agent, id: "claude-test", app: "claude", sessionId: "test", cwd: process.cwd() } as AgentInfo;
  state.policy = "accept";
  state.replyStatus = "pending";
  assert.equal((await adapter.inspect(claudeAgent)).available, true);
  await adapter.send(claudeAgent, "Human fixture", randomUUID());
  const blocked = await adapter.inspect(claudeAgent);
  assert.equal(blocked.available, false);
  assert.match(blocked.reason, /chưa xác nhận được phản hồi/);
  state.replyPending = true;
  await assert.rejects(adapter.send(claudeAgent, "Second", randomUUID()), (error: { sent?: boolean; reason?: string }) => error.sent === false && /tránh gửi chồng/.test(error.reason ?? ""));
  state.replyPending = false;
  state.replyStatus = "reply_received";
  assert.equal((await adapter.inspect(claudeAgent)).available, true);
});
