import { L } from "../shared/i18n.ts";
import type { AgentInfo, MachineId } from "../shared/types.ts";
import type { DispatchList, DispatchReceipt, DispatchStatus, DispatchTarget } from "../shared/dispatch.ts";
import { uuid } from "./agent-controls.ts";
import { copyText } from "./clipboard.ts";
import { escapeHtml as escape } from "./markdown.ts";

const STORAGE_KEY = "msc-decision-receipts";
const APP_LABELS = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
const SAVED_LIMIT = 100;
const MESSAGE_LIMIT = 4000;
const CHECK_WINDOW_MS = 10 * 60_000;
const SETTLED: readonly DispatchStatus[] = ["replied", "failed"];
const NOT_APPROVAL: Record<AgentInfo["app"], string> = {
  claude: L("Claude nhận như tin từ phiên khác, không tính là sếp duyệt. Cần duyệt thì bấm trong app."),
  codex: L("Codex có thể không tính đây là sếp duyệt. Cần duyệt thì trả lời trong app."),
  antigravity: L("Antigravity có thể không tính đây là sếp duyệt. Cần duyệt thì trả lời trong app."),
};
const STATUS_TITLES: Record<DispatchStatus, string> = { queued: L("Đang gửi"), sending: L("Đang gửi"), accepted: L("Đã chuyển vào chat"), delivered: L("Đã tới chat"), replied: L("Agent đã phản hồi"), failed: L("Chưa gửi được"), unknown: L("Chưa xác nhận được") };

interface SentAnswer {
  key: string;
  requestId: string;
  agentId: string;
  machine: MachineId;
  answer: string;
  status: DispatchStatus;
  detail: string;
  at: string;
}

interface AnswerRoute {
  send: boolean;
  checking?: boolean;
  note: string;
}

export function decisionKey(agent: AgentInfo): string {
  return `${agent.machine}|${agent.id}|${agent.pending?.askedAt ?? ""}`;
}

export class DecisionReplies {
  private targets: DispatchTarget[] | null = null;
  private error = "";
  private inflight: Promise<void> | null = null;
  private readonly routing = new Set<string>();
  private readonly sent = new Map<string, SentAnswer>();
  private readonly drafts = new Map<string, string>();
  private readonly notices = new Map<string, string>();
  private readonly rendered = new Map<string, { agent: AgentInfo; online: boolean }>();
  private readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
      for (const item of Array.isArray(saved) ? saved.slice(-SAVED_LIMIT) : []) {
        if (item && typeof item.key === "string" && typeof item.requestId === "string" && typeof item.agentId === "string" && typeof item.machine === "string" && typeof item.answer === "string" && typeof item.status === "string" && typeof item.detail === "string") this.sent.set(item.key, item);
      }
    } catch {}
  }

  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<void> {
    try {
      const response = await fetch("/api/communications", { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(response.status === 401 ? L("Đăng nhập bằng mã truy cập để gửi từ web.") : L("Chưa nối được kênh gửi vào chat."));
      const data = await response.json() as DispatchList;
      this.targets = Array.isArray(data?.targets) ? data.targets : [];
      this.error = "";
    } catch (error) {
      this.targets = null;
      this.error = error instanceof Error ? error.message : L("Chưa kiểm tra được kênh gửi vào chat.");
    }
    await Promise.all([...this.sent.values()].filter((item) => this.needsCheck(item)).map((item) => this.check(item)));
    this.changed();
  }

  private needsCheck(item: SentAnswer): boolean {
    return !SETTLED.includes(item.status) && Date.now() - Date.parse(item.at) < CHECK_WINDOW_MS;
  }

  private route(agent: AgentInfo, online: boolean): AnswerRoute {
    const place = L("{0} trên {1}", APP_LABELS[agent.app], agent.machine);
    const fallback = (reason: string): AnswerRoute => ({ send: false, note: L("{0} Bấm để chép rồi dán vào {1}.", reason, place) });
    if (!online) return fallback(L("Máy đang mất kết nối."));
    if (agent.pending?.kind !== "decision" || agent.state !== "idle") return fallback(L("Phiên này chưa nối kênh trả lời trực tiếp: máy chưa cài hook, hoặc phiên mở trước khi cài."));
    if (this.error) return fallback(this.error);
    if (!this.targets) return { send: false, checking: true, note: L("Đang kiểm tra kênh gửi vào chat. Bấm là gửi ngay khi kiểm tra xong.") };
    const target = this.targets.find((item) => item.agentId === agent.id && item.machine === agent.machine);
    if (!target) return fallback(L("Chưa thấy phiên này trong kênh gửi."));
    return target.available ? { send: true, note: L("Gửi thành tin nhắn vào đúng chat. {0}", NOT_APPROVAL[agent.app]) } : fallback(`${target.reason}.`.replace(/\.\.$/, "."));
  }

  markup(agent: AgentInfo, online: boolean, chatHref: string | null = null): string {
    const pending = agent.pending;
    if (!pending) return "";
    const key = decisionKey(agent);
    this.rendered.set(key, { agent, online });
    const id = escape(key);
    const sent = this.sent.get(key);
    if (sent && sent.status !== "failed") return `<section class="cq" data-kind="decision" role="status"><div class="cq-sent"><strong>${escape(STATUS_TITLES[sent.status])}: “${escape(sent.answer)}”</strong><p>${escape(sent.detail)}</p><p>${escape(NOT_APPROVAL[agent.app])}</p>${sent.status === "unknown" ? L("<button type=\"button\" class=\"cq-btn\" data-tone=\"neutral\" data-decide-check=\"{0}\" data-key=\"decide-check:{1}\">Kiểm tra biên nhận</button>", id, id) : ""}</div></section>`;
    const route = this.route(agent, online);
    const buttons = pending.options.map((option, index) => `<button type="button" class="cq-btn" data-tone="${index === 0 ? "primary" : "neutral"}" data-decide="${id}" data-decide-index="${index}" data-key="decide:${id}:${index}">${escape(option)}</button>`).join("");
    const draft = this.drafts.get(key) ?? "";
    const notice = this.notices.get(key) ?? (sent ? sent.detail : route.note);
    return L("<section class=\"cq\" data-kind=\"decision\"><p class=\"cq-question\">{0}</p>{1}<label class=\"cq-other\"><span class=\"cq-label\">{2}</span><textarea rows=\"1\" maxlength=\"{3}\" placeholder=\"Nhập câu trả lời của sếp…\" data-decide-text=\"{4}\" data-key=\"decide-text:{5}\">{6}</textarea></label><div class=\"cq-foot\"><small role=\"status\">{7}</small><div class=\"cq-actions\">{8}<button type=\"button\" class=\"cq-btn\" data-tone=\"neutral\" data-decide-custom=\"{9}\" data-key=\"decide-custom:{10}\">{11}</button></div></div></section>", escape(pending.question), buttons ? `<div class="cq-actions">${buttons}</div>` : "", buttons ? L("Khác") : L("Câu trả lời"), MESSAGE_LIMIT, id, id, escape(draft), escape(notice), chatHref ? L("<a class=\"cq-btn\" href=\"{0}\" target=\"_blank\" rel=\"noopener noreferrer\" data-key=\"decide-chat:{1}\">Mở chat gốc</a>", escape(chatHref), id) : "", id, id, route.send || route.checking ? L("Gửi tin nhắn") : L("Chép"));
  }

  signature(agent: AgentInfo): string {
    if (!agent.pending) return "";
    const key = decisionKey(agent);
    const target = this.targets?.find((item) => item.agentId === agent.id && item.machine === agent.machine);
    const sent = this.sent.get(key);
    return JSON.stringify([key, this.targets === null, target?.available, target?.reason, this.error, this.notices.get(key), sent?.status, sent?.detail]);
  }

  input(target: HTMLInputElement | HTMLTextAreaElement): boolean {
    const key = target.dataset.decideText;
    if (!key) return false;
    this.drafts.set(key, target.value);
    return true;
  }

  click(target: Element, enabled: boolean): boolean {
    const option = target.closest<HTMLElement>("[data-decide]");
    const custom = target.closest<HTMLElement>("[data-decide-custom]");
    const check = target.closest<HTMLElement>("[data-decide-check]");
    if (!option && !custom && !check) return false;
    if (!enabled) return true;
    if (check?.dataset.decideCheck) {
      const item = this.sent.get(check.dataset.decideCheck);
      if (item) void this.check(item).then(() => this.changed());
      return true;
    }
    const key = option?.dataset.decide ?? custom?.dataset.decideCustom ?? "";
    const entry = this.rendered.get(key);
    if (!entry?.agent.pending) return true;
    const answer = option ? entry.agent.pending.options[Number(option.dataset.decideIndex)] : (this.drafts.get(key) ?? "").trim();
    if (!answer) {
      this.notices.set(key, L("Nhập câu trả lời trước đã."));
      this.changed();
      return true;
    }
    void this.answer(key, entry.agent, entry.online, answer);
    return true;
  }

  private save(): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.sent.values()].slice(-SAVED_LIMIT)));
      return true;
    } catch { return false; }
  }

  private async answer(key: string, agent: AgentInfo, online: boolean, answer: string): Promise<void> {
    const current = this.sent.get(key);
    if (current && current.status !== "failed" || this.routing.has(key)) return;
    let route = this.route(agent, online);
    if (route.checking) {
      this.routing.add(key);
      this.notices.set(key, L("Đang kiểm tra kênh gửi cho “{0}”. Chưa gửi nội dung.", answer));
      this.changed();
      await this.refresh();
      this.routing.delete(key);
      this.notices.delete(key);
      route = this.route(agent, online);
      if (!route.send) {
        this.notices.set(key, route.note);
        this.changed();
        return;
      }
    } else if (!route.send) return this.copy(key, agent, answer);
    const item: SentAnswer = { key, requestId: uuid(), agentId: agent.id, machine: agent.machine, answer, status: "sending", detail: L("Đang gửi vào đúng chat. Không gửi lại trong khi chờ."), at: new Date().toISOString() };
    this.sent.set(key, item);
    if (!this.save()) {
      this.sent.delete(key);
      this.notices.set(key, L("Trình duyệt chưa lưu được mã gửi để chống gửi trùng. Chưa gửi nội dung."));
      this.changed();
      return;
    }
    this.notices.delete(key);
    this.changed();
    try {
      const response = await fetch("/api/communications", { method: "POST", headers: { "content-type": "application/json", "x-msc-communication": "human-web" }, body: JSON.stringify({ requestId: item.requestId, targetAgentId: agent.id, targetMachine: agent.machine, message: answer }), signal: AbortSignal.timeout(45_000) });
      const result = await response.json() as Partial<DispatchReceipt> & { error?: unknown };
      if (result.id === item.requestId && result.status && typeof result.detail === "string") {
        item.status = result.status;
        item.detail = result.detail.slice(0, 500);
      } else if (response.status >= 400 && response.status < 500) {
        item.status = "failed";
        item.detail = typeof result.error === "string" ? result.error.slice(0, 300) : L("Yêu cầu bị từ chối trước khi gửi tới agent.");
      } else throw new Error("no receipt");
    } catch {
      item.status = "unknown";
      item.detail = L("Chưa rõ máy đích đã nhận hay chưa; không gửi lại. Kiểm tra biên nhận hoặc chat gốc.");
    }
    this.save();
    this.changed();
  }

  private async copy(key: string, agent: AgentInfo, answer: string): Promise<void> {
    const place = L("{0} trên {1}", APP_LABELS[agent.app], agent.machine);
    this.notices.set(key, await copyText(answer) ? L("Đã chép “{0}”. Dán vào {1} để trả lời.", answer, place) : L("Trình duyệt không cho chép tự động. Gõ “{0}” trong {1}.", answer, place));
    this.changed();
  }

  private async check(item: SentAnswer): Promise<void> {
    try {
      const response = await fetch(`/api/communications/${encodeURIComponent(item.requestId)}?machine=${encodeURIComponent(item.machine)}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return;
      const result = await response.json() as Partial<DispatchReceipt> | null;
      if (result?.id !== item.requestId || !result.status || typeof result.detail !== "string") return;
      item.status = result.status;
      item.detail = result.detail.slice(0, 500);
      this.save();
    } catch {}
  }
}
