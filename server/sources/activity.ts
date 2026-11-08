import path from "node:path";
import type { AgentInfo } from "../../shared/types.ts";

const WRITE_WINDOW_MS = 10 * 60_000;
const MAX_FILES = 80;

export function canonicalPath(value: unknown, cwd: string): string | undefined {
  if (typeof value !== "string" || !value.trim() || /[\r\n\0]/.test(value)) return undefined;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd) || /^[a-z]:[\\/]|^\\\\/i.test(value);
  const platform = windows ? path.win32 : path.posix;
  if (!platform.isAbsolute(value) && !platform.isAbsolute(cwd)) return undefined;
  const resolved = platform.resolve(cwd, value.trim());
  return windows ? resolved.replace(/\\/g, "/").toLowerCase() : resolved;
}

function inputOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch { return { patch: value }; }
  }
  return {};
}

export function writePaths(name: string, raw: unknown, cwd: string): string[] {
  const tool = name.split(/[.:]/).pop()?.split("__").pop()?.toLowerCase() ?? "";
  const input = inputOf(raw);
  const values: unknown[] = [];
  if (["edit", "multiedit", "write", "write_file", "edit_file", "notebookedit"].includes(tool)) {
    values.push(input.file_path ?? input.path ?? input.notebook_path);
  }
  if (tool === "apply_patch") {
    const patch = String(input.patch ?? input.input ?? input.command ?? "");
    for (const match of patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) values.push(match[1].trim());
  }
  if (tool === "exec" && typeof raw === "string") {
    for (const match of raw.matchAll(/\btools\.apply_patch\(\s*("(?:[^"\\]|\\.)*")\s*\)/g)) {
      try { values.push(...writePaths("apply_patch", JSON.parse(match[1]), cwd)); } catch {}
    }
  }
  return [...new Set(values.map((value) => canonicalPath(value, cwd)).filter((value): value is string => Boolean(value)))].slice(0, MAX_FILES);
}

type ActivityMetadata = Pick<AgentInfo, "files" | "lastActivityAt" | "outcome" | "repeatedError">;

function failedResult(value: unknown, depth = 0): boolean {
  if (depth > 4 || !value) return false;
  if (typeof value === "string") {
    if (value.length > 256 * 1024) return false;
    try { return failedResult(JSON.parse(value), depth + 1); } catch { return false; }
  }
  if (typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  if (result.is_error === true || result.isError === true || typeof result.exit_code === "number" && result.exit_code !== 0) return true;
  if (Array.isArray(result.content)) return result.content.some((part) => part?.type === "text" && failedResult(part.text, depth + 1));
  return result.structuredContent ? failedResult(result.structuredContent, depth + 1) : false;
}

function isoAt(value: unknown): string | undefined {
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

function userPrompt(content: unknown): boolean {
  if (typeof content === "string") return Boolean(content.trim()) && !content.trim().startsWith("<") && !content.startsWith("# AGENTS.md");
  return Array.isArray(content) && content.some((part) => ["text", "input_text"].includes(part?.type) && userPrompt(part.text));
}

export function collectActivity(records: any[], cwd: string, app: "codex" | "claude", now = Date.now()): ActivityMetadata {
  const writes = new Map<string, string>();
  let outcome: AgentInfo["outcome"];
  let lastActivityAt: string | undefined;
  const failures = new Map<string, string>();
  for (const record of records) {
    const at = isoAt(record.timestamp);
    if (!at) continue;
    const p = app === "codex" ? record.payload ?? {} : record.message ?? {};
    const user = app === "codex"
      ? record.type === "event_msg" && ["task_started", "user_message"].includes(p.type) || record.type === "response_item" && p.type === "message" && p.role === "user" && userPrompt(p.content)
      : record.type === "user" && !record.isMeta && userPrompt(p.content);
    if (user) {
      writes.clear();
      outcome = undefined;
      failures.clear();
    }
    const relevant = app === "codex" ? ["event_msg", "response_item"].includes(record.type) : ["assistant", "user"].includes(record.type);
    if (!relevant) continue;
    if (!lastActivityAt || at > lastActivityAt) lastActivityAt = at;
    if (app === "codex" && record.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(p.type) && typeof p.call_id === "string" && failedResult(p.output)) failures.set(p.call_id, at);
    if (app === "claude" && record.type === "user" && Array.isArray(p.content)) {
      for (const part of p.content) if (part?.type === "tool_result" && typeof part.tool_use_id === "string" && part.is_error === true) failures.set(part.tool_use_id, at);
    }
    const tools = app === "codex"
      ? record.type === "response_item" && ["function_call", "custom_tool_call"].includes(p.type) ? [{ name: p.name, input: p.input ?? p.arguments }] : []
      : Array.isArray(p.content) ? p.content.filter((part: any) => part.type === "tool_use") : [];
    for (const tool of tools) {
      if (Date.parse(at) < now - WRITE_WINDOW_MS || Date.parse(at) > now + 60_000) continue;
      for (const file of writePaths(String(tool.name ?? ""), tool.input, cwd)) writes.set(file, at);
    }
    const terminal = app === "codex"
      ? record.type === "event_msg" && ["task_complete", "task_aborted", "turn_aborted"].includes(p.type) ? p.type : record.type === "response_item" && p.role === "assistant" && ["final", "final_answer"].includes(p.channel ?? p.phase) ? "end_turn" : null
      : record.type === "assistant" && p.stop_reason === "end_turn" ? "end_turn" : null;
    if (terminal) outcome = { status: terminal.includes("aborted") ? "aborted" : "completed", at, summary: terminal.includes("aborted") ? "Ứng dụng ghi nhận lượt bị dừng" : "Ứng dụng ghi nhận kết thúc lượt; chưa xác minh kết quả công việc", verified: false };
  }
  const repeatedError = failures.size >= 3 ? { count: failures.size, at: [...failures.values()].sort().at(-1)!, summary: `${failures.size} lần gọi công cụ khác nhau báo lỗi trong lượt hiện tại` } : undefined;
  return { files: [...writes].slice(-MAX_FILES).map(([file, at]) => ({ path: file, at })), lastActivityAt, outcome, repeatedError };
}
