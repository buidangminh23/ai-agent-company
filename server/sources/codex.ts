import { L } from "../../shared/i18n.ts";
import { open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentInfo, AgentState, MachineId, PendingQuestion } from "../../shared/types.ts";
import { classifyRole } from "../../shared/roles.ts";
import { clip, mtimeMs, parseLines, projectName, readHead, readTail } from "./files.ts";
import { describeTool } from "../../shared/tools.ts";
import { canonicalPath, collectActivity } from "./activity.ts";
import { codexSentMessages } from "./messages.ts";

const ROOT = path.join(os.homedir(), ".codex", "sessions");
const VISIBLE_MS = 2 * 60 * 60_000;
const ACTIVE_MS = 3 * 60_000;
const headCache = new Map<string, { id: string; cwd: string; prompt: string; originator: string; model: string; branch: string; progress: string; parentId: string | null; agentPath: string; ownStart: number }>();

function progressText(rec: any): string {
  const payload = rec.payload ?? {};
  if (rec.type === "event_msg" && payload.type === "task_complete" && typeof payload.last_agent_message === "string") return requestText(payload.last_agent_message);
  if (rec.type !== "response_item" || payload.type !== "message" || payload.role !== "assistant" || !["commentary", "final", "final_answer"].includes(payload.channel ?? payload.phase)) return "";
  const parts: any[] = Array.isArray(payload.content) ? payload.content : [];
  return requestText(parts.filter((part) => part.type === "output_text" || part.type === "text").map((part) => part.text ?? "").join(" "));
}

function requestText(text: string): string {
  const request = text.includes("## My request:") ? text.split("## My request:").slice(1).join("## My request:") : text;
  const cleaned = request.replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "").trim();
  if (!cleaned || cleaned.startsWith("<") || /^# AGENTS\.md instructions\b/.test(cleaned)) return "";
  return clip(cleaned.replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|Bearer\s+[\w.\/-]+)/gi, L("[đã ẩn]")), 2000);
}

function dayDir(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return path.join(ROOT, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
}

async function recentRollouts(sinceMs: number): Promise<{ file: string; updatedAt: number; records: any[] }[]> {
  const out: { file: string; updatedAt: number; records: any[] }[] = [];
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  for (const dir of [dayDir(today), dayDir(yesterday)]) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const mtime = await mtimeMs(file);
      const head = await readHeadInfo(file);
      const records = parseLines(await readOwnTail(file, head.ownStart).catch(() => ""));
      const updatedAt = records.reduce((latest, rec) => Math.max(latest, Date.parse(rec.timestamp) || 0), mtime);
      if (updatedAt >= sinceMs) out.push({ file, updatedAt, records });
    }
  }
  return out;
}

function userText(payload: any): string {
  if (payload?.type !== "message" || payload.role !== "user") return "";
  const parts: any[] = Array.isArray(payload.content) ? payload.content : [];
  return requestText(parts.filter((p) => p.type === "input_text" || p.type === "text").map((p) => p.text ?? "").join(" "));
}

async function readHeadInfo(file: string) {
  const cached = headCache.get(file);
  if (cached) return cached;
  const info = { id: path.basename(file, ".jsonl"), cwd: "", prompt: "", originator: "", model: "", branch: "", progress: "", parentId: null as string | null, agentPath: "/root", ownStart: 0 };
  let hasIdentity = false;
  const raw = await readHead(file, 8 * 1024 * 1024);
  const lines = raw.split("\n");
  let ownOrdinal = 0;
  for (const [index, line] of lines.entries()) {
    const rec = parseLines(line)[0];
    if (!rec) continue;
    if (rec.type === "session_meta" && !hasIdentity) {
      hasIdentity = true;
      info.id = rec.payload?.id ?? info.id;
      info.cwd = rec.payload?.cwd ?? "";
      info.originator = rec.payload?.originator ?? "";
      info.branch = rec.payload?.git?.branch ?? "";
      info.parentId = rec.payload?.parent_thread_id ?? null;
      info.agentPath = rec.payload?.agent_path ?? (info.parentId ? "" : "/root");
      ownOrdinal = Number.isSafeInteger(rec.payload?.subagent_history_start_ordinal) ? rec.payload.subagent_history_start_ordinal : 0;
      info.ownStart = ownOrdinal > 0 ? Buffer.byteLength(lines.slice(0, ownOrdinal).join("\n") + "\n") : 0;
    }
    if (index < ownOrdinal) continue;
    if (rec.type === "turn_context" && typeof rec.payload?.model === "string") info.model = rec.payload.model;
    if (rec.type === "event_msg" && rec.payload?.type === "thread_settings_applied" && typeof rec.payload.thread_settings?.model === "string") info.model = rec.payload.thread_settings.model;
    const text = rec.type === "response_item" ? userText(rec.payload) : "";
    if (text && !info.prompt) info.prompt = text;
    const progress = progressText(rec);
    if (progress) info.progress = progress;
  }
  if (ownOrdinal >= lines.length) info.ownStart = Number.MAX_SAFE_INTEGER;
  else headCache.set(file, info);
  return info;
}

async function readOwnTail(file: string, ownStart: number): Promise<string> {
  if (!ownStart) return readTail(file, 128 * 1024);
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.min(size, Math.max(ownStart, size - 128 * 1024));
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > ownStart ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { await handle.close(); }
}

function callInput(p: any): Record<string, unknown> {
  const raw = p.input ?? p.arguments ?? "";
  let input: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      input = JSON.parse(raw);
    } catch {
      input = { command: raw };
    }
  } else if (raw && typeof raw === "object") {
    input = raw;
  }
  return input;
}

function callSummary(p: any): string {
  return clip(describeTool(String(p.name ?? "tool"), callInput(p)), 120);
}

function tailState(records: any[], fresh: boolean): { state: AgentState; detail: string; files: string[]; pending: PendingQuestion | null } {
  const files: string[] = [];
  let state: AgentState = fresh ? "thinking" : "idle";
  let detail = fresh ? L("Đang suy nghĩ") : "";
  let pending: PendingQuestion | null = null;
  let pendingCall: string | null = null;
  let asyncQuestion = false;
  let terminal = false;
  for (const rec of records) {
    const p = rec.payload ?? {};
    if (rec.type === "event_msg" && ["task_complete", "task_aborted", "turn_aborted"].includes(p.type)) {
      state = "idle";
      detail = clip(String(p.last_agent_message ?? (p.type === "task_complete" ? L("Đã xong lượt") : L("Đã dừng lượt"))), 90);
      pending = null;
      pendingCall = null;
      terminal = true;
    } else if (rec.type === "event_msg" && (p.type === "task_started" || p.type === "user_message")) {
      state = "thinking";
      detail = L("Đang suy nghĩ");
      pending = null;
      pendingCall = null;
      terminal = false;
    } else if (rec.type === "response_item" && p.type === "message" && p.role === "user" && userText(p)) {
      state = "thinking";
      detail = L("Đang suy nghĩ");
      pending = null;
      pendingCall = null;
      terminal = false;
    } else if (rec.type === "response_item" && p.type === "message" && p.role === "assistant" && ["final", "final_answer"].includes(p.channel ?? p.phase)) {
      state = "idle";
      detail = clip(progressText(rec) || L("Đã xong lượt"), 90);
      pending = null;
      pendingCall = null;
      terminal = true;
    } else if (terminal) {
      continue;
    } else if (rec.type === "response_item" && p.type === "reasoning") {
      state = "thinking";
      detail = L("Đang suy nghĩ");
    } else if (rec.type === "response_item" && (p.type === "custom_tool_call" || p.type === "function_call")) {
      const name = String(p.name ?? "").split(/[.:]/).pop();
      const asks = name === "request_user_input" || name === "request_user_input_async";
      state = asks ? "waiting" : "working";
      detail = callSummary(p);
      if (asks) {
        const input = callInput(p);
        const questions = Array.isArray(input.questions) ? input.questions : [];
        pending = {
          question: questions.map((q) => clip(String(q.question ?? q.title ?? L("Cần sếp trả lời")), 1000)).join("\n") || L("Cần sếp trả lời"),
          options: questions.flatMap((q) => (Array.isArray(q.options) ? q.options : []).map((o: any) => clip(String(typeof o === "string" ? o : o.label ?? ""), 160))).filter(Boolean),
          askedAt: Number.isFinite(Date.parse(rec.timestamp)) ? rec.timestamp : new Date(0).toISOString(),
        };
        pendingCall = typeof p.call_id === "string" ? p.call_id : null;
        asyncQuestion = name === "request_user_input_async";
      }
      const m = String(p.input ?? p.arguments ?? "").match(/[\w./\\-]+\.(tsx?|jsx?|py|css|md|ps1|sh|sql|vue|astro|json)/g);
      if (m) files.push(...m);
    } else if (rec.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(p.type) && pendingCall && p.call_id === pendingCall) {
      let output: any = p.output;
      if (typeof output === "string") {
        try { output = JSON.parse(output); } catch {}
      }
      if (!asyncQuestion || output?.answers || output?.error || output?.isError) {
        pending = null;
        pendingCall = null;
        state = "thinking";
        detail = L("Đang suy nghĩ");
      }
    }
  }
  if (pending) return { state: "waiting", detail: pending.question, files, pending };
  return { state, detail, files, pending: null };
}

export async function readCodex(machine: MachineId): Promise<AgentInfo[]> {
  const now = Date.now();
  const agents: AgentInfo[] = [];
  for (const { file, updatedAt, records } of await recentRollouts(now - VISIBLE_MS)) {
    const head = await readHeadInfo(file);
    const st = tailState(records, now - updatedAt < ACTIVE_MS);
    for (const rec of records) {
      if (rec.type === "turn_context" && typeof rec.payload?.model === "string") head.model = rec.payload.model;
      if (rec.type === "event_msg" && rec.payload?.type === "thread_settings_applied" && typeof rec.payload.thread_settings?.model === "string") head.model = rec.payload.thread_settings.model;
      const task = rec.type === "response_item" ? userText(rec.payload) : "";
      if (task && (!head.prompt || task.length >= 60)) head.prompt = task;
      const progress = progressText(rec);
      if (progress) head.progress = progress;
    }
    const id = `codex:${machine}:${head.id}`;
    agents.push({
      id,
      sent: codexSentMessages(records, id, now),
      app: "codex",
      machine,
      cwd: canonicalPath(head.cwd, head.cwd),
      sessionId: head.id,
      aliases: head.agentPath ? [head.agentPath] : [],
      nativeUrl: ["Codex Desktop", "codex_work_desktop"].includes(head.originator) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(head.id) ? `codex://threads/${head.id}` : undefined,
      ...collectActivity(records, head.cwd, "codex", now),
      title: clip(head.prompt || L("Luồng Codex"), 80),
      model: head.model || undefined,
      branch: head.branch || undefined,
      task: head.prompt || undefined,
      progress: head.progress || undefined,
      project: projectName(head.cwd),
      role: classifyRole(head.prompt, st.files),
      state: st.state,
      detail: st.detail,
      parentId: head.parentId ? `codex:${machine}:${head.parentId}` : null,
      updatedAt: new Date(updatedAt).toISOString(),
      pending: st.pending,
    });
  }
  return agents;
}

export async function countCodexToday(): Promise<number> {
  return (await readdir(dayDir(new Date())).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).length;
}
