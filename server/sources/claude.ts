import { L } from "../../shared/i18n.ts";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentInfo, AgentState, MachineId, PendingQuestion } from "../../shared/types.ts";
import { classifyRole } from "../../shared/roles.ts";
import { clip, clipLines, isAlive, mtimeMs, parseLines, projectName, readHead, readTail } from "./files.ts";
import { describeTool } from "../../shared/tools.ts";
import { canonicalPath, collectActivity } from "./activity.ts";
import { claudeSentMessages, socketKey } from "./messages.ts";

const HOME = os.homedir();
const SESSIONS = path.join(HOME, ".claude", "sessions");
const PROJECTS = path.join(HOME, ".claude", "projects");
const transcriptCache = new Map<string, string>();
const firstPromptCache = new Map<string, string>();
const metadataCache = new Map<string, Pick<AgentInfo, "model" | "branch" | "task" | "progress" | "recap">>();
const WRAP_UP_TOOL = "mcp__ccd_turn__wrap_up";
const SECRET_PATTERN = /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{16,}|Bearer\s+[\w.\/-]+)/gi;
const APP_ACTION_LABELS: Record<string, string> = {
  commit: "Commit",
  create_pr: L("Tạo PR"),
  merge: L("Gộp PR"),
  fix_ci: L("Sửa CI"),
  resolve_conflicts: L("Gỡ xung đột"),
  address_comments: L("Xử lý góp ý"),
  verify: L("Kiểm tra"),
  archive: L("Lưu trữ phiên"),
  new_session: L("Mở phiên mới"),
};

function cleanRequest(text: string): string {
  const request = text.includes("## My request:") ? text.split("## My request:").slice(1).join("## My request:") : text;
  const cleaned = request.replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, "").trim();
  if (!cleaned || cleaned.startsWith("<") || /^# AGENTS\.md instructions\b/.test(cleaned)) return "";
  return cleaned.replace(SECRET_PATTERN, L("[đã ẩn]"));
}

function requestText(text: string): string {
  return clip(cleanRequest(text), 2000);
}

function reportText(text: string): string {
  return clipLines(cleanRequest(text), 6000);
}

function wrapUpOf(content: unknown): any {
  return Array.isArray(content) ? content.find((part) => part?.type === "tool_use" && part.name === WRAP_UP_TOOL) ?? null : null;
}

function readMetadata(file: string, records: any[], prompt: string): Pick<AgentInfo, "model" | "branch" | "task" | "progress" | "recap"> {
  const metadata = metadataCache.get(file) ?? { task: prompt || undefined };
  for (const rec of records) {
    if (typeof rec.gitBranch === "string") metadata.branch = rec.gitBranch || undefined;
    if (rec.type === "assistant" && typeof rec.message?.model === "string" && rec.message.model !== "<synthetic>") metadata.model = rec.message.model;
    if (rec.type === "assistant") {
      const progress = reportText(textOf(rec.message?.content));
      if (progress) metadata.progress = progress;
      const recap = wrapUpOf(rec.message?.content)?.input?.recap;
      if (typeof recap === "string" && recap.trim()) metadata.recap = clipLines(recap.replace(SECRET_PATTERN, L("[đã ẩn]")), 600);
    }
    if (rec.type === "user" && rec.message?.role === "user" && !rec.isMeta) {
      const task = requestText(textOf(rec.message.content));
      if (task) metadata.recap = undefined;
      if (task && (!metadata.task || task.length >= 60)) metadata.task = task;
    }
  }
  metadataCache.set(file, metadata);
  return metadata;
}

async function findTranscript(sessionId: string): Promise<string | null> {
  const cached = transcriptCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  for (const dir of await readdir(PROJECTS).catch(() => [] as string[])) {
    const file = path.join(PROJECTS, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      transcriptCache.set(sessionId, file);
      return file;
    }
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((p) => p?.type === "text").map((p) => p.text).join(" ");
  return "";
}

function decisionOf(wrap: any, askedAt: string): PendingQuestion | null {
  const ask = wrap?.input?.ask;
  if (typeof ask !== "string" || !ask.trim()) return null;
  const actions: any[] = Array.isArray(wrap.input.actions) ? wrap.input.actions : [];
  const options = actions.map((a) => clip(String(a?.label || APP_ACTION_LABELS[a?.action] || a?.action || ""), 40)).filter(Boolean);
  return { question: clip(ask, 220), options, askedAt, kind: "decision" };
}

async function firstPrompt(file: string): Promise<string> {
  const cached = firstPromptCache.get(file);
  if (cached !== undefined) return cached;
  let prompt = "";
  for (const rec of parseLines(await readHead(file, 256 * 1024))) {
    if (rec.type !== "user" || rec.message?.role !== "user") continue;
    if (rec.isMeta) continue;
    const t = requestText(textOf(rec.message.content));
    if (!t) continue;
    prompt = t;
    break;
  }
  firstPromptCache.set(file, prompt);
  return prompt;
}

function toolSummary(tool: any): string {
  return clip(describeTool(String(tool.name ?? "tool"), tool.input ?? {}), 120);
}

interface TailState {
  state: AgentState;
  detail: string;
  files: string[];
  pending: PendingQuestion | null;
  at: string;
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  return Number(value) || Date.parse(value) || 0;
}

function readState(records: any[], busy: boolean | null, statusAt = 0): TailState {
  const files: string[] = [];
  let last: any = null;
  let ask: any = null;
  let askedAt = new Date(0).toISOString();
  let decision: PendingQuestion | null = null;
  for (const rec of records) {
    if (rec.type !== "assistant" && rec.type !== "user") continue;
    const content = rec.message?.content;
    if (rec.type === "user" && !rec.isMeta && requestText(textOf(content))) {
      ask = null;
      decision = null;
    }
    if (rec.type === "assistant") {
      const wrap = wrapUpOf(content);
      if (wrap) decision = decisionOf(wrap, rec.timestamp ?? new Date(0).toISOString());
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "tool_result" && part.tool_use_id === ask?.id) ask = null;
        if (part.type === "tool_use" && part.input?.file_path) files.push(String(part.input.file_path));
        if (rec.type === "assistant" && part.type === "tool_use" && (part.name === "AskUserQuestion" || part.name === "ExitPlanMode")) {
          ask = part;
          askedAt = rec.timestamp ?? new Date(0).toISOString();
        }
      }
    }
    if (rec.type === "assistant" && rec.message?.stop_reason === "end_turn") ask = null;
    last = rec;
  }
  const at = last?.timestamp ?? new Date(0).toISOString();
  if (!last) return { state: busy ? "thinking" : "idle", detail: "", files, pending: null, at };
  const parts: any[] = Array.isArray(last.message?.content) ? last.message.content : [];
  if (busy === false && statusAt >= timestamp(at)) return { state: "idle", detail: clip(textOf(last.message?.content), 90), files, pending: decision, at };
  if (last.type === "assistant" && last.message?.stop_reason === "end_turn" && !(busy === true && statusAt > timestamp(at))) return { state: "idle", detail: clip(textOf(last.message.content), 90), files, pending: decision, at };
  if (ask) {
    const q = ask.input?.questions?.[0];
    const pending: PendingQuestion = {
      question: clip(q?.question ?? (ask.name === "ExitPlanMode" ? L("Duyệt kế hoạch?") : L("Cần sếp trả lời")), 220),
      options: (q?.options ?? []).map((o: any) => clip(String(o.label ?? o), 60)),
      askedAt,
      kind: "question",
    };
    return { state: "waiting", detail: pending.question, files, pending, at };
  }
  if (busy === false && !statusAt) return { state: "idle", detail: clip(textOf(last.message?.content), 90), files, pending: decision, at };
  const tool = parts.filter((p) => p.type === "tool_use").pop();
  if (last.type === "assistant" && tool) return { state: "working", detail: toolSummary(tool), files, pending: null, at };
  if (parts.some((p) => p.type === "thinking")) return { state: "thinking", detail: L("Đang suy nghĩ"), files, pending: null, at };
  return { state: busy === null ? "idle" : "thinking", detail: busy === null ? "" : L("Đang suy nghĩ"), files, pending: null, at };
}

async function listFiles(dir: string, suffix: string, out: string[] = []): Promise<string[]> {
  for (const ent of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await listFiles(full, suffix, out);
    else if (ent.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

async function readSubagents(parent: AgentInfo, transcript: string, machine: MachineId): Promise<AgentInfo[]> {
  const dir = path.join(path.dirname(transcript), path.basename(transcript, ".jsonl"), "subagents");
  const out: AgentInfo[] = [];
  const now = Date.now();
  for (const metaFile of await listFiles(dir, ".meta.json")) {
    const jsonl = metaFile.replace(/\.meta\.json$/, ".jsonl");
    const mtime = await mtimeMs(jsonl);
    let meta: any = {};
    try {
      meta = JSON.parse(await readFile(metaFile, "utf8"));
    } catch {}
    const records = parseLines(await readTail(jsonl, 48 * 1024));
    const latestAt = records.reduce((latest, rec) => Math.max(latest, timestamp(rec.timestamp)), mtime);
    if (now - latestAt >= 90_000 && (meta.finished || now - latestAt > 2 * 60 * 60_000)) continue;
    const st = readState(records, meta.finished ? false : now - latestAt < 90_000 ? true : null, meta.finished ? latestAt : 0);
    const prompt = await firstPrompt(jsonl);
    const title = clip(meta.description || meta.agentType || "Subagent", 80);
    const id = `claude:${machine}:${path.basename(jsonl, ".jsonl")}`;
    out.push({
      id,
      sent: claudeSentMessages(records, id, machine, now),
      app: "claude",
      machine,
      cwd: parent.cwd,
      sessionId: path.basename(jsonl, ".jsonl"),
      ...collectActivity(records, parent.cwd ?? "", "claude", now),
      title,
      ...readMetadata(jsonl, records, prompt),
      project: parent.project,
      role: classifyRole(`${title} ${meta.agentType ?? ""} ${prompt}`, st.files),
      state: st.state,
      detail: st.detail,
      parentId: parent.id,
      updatedAt: new Date(latestAt).toISOString(),
      pending: st.pending,
    });
  }
  return out;
}

export async function readClaude(machine: MachineId): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];
  for (const name of await readdir(SESSIONS).catch(() => [] as string[])) {
    if (!/^\d+\.json$/.test(name)) continue;
    let s: any;
    try {
      s = JSON.parse(await readFile(path.join(SESSIONS, name), "utf8"));
    } catch {
      continue;
    }
    if (s.entrypoint === "codex-bridge" || !s.sessionId || !isAlive(Number(s.pid))) continue;
    const transcript = await findTranscript(s.sessionId);
    const busy = s.status === "busy" ? true : s.status === "idle" ? false : null;
    const records = transcript ? parseLines(await readTail(transcript, 96 * 1024)) : [];
    const statusAt = timestamp(s.statusUpdatedAt ?? s.updatedAt);
    const st = readState(records, busy, statusAt);
    const prompt = transcript ? await firstPrompt(transcript) : "";
    const id = `claude:${machine}:${s.sessionId}`;
    const agent: AgentInfo = {
      id,
      aliases: [typeof s.messagingSocketPath === "string" ? socketKey(machine, s.messagingSocketPath) : "", s.hostSessionId, s.name].filter((v): v is string => typeof v === "string" && v !== ""),
      sent: claudeSentMessages(records, id, machine),
      app: "claude",
      machine,
      cwd: canonicalPath(s.cwd, s.cwd ?? ""),
      sessionId: s.sessionId,
      ...collectActivity(records, s.cwd ?? "", "claude"),
      title: clip(s.name || prompt || L("Phiên Claude"), 80),
      ...(transcript ? readMetadata(transcript, metadataCache.has(transcript) ? records : [...parseLines(await readHead(transcript, 256 * 1024)), ...records], prompt) : {}),
      project: projectName(s.cwd ?? ""),
      role: classifyRole(`${s.name ?? ""} ${prompt}`, st.files),
      state: st.state,
      detail: st.detail,
      parentId: null,
      updatedAt: new Date(Math.max(statusAt, timestamp(st.at))).toISOString(),
      pending: st.pending,
    };
    agents.push(agent);
    if (transcript) agents.push(...(await readSubagents(agent, transcript, machine)));
  }
  return agents;
}

export async function countClaudeToday(): Promise<number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  let n = 0;
  for (const dir of await readdir(PROJECTS).catch(() => [] as string[])) {
    for (const f of await readdir(path.join(PROJECTS, dir)).catch(() => [] as string[])) {
      if (f.endsWith(".jsonl") && (await mtimeMs(path.join(PROJECTS, dir, f))) >= start.getTime()) n++;
    }
  }
  return n;
}
