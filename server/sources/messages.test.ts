import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentInfo } from "../../shared/types.ts";
import { resolveMessages } from "../../shared/messages.ts";
import { agentBridgePrompts, antigravitySentMessages, claudeSentMessages, codexSentMessages, messageSummary, socketKey } from "./messages.ts";

const NOW = Date.parse("2026-10-31T05:00:00Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();
const THREAD = "01a02434-3b66-7f81-bef6-9d7959dfcb7a";
const TASK = "local_0529775f-5db1-4d75-a497-47f4bd9e7a9c";

const use = (id: string, name: string, input: unknown, seconds = -30) => ({ type: "assistant", timestamp: at(seconds), message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, text: string, isError = false) => ({ type: "user", timestamp: at(-29), message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] } });

function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return { id, app: "claude", machine: "WORKSTATION", title: id, project: "p", role: null, state: "working", detail: "", parentId: null, updatedAt: at(0), pending: null, ...extra };
}

test("socket keys ignore uds prefix, encoding and case", () => {
  assert.equal(socketKey("WORKSTATION", "uds:\\\\.\\pipe\\LOCAL\\cc-msg-ABC"), "sock:WORKSTATION:cc-msg-abc");
  assert.equal(socketKey("WORKSTATION", "uds:%5C%5C.%5Cpipe%5CLOCAL%5Ccc-msg-abc"), "sock:WORKSTATION:cc-msg-abc");
  assert.equal(socketKey("LAPTOP", "/tmp/cc-socks/123.sock"), "sock:LAPTOP:123.sock");
});

test("summaries prefer the explicit summary, then the brief purpose, and hide secrets", () => {
  assert.equal(messageSummary("long text", "Reply: done"), "Reply: done");
  assert.equal(messageSummary("[From Claude · AI Agent Company · website features]\n## Goal\nShip it"), "website features");
  assert.equal(messageSummary("## Goal\nUse token ghp_abcdefghijklmnopqrstuvwx now"), "Use token [đã ẩn] now");
  assert.equal(messageSummary("[From Antigravity · codex-mcp-bridge · Outbound verification] ANTIGRAVITY_OK. Observed sender"), "Outbound verification");
  assert.equal(messageSummary("[From Claude · App · x]yz trailing"), "[From Claude · App · x]yz trailing");
});

test("Claude SendMessage and codex-bridge calls become sent messages", () => {
  const records = [
    use("a", "SendMessage", { to: "uds:\\\\.\\pipe\\LOCAL\\cc-msg-abc", summary: "Hand over 0.3.13", message: "..." }),
    use("b", "mcp__codex-bridge__send_to_codex_thread", { threadId: THREAD, prompt: "[From Claude · App · Fix API]\n## Goal" }),
    use("c", "mcp__codex-bridge__delegate_to_codex", { cwd: "C:\\Work", prompt: "## Goal\nBuild it" }),
    result("c", `Created Codex thread\n  threadId: ${THREAD}\n  cwd: C:\\Work`),
    use("d", "mcp__codex-bridge-desktop__send_to_codex_thread", { threadId: THREAD, prompt: "x" }),
    result("d", "refused", true),
    use("e", "mcp__codex-bridge__send_to_codex_thread", { threadId: THREAD, prompt: "old" }, -3600),
    use("f", "mcp__codex-bridge__start_codex_thread", { cwd: "C:\Work" }),
    result("f", `threadId: ${THREAD}`),
  ];
  const sent = claudeSentMessages(records, "claude:WORKSTATION:s1", "WORKSTATION", NOW);
  assert.deepEqual(sent.map((m) => [m.via, m.target.app, m.target.keys, m.summary]), [
    ["claude", "claude", ["sock:WORKSTATION:cc-msg-abc"], "Hand over 0.3.13"],
    ["codex-bridge", "codex", [THREAD], "Fix API"],
    ["codex-bridge", "codex", [THREAD], "Build it"],
    ["codex-bridge", "codex", [THREAD], "x"],
    ["codex-bridge", "codex", [THREAD], "Gửi việc sang codex"],
  ]);
  assert.equal(sent[2].target.cwd, "C:\\Work");
  assert.equal(sent[3].status, "failed");
});

test("Codex claude-bridge calls target the native task id and cwd", () => {
  const records = [
    { type: "event_msg", timestamp: at(-20), payload: { type: "item_completed", item: { type: "McpToolCall", id: "exec-1", server: "claude-bridge", tool: "send_to_claude_session", arguments: { target: "auto", expectedCwd: "C:\\Work", expectedTaskId: TASK, message: "[From Codex · Work · Coordinate fixes]\n## Goal" }, result: { content: [{ type: "text", text: "{}" }] } } } },
    { type: "event_msg", timestamp: at(-10), payload: { type: "item_completed", item: { type: "McpToolCall", id: "exec-2", server: "claude-bridge", tool: "list_claude_sessions", arguments: {} } } },
  ];
  const sent = codexSentMessages(records, `codex:WORKSTATION:${THREAD}`, NOW);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { app: "claude", keys: [TASK], cwd: "C:\\Work" });
  assert.equal(sent[0].summary, "Coordinate fixes");
});

test("hub resolves recipients by socket, task id, thread id and a unique cwd", () => {
  const codex = agent(`codex:WORKSTATION:${THREAD}`, { app: "codex", sessionId: THREAD, cwd: "C:/Work" });
  const peer = agent("claude:WORKSTATION:peer", { aliases: ["sock:WORKSTATION:cc-msg-abc", TASK], cwd: "C:/Work" });
  const sender = agent("claude:WORKSTATION:s1", {
    sent: [
      { id: "m1", at: at(-30), via: "claude", summary: "a", target: { app: "claude", keys: ["sock:WORKSTATION:cc-msg-abc"] } },
      { id: "m2", at: at(-20), via: "codex-bridge", summary: "b", target: { app: "codex", keys: [THREAD] } },
      { id: "m3", at: at(-10), via: "codex-bridge", summary: "c", target: { app: "codex", keys: [], cwd: "c:\\work\\" } },
      { id: "m4", at: at(-5), via: "claude", summary: "d", target: { app: "claude", keys: ["nobody"] } },
    ],
  });
  const fromCodex = agent(codex.id, { ...codex, sent: [{ id: "m5", at: at(-1), via: "claude-bridge", summary: "e", target: { app: "claude", keys: [TASK] } }] });
  const messages = resolveMessages([sender, peer, fromCodex]);
  assert.deepEqual(messages.map((m) => [m.id, m.fromId, m.toId]), [
    ["m1", sender.id, peer.id],
    ["m2", sender.id, codex.id],
    ["m3", sender.id, codex.id],
    ["m4", sender.id, ""],
    ["m5", codex.id, peer.id],
  ]);
});

test("an ambiguous cwd or a message to itself is not resolved", () => {
  const a = agent("codex:1", { app: "codex", cwd: "C:/Work" });
  const b = agent("codex:2", { app: "codex", cwd: "C:/Work" });
  const sender = agent("claude:s", { aliases: ["me"], sent: [
    { id: "x", at: at(0), via: "codex-bridge", summary: "", target: { app: "codex", keys: [], cwd: "C:/Work" } },
    { id: "y", at: at(0), via: "claude", summary: "", target: { app: "claude", keys: ["me"] } },
  ] });
  assert.deepEqual(resolveMessages([sender, a, b]).map((message) => [message.id, message.toId]), [["x", ""], ["y", ""]]);
});

test("antigravity sends follow their delivery receipt", () => {
  const CONVERSATION = "0a78456c-330e-4394-90c2-6ec08c1d8de5";
  const send = (id: string, requestId: string, seconds: number) => use(id, "mcp__antigravity-bridge__send_to_antigravity_conversation", { requestId, conversationId: CONVERSATION, cwd: "C:\\Work", surface: "desktop", prompt: `[From Claude · Work · ${id}]` }, seconds);
  const status = (id: string, requestId: string, value: string) => result(id, JSON.stringify({ requestId, status: value, conversationId: CONVERSATION }));
  const records = [
    send("busy", "r-busy", -60), status("busy", "r-busy", "pending"),
    use("busy-read", "mcp__antigravity-bridge__read_antigravity_delivery", { requestId: "r-busy", surface: "desktop" }, -59), status("busy-read", "r-busy", "failed"),
    send("ok", "r-ok", -50), status("ok", "r-ok", "pending"),
    use("ok-read", "mcp__antigravity-bridge__read_antigravity_delivery", { requestId: "r-ok", surface: "desktop" }, -49), status("ok-read", "r-ok", "accepted"),
    send("fresh", "r-fresh", -5), status("fresh", "r-fresh", "pending"),
    send("quiet", "r-quiet", -45), status("quiet", "r-quiet", "pending"),
  ];
  const sent = claudeSentMessages(records, "claude:WORKSTATION:s", "WORKSTATION", NOW);
  assert.deepEqual(sent.map((m) => [m.summary, m.status]), [["busy", "failed"], ["ok", "accepted"], ["fresh", "queued"], ["quiet", "queued"]]);
});

test("Antigravity agent-bridge receipts become messages to the exact Claude task or Codex thread", () => {
  const ANTIGRAVITY = "ef25cdde-19d5-47a3-a35a-fd1b565103d0";
  const SESSION = "40e3435e-9aff-4b6a-b653-302b0dab72a6";
  const receipt = (requestId: string, surface: string, status: string, seconds: number, result: Record<string, string>, sender = ANTIGRAVITY) => ({
    requestId, status, surface, cwd: "C:\Work", createdAt: at(seconds), conversationId: result.sessionId ?? result.threadId, sender: { provider: "antigravity", id: sender }, result,
  });
  const receipts = [
    receipt("to-claude", "claude", "sent_unconfirmed", -60, { taskId: TASK, sessionId: SESSION }),
    receipt("to-codex", "codex", "accepted", -50, { threadId: THREAD }),
    receipt("refused", "codex", "refused", -40, { threadId: THREAD }),
    receipt("fresh", "codex", "pending", -5, { threadId: THREAD }),
    receipt("old", "codex", "accepted", -3600, { threadId: THREAD }),
    receipt("other", "codex", "accepted", -30, { threadId: THREAD }, "0a78456c-330e-4394-90c2-6ec08c1d8de5"),
  ];
  const prompts = new Map([["to-claude", "[From Antigravity · Work · Background bridge check]\nbody"]]);
  const sender = agent(`antigravity:WORKSTATION:${ANTIGRAVITY}`, { app: "antigravity", sessionId: ANTIGRAVITY, sent: antigravitySentMessages(receipts, `antigravity:WORKSTATION:${ANTIGRAVITY}`, ANTIGRAVITY, prompts, NOW) });
  assert.deepEqual(sender.sent!.map((m) => [m.via, m.target.app, m.summary]), [
    ["agent-bridge", "claude", "Background bridge check"],
    ["agent-bridge", "codex", "Antigravity gửi việc sang Codex"],
    ["agent-bridge", "codex", "Antigravity gửi việc sang Codex"],
    ["agent-bridge", "codex", "Antigravity gửi việc sang Codex"],
  ]);
  const claude = agent("claude:task", { sessionId: SESSION, aliases: [TASK] });
  const codex = agent("codex:thread", { app: "codex", sessionId: THREAD });
  assert.deepEqual(resolveMessages([sender, claude, codex]).map((m) => [m.fromId, m.toId]), [[sender.id, claude.id], [sender.id, codex.id], [sender.id, codex.id], [sender.id, codex.id]]);
  assert.deepEqual(sender.sent!.map((m) => m.status), ["unknown", "accepted", "failed", "queued"]);
});

test("agent-bridge prompts are read only from send_to_agent_task calls with a known requestId", () => {
  const call = (tool: string, args: object) => `\u0012\rcall_mcp_tool\u001a\u0006${JSON.stringify({ Arguments: args, ServerName: "agent-bridge", ToolName: tool })}:\u00c3binary{`;
  const payloads = [
    call("send_to_agent_task", { requestId: "a", prompt: "Hello {\"nested\"} }" }) + call("read_agent_delivery", { requestId: "b" }),
    call("send_to_agent_task", { requestId: "b", prompt: "ignored, unknown id" }),
    '{"Arguments":{"requestId":"a"',
  ];
  assert.deepEqual([...agentBridgePrompts(payloads, new Set(["a", "c"]))], [["a", 'Hello {"nested"} }']]);
});

test("pending attempts never become successful with age and missing identities remain visible", () => {
  const records = [
    use("queued", "mcp__codex_bridge__start_codex_thread", { prompt: "Queue work" }, -300),
    result("queued", JSON.stringify({ requestId: "pending-1", status: "pending" })),
    use("active", "mcp__codex_bridge__send_to_codex_thread", { threadId: THREAD, prompt: "Sending" }, -60),
  ];
  const messages = claudeSentMessages(records, "source", "WORKSTATION", NOW);
  assert.deepEqual(messages.map((message) => message.status), ["queued", "sending"]);
  assert.deepEqual(messages[0].target.keys, []);
  assert.equal(claudeSentMessages(records, "source", "WORKSTATION", NOW + 60_000)[0].status, "queued");
});

test("Codex function calls retain errors and distinguish acceptance, receipt and reply evidence", () => {
  const call = (id: string, type: string, args: unknown, name = "mcp__claude_bridge__send_to_claude_session") => ({ type, timestamp: at(-10), payload: { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) } });
  const output = (id: string, value: unknown) => ({ type: "response_item", timestamp: at(-5), payload: { type: "function_call_output", call_id: id, output: JSON.stringify(value) } });
  const args = { expectedTaskId: TASK, message: "Coordinate", targetMachine: "LAPTOP" };
  const records = [
    call("accepted", "response_item", args), output("accepted", { status: "accepted" }),
    call("delivered", "response_msg", args), output("delivered", { status: "delivered" }),
    call("reply", "response_item", { ...args, replyTo: "first" }), output("reply", { status: "replied" }),
    call("error", "response_item", args), output("error", { isError: true, error: "Bearer secret_should_not_be_copied" }),
    call("unknown", "response_item", args), output("unknown", { ok: true }),
    call("native", "response_item", { id: THREAD, message: "Native handoff" }, "functions.send_input"), output("native", { submission_id: "submission-1" }),
    call("inspect", "response_item", {}, "mcp__claude_bridge__list_claude_sessions"), output("inspect", {}),
  ];
  const messages = codexSentMessages(records, "codex:WORKSTATION:sender", NOW);
  assert.deepEqual(messages.map((message) => message.status), ["accepted", "delivered", "replied", "failed", "unknown", "accepted"]);
  assert.equal(messages[0].target.machine, "LAPTOP");
  assert.equal(messages[2].replyTo, "first");
  assert.doesNotMatch(JSON.stringify(messages), /secret_should_not_be_copied/);
  assert.deepEqual(messages[5].target, { app: "codex", keys: [THREAD], machine: "WORKSTATION" });
});

test("a later receipt updates the original attempt without creating a second message", () => {
  const records = [
    use("send", "mcp__antigravity-bridge__send_to_antigravity_conversation", { requestId: "r", conversationId: THREAD, prompt: "Work" }, -100),
    result("send", JSON.stringify({ requestId: "r", status: "accepted" })),
    use("read", "mcp__antigravity-bridge__read_antigravity_delivery", { requestId: "r" }, -20),
    { ...result("read", JSON.stringify({ requestId: "r", status: "delivered" })), timestamp: at(-2) },
  ];
  const messages = claudeSentMessages(records, "sender", "WORKSTATION", NOW);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "sender:send");
  assert.equal(messages[0].at, at(-100));
  assert.equal(messages[0].updatedAt, at(-2));
  assert.equal(messages[0].status, "delivered");
});

test("native Codex namespace fields and empty completion results do not invent delivery", () => {
  const records = [
    { type: "response_item", timestamp: at(-4), payload: { type: "function_call", call_id: "native", namespace: "collaboration", name: "send_message", arguments: JSON.stringify({ target: "/root/reviewer", message: "Review work" }) } },
    { type: "response_item", timestamp: at(-3), payload: { type: "function_call_output", call_id: "native", output: "" } },
    { type: "response_item", timestamp: at(-2), payload: { type: "function_call", call_id: "bridge", namespace: "mcp__claude_bridge", name: "send_to_claude_session", arguments: JSON.stringify({ expectedTaskId: TASK, message: "Review" }) } },
    { type: "response_item", timestamp: at(-1), payload: { type: "function_call_output", call_id: "bridge", output: "aborted" } },
  ];
  const messages = codexSentMessages(records, "codex:WORKSTATION:source", NOW);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].status, "unknown");
  assert.deepEqual(messages[0].target.keys, ["/root/reviewer"]);
  assert.equal(messages[1].status, "failed");
});

test("structured bridge receipts preserve reply evidence and later correlated updates", () => {
  const call = (id: string, tool: string, args: unknown) => ({ type: "response_item", timestamp: at(-10), payload: { type: "function_call", call_id: id, name: `mcp__claude_bridge__${tool}`, arguments: JSON.stringify(args) } });
  const output = (id: string, receipt: unknown, isError = false) => ({ type: "response_item", timestamp: at(-5), payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ content: [{ type: "text", text: "Bridge result" }], structuredContent: { receipt }, isError }) } });
  const messages = codexSentMessages([
    call("send", "send_to_claude_session", { target: "auto", expectedTaskId: TASK, message: "Work" }),
    output("send", { msgId: "message-id", status: "sent_unconfirmed" }),
    call("read", "read_claude_delivery", { msgId: "message-id" }),
    output("read", { msgId: "message-id", status: "reply_received" }),
    call("interrupted", "send_to_claude_session", { expectedTaskId: TASK, message: "Other work" }),
    output("interrupted", { msgId: "interrupted-id", status: "interrupted", outcome: "unknown" }, true),
  ], "codex:WORKSTATION:source", NOW);
  assert.deepEqual(messages.map((entry) => entry.status), ["replied", "unknown"]);
});

test("Codex structured completion distinguishes answer from accepted request", () => {
  const records = [
    use("send", "mcp__codex_bridge__send_to_codex_thread", { threadId: THREAD, prompt: "Work" }),
    result("send", JSON.stringify({ content: [{ type: "text", text: "Completed" }], structuredContent: { deliveryId: "delivery", deliveryStatus: "accepted", responseStatus: "completed", status: "completed", text: "Result" } })),
  ];
  assert.equal(claudeSentMessages(records, "source", "WORKSTATION", NOW)[0].status, "replied");
});

test("encrypted native messages use a readable placeholder and preserve accepted task identity", () => {
  const encrypted = `gAAAAA${"x".repeat(80)}`;
  assert.equal(messageSummary(encrypted), "Nội dung trao đổi đã mã hóa");
  const messages = codexSentMessages([
    { type: "response_item", timestamp: at(-2), payload: { type: "function_call", call_id: "spawn", namespace: "collaboration", name: "spawn_agent", arguments: JSON.stringify({ task_name: "worker", message: encrypted }) } },
    { type: "response_item", timestamp: at(-1), payload: { type: "function_call_output", call_id: "spawn", output: JSON.stringify({ task_name: "/root/worker" }) } },
  ], "codex:WORKSTATION:source", NOW);
  assert.equal(messages[0].status, "accepted");
  assert.deepEqual(messages[0].target.keys, ["/root/worker"]);
  assert.doesNotMatch(messages[0].summary, /gAAAAA/);
});
