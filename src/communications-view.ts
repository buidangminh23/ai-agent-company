import { L, locale } from "../shared/i18n.ts";
import { MACHINE_LABELS, MACHINE_ORDER, type AgentMessage, type MachineId, type MessageStatus, type Snapshot } from "../shared/types.ts";
import { messageStatus, messageStatusLabel } from "../shared/messages.ts";
import { mergeDispatchReceipt, type DispatchList, type DispatchReceipt, type DispatchTarget } from "../shared/dispatch.ts";
import { escapeHtml as text } from "./markdown.ts";

const APP_NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
const OPEN_STATUSES = new Set<MessageStatus>(["queued", "sending", "unknown"]);
const STORAGE_KEY = "msc-communication-receipts";
const LIMIT = 8000;
const STATUSES = new Set<MessageStatus>(["queued", "sending", "accepted", "delivered", "replied", "failed", "unknown"]);

function isReceipt(value: unknown): value is DispatchReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as DispatchReceipt;
  return typeof receipt.id === "string" && typeof receipt.targetAgentId === "string" && MACHINE_ORDER.includes(receipt.targetMachine) && typeof receipt.summary === "string" && typeof receipt.detail === "string" && STATUSES.has(receipt.status) && typeof receipt.at === "string" && Number.isFinite(Date.parse(receipt.at)) && typeof receipt.updatedAt === "string" && Number.isFinite(Date.parse(receipt.updatedAt));
}

function date(value: string): string {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale(), { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : L("Chưa rõ thời điểm");
}

function tone(status: MessageStatus): string {
  return status === "failed" ? "error" : status === "delivered" || status === "replied" ? "success" : status === "unknown" ? "warning" : "pending";
}

function statusMarkup(status: MessageStatus): string {
  return `<span class="comm-status" data-tone="${tone(status)}" data-state="${status}"><i aria-hidden="true"></i>${text(messageStatusLabel(status))}</span>`;
}

function uuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function communicationMachines(snapshot: Snapshot | null, connected: boolean): string {
  return MACHINE_ORDER.map((id) => {
    const machine = snapshot?.machines.find((entry) => entry.id === id);
    const online = connected && machine?.online === true;
    const count = snapshot?.agents.filter((agent) => agent.machine === id).length ?? 0;
    return `<article class="comm-machine" data-online="${online}"><span class="comm-machine-dot" aria-hidden="true"></span><div><strong>${text(MACHINE_LABELS[id])}</strong><small>${text(id)}</small></div><span class="comm-machine-state">${!connected ? L("Chờ kết nối hub") : !machine ? L("Chưa có dữ liệu") : online ? L("Đang kết nối") : L("Mất kết nối")}<small>${count} agent${machine ? ` · ${text(date(machine.checkedAt))}` : ""}</small></span></article>`;
  }).join("");
}

export function communicationMessage(message: AgentMessage, snapshot: Snapshot | null): string {
  const sender = snapshot?.agents.find((agent) => agent.id === message.fromId);
  const receiver = snapshot?.agents.find((agent) => agent.id === message.toId);
  const from = message.fromId === "human-web" ? L("Sếp · Dashboard") : sender ? `${APP_NAMES[sender.app]} · ${MACHINE_LABELS[sender.machine]}` : L("Phiên gửi không còn trong văn phòng");
  const to = receiver ? `${APP_NAMES[receiver.app]} · ${MACHINE_LABELS[receiver.machine]}` : message.targetLabel || (message.targetMachine ? MACHINE_LABELS[message.targetMachine] : L("Chưa xác định người nhận"));
  const offline = receiver && snapshot?.machines.find((machine) => machine.id === receiver.machine)?.online === false;
  return L("<article class=\"comm-message\"><div class=\"comm-message-top\"><span class=\"comm-route\"><b>{0}</b><span aria-label=\"gửi tới\">→</span><b>{1}</b></span>{2}</div><p class=\"comm-summary\">{3}</p>{4}{5}<footer><span>{6}{7}</span><time datetime=\"{8}\">{9}</time></footer></article>", text(from), text(to), statusMarkup(messageStatus(message)), text(message.summary), message.detail ? `<p class="comm-detail">${text(message.detail)}</p>` : "", !receiver ? L("<p class=\"comm-detail\">Chưa ghép được đúng phiên nhận; chưa thể xác nhận giao nhận.</p>") : offline ? L("<p class=\"comm-detail\">Máy nhận hiện mất kết nối; trạng thái trên là bằng chứng gần nhất.</p>") : "", text(message.via), message.replyTo ? L(" · Phản hồi có liên kết") : "", text(message.updatedAt ?? message.at), text(date(message.updatedAt ?? message.at)));
}

export class CommunicationsBoard {
  private snapshot: Snapshot | null = null;
  private connected = false;
  private replay = false;
  private composerOpen = false;
  private expanded = false;
  private data: DispatchList | null = null;
  private loading = false;
  private error = "";
  private formError = "";
  private draft = "";
  private targetId = "";
  private targetMachine: MachineId | "" = "";
  private submitting = false;
  private activeId: string | null = null;
  private checking = new Set<string>();
  private receipts = new Map<string, DispatchReceipt>();
  private filter: MachineId | "" = "";
  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      if (Array.isArray(saved)) for (const receipt of saved.slice(-100)) {
        if (isReceipt(receipt)) this.receipts.set(receipt.id, receipt);
      }
      const pending = [...this.receipts.values()].reverse().find((receipt) => OPEN_STATUSES.has(receipt.status));
      if (pending) { this.activeId = pending.id; this.targetId = pending.targetAgentId; this.targetMachine = pending.targetMachine; }
    } catch {}
  }

  update(snapshot: Snapshot | null, connected: boolean, replay = false): void {
    this.snapshot = snapshot;
    this.connected = connected;
    if (this.replay && !replay && this.formError === L("Đang xem lại lịch sử; trở về Trực tiếp để giao việc.")) this.formError = "";
    this.replay = replay;
    if (replay) return;
    for (const message of snapshot?.messages ?? []) {
      if (message.fromId !== "human-web" || !message.targetMachine) continue;
      const receipt = { id: message.id, targetAgentId: message.toId, targetMachine: message.targetMachine, summary: message.summary, status: messageStatus(message), at: message.at, updatedAt: message.updatedAt ?? message.at, detail: message.detail ?? "", author: "human-web" as const };
      if (isReceipt(receipt)) this.merge(receipt);
    }
  }

  async refresh(): Promise<void> {
    if (this.loading || this.replay) return;
    this.loading = true;
    if (!this.data) this.changed();
    try {
      const response = await fetch("/api/communications", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(response.status === 401 ? L("Đăng nhập bằng mã truy cập để mở kênh giao việc.") : L("Chưa đọc được kênh giao tiếp ({0}).", response.status));
      const data = await response.json() as DispatchList;
      if (!Array.isArray(data.targets) || !Array.isArray(data.receipts)) throw new Error(L("Dữ liệu kênh giao tiếp chưa hợp lệ."));
      this.data = data;
      for (const receipt of data.receipts) if (isReceipt(receipt)) this.merge(receipt);
      this.save();
      this.error = "";
    } catch (error) {
      this.error = error instanceof Error ? error.message : L("Chưa nối được kênh giao tiếp.");
    } finally {
      this.loading = false;
      this.changed();
    }
  }

  private merge(receipt: DispatchReceipt): void {
    this.receipts.set(receipt.id, mergeDispatchReceipt(this.receipts.get(receipt.id), receipt));
  }

  private save(): boolean {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.receipts.values()].slice(-100))); return true; } catch { return false; }
  }

  private selected(): DispatchTarget | undefined {
    return this.data?.targets.find((target) => target.agentId === this.targetId && target.machine === this.targetMachine);
  }

  private available(target: DispatchTarget | undefined): boolean {
    return !this.replay && this.connected && !this.error && Boolean(target?.available) && this.snapshot?.machines.some((machine) => machine.id === target?.machine && machine.online) === true;
  }

  openComposer(): void {
    this.composerOpen = true;
    this.changed();
  }

  machineMarkup(): string {
    return `<div class="comm-machines">${communicationMachines(this.snapshot, this.connected)}</div>`;
  }

  input(target: HTMLInputElement | HTMLTextAreaElement): boolean {
    if (target.dataset.commDraft === undefined) return false;
    if (!this.activeId && !this.submitting) this.draft = target.value;
    const count = target.closest("form")?.querySelector("[data-comm-count]");
    if (count) count.textContent = `${this.draft.length.toLocaleString(locale())} / ${LIMIT.toLocaleString(locale())}`;
    return true;
  }

  change(target: HTMLInputElement | HTMLSelectElement): boolean {
    if (target.dataset.commTarget !== undefined) {
      if (this.activeId || this.submitting) return true;
      const selected = this.data?.targets.find((entry) => `${entry.machine}:${entry.agentId}` === target.value);
      this.targetId = selected?.agentId ?? "";
      this.targetMachine = selected?.machine ?? "";
      this.formError = "";
      this.changed();
      return true;
    }
    if (target.dataset.commFilter !== undefined) {
      this.filter = MACHINE_ORDER.includes(target.value as MachineId) ? target.value as MachineId : "";
      this.changed();
      return true;
    }
    return false;
  }

  click(target: Element): boolean {
    const action = target.closest<HTMLElement>("[data-comm-action]");
    if (!action) return false;
    if (action.dataset.commAction === "compose") { this.composerOpen = !this.composerOpen; this.changed(); }
    if (action.dataset.commAction === "expand") { this.expanded = !this.expanded; this.changed(); }
    if (action.dataset.commAction === "refresh") void this.refresh();
    if (action.dataset.commAction === "check" && action.dataset.receipt) void this.check(action.dataset.receipt);
    if (action.dataset.commAction === "new" && !this.submitting) {
      this.activeId = null;
      this.draft = "";
      this.formError = "";
      this.changed();
    }
    return true;
  }

  submit(form: HTMLFormElement): boolean {
    if (!form.matches("[data-comm-form]")) return false;
    void this.send();
    return true;
  }

  private async send(): Promise<void> {
    if (this.replay) { this.formError = L("Đang xem lại lịch sử; trở về Trực tiếp để giao việc."); this.changed(); return; }
    if (this.submitting || this.activeId) return;
    const target = this.selected();
    const message = this.draft.trim();
    if (!target || !this.available(target) || !message || message.length > LIMIT) {
      this.formError = !message ? L("Nhập nội dung cần gửi.") : L("Chọn đúng phiên đang có kênh gửi khả dụng.");
      this.changed();
      return;
    }
    const id = uuid();
    const at = new Date().toISOString();
    const pending: DispatchReceipt = { id, status: "sending", targetAgentId: target.agentId, targetMachine: target.machine, summary: L("Tin nhắn từ sếp"), at, updatedAt: at, detail: L("Đang gửi yêu cầu; chờ biên nhận từ máy đích."), author: "human-web" };
    this.receipts.set(id, pending);
    if (!this.save()) {
      this.receipts.delete(id);
      this.formError = L("Trình duyệt chưa lưu được mã gửi để chống gửi trùng. Chưa gửi nội dung.");
      this.changed();
      return;
    }
    this.activeId = id;
    this.submitting = true;
    this.formError = "";
    this.changed();
    try {
      const response = await fetch("/api/communications", { method: "POST", headers: { "content-type": "application/json", "x-msc-communication": "human-web" }, body: JSON.stringify({ requestId: id, targetAgentId: target.agentId, targetMachine: target.machine, message }), signal: AbortSignal.timeout(45_000) });
      const result = await response.json();
      if (isReceipt(result) && result.id === id && result.targetAgentId === target.agentId && result.targetMachine === target.machine) this.merge(result);
      else if ([400, 401, 403, 413, 415, 422].includes(response.status)) this.merge({ ...pending, status: "failed", updatedAt: new Date().toISOString(), detail: typeof result?.error === "string" ? result.error : L("Yêu cầu bị từ chối trước khi gửi tới agent.") });
      else throw new Error(typeof result?.error === "string" ? result.error : L("Chưa nhận được biên nhận ({0}).", response.status));
    } catch (error) {
      this.merge({ ...pending, status: "unknown", updatedAt: new Date().toISOString(), detail: L("{0} Chưa rõ máy đích đã nhận hay chưa; kiểm tra biên nhận trước khi tạo tin mới.", error instanceof Error ? error.message : L("Mất kết nối khi gửi.")) });
    } finally {
      this.submitting = false;
      this.save();
      this.changed();
    }
  }

  private async check(id: string): Promise<void> {
    if (this.replay) return;
    const receipt = this.receipts.get(id);
    if (!receipt || this.checking.has(id)) return;
    this.checking.add(id);
    this.changed();
    try {
      const response = await fetch(`/api/communications/${encodeURIComponent(id)}?machine=${encodeURIComponent(receipt.targetMachine)}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(L("Chưa đọc được biên nhận ({0}).", response.status));
      const result = await response.json();
      if (isReceipt(result) && result.id === id && result.targetAgentId === receipt.targetAgentId && result.targetMachine === receipt.targetMachine) this.merge(result);
      else this.formError = L("Chưa tìm thấy biên nhận. Không tự gửi lại; kiểm tra chat trên máy đích.");
      this.save();
    } catch (error) { this.formError = error instanceof Error ? error.message : L("Chưa kiểm tra được biên nhận."); }
    finally { this.checking.delete(id); this.changed(); }
  }

  private receiptMarkup(receipt: DispatchReceipt): string {
    const agent = this.snapshot?.agents.find((entry) => entry.id === receipt.targetAgentId && entry.machine === receipt.targetMachine);
    const target = agent ? `${APP_NAMES[agent.app]} · ${MACHINE_LABELS[agent.machine]}` : MACHINE_LABELS[receipt.targetMachine];
    return L("<article class=\"comm-message comm-human\"><div class=\"comm-message-top\"><span class=\"comm-route\"><b>Sếp</b><span aria-label=\"gửi tới\">→</span><b>{0}</b></span>{1}</div><p class=\"comm-summary\">{2}</p><p class=\"comm-detail\">{3}</p><footer><span>Giao việc từ dashboard</span><time datetime=\"{4}\">{5}</time>{6}</footer></article>", text(target), statusMarkup(receipt.status), text(receipt.summary), text(receipt.detail), text(receipt.updatedAt), text(date(receipt.updatedAt)), OPEN_STATUSES.has(receipt.status) || receipt.status === "accepted" ? `<button type="button" data-comm-action="check" data-receipt="${text(receipt.id)}" data-key="comm-check:${text(receipt.id)}" ${this.checking.has(receipt.id) ? "disabled" : ""}>${this.checking.has(receipt.id) ? L("Đang kiểm tra…") : L("Kiểm tra biên nhận")}</button>` : "");
  }

  markup(embedded = false): string {
    const active = this.activeId ? this.receipts.get(this.activeId) : undefined;
    const selected = this.selected();
    const canSend = !active && !this.submitting && this.available(selected);
    const targets = this.data?.targets ?? [];
    const groups = MACHINE_ORDER.map((machine) => {
      const entries = targets.filter((target) => target.machine === machine);
      return entries.length ? `<optgroup label="${text(MACHINE_LABELS[machine])}">${entries.map((target) => `<option value="${text(`${machine}:${target.agentId}`)}" ${target.agentId === this.targetId && machine === this.targetMachine ? "selected" : ""}>${text(`${APP_NAMES[target.app]} · ${target.project || target.title} · ${target.title}`)}${target.available ? "" : L(" — Chưa khả dụng")}</option>`).join("")}</optgroup>` : "";
    }).join("");
    const observed = (this.snapshot?.messages ?? []).filter((message) => (this.replay || !this.receipts.has(message.id)) && (!this.filter || message.targetMachine === this.filter || this.snapshot?.agents.some((agent) => agent.machine === this.filter && (agent.id === message.fromId || agent.id === message.toId))));
    const receipts = (this.replay ? [] : [...this.receipts.values()]).filter((receipt) => !this.filter || receipt.targetMachine === this.filter);
    const history = [...observed.map((message) => ({ at: message.updatedAt ?? message.at, html: communicationMessage(message, this.snapshot) })), ...receipts.map((receipt) => ({ at: receipt.updatedAt, html: this.receiptMarkup(receipt) }))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80);
    const visibleHistory = embedded && !this.expanded ? history.slice(0, 4) : history;
    const reason = this.replay ? L("Đang xem lại lịch sử; trở về Trực tiếp để giao việc.") : !this.connected ? L("Chờ hub kết nối lại trước khi gửi.") : this.error || selected?.reason || (!selected ? L("Chọn máy và phiên nhận để kiểm tra kênh gửi.") : !this.available(selected) ? L("Máy đích chưa sẵn sàng nhận tin.") : L("Nội dung gửi với danh nghĩa của sếp vào đúng chat đã chọn."));
    const compose = L("<section class=\"comm-compose\" id=\"comm-compose\"><h3>Gửi việc đến agent</h3>{0}<form data-comm-form><label for=\"comm-target\">Máy / phiên nhận</label><select id=\"comm-target\" data-comm-target data-key=\"comm-target\" {1}><option value=\"\">{2}</option>{3}</select><p class=\"comm-capability\" id=\"comm-capability\">{4}</p><label for=\"comm-draft\">Nội dung giao việc</label><textarea id=\"comm-draft\" data-comm-draft data-key=\"comm-draft\" rows=\"{5}\" maxlength=\"{6}\" aria-describedby=\"comm-capability\" placeholder=\"Mô tả việc cần làm, kết quả mong muốn và giới hạn…\" {7}>{8}</textarea><div class=\"comm-compose-footer\"><small data-comm-count>{9} / {10}</small><button type=\"submit\" class=\"ops-primary\" {11}>{12}</button></div>{13}</form>{14}<div class=\"comm-legend\"><strong>Đọc đúng trạng thái</strong><p>“Đã tiếp nhận” là kênh gửi đã chấp nhận yêu cầu. “Đã nhận” và “Đã phản hồi” cần bằng chứng từ ứng dụng đích.</p></div></section>", embedded ? "" : L("<p class=\"comm-note\">Chọn phiên đang có trên một trong ba máy. Trạng thái nhận tin chỉ cập nhật khi có biên nhận.</p>"), active || this.submitting || this.replay ? "disabled" : "", this.loading && !this.data ? L("Đang kiểm tra kênh gửi…") : L("Chọn phiên nhận"), groups, text(reason), embedded ? 4 : 7, LIMIT, active || this.submitting || this.replay ? "readonly" : "", text(this.draft), this.draft.length.toLocaleString(locale()), LIMIT.toLocaleString(locale()), canSend ? "" : "disabled", this.submitting ? L("Đang gửi…") : L("Gửi việc"), this.formError ? `<p class="comm-error" role="alert">${text(this.formError)}</p>` : "", active && !this.replay ? `<div class="comm-result" role="status">${statusMarkup(active.status)}<p>${text(active.detail)}</p>${OPEN_STATUSES.has(active.status) ? L("<button type=\"button\" data-comm-action=\"check\" data-receipt=\"{0}\" data-key=\"comm-active-check\" {1}>Kiểm tra biên nhận</button>", text(active.id), this.checking.has(active.id) ? "disabled" : "") : ""}${!this.submitting ? `<button type="button" data-comm-action="new" data-key="comm-new">${OPEN_STATUSES.has(active.status) ? L("Soạn việc khác") : L("Soạn việc mới")}</button>` : ""}</div>` : "");
    const historyMarkup = L("<section class=\"comm-history\"><div class=\"comm-history-heading\"><div><h3>Nhật ký giao tiếp</h3><p>{0} lượt gần nhất{1}</p></div><label class=\"comm-filter\">Máy<select data-comm-filter data-key=\"comm-filter\"><option value=\"\">Tất cả máy</option>{2}</select></label></div>{3}{4}{5}</section>", history.length, this.filter ? ` · ${text(MACHINE_LABELS[this.filter])}` : "", MACHINE_ORDER.map((machine) => `<option value="${machine}" ${this.filter === machine ? "selected" : ""}>${text(MACHINE_LABELS[machine])}</option>`).join(""), this.error ? L("<p class=\"comm-error\" role=\"alert\">{0} <button type=\"button\" data-comm-action=\"refresh\" data-key=\"comm-refresh\">Kiểm tra lại</button></p>", text(this.error)) : "", history.length ? `<div class="comm-feed">${visibleHistory.map((item) => item.html).join("")}</div>` : L("<div class=\"comm-empty\"><strong>Chưa có trao đổi được ghi nhận</strong><p>Khi agent gửi tin qua kênh được hỗ trợ hoặc sếp giao việc tại đây, người gửi, máy nhận và biên nhận sẽ xuất hiện.</p></div>"), embedded && history.length > 4 ? `<button type="button" class="comm-expand" data-comm-action="expand" data-key="comm-expand" aria-expanded="${this.expanded}">${this.expanded ? L("Thu gọn") : L("Xem thêm {0} lượt", history.length - 4)}</button>` : "");
    const heading = embedded ? L("<header class=\"comm-embedded-heading\"><div><h3>Giao tiếp</h3><span class=\"comm-caption\">{0}</span></div><button type=\"button\" class=\"ops-primary\" data-comm-action=\"compose\" data-key=\"comm-compose-toggle\" aria-controls=\"comm-compose\" aria-expanded=\"{1}\">{2}</button></header>", this.replay ? L("Lịch sử trao đổi") : this.connected ? L("Trao đổi giữa các máy") : L("Chờ kết nối hub"), this.composerOpen, this.composerOpen ? L("Đóng") : L("Giao việc")) : L("<div class=\"comm-intro\"><div><h2>Giao tiếp giữa các máy</h2><p>Theo dõi trao đổi thật giữa agent và giao việc vào đúng phiên.</p></div><span class=\"comm-live\" data-connected=\"{0}\">{1}</span></div><div class=\"comm-machines\">{2}</div>", this.connected, this.connected ? L("Đang nhận dữ liệu") : L("Chờ kết nối"), communicationMachines(this.snapshot, this.connected));
    return `<div class="comm-board${embedded ? " comm-embedded" : ""}">${heading}${this.replay ? L("<p class=\"comm-replay-notice\" role=\"status\">Đang xem lại lịch sử; trở về Trực tiếp để giao việc.</p>") : ""}<div class="comm-layout">${!embedded || this.composerOpen ? compose : ""}${historyMarkup}</div></div>`;
  }
}
