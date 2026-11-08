import { MACHINE_ORDER, type AgentApp, type MachineId, type MessageStatus, type MessageTarget, type MessageVia, type SentMessage } from "../../shared/types.ts";

export const WINDOW_MS = 10 * 60_000;
const SUMMARY_MAX = 110;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SECRET_PATTERN = /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|Bearer\s+[\w.\/-]+)/gi;
const CODEX_BRIDGE = /^mcp__codex[-_]bridge(?:-desktop)?__(send_to_codex_thread|delegate_to_codex|start_codex_thread)$/;
const ANTIGRAVITY_BRIDGE = /^mcp__antigravity[-_]bridge__(send_to_antigravity_conversation|start_antigravity_cli_session)$/;
const CLAUDE_BRIDGE_SERVERS = new Set(["claude-bridge", "claude_bridge"]);
const ANTIGRAVITY_BRIDGE_SERVERS = new Set(["antigravity-bridge", "antigravity_bridge"]);
const DELIVERY_FAILED = new Set(["failed", "send_failed", "refused", "rejected", "denied", "expired", "cancelled", "canceled", "aborted"]);
const AGENT_BRIDGE_CALL = '{"Arguments":';
const AGENT_BRIDGE_SEND = "send_to_agent_task";
const OUTBOUND_APPS: Record<string, AgentApp> = { claude: "claude", codex: "codex" };
const OUTBOUND_FALLBACK: Record<string, string> = { claude: "Antigravity gửi việc sang Claude", codex: "Antigravity gửi việc sang Codex" };

interface Call {
  id: string;
  at: string;
  tool: string;
  input: any;
  result: string;
  failed: boolean;
  completed?: boolean;
  updatedAt?: string;
  status?: MessageStatus;
}

function record(value: unknown): Record<string, any> {
  if (typeof value === "string") {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function statusOf(value: unknown): MessageStatus {
  const status = typeof value === "string" ? value.toLowerCase() : "";
  if (DELIVERY_FAILED.has(status)) return "failed";
  if (["queued", "pending"].includes(status)) return "queued";
  if (["sending", "dispatching", "in_progress"].includes(status)) return "sending";
  if (status === "accepted") return "accepted";
  if (["delivered", "received", "acknowledged"].includes(status)) return "delivered";
  if (["replied", "answered", "reply_received"].includes(status)) return "replied";
  return "unknown";
}

function callStatus(call: Call): MessageStatus {
  if (call.status) return call.status;
  const result = record(call.result);
  if (result.accountChanged || result.outcome === "unknown" || ["sent_unconfirmed", "reply_timeout", "interrupted", "unconfirmed"].includes(result.status)) return "unknown";
  if (result.responseStatus === "completed" && typeof result.text === "string" && result.text.trim()) return "replied";
  if (result.deliveryStatus) return statusOf(result.deliveryStatus);
  if (call.failed) return "failed";
  if (result.isError === true || result.error) return "failed";
  if (DELIVERY_FAILED.has(call.result.trim().toLowerCase())) return "failed";
  const status = statusOf(result.status ?? result.deliveryStatus);
  if (status !== "unknown") return status;
  if (result.acknowledged === true || result.delivered === true) return "delivered";
  return call.completed ? "unknown" : "sending";
}

function targetMachine(input: any): MachineId | undefined {
  const value = input?.targetMachine ?? input?.machine ?? input?.hostId;
  return MACHINE_ORDER.includes(value) ? value : undefined;
}

export function socketKey(machine: MachineId, socket: string): string {
  let value = socket.replace(/^uds:/i, "");
  try {
    value = decodeURIComponent(value);
  } catch {}
  const base = value.split(/[\\/]/).filter(Boolean).pop() ?? value;
  return `sock:${machine}:${base.toLowerCase()}`;
}

export function messageSummary(text: unknown, explicit?: unknown): string {
  const given = typeof explicit === "string" ? explicit.trim() : "";
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = lines[0]?.match(/^\[From [^\]·]+(?:·[^\]·]*)*·\s*([^\]]+)\](?:\s|$)/i);
  const body = lines.find((line) => !line.startsWith("[From ") && !line.startsWith("#")) ?? "";
  const picked = given || header?.[1]?.trim() || body || lines[0] || "";
  if (/^gAAAAA[A-Za-z0-9_-]{40,}={0,2}$/.test(picked)) return "Nội dung trao đổi đã mã hóa";
  const plain = picked.replace(SECRET_PATTERN, "[đã ẩn]").replace(/[*`>#]|(^|\s)_+|_+(?=\s|$)/g, "$1").replace(/\s+/g, " ").trim();
  return plain.length > SUMMARY_MAX ? `${plain.slice(0, SUMMARY_MAX - 1)}…` : plain;
}

function matchAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] ?? m[0]);
}

function resultIds(result: string, kind: "thread" | "conversation" | "claude"): string[] {
  if (kind === "claude") return [...matchAll(result, new RegExp(`\\b(local_${UUID})\\b`, "gi")), ...matchAll(result, new RegExp(`session[_ ]?id["'\\s:=]+(${UUID})`, "gi"))];
  return matchAll(result, new RegExp(`${kind}[_ ]?id["'\\s:=]+(${UUID})`, "gi"));
}

function textOfResult(content: unknown): string {
  if (typeof content === "string") {
    const parsed = record(content);
    return parsed.structuredContent || parsed.content ? textOfResult(parsed) : content;
  }
  if (Array.isArray(content)) return content.map((part) => textOfResult(typeof part === "string" ? part : part?.text ?? "")).join("\n");
  if (content && typeof content === "object") {
    const value = content as any;
    if (value.structuredContent) return JSON.stringify(value.structuredContent.receipt ?? value.structuredContent.creation ?? value.structuredContent);
    return textOfResult(value.content ?? JSON.stringify(content));
  }
  return "";
}

function unique(values: unknown[]): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()))];
}

function message(ownerId: string, call: Call, via: MessageVia, app: AgentApp, keys: string[], text: unknown, cwd?: unknown, explicit?: unknown): SentMessage | null {
  const target: MessageTarget = { app, keys: unique(keys) };
  if (typeof cwd === "string" && cwd.trim()) target.cwd = cwd.trim();
  const machine = targetMachine(call.input);
  if (machine) target.machine = machine;
  const summary = messageSummary(text, explicit) || `Gửi việc sang ${app}`;
  const replyTo = call.input?.replyTo ?? record(call.result).replyTo;
  return {
    id: `${ownerId}:${call.id}`, at: call.at, via, summary, target, status: callStatus(call), updatedAt: call.updatedAt ?? call.at,
    ...(typeof replyTo === "string" && replyTo ? { replyTo } : {}),
    ...(callStatus(call) === "failed" ? { detail: "Kênh gửi báo lỗi; chưa xác nhận máy đích nhận được." } : {}),
  };
}

function claudeTarget(machine: MachineId, to: string): string[] {
  return to.toLowerCase().startsWith("uds:") ? [socketKey(machine, to)] : [to];
}

function fromClaudeCall(ownerId: string, machine: MachineId, call: Call): SentMessage | null {
  const input = call.input ?? {};
  if (call.tool === "SendMessage" && typeof input.to === "string") return message(ownerId, call, "claude", "claude", claudeTarget(machine, input.to), input.message, undefined, input.summary);
  const codex = call.tool.match(CODEX_BRIDGE);
  if (codex) {
    const keys = codex[1] === "send_to_codex_thread" ? [input.threadId] : resultIds(call.result, "thread");
    return message(ownerId, call, "codex-bridge", "codex", keys, input.prompt ?? input.message, codex[1] === "send_to_codex_thread" ? undefined : input.cwd, input.name);
  }
  const antigravity = call.tool.match(ANTIGRAVITY_BRIDGE);
  if (antigravity) {
    const keys = antigravity[1] === "send_to_antigravity_conversation" ? [input.conversationId] : resultIds(call.result, "conversation");
    return message(ownerId, call, "antigravity-bridge", "antigravity", keys, input.prompt ?? input.message, input.cwd);
  }
  return null;
}

function deliveryOutcomes(calls: Call[]): Call[] {
  const out = new Map<string, { status: MessageStatus; at: string }>();
  const key = (call: Call, value: Record<string, any>) => {
    const scope = call.tool.match(/mcp__([^_]+(?:_[^_]+)*)__/)?.[1]?.replaceAll("_", "-") ?? "";
    const id = value.requestId ?? value.msgId ?? value.deliveryId;
    return scope && typeof id === "string" ? `${scope}:${id}` : "";
  };
  for (const call of calls) {
    const seen = record(call.result);
    const id = key(call, seen);
    if (!id || typeof seen.status !== "string" && typeof seen.deliveryStatus !== "string") continue;
    const at = call.updatedAt ?? call.at;
    const known = out.get(id);
    if (!known || at >= known.at) out.set(id, { status: callStatus(call), at });
  }
  return calls.map((call) => {
    const outcome = out.get(key(call, record(call.result)) || key(call, call.input ?? {}));
    return outcome ? { ...call, status: outcome.status, updatedAt: outcome.at } : call;
  });
}

function recent(messages: (SentMessage | null)[], now: number): SentMessage[] {
  return messages.filter((m): m is SentMessage => m !== null && Number.isFinite(Date.parse(m.updatedAt ?? m.at)) && now - Date.parse(m.updatedAt ?? m.at) <= WINDOW_MS && Date.parse(m.at) <= now);
}

export function claudeSentMessages(records: any[], ownerId: string, machine: MachineId, now = Date.now()): SentMessage[] {
  const calls = new Map<string, Call>();
  for (const rec of records) {
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (rec.type === "assistant" && part?.type === "tool_use" && typeof part.id === "string") {
        calls.set(part.id, { id: part.id, at: String(rec.timestamp ?? new Date(0).toISOString()), tool: String(part.name ?? ""), input: part.input, result: "", failed: false });
      }
      if (rec.type === "user" && part?.type === "tool_result" && calls.has(part.tool_use_id)) {
        const call = calls.get(part.tool_use_id)!;
        call.result = textOfResult(part.content);
        call.failed = part.is_error === true;
        call.completed = true;
        call.updatedAt = String(rec.timestamp ?? call.at);
      }
    }
  }
  const settled = deliveryOutcomes([...calls.values()]);
  return recent(settled.map((call) => fromClaudeCall(ownerId, machine, call)), now);
}

function fromCodexCall(ownerId: string, call: Call, server: string): SentMessage | null {
  const input = call.input ?? {};
  const qualified = call.tool.match(/^(?:functions\.)?mcp__([^_]+(?:_[^_]+)*)__([^_].*)$/);
  if (qualified) { server = qualified[1]; call = { ...call, tool: qualified[2] }; }
  if (CLAUDE_BRIDGE_SERVERS.has(server) && (call.tool === "send_to_claude_session" || call.tool === "start_claude_session")) {
    const named = typeof input.target === "string" && !["auto", "new"].includes(input.target) ? input.target : undefined;
    const keys = [input.expectedTaskId, named, ...resultIds(call.result, "claude")];
    return message(ownerId, call, "claude-bridge", "claude", keys, input.message ?? input.prompt, input.expectedCwd ?? input.cwd);
  }
  if (ANTIGRAVITY_BRIDGE_SERVERS.has(server) && (call.tool === "send_to_antigravity_conversation" || call.tool === "start_antigravity_cli_session")) {
    const keys = call.tool === "send_to_antigravity_conversation" ? [input.conversationId] : resultIds(call.result, "conversation");
    return message(ownerId, call, "antigravity-bridge", "antigravity", keys, input.prompt ?? input.message, input.cwd);
  }
  if (["codex-bridge", "codex_bridge", "codex-bridge-desktop"].includes(server)) {
    return fromClaudeCall(ownerId, ownerMachine(ownerId) ?? "WORKSTATION", { ...call, tool: `mcp__${server}__${call.tool}` });
  }
  const native = call.tool.match(/^(?:collaboration|functions)\.(send_message|followup_task|spawn_agent|send_input)$/);
  if (native) {
    const result = record(call.result);
    const keys = [input.target, input.id, result.agent_id, result.agentId, result.task_name];
    const machine = ownerMachine(ownerId);
    const status = callStatus(call);
    const accepted = call.completed && status === "unknown" && (typeof result.submission_id === "string" || typeof result.agent_id === "string" || typeof result.task_name === "string");
    return message(ownerId, { ...call, input: { ...input, ...(machine ? { targetMachine: machine } : {}) }, ...(accepted ? { status: "accepted" } : {}) }, "agent-bridge", "codex", keys, input.message ?? input.prompt);
  }
  return null;
}

function ownerMachine(ownerId: string): MachineId | undefined {
  return MACHINE_ORDER.find((machine) => ownerId.includes(`:${machine}:`));
}

export function codexSentMessages(records: any[], ownerId: string, now = Date.now()): SentMessage[] {
  const calls = new Map<string, Call>();
  const servers = new Map<string, string>();
  for (const rec of records) {
    const payload = rec?.payload;
    const at = String(rec.timestamp ?? new Date(0).toISOString());
    const item = payload?.item;
    if (rec?.type === "event_msg" && ["item_started", "item_completed"].includes(payload?.type) && item?.type === "McpToolCall" && typeof item.id === "string") {
      const previous = calls.get(item.id);
      calls.set(item.id, { id: item.id, at: previous?.at ?? at, updatedAt: at, tool: String(item.tool ?? previous?.tool ?? ""), input: record(item.arguments ?? previous?.input), result: textOfResult(item.result), failed: Boolean(item.error) || item.result?.isError === true || item.status === "failed", completed: payload.type === "item_completed" });
      servers.set(item.id, String(item.server ?? ""));
    }
    if (!["response_item", "response_msg"].includes(rec?.type) || typeof payload?.call_id !== "string") continue;
    if (payload.type === "function_call") {
      const name = String(payload.name ?? "");
      const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
      const tool = namespace && !name.includes(".") && !name.startsWith("mcp__") ? `${namespace}${namespace.startsWith("mcp__") ? "__" : "."}${name}` : name;
      calls.set(payload.call_id, { id: payload.call_id, at, tool, input: record(payload.arguments), result: "", failed: false });
    } else if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const call = calls.get(payload.call_id);
      if (!call) continue;
      const output = record(payload.output);
      call.result = textOfResult(payload.output);
      call.failed = payload.is_error === true || output.isError === true || Boolean(output.error);
      call.completed = true;
      call.updatedAt = at;
    }
  }
  const qualified = [...calls.values()].map((call) => servers.get(call.id) ? { ...call, tool: `mcp__${servers.get(call.id)}__${call.tool}` } : call);
  return recent(deliveryOutcomes(qualified).map((call) => fromCodexCall(ownerId, call, "")), now);
}

function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let quoted = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

export function agentBridgePrompts(payloads: string[], requestIds: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const payload of payloads) {
    for (let at = payload.indexOf(AGENT_BRIDGE_CALL); at >= 0; at = payload.indexOf(AGENT_BRIDGE_CALL, at + 1)) {
      const raw = balancedObject(payload, at);
      if (!raw) continue;
      try {
        const call = JSON.parse(raw);
        const args = call?.Arguments;
        if (call?.ToolName === AGENT_BRIDGE_SEND && requestIds.has(args?.requestId) && typeof args.prompt === "string") out.set(args.requestId, args.prompt);
      } catch {}
    }
  }
  return out;
}

function outboundMessage(ownerId: string, receipt: any, prompts: ReadonlyMap<string, string>): SentMessage | null {
  const app = OUTBOUND_APPS[receipt?.surface];
  const at = typeof receipt?.createdAt === "string" ? receipt.createdAt : "";
  if (!app || typeof receipt.requestId !== "string" || !Number.isFinite(Date.parse(at))) return null;
  const result = receipt.result ?? {};
  const call: Call = { id: receipt.requestId, at, tool: AGENT_BRIDGE_SEND, input: receipt, result: JSON.stringify(receipt), failed: false, completed: true, updatedAt: typeof receipt.updatedAt === "string" ? receipt.updatedAt : at };
  const keys = [result.taskId, result.sessionId, result.threadId, receipt.conversationId];
  return message(ownerId, call, "agent-bridge", app, keys, prompts.get(receipt.requestId) ?? OUTBOUND_FALLBACK[receipt.surface], receipt.cwd ?? result.cwd);
}

export function antigravitySentMessages(receipts: any[], ownerId: string, conversationId: string, prompts: ReadonlyMap<string, string>, now = Date.now()): SentMessage[] {
  const own = receipts.filter((receipt) => receipt?.sender?.provider === "antigravity" && receipt.sender.id === conversationId);
  return recent(own.map((receipt) => outboundMessage(ownerId, receipt, prompts)), now);
}
