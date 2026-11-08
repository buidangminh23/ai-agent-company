import { L } from "../shared/i18n.ts";
import type { AgentInfo, MachineId } from "../shared/types.ts";
import type { AgentControlState, ControlAction, ControlCapability, ControlList, ControlReceipt, ControlSettingsChange } from "../shared/controls.ts";
import { escapeHtml as escape } from "./markdown.ts";

const STORAGE_KEY = "msc-control-receipts";
const APP_LABELS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
const STALE_PENDING_MS = 90_000;
const STALE_DETAIL = L("Không tìm thấy biên nhận trên máy đích; kiểm tra trong ứng dụng gốc trước khi thao tác lại");
const CAPABILITY_LABELS: [keyof Pick<AgentControlState, "approvals" | "questions" | "send" | "stop" | "settings">, string][] = [["approvals", L("Duyệt quyền")], ["questions", L("Trả lời câu hỏi")], ["send", L("Gửi lệnh mới")], ["stop", L("Dừng lượt")], ["settings", L("Đổi model / mức suy nghĩ")]];

interface LocalControl {
  requestId: string;
  agentId: string;
  machine: MachineId;
  action: ControlAction;
  status: ControlReceipt["status"];
  detail: string;
  createdAt: string;
}

export function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function controlKey(agentId: string, machine: string): string {
  return `${machine}|${agentId}`;
}

export class AgentControls {
  private data: ControlList | null = null;
  private loading = false;
  private error = "";
  private readonly confirming = new Set<string>();
  private readonly selections = new Map<string, { model: string; effort: string }>();
  private readonly receipts = new Map<string, LocalControl>();
  private readonly errors = new Map<string, string>();
  private readonly checking = new Set<string>();
  private readonly sending = new Set<string>();

  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      for (const item of Array.isArray(saved) ? saved.slice(-100) : []) {
        if (item && typeof item.requestId === "string" && typeof item.agentId === "string" && typeof item.machine === "string" && (item.action === "stop" || item.action === "settings") && ["pending", "done", "rejected", "unknown"].includes(item.status) && typeof item.detail === "string") this.receipts.set(item.requestId, { ...item, createdAt: typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? item.createdAt : new Date(0).toISOString() });
      }
    } catch {}
  }

  async refresh(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const response = await fetch("/api/agent-controls", { cache: "no-store", signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(response.status === 401 ? L("Đăng nhập bằng mã truy cập để điều khiển agent.") : L("Chưa nối được kênh điều khiển agent."));
      const data = await response.json() as ControlList;
      if (!data || !Array.isArray(data.agents)) throw new Error(L("Dữ liệu điều khiển không hợp lệ."));
      this.data = data;
      this.error = "";
    } catch (error) {
      this.data = null;
      this.error = error instanceof Error ? error.message : L("Chưa kiểm tra được khả năng điều khiển.");
    } finally {
      this.loading = false;
      this.changed();
    }
    await this.expireStale();
  }

  private stale(receipt: LocalControl): boolean {
    const created = Date.parse(receipt.createdAt);
    return (receipt.status === "pending" || receipt.status === "unknown") && !this.sending.has(receipt.requestId) && (!Number.isFinite(created) || Date.now() - created > STALE_PENDING_MS);
  }

  private async expireStale(): Promise<void> {
    await Promise.all([...this.receipts.values()].filter((receipt) => receipt.status === "pending" && this.stale(receipt)).map((receipt) => this.checkReceipt(receipt.requestId)));
  }

  state(agent: AgentInfo): AgentControlState | undefined {
    return this.data?.agents.find((item) => item.agentId === agent.id && item.machine === agent.machine);
  }

  markup(agent: AgentInfo, enabled: boolean): string {
    if (!enabled) return "";
    const key = controlKey(agent.id, agent.machine);
    const state = this.state(agent);
    const receipts = [...this.receipts.values()].filter((receipt) => receipt.agentId === agent.id && receipt.machine === agent.machine).slice(-2);
    const receiptMarkup = receipts.map((receipt) => `<div class="ops-control-status" role="status" data-state="${receipt.status}"><strong>${receipt.action === "stop" ? L("Dừng lượt") : L("Đổi model / mức suy nghĩ")} · ${receipt.status === "done" ? L("Đã áp dụng") : receipt.status === "rejected" ? L("Không áp dụng") : receipt.status === "pending" ? L("Đang gửi") : L("Chưa xác nhận")}</strong><p>${escape(receipt.detail)}</p>${receipt.status === "pending" || receipt.status === "unknown" ? L("<button type=\"button\" data-control-receipt=\"{0}\" data-key=\"control-receipt:{1}\">Kiểm tra biên nhận</button>", escape(receipt.requestId), escape(receipt.requestId)) : ""}</div>`).join("");
    const error = this.errors.has(key) ? `<p class="ops-reply-error" role="alert">${escape(this.errors.get(key)!)}</p>` : "";
    if (!state) return this.error || receiptMarkup ? L("<section class=\"ops-controls\" aria-label=\"Điều khiển {0}\">{1}{2}{3}</section>", APP_LABELS[agent.app], this.error ? `<p class="ops-source-note">${escape(this.error)}</p>` : "", receiptMarkup, error) : "";
    const busy = (action: ControlAction) => receipts.some((receipt) => receipt.action === action && receipt.status === "pending");
    const id = escape(key);
    let stop = "";
    if (state.stop.available) {
      stop = this.confirming.has(key)
        ? L("<div class=\"ops-control-confirm\" role=\"group\" aria-label=\"Xác nhận dừng lượt\"><p>{0}</p><div class=\"ops-control-buttons\"><button type=\"button\" data-tone=\"stop\" data-control-stop-confirm=\"{1}\" data-key=\"control-stop-confirm:{2}\" {3}>Xác nhận dừng</button><button type=\"button\" data-control-stop-cancel=\"{4}\" data-key=\"control-stop-cancel:{5}\">Huỷ</button></div></div>", escape(state.stop.warning || L("Dừng lượt đang chạy của agent.")), id, id, busy("stop") ? "disabled" : "", id, id)
        : `<button type="button" class="ops-control-stop" data-tone="stop" data-control-stop="${id}" data-key="control-stop:${id}" ${busy("stop") ? "disabled" : ""}>${busy("stop") ? L("Đang dừng…") : L("Dừng lượt")}</button>`;
    }
    let settings = "";
    if (state.settings.available && state.settings.models.length) {
      const selection = this.selection(key, state);
      const model = state.settings.models.find((item) => item.id === selection.model);
      const current = [state.settings.models.find((item) => item.id === state.settings.model)?.label ?? state.settings.model, state.settings.effort].filter(Boolean).join(" · ") || L("Chưa đọc được");
      settings = L("<div class=\"ops-control-settings\"><p class=\"ops-control-current\">Hiện tại: <strong>{0}</strong></p><div class=\"ops-control-fields\"><label>Model<select data-control-model=\"{1}\" data-key=\"control-model:{2}\">{3}</select></label>{4}</div><button type=\"button\" data-control-apply=\"{5}\" data-key=\"control-apply:{6}\" {7}>Áp dụng cho lượt sau</button></div>", escape(current), id, id, state.settings.models.map((item) => `<option value="${escape(item.id)}" ${item.id === selection.model ? "selected" : ""}>${escape(item.label || item.id)}</option>`).join(""), model?.efforts.length ? L("<label>Mức suy nghĩ<select data-control-effort=\"{0}\" data-key=\"control-effort:{1}\">{2}</select></label>", id, id, model.efforts.map((effort) => `<option value="${escape(effort)}" ${effort === selection.effort ? "selected" : ""}>${escape(effort)}</option>`).join("")) : "", id, id, busy("settings") ? "disabled" : "");
    }
    const limits = CAPABILITY_LABELS.filter(([name]) => !(state[name] as ControlCapability).available && (state[name] as ControlCapability).reason).map(([name, label]) => `<li><b>${label}:</b> ${escape((state[name] as ControlCapability).reason)}</li>`).join("");
    return L("<section class=\"ops-controls\" aria-label=\"Điều khiển {0}\" data-agent-controls=\"{1}\"><header class=\"ops-control-head\"><strong>Điều khiển {2}</strong><small>{3} · Thao tác của sếp từ web</small></header>{4}{5}{6}{7}{8}</section>", APP_LABELS[state.app] ?? APP_LABELS[agent.app], id, APP_LABELS[state.app] ?? APP_LABELS[agent.app], escape(state.machine), stop, settings, limits ? `<ul class="ops-control-limits">${limits}</ul>` : "", receiptMarkup, error);
  }

  private selection(key: string, state: AgentControlState): { model: string; effort: string } {
    const saved = this.selections.get(key);
    const model = state.settings.models.find((item) => item.id === saved?.model) ?? state.settings.models.find((item) => item.id === state.settings.model) ?? state.settings.models[0];
    const effort = model.efforts.includes(saved?.effort ?? "") ? saved!.effort : model.efforts.includes(state.settings.effort ?? "") ? state.settings.effort! : model.efforts[0] ?? "";
    return { model: model.id, effort };
  }

  private find(key: string): AgentControlState | undefined {
    return this.data?.agents.find((item) => controlKey(item.agentId, item.machine) === key);
  }

  input(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
    const modelKey = target.dataset.controlModel;
    const effortKey = target.dataset.controlEffort;
    const key = modelKey ?? effortKey;
    if (!key) return false;
    const state = this.find(key);
    if (!state) return true;
    const current = this.selection(key, state);
    if (modelKey) {
      const model = state.settings.models.find((item) => item.id === target.value);
      if (!model) return true;
      this.selections.set(key, { model: model.id, effort: model.efforts.includes(current.effort) ? current.effort : model.efforts.includes(state.settings.effort ?? "") ? state.settings.effort! : model.efforts[0] ?? "" });
      this.errors.delete(key);
      this.changed();
    } else this.selections.set(key, { model: current.model, effort: target.value });
    return true;
  }

  change(target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean {
    return this.input(target);
  }

  click(target: Element, enabled: boolean): boolean {
    const stop = target.closest<HTMLElement>("[data-control-stop]");
    const confirm = target.closest<HTMLElement>("[data-control-stop-confirm]");
    const cancel = target.closest<HTMLElement>("[data-control-stop-cancel]");
    const apply = target.closest<HTMLElement>("[data-control-apply]");
    const receipt = target.closest<HTMLElement>("[data-control-receipt]");
    if (!stop && !confirm && !cancel && !apply && !receipt) return false;
    if (receipt?.dataset.controlReceipt) { void this.checkReceipt(receipt.dataset.controlReceipt); return true; }
    if (cancel?.dataset.controlStopCancel) { this.confirming.delete(cancel.dataset.controlStopCancel); this.changed(); return true; }
    if (!enabled) return true;
    if (stop?.dataset.controlStop && this.find(stop.dataset.controlStop)?.stop.available) { this.confirming.add(stop.dataset.controlStop); this.errors.delete(stop.dataset.controlStop); this.changed(); }
    if (confirm?.dataset.controlStopConfirm && this.confirming.has(confirm.dataset.controlStopConfirm)) { const key = confirm.dataset.controlStopConfirm; this.confirming.delete(key); void this.submit(key, "stop"); }
    if (apply?.dataset.controlApply) void this.submit(apply.dataset.controlApply, "settings");
    return true;
  }

  private save(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.receipts.values()].slice(-100)));
      return true;
    } catch { return false; }
  }

  private async submit(key: string, action: ControlAction): Promise<void> {
    const state = this.find(key);
    if (!state || [...this.receipts.values()].some((receipt) => controlKey(receipt.agentId, receipt.machine) === key && receipt.action === action && receipt.status === "pending")) return;
    let settings: ControlSettingsChange | undefined;
    if (action === "stop" && !state.stop.available) return;
    if (action === "settings") {
      if (!state.settings.available) return;
      const selection = this.selection(key, state);
      if (selection.model === state.settings.model && selection.effort === (state.settings.effort ?? "")) {
        this.errors.set(key, L("Model và mức suy nghĩ đang đúng như đã chọn; chưa gửi gì."));
        this.changed();
        return;
      }
      settings = { model: selection.model, ...(selection.effort ? { effort: selection.effort } : {}) };
    }
    const requestId = uuid();
    const body = JSON.stringify({ requestId, agentId: state.agentId, machine: state.machine, action, ...(settings ? { settings } : {}) });
    const receipt: LocalControl = { requestId, agentId: state.agentId, machine: state.machine, action, status: "pending", createdAt: new Date().toISOString(), detail: action === "stop" ? L("Đang gửi lệnh dừng. Không gửi lại trong khi kiểm tra.") : L("Đang gửi thiết lập cho lượt sau. Không gửi lại trong khi kiểm tra.") };
    this.receipts.set(requestId, receipt);
    if (!this.save()) {
      this.receipts.delete(requestId);
      this.errors.set(key, L("Không lưu được biên nhận trong trình duyệt. Bật lưu trữ trang rồi thử lại; chưa gửi lệnh."));
      this.changed();
      return;
    }
    this.errors.delete(key);
    this.sending.add(requestId);
    this.changed();
    try {
      const response = await fetch("/api/agent-controls", { method: "POST", headers: { "content-type": "application/json", "x-msc-control": "human-web" }, body, signal: AbortSignal.timeout(40_000) });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? L("{0}. Kiểm tra biên nhận hoặc ứng dụng gốc; không gửi lại.", failure.error.slice(0, 300)) : L("Chưa xác nhận được kết quả. Kiểm tra biên nhận hoặc ứng dụng gốc; không gửi lại."));
      }
      const result = await response.json() as ControlReceipt;
      if (result?.requestId?.toLowerCase() !== requestId || result.agentId !== state.agentId || result.action !== action || !["pending", "done", "rejected", "unknown"].includes(result.status)) throw new Error(L("Biên nhận không khớp; kiểm tra ứng dụng gốc, không gửi lại."));
      receipt.status = result.status;
      receipt.detail = typeof result.detail === "string" ? result.detail.slice(0, 500) : receipt.detail;
    } catch (error) {
      receipt.status = "unknown";
      receipt.detail = error instanceof Error && error.name !== "TimeoutError" && error.name !== "AbortError" && /không gửi lại|do not resend|not resending/i.test(error.message) ? error.message : L("Chưa xác nhận được kết quả; không gửi lại. Kiểm tra biên nhận hoặc ứng dụng gốc.");
    } finally {
      this.sending.delete(requestId);
    }
    this.save();
    this.changed();
    await this.refresh();
  }

  private async checkReceipt(requestId: string): Promise<void> {
    const receipt = this.receipts.get(requestId);
    if (!receipt || this.checking.has(requestId)) return;
    this.checking.add(requestId);
    try {
      const response = await fetch(`/api/agent-controls/${encodeURIComponent(receipt.requestId)}?machine=${encodeURIComponent(receipt.machine)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("unreachable");
      const result = await response.json() as ControlReceipt | null;
      if (result?.requestId?.toLowerCase() === receipt.requestId && result.agentId === receipt.agentId && ["pending", "done", "rejected", "unknown"].includes(result.status)) {
        receipt.status = result.status;
        receipt.detail = typeof result.detail === "string" ? result.detail.slice(0, 500) : receipt.detail;
      } else if (result === null && this.stale(receipt)) {
        receipt.status = "unknown";
        receipt.detail = STALE_DETAIL;
      } else receipt.detail = L("Chưa tìm thấy biên nhận trên máy đích. Kiểm tra ứng dụng gốc; không gửi lại khi chưa xác minh.");
    } catch {
      receipt.detail = L("Chưa kết nối được nơi lưu biên nhận; kiểm tra ứng dụng gốc. Không gửi lại.");
    } finally {
      this.checking.delete(requestId);
    }
    this.save();
    this.changed();
  }
}
