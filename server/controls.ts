import { L } from "../shared/i18n.ts";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentApp, AgentInfo, MachineId } from "../shared/types.ts";
import type { AgentControlState, ControlAction, ControlCapability, ControlList, ControlModel, ControlReceipt, ControlSettingsChange, ControlStatus, ControlSubmission } from "../shared/controls.ts";

export type NativeControlState = Pick<AgentControlState, "approvals" | "questions" | "stop" | "settings">;

export interface NativeControlContext {
  author: "human-web";
  requestId: string;
  signal: AbortSignal;
}

export interface NativeControlResult {
  status: "done" | "stale" | "unknown";
  detail?: string;
}

export interface NativeControlAdapter {
  app: "claude" | "codex";
  state(agent: AgentInfo, signal: AbortSignal): Promise<NativeControlState>;
  stop(agent: AgentInfo, context: NativeControlContext): Promise<NativeControlResult>;
  settings(agent: AgentInfo, change: ControlSettingsChange, context: NativeControlContext): Promise<NativeControlResult>;
}

export interface ControlBrokerOptions {
  adapters: NativeControlAdapter[];
  file?: string;
  timeoutMs?: number;
  send?: (agents: AgentInfo[]) => Promise<Map<string, ControlCapability>>;
}

interface ControlRow extends ControlReceipt {
  digest: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MACHINES: readonly MachineId[] = ["WORKSTATION", "SERVER", "LAPTOP"];
const ACTIONS: readonly ControlAction[] = ["stop", "settings"];
const CONTROL_APPS: readonly AgentApp[] = ["claude", "codex", "antigravity"];
const STATUS_TEXT: Record<ControlStatus, string> = {
  pending: L("Đang gửi thao tác tới ứng dụng gốc; không gửi lại"),
  done: L("Ứng dụng gốc đã xác nhận thao tác"),
  rejected: L("Trạng thái agent đã thay đổi hoặc thao tác không còn hợp lệ; chưa gửi"),
  unknown: L("Chưa xác nhận được kết quả; không tự gửi lại, kiểm tra trong ứng dụng gốc"),
};
export const CONTROL_UNVERIFIED = L("Không xác minh được kênh điều khiển trong ứng dụng gốc");
const NO_ADAPTER = L("Ứng dụng chưa có kênh điều khiển trực tiếp đã xác minh");
const NO_STORE = L("Không lưu được biên nhận; dừng và đổi cài đặt từ web đang tắt");
const NO_SEND = L("Chưa có kênh gửi tin nhắn đã xác minh");
const SEND_FAILED = L("Không xác minh được kênh gửi tin nhắn");
const ANTIGRAVITY: NativeControlState = {
  approvals: { available: false, reason: L("Antigravity chưa có kênh duyệt đã xác minh từ web; thao tác trong app") },
  questions: { available: false, reason: L("Antigravity chưa có kênh trả lời đã xác minh từ web; thao tác trong app") },
  stop: { available: false, reason: L("Antigravity chưa có kênh dừng đã xác minh từ web; thao tác trong app"), warning: "" },
  settings: { available: false, reason: L("Antigravity chưa có kênh đổi cài đặt đã xác minh từ web; thao tác trong app"), model: null, effort: null, models: [] },
};

export class ControlBrokerError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0");
}

function plain(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function controlCapability(value: unknown): ControlCapability | null {
  if (!record(value) || typeof value.available !== "boolean" || !plain(value.reason, 500)) return null;
  return { available: value.available, reason: value.reason };
}

function model(value: unknown): ControlModel | null {
  if (!record(value) || !text(value.id, 200) || !plain(value.label, 200) || !Array.isArray(value.efforts) || value.efforts.length > 16 || !value.efforts.every((effort) => text(effort, 200)) || new Set(value.efforts).size !== value.efforts.length) return null;
  return { id: value.id, label: value.label || value.id, efforts: [...value.efforts as string[]] };
}

export function controlState(value: unknown): NativeControlState | null {
  if (!record(value) || !record(value.stop) || !record(value.settings)) return null;
  const approvals = controlCapability(value.approvals), questions = controlCapability(value.questions), stop = controlCapability(value.stop), settings = controlCapability(value.settings);
  const { warning } = value.stop;
  const { model: current, effort, models } = value.settings;
  if (!approvals || !questions || !stop || !settings || !plain(warning, 1000) || (current !== null && !text(current, 200)) || (effort !== null && !text(effort, 200)) || !Array.isArray(models) || models.length > 64) return null;
  const listed = models.map(model);
  if (listed.some((item) => !item) || new Set(listed.map((item) => item!.id)).size !== listed.length) return null;
  return { approvals, questions, stop: { ...stop, warning }, settings: { ...settings, model: current as string | null, effort: effort as string | null, models: listed as ControlModel[] } };
}

export function unavailableControl(reason: string): NativeControlState {
  return {
    approvals: { available: false, reason },
    questions: { available: false, reason },
    stop: { available: false, reason, warning: "" },
    settings: { available: false, reason, model: null, effort: null, models: [] },
  };
}

export function controlSubmission(value: unknown): ControlSubmission {
  const invalid = () => new ControlBrokerError(400, L("Dữ liệu điều khiển không hợp lệ"));
  if (!record(value)) throw invalid();
  if (typeof value.requestId !== "string" || !UUID.test(value.requestId) || !text(value.agentId, 300) || !MACHINES.includes(value.machine as MachineId) || !ACTIONS.includes(value.action as ControlAction)) throw invalid();
  const body: ControlSubmission = { requestId: value.requestId.toLowerCase(), agentId: value.agentId, machine: value.machine as MachineId, action: value.action as ControlAction };
  if (body.action === "stop") {
    if (value.settings !== undefined) throw invalid();
    return body;
  }
  const change = value.settings;
  if (!record(change) || Object.keys(change).some((key) => key !== "model" && key !== "effort") || (change.model === undefined && change.effort === undefined)) throw new ControlBrokerError(400, L("Cần chọn model hoặc mức suy nghĩ mới"));
  if ((change.model !== undefined && !text(change.model, 200)) || (change.effort !== undefined && !text(change.effort, 200))) throw new ControlBrokerError(400, L("Model hoặc mức suy nghĩ không hợp lệ"));
  return { ...body, settings: { ...(change.model !== undefined ? { model: change.model as string } : {}), ...(change.effort !== undefined ? { effort: change.effort as string } : {}) } };
}

function actionAllowed(state: NativeControlState, body: ControlSubmission): boolean {
  if (body.action === "stop") return state.stop.available;
  const change = body.settings!;
  if (!state.settings.available) return false;
  if (change.model !== undefined && !state.settings.models.some((item) => item.id === change.model)) return false;
  if (change.effort === undefined) return true;
  const target = state.settings.models.find((item) => item.id === (change.model ?? state.settings.model));
  return Boolean(target?.efforts.includes(change.effort));
}

async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export class ControlBroker {
  private db: DatabaseSync | null = null;
  private readonly adapters: Map<NativeControlAdapter["app"], NativeControlAdapter>;
  private readonly timeoutMs: number;
  private readonly sendState?: ControlBrokerOptions["send"];

  constructor(options: ControlBrokerOptions) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.app, adapter]));
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.sendState = options.send;
    try {
      const file = options.file ?? process.env.MSC_CONTROLS_FILE ?? path.join(os.homedir(), ".msc-company", "controls.sqlite");
      if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(file);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; PRAGMA max_page_count=16384; CREATE TABLE IF NOT EXISTS receipts (requestId TEXT PRIMARY KEY, agentId TEXT NOT NULL, action TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, detail TEXT NOT NULL)");
      this.db.prepare("UPDATE receipts SET status = 'unknown', updatedAt = ?, detail = ? WHERE status = 'pending'").run(new Date().toISOString(), STATUS_TEXT.unknown);
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS active_agent_control ON receipts(agentId) WHERE status = 'pending'");
    } catch {
      this.db?.close();
      this.db = null;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  receipt(requestId: string): ControlReceipt | null {
    if (!UUID.test(requestId)) throw new ControlBrokerError(400, L("Mã gửi không hợp lệ"));
    const row = this.row(requestId.toLowerCase());
    return row ? this.publicReceipt(row) : null;
  }

  async list(agents: AgentInfo[]): Promise<ControlList> {
    const eligible = agents.filter((agent) => CONTROL_APPS.includes(agent.app) && !agent.parentId).slice(0, 100);
    const sendable = await this.sendable(eligible);
    const states = await Promise.all(eligible.map(async (agent): Promise<AgentControlState> => {
      const send = sendable.get(agent.id) ?? { available: false, reason: sendable.size ? L("{0} cho agent này", NO_SEND) : NO_SEND };
      return { agentId: agent.id, app: agent.app, machine: agent.machine, send, ...await this.nativeState(agent) };
    }));
    return { generatedAt: new Date().toISOString(), agents: states };
  }

  async submit(value: unknown, agents: AgentInfo[]): Promise<ControlReceipt> {
    const body = controlSubmission(value);
    if (!this.db) throw new ControlBrokerError(503, L("Không lưu được biên nhận; chưa gửi thao tác"));
    const hash = digest([body.agentId, body.machine, body.action, body.settings ?? null]);
    const previous = this.row(body.requestId);
    if (previous) {
      if (previous.digest !== hash) throw new ControlBrokerError(409, L("Mã gửi đã được dùng cho thao tác khác"));
      return this.publicReceipt(previous);
    }
    const agent = agents.find((item) => item.id === body.agentId && item.machine === body.machine && !item.parentId);
    const adapter = agent && (agent.app === "claude" || agent.app === "codex") ? this.adapters.get(agent.app) : undefined;
    if (!agent || !adapter) throw new ControlBrokerError(409, L("Không xác minh được phiên đích; chưa gửi"));
    let allowed = false;
    try {
      const state = controlState(await bounded((signal) => adapter.state(agent, signal), this.timeoutMs));
      allowed = Boolean(state && actionAllowed(state, body));
    } catch { allowed = false; }
    const initialStatus: ControlStatus = allowed ? "pending" : "rejected";
    const now = new Date().toISOString();
    try {
      this.db.prepare("INSERT INTO receipts (requestId,agentId,action,digest,status,createdAt,updatedAt,detail) VALUES (?,?,?,?,?,?,?,?)").run(body.requestId, body.agentId, body.action, hash, initialStatus, now, now, STATUS_TEXT[initialStatus]);
    } catch {
      const current = this.row(body.requestId);
      if (current?.digest === hash) return this.publicReceipt(current);
      if (current) throw new ControlBrokerError(409, L("Mã gửi đã được dùng cho thao tác khác"));
      if (this.db.prepare("SELECT requestId FROM receipts WHERE agentId = ? AND status = 'pending'").get(body.agentId)) throw new ControlBrokerError(409, L("Agent đang có một thao tác chờ xác nhận; kiểm tra biên nhận trước khi tiếp tục"));
      throw new ControlBrokerError(503, L("Không lưu được biên nhận; chưa gửi thao tác"));
    }
    if (initialStatus === "rejected") return this.publicReceipt(this.row(body.requestId)!);
    const context = (signal: AbortSignal) => ({ author: "human-web" as const, requestId: body.requestId, signal });
    try {
      const result = await bounded((signal) => body.action === "stop" ? adapter.stop(agent, context(signal)) : adapter.settings(agent, { ...body.settings! }, context(signal)), this.timeoutMs);
      const status: ControlStatus = result?.status === "done" ? "done" : result?.status === "stale" ? "rejected" : "unknown";
      return this.finish(body.requestId, status, text(result?.detail, 500) ? result.detail : undefined);
    } catch {
      return this.finish(body.requestId, "unknown");
    }
  }

  private async sendable(agents: AgentInfo[]): Promise<Map<string, ControlCapability>> {
    const result = new Map<string, ControlCapability>();
    if (!this.sendState || !agents.length) return result;
    try {
      const given = await bounded(() => this.sendState!(agents), this.timeoutMs);
      if (!(given instanceof Map)) throw new Error("invalid send state");
      for (const agent of agents) {
        const entry = given.get(agent.id);
        if (entry !== undefined) result.set(agent.id, controlCapability(entry) ?? { available: false, reason: SEND_FAILED });
      }
      if (!result.size) for (const agent of agents) result.set(agent.id, { available: false, reason: NO_SEND });
    } catch {
      for (const agent of agents) result.set(agent.id, { available: false, reason: SEND_FAILED });
    }
    return result;
  }

  private async nativeState(agent: AgentInfo): Promise<NativeControlState> {
    if (agent.app === "antigravity") return structuredClone(ANTIGRAVITY);
    const adapter = this.adapters.get(agent.app);
    if (!adapter) return unavailableControl(NO_ADAPTER);
    let state: NativeControlState | null = null;
    try { state = controlState(await bounded((signal) => adapter.state(agent, signal), this.timeoutMs)); } catch { state = null; }
    if (!state) return unavailableControl(CONTROL_UNVERIFIED);
    if (this.db) return state;
    return { ...state, stop: { ...state.stop, available: false, reason: NO_STORE }, settings: { ...state.settings, available: false, reason: NO_STORE } };
  }

  private row(requestId: string): ControlRow | undefined {
    if (!this.db) throw new ControlBrokerError(503, L("Kho biên nhận chưa sẵn sàng"));
    return this.db.prepare("SELECT * FROM receipts WHERE requestId = ?").get(requestId) as unknown as ControlRow | undefined;
  }

  private publicReceipt(row: ControlRow): ControlReceipt {
    return { requestId: row.requestId, agentId: row.agentId, action: row.action, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, detail: row.detail };
  }

  private finish(requestId: string, status: ControlStatus, detail?: string): ControlReceipt {
    const now = new Date().toISOString();
    try {
      this.db!.prepare("UPDATE receipts SET status = ?, updatedAt = ?, detail = ? WHERE requestId = ?").run(status, now, detail ? `${STATUS_TEXT[status]}: ${detail}` : STATUS_TEXT[status], requestId);
      return this.publicReceipt(this.row(requestId)!);
    } catch {
      throw new ControlBrokerError(503, L("Không cập nhật được biên nhận; không gửi lại, kiểm tra trong ứng dụng gốc"));
    }
  }
}
