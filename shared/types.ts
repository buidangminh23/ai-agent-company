import { L } from "./i18n.ts";
export type AgentApp = "claude" | "codex" | "antigravity";
export type AgentState = "thinking" | "working" | "waiting" | "idle";
export type MachineId = "WORKSTATION" | "SERVER" | "LAPTOP";
export const MACHINE_ORDER: readonly MachineId[] = ["WORKSTATION", "LAPTOP", "SERVER"];

export const MACHINE_LABELS: Record<MachineId, string> = { WORKSTATION: L("Máy chính"), LAPTOP: "Laptop", SERVER: L("Máy chủ") };

export function byMachineOrder(a: MachineId, b: MachineId): number {
  return MACHINE_ORDER.indexOf(a) - MACHINE_ORDER.indexOf(b);
}

export type RoleId =
  | "po" | "ba" | "marketing" | "content" | "cskh" | "hr" | "admin" | "sales"
  | "backend" | "frontend" | "uiux" | "test" | "devops" | "ai" | "data" | "system";

export interface PendingQuestion {
  question: string;
  options: string[];
  askedAt: string;
  kind?: "question" | "decision";
}

export type MessageVia = "claude" | "codex-bridge" | "claude-bridge" | "antigravity-bridge" | "agent-bridge";
export type MessageStatus = "queued" | "sending" | "accepted" | "delivered" | "replied" | "failed" | "unknown";

export interface MessageTarget {
  app: AgentApp;
  keys: string[];
  cwd?: string;
  machine?: MachineId;
}

export interface SentMessage {
  id: string;
  at: string;
  via: MessageVia;
  summary: string;
  target: MessageTarget;
  status?: MessageStatus;
  updatedAt?: string;
  detail?: string;
  replyTo?: string;
}

export interface AgentMessage {
  id: string;
  fromId: string;
  toId: string;
  at: string;
  via: MessageVia;
  summary: string;
  status?: MessageStatus;
  updatedAt?: string;
  detail?: string;
  replyTo?: string;
  targetMachine?: MachineId;
  targetLabel?: string;
}

export interface AgentInfo {
  id: string;
  aliases?: string[];
  sent?: SentMessage[];
  cwd?: string;
  sessionId?: string;
  files?: { path: string; at: string }[];
  lastActivityAt?: string;
  outcome?: { status: "completed" | "failed" | "aborted"; at: string; summary: string; verified?: boolean };
  nativeUrl?: string;
  repeatedError?: { count: number; at: string; summary: string };
  app: AgentApp;
  machine: MachineId;
  title: string;
  model?: string;
  branch?: string;
  task?: string;
  progress?: string;
  recap?: string;
  project: string;
  role: RoleId | null;
  state: AgentState;
  detail: string;
  parentId: string | null;
  updatedAt: string;
  pending: PendingQuestion | null;
}

export interface GpuStats {
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  tempC: number | null;
  powerW: number | null;
}

export interface MachineHealth {
  id: MachineId;
  online: boolean;
  source: "local" | "collector" | "none";
  cpu: number | null;
  cpuModel: string | null;
  cores: number | null;
  memUsed: number | null;
  memTotal: number | null;
  netRxBps: number | null;
  netTxBps: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  gpu: GpuStats | null;
  os: string | null;
  lanIp: string | null;
  tailscaleIp: string | null;
  uptimeSec: number | null;
  checkedAt: string;
}

export interface SiteStatus {
  url: string;
  label: string;
  status: number | null;
  ok: boolean;
  latencyMs: number | null;
  checkedAt: string;
  note: string;
}

export interface QuotaRow {
  app: string;
  account: string;
  window: string;
  remaining: number;
  resetsAt: string | null;
}

export interface QuotaSnapshot {
  connected: boolean;
  rows: QuotaRow[];
  fetchedAt: string | null;
}

export interface ActivitySnapshot {
  tasksToday: number;
  activeProjects: number;
  agentsWorking: number;
  machinesOnline: number;
  machinesTotal: number;
}

export interface MetricSource {
  connected: boolean;
  note: string;
}

export interface SkillGroup {
  source: string;
  count: number;
  names: string[];
}

export interface SkillsSnapshot extends MetricSource {
  total: number;
  groups: SkillGroup[];
}

export interface RepoInfo {
  name: string;
  url: string;
  isPrivate: boolean;
  isArchived: boolean;
  pushedAt: string;
  release: { tag: string; publishedAt: string } | null;
  deploy: { environment: string; state: string; at: string } | null;
  ci: string | null;
}

export interface ProjectsSnapshot extends MetricSource {
  repos: RepoInfo[];
  fetchedAt: string | null;
}

export interface Snapshot {
  generatedAt: string;
  agents: AgentInfo[];
  messages: AgentMessage[];
  machines: MachineHealth[];
  sites: SiteStatus[];
  quota: QuotaSnapshot;
  activity: ActivitySnapshot;
  skills: SkillsSnapshot;
  projects: ProjectsSnapshot;
}
