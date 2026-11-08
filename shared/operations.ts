import { L } from "./i18n.ts";
import type { AgentInfo, MachineId, QuotaRow, Snapshot } from "./types.ts";

export type TaskStage = "working" | "waiting" | "testing" | "review" | "completed";
export interface AttentionItem {
  id: string;
  kind: "question" | "stalled" | "offline" | "failure" | "conflict";
  severity: "warning" | "error";
  title: string;
  detail: string;
  since: string;
  agentIds: string[];
  project?: string;
  machine?: MachineId;
  url?: string;
}
export interface TaskCard {
  id: string;
  agent: AgentInfo;
  stage: TaskStage;
  evidence: string;
  inferred: boolean;
  online: boolean;
}
export interface FileConflict {
  id: string;
  machine: MachineId;
  project: string;
  cwd: string;
  path: string;
  agentIds: string[];
  since: string;
}
export interface QuotaForecast extends QuotaRow {
  key: string;
  sampleCount: number;
  observedMinutes: number;
  pointsPerHour: number | null;
  exhaustedAt: string | null;
  beforeReset: boolean | null;
  note: string;
}
export interface HistoryCoverage {
  from: string | null;
  to: string | null;
  retentionDays: number;
  persistent: boolean;
  note: string;
}
export interface OperationsSnapshot {
  generatedAt: string;
  attention: AttentionItem[];
  tasks: TaskCard[];
  conflicts: FileConflict[];
  forecasts: QuotaForecast[];
  coverage: HistoryCoverage;
}
export interface HistoryEvent {
  id: number;
  at: string;
  kind: "agent" | "question" | "outcome" | "site" | "machine" | "deploy" | "alert";
  title: string;
  detail: string;
  agentId?: string;
  project?: string;
  machine?: MachineId;
  url?: string;
}
export interface HistoryResponse {
  events: HistoryEvent[];
  coverage: HistoryCoverage;
  truncated: boolean;
}
export interface ReplayFrame {
  at: string;
  snapshot: Snapshot;
}
export interface ReplayResponse {
  frames: ReplayFrame[];
  coverage: HistoryCoverage;
  truncated: boolean;
}
export interface DailyReport {
  date: string;
  timezone: "Asia/Ho_Chi_Minh";
  coverage: HistoryCoverage;
  completed: TaskCard[];
  review: TaskCard[];
  unfinished: TaskCard[];
  attention: AttentionItem[];
  events: HistoryEvent[];
  summary: string;
  truncated: boolean;
}
export interface QuotaSample {
  at: string;
  row: QuotaRow;
}

const STALL_MS = 10 * 60_000;
const WRITE_WINDOW_MS = 10 * 60_000;

export function taskCard(agent: AgentInfo, online: boolean): TaskCard {
  if (agent.pending || agent.state === "waiting") return { id: agent.id, agent, stage: "waiting", evidence: L("Đang chờ trả lời trong ứng dụng gốc"), inferred: false, online };
  if (agent.outcome?.status === "completed" && agent.outcome.verified === true) return { id: agent.id, agent, stage: "completed", evidence: agent.outcome.summary, inferred: false, online };
  if (agent.state === "idle" || agent.outcome?.status === "failed" || agent.outcome?.status === "aborted") return { id: agent.id, agent, stage: "review", evidence: agent.outcome?.summary || L("Chưa có bằng chứng nghiệm thu; kết thúc lượt không đồng nghĩa hoàn tất công việc"), inferred: false, online };
  if (agent.state === "working" && /\b(?:vitest|pytest|playwright|jest|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|tsc|kiểm thử|chạy test)\b/i.test(agent.detail)) return { id: agent.id, agent, stage: "testing", evidence: agent.detail, inferred: true, online };
  return { id: agent.id, agent, stage: "working", evidence: agent.detail || L("Đang thực hiện"), inferred: false, online };
}

function normalizePath(value: string, windows: boolean): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  const result = parts.join("/");
  return windows ? result.toLowerCase() : result;
}

export function fileConflicts(agents: AgentInfo[], machines: Snapshot["machines"], now: number): FileConflict[] {
  const online = new Set(machines.filter((m) => m.online).map((m) => m.id));
  const writes = new Map<string, FileConflict>();
  for (const agent of agents) {
    if (!online.has(agent.machine) || !agent.cwd || !["working", "thinking"].includes(agent.state)) continue;
    const windows = /^[a-z]:[\\/]/i.test(agent.cwd) || agent.cwd.startsWith("\\\\");
    const cwd = normalizePath(agent.cwd, windows);
    for (const file of agent.files ?? []) {
      const time = Date.parse(file.at);
      if (!Number.isFinite(time) || now - time > WRITE_WINDOW_MS || time > now + 30_000) continue;
      const path = normalizePath(/^(?:[a-z]:[\\/]|[\\/])/i.test(file.path) ? file.path : `${cwd}/${file.path}`, windows);
      const id = `${agent.machine}:${cwd}:${path}`;
      const conflict = writes.get(id) ?? { id, machine: agent.machine, project: agent.project, cwd, path, agentIds: [], since: file.at };
      if (!conflict.agentIds.includes(agent.id)) conflict.agentIds.push(agent.id);
      if (file.at < conflict.since) conflict.since = file.at;
      writes.set(id, conflict);
    }
  }
  return [...writes.values()].filter((conflict) => conflict.agentIds.length > 1);
}

export function deriveOperations(snapshot: Snapshot, coverage: HistoryCoverage, samples: QuotaSample[] = []): OperationsSnapshot {
  const now = Date.parse(snapshot.generatedAt);
  const online = new Set(snapshot.machines.filter((m) => m.online).map((m) => m.id));
  const tasks = snapshot.agents.map((agent) => taskCard(agent, online.has(agent.machine)));
  const conflicts = fileConflicts(snapshot.agents, snapshot.machines, now);
  const attention: AttentionItem[] = [];
  for (const agent of snapshot.agents) {
    if (!online.has(agent.machine)) continue;
    const base = { agentIds: [agent.id], project: agent.project, machine: agent.machine, url: agent.nativeUrl };
    if (agent.pending) attention.push({ ...base, id: `question:${agent.id}`, kind: "question", severity: "warning", title: agent.title, detail: agent.pending.question, since: agent.pending.askedAt });
    else if (["thinking", "working"].includes(agent.state) && now - Date.parse(agent.lastActivityAt ?? agent.updatedAt) >= STALL_MS) attention.push({ ...base, id: `stalled:${agent.id}`, kind: "stalled", severity: "warning", title: L("{0}: lâu chưa có hoạt động mới", agent.title), detail: agent.detail || L("Cần kiểm tra trong ứng dụng; đây là dấu hiệu, chưa kết luận bị treo"), since: agent.lastActivityAt ?? agent.updatedAt });
    if (agent.outcome?.status === "failed" || agent.outcome?.status === "aborted") attention.push({ ...base, id: `failure:${agent.id}`, kind: "failure", severity: "error", title: agent.title, detail: agent.outcome.summary, since: agent.outcome.at });
    if (agent.repeatedError && agent.repeatedError.count >= 3 && now - Date.parse(agent.repeatedError.at) <= 30 * 60_000) attention.push({ ...base, id: `repeated:${agent.id}`, kind: "failure", severity: "warning", title: L("{0}: công cụ lỗi lặp lại", agent.title), detail: L("{0} lần: {1}", agent.repeatedError.count, agent.repeatedError.summary), since: agent.repeatedError.at });
  }
  for (const machine of snapshot.machines) {
    if (!machine.online && machine.source !== "none") attention.push({ id: `offline:${machine.id}`, kind: "offline", severity: "warning", title: L("{0}: mất kết nối collector", machine.id), detail: L("Không có dữ liệu mới từ máy; chưa thể kết luận agent đã dừng"), since: machine.checkedAt, agentIds: [], machine: machine.id });
  }
  for (const site of snapshot.sites) {
    if (!site.ok) attention.push({ id: `site:${site.url}`, kind: "failure", severity: "error", title: site.label, detail: site.note, since: site.checkedAt, agentIds: [], url: site.url });
  }
  if (snapshot.projects.connected) for (const repo of snapshot.projects.repos) {
    if (/failure|failed|error|timed_out|action_required/i.test(repo.ci ?? "")) attention.push({ id: `ci:${repo.name}`, kind: "failure", severity: "error", title: L("{0}: CI lỗi", repo.name), detail: repo.ci!, since: snapshot.projects.fetchedAt ?? snapshot.generatedAt, agentIds: [], project: repo.name, url: repo.url });
    if (repo.deploy && /failure|failed|error/i.test(repo.deploy.state)) attention.push({ id: `deploy:${repo.name}`, kind: "failure", severity: "error", title: L("{0}: deploy lỗi", repo.name), detail: `${repo.deploy.environment}: ${repo.deploy.state}`, since: repo.deploy.at, agentIds: [], project: repo.name, url: repo.url });
  }
  for (const conflict of conflicts) attention.push({ id: `conflict:${conflict.id}`, kind: "conflict", severity: "warning", title: L("Hai agent sửa cùng file"), detail: conflict.path, since: conflict.since, agentIds: conflict.agentIds, project: conflict.project, machine: conflict.machine });
  attention.sort((a, b) => a.since.localeCompare(b.since));
  return { generatedAt: snapshot.generatedAt, attention, tasks, conflicts, forecasts: snapshot.quota.connected ? snapshot.quota.rows.map((row) => quotaForecast(row, samples, now)) : [], coverage };
}

export function quotaKey(row: QuotaRow): string {
  return JSON.stringify([row.app, row.account, row.window]);
}

export function quotaForecast(row: QuotaRow, samples: QuotaSample[], now: number): QuotaForecast {
  const key = quotaKey(row);
  const recent = [...new Map(samples.filter((s) => quotaKey(s.row) === key && s.row.resetsAt === row.resetsAt && Number.isFinite(s.row.remaining) && s.row.remaining >= 0 && s.row.remaining <= 100 && Date.parse(s.at) >= now - 6 * 3_600_000 && Date.parse(s.at) <= now).map((s) => [s.at, s])).values()].sort((a, b) => a.at.localeCompare(b.at));
  let start = 0;
  for (let i = 1; i < recent.length; i++) if (recent[i].row.remaining > recent[i - 1].row.remaining + 0.01) start = i;
  const window = recent.slice(start);
  const observedMinutes = window.length > 1 ? (Date.parse(window.at(-1)!.at) - Date.parse(window[0].at)) / 60_000 : 0;
  const base: QuotaForecast = { ...row, key, sampleCount: window.length, observedMinutes, pointsPerHour: null, exhaustedAt: null, beforeReset: null, note: L("Cần ít nhất 3 mẫu trong 10 phút cùng kỳ hạn mức") };
  if (!Number.isFinite(row.remaining) || row.remaining < 0 || row.remaining > 100) return { ...base, note: L("Nguồn chưa cung cấp tỷ lệ hạn mức hợp lệ") };
  if (row.resetsAt && Date.parse(row.resetsAt) <= now) return { ...base, note: L("Đã tới giờ reset; chờ nguồn cập nhật kỳ mới") };
  if (window.length < 3 || observedMinutes < 10) return base;
  const consumed = window[0].row.remaining - window.at(-1)!.row.remaining;
  if (consumed <= 0) return { ...base, pointsPerHour: 0, note: L("Chưa ghi nhận mức sử dụng tăng trong khoảng quan sát") };
  const pointsPerHour = consumed * 60 / observedMinutes;
  const exhausted = now + Math.max(0, row.remaining) / pointsPerHour * 3_600_000;
  if (!Number.isFinite(exhausted) || exhausted > 8.64e15) return base;
  const beforeReset = row.resetsAt && Number.isFinite(Date.parse(row.resetsAt)) ? exhausted < Date.parse(row.resetsAt) : null;
  return { ...base, pointsPerHour, exhaustedAt: new Date(exhausted).toISOString(), beforeReset, note: beforeReset === false ? L("Dự kiến reset trước khi hết; ước tính theo tốc độ gần đây") : L("Ước tính theo tốc độ gần đây, có thể thay đổi") };
}
