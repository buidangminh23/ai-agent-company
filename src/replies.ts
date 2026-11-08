import type { AgentInfo, MachineId } from "../shared/types.ts";
import type { ReplyField, ReplyKind, ReplyList, ReplyQuestion, ReplyReceipt } from "../shared/replies.ts";
import { escapeHtml as escape, renderMarkdown } from "./markdown.ts";

const OPTION_DIGIT = /^[1-9]$/;

export function pressOptionKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || !OPTION_DIGIT.test(event.key)) return false;
  const target = event.target as Element | null;
  const field = target?.closest?.(".cq-field");
  if (!field || target?.closest("textarea")) return false;
  const option = field.querySelectorAll<HTMLInputElement>(".cq-option input")[Number(event.key) - 1];
  if (!option) return false;
  event.preventDefault();
  option.click();
  option.focus({ preventScroll: true });
  return true;
}

const APP_LABELS = { claude: "Claude", codex: "Codex" };
const DENY_DECISIONS = new Set(["deny", "decline"]);
const STOP_DECISIONS = new Set(["deny-stop", "cancel"]);
const SETTLE_MS = 60_000;
const AWAIT_MS = 12_000;
const SEEN_LIMIT = 200;
const STOP_WARNINGS: Record<string, string> = { cancel: "Từ chối và dừng lượt: Codex Desktop tự từ chối mọi yêu cầu duyệt và gửi câu trả lời trống cho mọi câu hỏi khác đang chờ trong chat này.", "deny-stop": "Từ chối và dừng lượt: Claude dừng ngay lượt đang chạy." };

interface LocalReply {
  requestId: string;
  questionId: string;
  agentId: string;
  machine: MachineId;
  detail: string;
  status: ReplyReceipt["status"];
  kind?: ReplyKind;
  sentAt?: number;
}

export class ReplyControls {
  private data: ReplyList | null = null;
  private loading = false;
  private again = false;
  private runs = 0;
  private checkedRun = 0;
  private error = "";
  private readonly firstSeen = new Map<string, { run: number; at: number }>();
  private readonly values = new Map<string, string[]>();
  private readonly receipts = new Map<string, LocalReply>();
  private readonly errors = new Map<string, string>();
  private readonly confirming = new Map<string, string>();

  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    try {
      const saved = JSON.parse(localStorage.getItem("msc-reply-receipts") ?? "[]");
      for (const item of Array.isArray(saved) ? saved.slice(-100) : []) {
        if (item && typeof item.questionId === "string" && typeof item.requestId === "string" && typeof item.agentId === "string" && typeof item.detail === "string") this.receipts.set(item.questionId, item);
      }
    } catch {}
  }

  async refresh(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    const run = ++this.runs;
    try {
      const response = await fetch("/api/reply-questions", { cache: "no-store", signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(response.status === 401 ? "Đăng nhập bằng mã truy cập để trả lời trực tiếp." : "Chưa nối được kênh trả lời trực tiếp.");
      this.data = await response.json();
      this.checkedRun = run;
      this.error = "";
    } catch (error) {
      this.data = null;
      this.error = error instanceof Error ? error.message : "Chưa kiểm tra được câu hỏi gốc.";
    } finally {
      this.loading = false;
      this.changed();
    }
    if (this.again) {
      this.again = false;
      await this.refresh();
    }
  }

  awaiting(agent: AgentInfo): boolean {
    const pending = agent.pending;
    if (!pending || pending.kind === "decision" || this.error) return false;
    const key = `${agent.id}|${pending.askedAt}`;
    let seen = this.firstSeen.get(key);
    if (seen === undefined) {
      if (this.firstSeen.size >= SEEN_LIMIT) this.firstSeen.clear();
      seen = { run: this.runs, at: Date.now() };
      this.firstSeen.set(key, seen);
      void this.refresh();
    }
    return this.checkedRun <= seen.run && Date.now() - seen.at < AWAIT_MS;
  }

  markup(agent: AgentInfo, enabled: boolean): string {
    if (!enabled) return "";
    const questions = this.data?.questions.filter((question) => question.agentId === agent.id) ?? [];
    const receipts = [...this.receipts.values()].filter((receipt) => receipt.agentId === agent.id).slice(-2);
    const receiptMarkup = receipts.map((receipt) => `<div class="ops-reply-status cq-status" role="status"><strong>${receipt.status === "answered" ? receipt.kind === "approval" ? "Đã gửi quyết định" : receipt.kind === "plan" ? "Đã gửi yêu cầu sửa kế hoạch" : "Đã trả lời" : receipt.status === "rejected" ? "Chưa gửi" : "Đang xác minh kết quả"}</strong><p>${escape(receipt.detail)}</p>${receipt.status === "pending" || receipt.status === "unknown" ? `<button type="button" class="cq-btn" data-tone="neutral" data-reply-receipt="${escape(receipt.questionId)}">Kiểm tra biên nhận</button>` : ""}</div>`).join("");
    if (questions.length) return receiptMarkup + questions.filter((question) => !this.receipts.has(question.id) || this.receipts.get(question.id)?.status === "rejected").map((question) => this.questionMarkup(question)).join("");
    if (!agent.pending || agent.pending.kind === "decision" || this.settling(agent)) return receiptMarkup;
    if (this.awaiting(agent)) return receiptMarkup + `<p class="ops-source-note" role="status">Đang lấy câu hỏi từ phiên này…</p>`;
    const note = this.error || this.data?.unavailable.find((item) => item.agentId === agent.id && item.machine === agent.machine)?.reason || "Chưa có câu hỏi native được xác minh để gửi trực tiếp.";
    return receiptMarkup + `<p class="ops-source-note">${escape(note)}</p>`;
  }

  settling(agent: AgentInfo): boolean {
    const asked = Date.parse(agent.pending?.askedAt ?? "");
    const now = Date.now();
    return [...this.receipts.values()].some((receipt) => receipt.agentId === agent.id && receipt.status !== "rejected" && receipt.sentAt !== undefined && now - receipt.sentAt < SETTLE_MS && !(asked > receipt.sentAt));
  }

  hasQuestion(agentId: string): boolean {
    return this.data?.questions.some((question) => question.agentId === agentId) ?? false;
  }

  signature(agentId: string): string {
    const questions = this.data?.questions.filter((question) => question.agentId === agentId) ?? [];
    return JSON.stringify([questions.map((question) => question.id), [...this.receipts.values()].filter((receipt) => receipt.agentId === agentId).map((receipt) => [receipt.questionId, receipt.status, receipt.detail]), questions.map((question) => [this.errors.get(question.id), this.confirming.get(question.id)]), this.error]);
  }

  private questionMarkup(question: ReplyQuestion): string {
    const header = `<header class="cq-head"><strong>${escape(question.title || (question.kind === "approval" ? "Yêu cầu cấp quyền" : question.kind === "plan" ? "Kế hoạch chờ duyệt" : "Câu hỏi đang chờ"))}</strong><small>${APP_LABELS[question.app]} · ${escape(question.machine)}</small></header>`;
    const error = this.errors.has(question.id) ? `<p class="ops-reply-error" role="alert">${escape(this.errors.get(question.id)!)}</p>` : "";
    if (question.kind === "question") {
      const fields = `<div class="cq-fields">${question.fields.map((field) => this.fieldMarkup(question, field)).join("")}</div>`;
      return `<div class="cq" data-kind="question">${header}${fields}<div class="cq-foot"><small>Ai trả lời trước (web hoặc app) sẽ được áp dụng.</small><button type="button" class="cq-btn" data-tone="primary" data-reply-send="${escape(question.id)}" data-key="reply-send:${escape(question.id)}">Gửi câu trả lời</button></div>${error}</div>`;
    }
    const decision = this.decisionField(question);
    const extras = question.fields.filter((field) => field !== decision).map((field) => this.textMarkup(question, field)).join("");
    const pendingStop = decision && this.confirming.get(question.id);
    const buttons = decision && pendingStop && decision.options.includes(pendingStop) ? `<div class="ops-control-confirm" role="group" aria-label="Xác nhận ${escape(decision.labels?.[pendingStop] ?? pendingStop)}"><p>${escape(STOP_WARNINGS[pendingStop] ?? "Từ chối và dừng lượt đang chạy.")}</p><div class="cq-actions"><button type="button" class="cq-btn" data-tone="stop" data-reply-confirm="${escape(question.id)}" data-reply-value="${escape(pendingStop)}" data-key="reply-confirm:${escape(question.id)}">Xác nhận</button><button type="button" class="cq-btn" data-tone="neutral" data-reply-cancel="${escape(question.id)}" data-key="reply-cancel:${escape(question.id)}">Huỷ</button></div></div>` : decision ? `<div class="cq-actions" role="group" aria-label="${question.kind === "plan" ? "Phản hồi kế hoạch" : "Quyết định cấp quyền"}">${decision.options.map((option, index) => `<button type="button" class="cq-btn" data-reply-decision="${escape(question.id)}" data-reply-value="${escape(option)}" data-tone="${STOP_DECISIONS.has(option) ? "stop" : DENY_DECISIONS.has(option) ? "deny" : index === 0 ? "primary" : "neutral"}" data-key="reply-decision:${escape(question.id)}:${index}">${escape(decision.labels?.[option] ?? option)}</button>`).join("")}</div>` : "";
    if (question.kind === "plan") return `<div class="cq" data-kind="plan">${header}<div class="ops-reply-plan ops-md">${renderMarkdown(question.detail)}</div>${extras}${buttons}${error}<small class="cq-note">Duyệt kế hoạch thực hiện trong ứng dụng Claude; Claude không cho hook tự duyệt kế hoạch.</small></div>`;
    return `<div class="cq" data-kind="approval">${header}${question.detail ? `<pre class="ops-reply-detail" tabindex="0">${escape(question.detail)}</pre>` : ""}${extras}${buttons}${error}<small class="cq-note">Ai trả lời trước (web hoặc app) sẽ được áp dụng.</small></div>`;
  }

  private decisionField(question: ReplyQuestion): ReplyField | undefined {
    return question.fields.find((field) => field.id === "decision") ?? question.fields.find((field) => field.options.length && !field.multiSelect);
  }

  private fieldMarkup(question: ReplyQuestion, field: ReplyField): string {
    const key = `${question.id}:${field.id}`;
    const selected = this.values.get(key) ?? [];
    const rows = field.options.map((option, index) => {
      const description = field.descriptions?.[option];
      return `<label class="cq-option"><input type="${field.multiSelect ? "checkbox" : "radio"}" name="reply-${escape(key)}" value="${escape(option)}" data-reply-field="${escape(key)}" data-key="reply:${escape(key)}:${index}" ${selected.includes(option) ? "checked" : ""}><span class="cq-index" aria-hidden="true">${index + 1}</span><span class="cq-text"><span class="cq-label">${escape(field.labels?.[option] ?? option)}</span>${description ? `<span class="cq-desc">${escape(description)}</span>` : ""}</span><span class="cq-mark" data-multi="${field.multiSelect}" aria-hidden="true"></span></label>`;
    }).join("");
    const other = field.allowFreeText ? `<label class="cq-other"><span class="cq-label">${field.options.length ? "Khác" : "Câu trả lời"}</span><textarea rows="1" maxlength="4000" placeholder="Nhập câu trả lời của sếp…" data-reply-text="${escape(key)}" data-key="reply:${escape(key)}:text">${escape(selected.find((value) => !field.options.includes(value)) ?? "")}</textarea></label>` : "";
    return `<fieldset class="cq-field"><legend class="cq-question">${field.header ? `<span class="cq-chip">${escape(field.header)}</span>` : ""}<span>${escape(field.text)}</span></legend><div class="cq-options">${rows}${other}</div></fieldset>`;
  }

  private textMarkup(question: ReplyQuestion, field: ReplyField): string {
    if (field.options.length) return this.fieldMarkup(question, field);
    const key = `${question.id}:${field.id}`;
    const label = field.id === "feedback" ? "Lý do / góp ý cho agent (không bắt buộc)" : `${field.text}${field.optional ? " (không bắt buộc)" : ""}`;
    return `<label class="ops-reply-feedback">${escape(label)}<textarea rows="2" maxlength="4000" data-reply-text="${escape(key)}" data-key="reply:${escape(key)}:text">${escape(this.values.get(key)?.[0] ?? "")}</textarea></label>`;
  }

  input(target: HTMLInputElement | HTMLTextAreaElement): void {
    const key = target.dataset.replyField ?? target.dataset.replyText;
    if (!key) return;
    const question = this.data?.questions.find((item) => key.startsWith(`${item.id}:`));
    const field = question?.fields.find((item) => key === `${question.id}:${item.id}`);
    if (!field) return;
    if (target.dataset.replyText) {
      this.values.set(key, target.value.trim() ? [target.value] : []);
      const parent = target.closest("fieldset");
      parent?.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.checked = false; });
    } else if (target instanceof HTMLInputElement) {
      const selected = field.multiSelect ? (this.values.get(key) ?? []).filter((value) => field.options.includes(value) && value !== target.value) : [];
      if (target.checked) selected.push(target.value);
      this.values.set(key, selected);
      const freeText = target.closest("fieldset")?.querySelector("textarea");
      if (freeText) freeText.value = "";
    }
  }

  click(target: Element, enabled: boolean): boolean {
    const send = target.closest<HTMLElement>("[data-reply-send]");
    const decision = target.closest<HTMLElement>("[data-reply-decision]");
    const receipt = target.closest<HTMLElement>("[data-reply-receipt]");
    const confirm = target.closest<HTMLElement>("[data-reply-confirm]");
    const cancel = target.closest<HTMLElement>("[data-reply-cancel]");
    if (!send && !decision && !receipt && !confirm && !cancel) return false;
    if (cancel?.dataset.replyCancel) { this.confirming.delete(cancel.dataset.replyCancel); this.changed(); }
    if (enabled && send?.dataset.replySend) void this.send(send.dataset.replySend);
    if (enabled && decision?.dataset.replyDecision && decision.dataset.replyValue !== undefined) this.decide(decision.dataset.replyDecision, decision.dataset.replyValue, false);
    if (enabled && confirm?.dataset.replyConfirm && confirm.dataset.replyValue !== undefined) this.decide(confirm.dataset.replyConfirm, confirm.dataset.replyValue, true);
    if (receipt?.dataset.replyReceipt) void this.checkReceipt(receipt.dataset.replyReceipt);
    return true;
  }

  private decide(id: string, value: string, confirmed: boolean): void {
    const question = this.data?.questions.find((item) => item.id === id);
    const field = question && this.decisionField(question);
    if (!question || !field || !field.options.includes(value) || this.receipts.has(id) && this.receipts.get(id)?.status !== "rejected") return;
    if (confirmed ? this.confirming.get(id) !== value : STOP_DECISIONS.has(value)) {
      if (!confirmed) { this.confirming.set(id, value); this.errors.delete(id); this.changed(); }
      return;
    }
    this.confirming.delete(id);
    this.values.set(`${id}:${field.id}`, [value]);
    void this.send(id);
  }

  private save(): boolean {
    try {
      localStorage.setItem("msc-reply-receipts", JSON.stringify([...this.receipts.values()].slice(-100)));
      return true;
    } catch { return false; }
  }

  private async send(id: string): Promise<void> {
    const question = this.data?.questions.find((item) => item.id === id);
    if (!question || this.receipts.has(id) && this.receipts.get(id)?.status !== "rejected") return;
    const answers: Record<string, string[]> = Object.fromEntries(question.fields.map((field) => [field.id, (this.values.get(`${id}:${field.id}`) ?? []).map((value) => value.trim()).filter(Boolean)]));
    for (const field of question.fields) if (field.optional && !answers[field.id].length) delete answers[field.id];
    if (question.fields.some((field) => !answers[field.id] && !field.optional) || question.fields.some((field) => answers[field.id] && ((!field.multiSelect && answers[field.id].length !== 1) || (!field.allowFreeText && answers[field.id].some((value) => !field.options.includes(value)))))) {
      this.errors.set(id, question.kind === "question" ? "Chọn hoặc nhập câu trả lời cho tất cả câu hỏi trước khi gửi." : "Chọn một quyết định trước khi gửi.");
      this.changed();
      return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    const requestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const body = JSON.stringify({ requestId, questionId: id, agentId: question.agentId, machine: question.machine, answers });
    if (new TextEncoder().encode(body).byteLength > 32 * 1024) {
      this.errors.set(id, "Tổng nội dung quá dài. Rút ngắn câu trả lời rồi gửi lại; chưa gửi dữ liệu.");
      this.changed();
      return;
    }
    const receipt: LocalReply = { requestId, questionId: id, agentId: question.agentId, machine: question.machine, status: "pending", kind: question.kind, sentAt: Date.now(), detail: question.kind === "question" ? "Đang gửi câu trả lời. Không gửi lại trong khi kiểm tra." : "Đang gửi quyết định. Không gửi lại trong khi kiểm tra." };
    this.receipts.set(id, receipt);
    if (!this.save()) {
      this.receipts.delete(id);
      this.errors.set(id, "Không lưu được biên nhận trong trình duyệt. Bật lưu trữ trang rồi thử lại; chưa gửi câu trả lời.");
      this.changed();
      return;
    }
    this.changed();
    try {
      const response = await fetch("/api/replies", { method: "POST", headers: { "content-type": "application/json", "x-msc-reply": "human-web" }, body, signal: AbortSignal.timeout(40_000) });
      if (!response.ok) throw new Error("Chưa xác nhận được kết quả gửi. Kiểm tra biên nhận hoặc chat gốc trước khi thao tác tiếp.");
      const result = await response.json() as ReplyReceipt;
      if (result.requestId !== requestId || result.questionId !== id) throw new Error("Biên nhận không khớp.");
      if (this.data) this.data.questions = this.data.questions.filter((entry) => entry.id !== id);
      Object.assign(receipt, result);
    } catch {
      receipt.status = "unknown";
      receipt.detail = "Chưa xác nhận được kết quả; không gửi lại. Kiểm tra biên nhận hoặc chat gốc.";
    }
    this.save();
    this.changed();
    await this.refresh();
  }

  private async checkReceipt(id: string): Promise<void> {
    const receipt = this.receipts.get(id);
    if (!receipt) return;
    try {
      const response = await fetch(`/api/replies/${encodeURIComponent(receipt.requestId)}?machine=${encodeURIComponent(receipt.machine)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Chưa kết nối được nơi lưu biên nhận; kiểm tra chat gốc. Không gửi lại.");
      const result = await response.json() as ReplyReceipt | null;
      if (result?.requestId === receipt.requestId && result.questionId === id) Object.assign(receipt, result);
      else receipt.detail = "Chưa tìm thấy biên nhận trên máy đích. Kiểm tra chat gốc; không gửi lại khi chưa xác minh.";
    } catch {
      receipt.detail = "Chưa kết nối được nơi lưu biên nhận; kiểm tra chat gốc. Không gửi lại.";
    }
    this.save();
    this.changed();
  }
}
