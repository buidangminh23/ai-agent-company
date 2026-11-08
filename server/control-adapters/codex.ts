import { L } from "../../shared/i18n.ts";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ControlModel, ControlSettingsChange } from "../../shared/controls.ts";
import type { AgentInfo, MachineId } from "../../shared/types.ts";
import type { NativeControlAdapter, NativeControlContext, NativeControlResult, NativeControlState } from "../controls.ts";
import { CodexFollowerClient, codexActiveTurn, codexData, codexFail, codexThreadState, openCodexReplyWire, readCodexReplyAccount, type CodexAccountEvidence, type CodexReplyWire } from "../reply-adapters/codex.ts";

type Data = Record<string, unknown>;
export interface CodexControlOptions {
  machine: MachineId;
  open?: (signal: AbortSignal) => Promise<CodexReplyWire>;
  account?: () => CodexAccountEvidence;
  models?: () => ControlModel[];
  modelsFile?: string;
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODELS_LIMIT = 4 * 1024 * 1024;
export const CODEX_STOP_WARNING = L("Khi dừng lượt, Codex Desktop tự từ chối mọi yêu cầu duyệt và gửi câu trả lời trống cho mọi câu hỏi đang chờ trong chat này");
const UNVERIFIED = L("Chưa xác minh được kênh điều khiển Codex Desktop (phiên bản, danh tính, tài khoản hoặc chat); dùng app gốc");
const NO_TURN = L("Codex không có lượt nào đang chạy trong chat này");
const NO_MODELS = L("Chưa đọc được danh sách model Codex trên máy này (~/.codex/models_cache.json)");
const NO_SETTINGS = L("Codex Desktop chưa trả về model và mức suy nghĩ của chat này");
const STALE = L("Phiên Codex đã lâu không hoạt động; mở chat trong Codex Desktop để thao tác");
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const name = (value: unknown, max = 200) => typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");

function readSmallFile(file: string): string {
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MODELS_LIMIT) throw codexFail();
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw codexFail();
      offset += count;
    }
    return bytes.toString("utf8");
  } finally { closeSync(descriptor); }
}

export function parseCodexModels(raw: unknown): ControlModel[] {
  const models = codexData(raw).models;
  if (!Array.isArray(models)) throw codexFail();
  const result: ControlModel[] = [];
  for (const value of models.slice(0, 64)) {
    const model = codexData(value);
    if (model.visibility !== "list" || !name(model.slug) || result.some((entry) => entry.id === model.slug)) continue;
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.map((level) => codexData(level).effort).filter((effort): effort is string => name(effort, 40)) : [];
    result.push({ id: model.slug as string, label: name(model.display_name) ? model.display_name as string : model.slug as string, efforts: [...new Set(levels)] });
  }
  return result;
}

export function codexModelsFile(): string {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(home)) throw codexFail();
  return path.join(home, "models_cache.json");
}

export function readCodexModels(file = codexModelsFile()): ControlModel[] {
  if (!path.isAbsolute(file)) throw codexFail();
  return parseCodexModels(JSON.parse(readSmallFile(file)));
}

const turnStillActive = (state: Data, turnId: string) => Array.isArray(state.turns) && state.turns.some((value) => { const turn = codexData(value); return turn.turnId === turnId && turn.status === "inProgress"; });

export class CodexControlAdapter implements NativeControlAdapter {
  readonly app = "codex" as const;
  private readonly options: CodexControlOptions;
  private readonly open: NonNullable<CodexControlOptions["open"]>;
  private readonly account: NonNullable<CodexControlOptions["account"]>;
  private readonly models: NonNullable<CodexControlOptions["models"]>;
  private readonly now: () => number;
  constructor(options: CodexControlOptions) { this.options = options; this.open = options.open ?? openCodexReplyWire; this.account = options.account ?? readCodexReplyAccount; this.models = options.models ?? (() => readCodexModels(options.modelsFile)); this.now = options.now ?? Date.now; }
  private recent(agent: AgentInfo): boolean {
    if (agent.pending || ["working", "thinking", "waiting"].includes(agent.state)) return true;
    const updated = Date.parse(agent.updatedAt);
    return Number.isFinite(updated) && this.now() - updated <= ACTIVE_WINDOW_MS;
  }
  private local(agent: AgentInfo): boolean { return agent.app === "codex" && agent.machine === this.options.machine && typeof agent.sessionId === "string" && UUID.test(agent.sessionId) && !!agent.cwd; }
  private async session<T>(agent: AgentInfo, signal: AbortSignal, work: (client: CodexFollowerClient, state: Data, account: CodexAccountEvidence) => Promise<T>): Promise<T> {
    const account = this.account();
    const client = new CodexFollowerClient(await this.open(signal), signal);
    try {
      await client.initialize(agent.sessionId!);
      const state = codexThreadState(await client.snapshot(), agent);
      if (!equal(account, this.account())) throw codexFail();
      return await work(client, state, account);
    } finally { client.close(); }
  }
  private async readSettings(client: CodexFollowerClient, agent: AgentInfo): Promise<{ model: string | null; effort: string | null } | null> {
    const settings = codexData(codexData((await client.request("thread-follower-read-model-settings", { conversationId: agent.sessionId }, 1)).result).settings);
    if (!Object.keys(settings).length) return null;
    return { model: name(settings.model) ? settings.model as string : null, effort: name(settings.reasoningEffort, 40) ? settings.reasoningEffort as string : null };
  }
  private loadModels(): ControlModel[] { try { return this.models(); } catch { return []; } }
  async state(agent: AgentInfo, signal: AbortSignal): Promise<NativeControlState> {
    const models = this.loadModels();
    const unavailable = (reason: string): NativeControlState => ({ approvals: { available: false, reason }, questions: { available: false, reason }, stop: { available: false, reason, warning: CODEX_STOP_WARNING }, settings: { available: false, reason, model: agent.model ?? null, effort: null, models } });
    if (!this.local(agent)) return unavailable(L("Phiên này không phải chat Codex Desktop trên máy đang chạy collector"));
    if (!this.recent(agent)) return unavailable(STALE);
    try {
      return await this.session(agent, signal, async (client, state, account) => {
        const turn = codexActiveTurn(state);
        let current: { model: string | null; effort: string | null } | null = null;
        try { current = await this.readSettings(client, agent); } catch { current = null; }
        if (!equal(account, this.account())) throw codexFail();
        const settingsReason = !models.length ? NO_MODELS : !current ? NO_SETTINGS : "";
        return {
          approvals: { available: true, reason: "" },
          questions: { available: true, reason: "" },
          stop: { available: !!turn, reason: turn ? "" : NO_TURN, warning: CODEX_STOP_WARNING },
          settings: { available: !settingsReason, reason: settingsReason, model: current?.model ?? agent.model ?? null, effort: current?.effort ?? null, models },
        };
      });
    } catch { return unavailable(UNVERIFIED); }
  }
  async stop(agent: AgentInfo, context: NativeControlContext): Promise<NativeControlResult> {
    if (context.author !== "human-web" || context.signal.aborted || !this.local(agent)) return { status: "stale", detail: L("Chat Codex không hợp lệ trên máy này; chưa gửi") };
    let sent = false;
    try {
      return await this.session<NativeControlResult>(agent, context.signal, async (client, state, account) => {
        const turn = codexActiveTurn(state);
        if (!turn) return { status: "stale", detail: L("{0}; chưa gửi", NO_TURN) };
        sent = true;
        const result = codexData((await client.request("thread-follower-interrupt-turn", { conversationId: agent.sessionId, mode: "user-stop", expectedTurnId: turn }, 4, true, 5000)).result);
        if (result.interruptedTurnId === null && result.ok === true) return { status: "stale", detail: L("Lượt đã kết thúc trước khi Codex nhận lệnh dừng") };
        if (result.ok !== true || result.interruptedTurnId !== turn) return { status: "unknown", detail: L("Codex trả kết quả dừng không khớp lượt đang chạy; kiểm tra chat gốc") };
        const after = codexThreadState(await client.snapshot(), agent);
        if (!equal(account, this.account()) || turnStillActive(after, turn)) return { status: "unknown", detail: L("Chưa xác nhận được lượt đã dừng; kiểm tra chat gốc, không tự gửi lại") };
        return { status: "done", detail: L("Codex Desktop đã dừng lượt đang chạy. {0}", CODEX_STOP_WARNING) };
      });
    } catch { return sent ? { status: "unknown", detail: L("Chưa xác nhận được kết quả dừng; kiểm tra chat gốc, không tự gửi lại") } : { status: "stale", detail: L("{0}; chưa gửi", UNVERIFIED) }; }
  }
  async settings(agent: AgentInfo, change: ControlSettingsChange, context: NativeControlContext): Promise<NativeControlResult> {
    const invalid: NativeControlResult = { status: "stale", detail: L("Model hoặc mức suy nghĩ không có trong danh sách Codex trên máy này; chưa gửi") };
    if (context.author !== "human-web" || context.signal.aborted || !this.local(agent)) return { status: "stale", detail: L("Chat Codex không hợp lệ trên máy này; chưa gửi") };
    if (!change || (change.model === undefined && change.effort === undefined) || (change.model !== undefined && !name(change.model)) || (change.effort !== undefined && !name(change.effort, 40))) return invalid;
    const models = this.loadModels();
    if (!models.length) return { status: "stale", detail: L("{0}; chưa gửi", NO_MODELS) };
    if (change.model !== undefined && !models.some((model) => model.id === change.model)) return invalid;
    let sent = false;
    try {
      return await this.session<NativeControlResult>(agent, context.signal, async (client, _state, account) => {
        const current = await this.readSettings(client, agent);
        const target = models.find((model) => model.id === (change.model ?? current?.model));
        if (change.effort !== undefined && (!target || !target.efforts.includes(change.effort))) return invalid;
        const threadSettings = { ...change.model !== undefined ? { model: change.model } : {}, ...change.effort !== undefined ? { effort: change.effort } : {} };
        if (!equal(account, this.account())) throw codexFail();
        sent = true;
        const result = codexData((await client.request("thread-follower-update-thread-settings", { conversationId: agent.sessionId, threadSettings }, 2)).result);
        return result.applied === true ? { status: "done", detail: L("Codex Desktop đã nhận thiết lập cho lượt kế tiếp") } : { status: "unknown", detail: L("Codex Desktop chưa xác nhận áp dụng thiết lập; kiểm tra chat gốc") };
      });
    } catch { return sent ? { status: "unknown", detail: L("Chưa xác nhận được thiết lập; kiểm tra chat gốc, không tự gửi lại") } : { status: "stale", detail: L("{0}; chưa gửi", UNVERIFIED) }; }
  }
}

export { codexActiveTurn };
export const createCodexControlAdapter = (machine: MachineId): NativeControlAdapter => new CodexControlAdapter({ machine });
