import type { AgentInfo, MachineId, Snapshot } from "../shared/types.ts";
import type { CalendarEvent, InboxSnapshot, MailContent } from "../shared/inbox.ts";
import { ALL_MAILBOXES, calendarRange, calendarScrollTop, calendarView, eventsToday, mailView, newDraft, draftFromEvent, draftToInput, shiftAnchor, todayKey, type CalendarMode, type EventDraft, type MailReader } from "./inbox-views.ts";
import type { AttentionItem, HistoryCoverage, OperationsSnapshot, ReplayResponse, TaskCard } from "../shared/operations.ts";
import { escapeHtml, renderMarkdown } from "./markdown.ts";
import { pressOptionKey, ReplyControls } from "./replies.ts";
import { DecisionReplies } from "./decision-replies.ts";
import { pressGuard } from "./press-guard.ts";
import "./reply-options.css";
import { AgentControls } from "./agent-controls.ts";
import "./agent-controls.css";
import { GitHubBoard } from "./github-view.ts";
import type { GitItem } from "../shared/github.ts";
import { TodoBoard } from "./todos-view.ts";
import { CommunicationsBoard } from "./communications-view.ts";
import "./communications-view.css";
import type { Todo } from "../shared/todos.ts";
import { systemAlerts, systemOverview, systemView } from "./system-view.ts";
import type { SystemSection, SystemFilter } from "./system-view.ts";
import type { SystemReport } from "../shared/system.ts";
import { attachTooltip } from "./charts.ts";
import type { AutomationReport } from "../shared/automation.ts";
import "./dashboard.css";
import "./system-view.css";

export type Tab = "overview" | "github" | "projects" | "mail" | "calendar" | "automation" | "quota";
interface DashboardCallbacks {
  selectAgent: (id: string) => void;
  replay: (snapshot: Snapshot | null) => void;
  effects: (enabled: boolean) => void;
  operations?: (snapshot: OperationsSnapshot) => void;
  inbox?: (snapshot: InboxSnapshot) => void;
  todos?: (todos: Todo[]) => void;
  github?: (count: number) => void;
  state?: (open: boolean, tab: Tab) => void;
}

export const ICONS = {
  git: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-7 2-7 4"/>',
  grid: '<path d="M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3"/>',
  agent: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.5 2.6-4 5-4s4.4 1.5 5 4"/>',
  alert: '<path d="M8 2.5l6 10.5H2zM8 7v2.5M8 11.5v.1"/>',
  machine: '<rect x="2" y="3" width="12" height="8" rx="1.2"/><path d="M6 13.5h4"/>',
  project: '<path d="M2 4.5h4.5l1.2 1.5H14v7H2z"/>',
  inbox: '<path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11zM2.5 9.5h3.5l.8 1.5h2.4l.8-1.5h3.5"/>',
  board: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M6.2 2.5v11M9.8 2.5v11"/>',
  auto: '<circle cx="8" cy="8" r="2"/><path d="M8 2.5v1.8M8 11.7v1.8M2.5 8h1.8M11.7 8h1.8M4.1 4.1l1.3 1.3M10.6 10.6l1.3 1.3M4.1 11.9l1.3-1.3M10.6 5.4l1.3-1.3"/>',
  chart: '<path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5"/>',
  money: '<circle cx="8" cy="8" r="5.5"/><path d="M9.8 6.3c-.3-.6-1-1-1.8-1-1 0-1.8.6-1.8 1.4 0 1.8 3.6 1 3.6 2.8 0 .8-.8 1.4-1.8 1.4-.9 0-1.6-.4-1.9-1M8 4.2v1.1M8 10.8v1"/>',
  gauge: '<path d="M2.8 11.5a5.5 5.5 0 1 1 10.4 0M8 9.5l2.5-3"/>',
  back: '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  home: '<path d="M2.5 7.5 8 3l5.5 4.5V13.5H9.8V10H6.2v3.5H2.5z"/>',
  check: '<circle cx="8" cy="8" r="5.5"/><path d="m5.6 8.1 1.7 1.7 3.1-3.4"/>',
  warn: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.2v3.3M8 10.8v.1"/>',
  chevron: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
  chat: '<path d="M2.5 4.5h11v6.5H8l-3 2.5V11H2.5z"/>',
  target: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8"/>',
  mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.3"/><path d="m2.5 4.5 5.5 4.2 5.5-4.2"/>',
  users: '<circle cx="6" cy="5.5" r="2.2"/><path d="M2 13c.4-2.4 2-3.8 4-3.8s3.6 1.4 4 3.8"/><path d="M10.5 3.6a2.1 2.1 0 1 1 .2 4.1M11.6 9.4c1.3.4 2.2 1.6 2.4 3.6"/>',
  store: '<path d="M2.5 6.5 3.5 3h9l1 3.5M2.5 6.5c0 1 .8 1.8 1.8 1.8S6 7.5 6 6.5c0 1 .9 1.8 2 1.8s2-.8 2-1.8c0 1 .8 1.8 1.8 1.8s1.7-.8 1.7-1.8M3.5 8.3v5.2h9V8.3M6.5 13.5v-3h3v3"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.3"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  send: '<path d="M13.5 2.5 2.5 7l4.2 1.8L8.5 13zM6.7 8.8l6.8-6.3"/>',
};
const TABS: [Tab, string, keyof typeof ICONS][] = [["overview", "Tổng quan", "grid"], ["github", "GitHub", "git"], ["projects", "Công việc", "board"], ["mail", "Thư", "mail"], ["calendar", "Lịch", "calendar"], ["automation", "Hệ thống", "machine"], ["quota", "Hạn mức", "gauge"]];
const SHORT_LABELS: Partial<Record<Tab, string>> = {};
const APP_NAMES = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
const STATE_NAMES = { thinking: "Đang nghĩ", working: "Đang làm", waiting: "Chờ sếp", idle: "Rảnh" };
const KIND_NAMES = { question: "Chờ trả lời", stalled: "Cần kiểm tra", offline: "Mất kết nối", failure: "Có lỗi", conflict: "Sửa trùng file" };
const TIMEZONE = "Asia/Ho_Chi_Minh";
const LONG_DETAIL = 260;
const AGENT_ALERTS: AttentionItem["kind"][] = ["stalled", "failure", "conflict"];
const SPLIT_TABS: Tab[] = ["github"];
const FILTER_TABS: Tab[] = ["github"];
const MOBILE = "(max-width: 760px)";
const CALENDAR_CACHE_MS = 5 * 60_000;
const AUTOMATION_CACHE_MS = 60_000;
const CHAT_NOTE = "Mở ứng dụng trên thiết bị đang xem; chat cần có trên thiết bị đó.";

export function icon(name: keyof typeof ICONS, className = "ops-icon"): string {
  return `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
}

function readable(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\((?:<[^>]*>|[^)\s]+)\)/g, (_, alt: string) => `[Ảnh: ${alt || "không tên"}]`)
    .replace(/\[([^\]]+)\]\(<[^>]*>\)/g, "$1");
}

function text(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function time(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Chưa có dữ liệu";
  return new Date(value).toLocaleString("vi-VN", { timeZone: TIMEZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function dateInput(now: number): string {
  return new Date(now + 7 * 3_600_000).toISOString().slice(0, 16);
}

function age(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (!Number.isFinite(minutes)) return "Chưa rõ thời điểm";
  return minutes < 1 ? "Vừa cập nhật" : minutes < 60 ? `${minutes} phút` : `${Math.floor(minutes / 60)} giờ ${minutes % 60} phút`;
}

function ago(value: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút`;
  return minutes < 1440 ? `${Math.floor(minutes / 60)} giờ` : `${Math.floor(minutes / 1440)} ngày`;
}

function waited(value: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(value)) / 60_000);
  return Number.isFinite(minutes) && minutes >= 1 ? `Đã chờ ${age(value)}` : "Vừa phát sinh";
}

export function safeLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || (url.protocol === "codex:" && url.hostname === "threads")) return url.href;
  } catch {}
  return null;
}

function link(value: string | undefined, label: string): string {
  const href = safeLink(value);
  return href ? `<a class="ops-action" href="${text(href)}" target="_blank" rel="noopener noreferrer">${text(label)}</a>` : "";
}

function empty(title: string, description: string): string {
  return `<div class="ops-empty"><strong>${text(title)}</strong><p>${text(description)}</p></div>`;
}

function coverage(value: HistoryCoverage): string {
  return `<p class="ops-coverage">${text(value.note)}${value.from ? ` · Dữ liệu từ ${time(value.from)}` : ""} · Giữ ${value.retentionDays} ngày${value.persistent ? "" : " · Chưa lưu bền vững"}</p>`;
}

export class OperationsDashboard {
  private readonly callbacks: DashboardCallbacks;
  private readonly root = document.createElement("main");
  private readonly toggle = document.createElement("button");
  private readonly replayBar = document.createElement("div");
  private readonly content: HTMLDivElement;
  private readonly status: HTMLElement;
  private readonly title: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly projectSelect: HTMLSelectElement;
  private readonly replayControls: HTMLElement;
  private readonly toolbar: HTMLElement;
  private snapshot: Snapshot | null = null;
  private operations: OperationsSnapshot | null = null;
  private inbox: InboxSnapshot | null = null;
  private mailbox = ALL_MAILBOXES;
  private reader: MailReader | null = null;
  private calendarMode: CalendarMode = "week";
  private calendarAnchor = todayKey(Date.now());
  private readonly calendarData = new Map<string, { at: number; events: CalendarEvent[] }>();
  private calendarLoading = "";
  private calendarError = "";
  private calendarEvent: string | null = null;
  private calendarForm: EventDraft | null = null;
  private calendarSaving = false;
  private calendarFormError = "";
  private automation: AutomationReport | null = null;
  private automationAt = 0;
  private automationLoading = false;
  private automationError = "";
  private automationMachine: MachineId | null = null;
  private system: SystemReport | null = null;
  private systemAt = 0;
  private systemLoading = false;
  private systemError = "";
  private systemSection: SystemSection = "background";
  private systemQuery = "";
  private systemFilter: SystemFilter = "all";
  private systemAllServices = false;
  private systemProcesses = false;
  private systemProcessQuery = "";
  private systemProcessLimit = 40;
  private systemServiceLimit = 40;
  private replayData: ReplayResponse | null = null;
  private tab: Tab = "overview";
  private opened = false;
  private connected = false;
  private error = "";
  private inboxError = "";
  private signature = "";
  private operationsBusy = false;
  private inboxBusy = false;
  private inboxRefreshAgain = false;
  private inboxForceAgain = false;
  private refreshAgain = false;
  private queryVersion = 0;
  private replayIndex = -1;
  private replayControlsOpen = false;
  private playback = 0;
  private effects = true;
  private lastFocus: HTMLElement | null = null;
  private modalFocus: HTMLElement | null = null;
  private readonly modalBackground = new Map<HTMLElement, boolean>();
  private readonly evidence = new Map<string, string>();
  private readonly expanded = new Set<string>();
  private readonly selected: Partial<Record<Tab, string>> = {};
  private detailOpen = false;
  private verifying: string | null = null;
  private readonly communications = new CommunicationsBoard(() => this.render());
  private readonly replies = new ReplyControls(() => this.answersChanged());
  private readonly decisions = new DecisionReplies(() => this.answersChanged());
  onAnswersChanged: () => void = () => {};
  private heldByPress: () => boolean = () => false;
  private askingId: string | null = null;
  private readonly controls = new AgentControls(() => this.render());
  private readonly todos = new TodoBoard((list) => {
    this.callbacks.todos?.(list);
    this.render();
  });
  private readonly github = new GitHubBoard(() => { this.callbacks.github?.(this.github.count()); this.render(); }, (message) => this.setNotice(message));

  constructor(callbacks: DashboardCallbacks) {
    this.callbacks = callbacks;
    try { this.effects = localStorage.getItem("msc-effects") !== "off"; } catch {}
    try { this.automationMachine = localStorage.getItem("msc-automation-machine") as MachineId | null; } catch {}
    callbacks.effects(this.effects);
    this.toggle.type = "button";
    this.toggle.className = "ops-toggle";
    this.toggle.setAttribute("aria-controls", "operations-dashboard");
    this.toggle.setAttribute("aria-expanded", "false");
    this.toggle.innerHTML = `${icon("grid")}<span>Điều hành</span>`;
    this.root.id = "operations-dashboard";
    this.root.className = "ops-shell";
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.setAttribute("aria-label", "Điều hành AI Agent Company");
    this.root.innerHTML = `<div class="ops-layout" data-side="none"><aside class="ops-side"><div class="ops-brand"><span class="ops-logo" aria-hidden="true">MS</span><div><strong>Trung tâm điều hành</strong><small>AI Agent Company</small></div></div>
      <nav class="ops-nav" role="tablist" aria-orientation="vertical" aria-label="Các bảng điều hành">${TABS.map(([id, label, name]) => `<button type="button" role="tab" id="ops-tab-${id}" data-tab="${id}" aria-label="${label}" title="${label}" aria-selected="${id === this.tab}" aria-controls="ops-content" tabindex="${id === this.tab ? 0 : -1}">${icon(name)}<span class="ops-nav-label"${SHORT_LABELS[id] ? ` data-short="${SHORT_LABELS[id]}"` : ""}><span class="ops-nav-full">${label}</span></span><span class="ops-tab-count" data-count-for="${id}" hidden></span></button>`).join("")}</nav>
      <p class="ops-status" role="status">Đang nối dữ liệu…</p></aside>
      <div class="ops-main"><header class="ops-topbar"><div class="ops-topbar-title"><span class="ops-kicker">AI Agent Company</span><h1 data-slot="title">Tổng quan</h1></div><div class="ops-toolbar" data-filters="on"><label class="ops-filter"><span>Dự án</span><select data-filter="project" aria-label="Dự án"><option value="">Tất cả</option></select></label><label class="ops-effects" title="Pháo giấy khi một việc được xác nhận hoàn tất"><input type="checkbox" role="switch" aria-label="Hiệu ứng" data-action="effects" ${this.effects ? "checked" : ""}><span>Hiệu ứng</span></label><button type="button" data-action="toggle-replay" class="ops-history-toggle" aria-expanded="false">Xem lại</button><button type="button" data-action="refresh" class="ops-icon-button" aria-label="Làm mới dữ liệu" title="Làm mới">${icon("refresh")}</button><button type="button" data-action="close" class="ops-icon-button ops-close" aria-label="Đóng trung tâm điều hành" title="Đóng (Esc)"><span aria-hidden="true">×</span></button></div></header>
      <div class="ops-date-controls" data-controls="replay" hidden><label>Từ (giờ Việt Nam)<input type="datetime-local" aria-label="Từ (giờ Việt Nam)" data-input="from" value="${dateInput(Date.now() - 3_600_000)}"></label><label>Đến (giờ Việt Nam)<input type="datetime-local" aria-label="Đến (giờ Việt Nam)" data-input="to" value="${dateInput(Date.now())}"></label><button type="button" data-action="load-replay">Xem lại văn phòng</button></div>
      <p class="ops-notice" role="status" hidden></p><div id="ops-content" class="ops-content" role="tabpanel" aria-labelledby="ops-tab-overview" data-layout="overview" tabindex="0"></div></div></div>`;
    this.content = this.root.querySelector<HTMLDivElement>(".ops-content")!;
    this.status = this.root.querySelector(".ops-status")!;
    this.title = this.root.querySelector('[data-slot="title"]')!;
    this.notice = this.root.querySelector(".ops-notice")!;
    this.projectSelect = this.root.querySelector('[data-filter="project"]')!;
    this.replayControls = this.root.querySelector('[data-controls="replay"]')!;
    this.toolbar = this.root.querySelector(".ops-toolbar")!;
    this.replayBar.className = "ops-replay-bar";
    this.replayBar.id = "operations-replay";
    this.replayBar.hidden = true;
    this.replayBar.innerHTML = '<b>XEM LẠI</b><button type="button" data-action="play">Phát</button><label class="ops-scrub"><span class="ops-replay-time"></span><input type="range" min="0" max="0" value="0" aria-label="Thời điểm xem lại"></label><button type="button" data-action="live">Về trực tiếp</button>';
    const controls = document.querySelector(".office-controls");
    if (controls) controls.prepend(this.toggle);
    else document.body.append(this.toggle);
    document.body.append(this.root, this.replayBar);
    this.toggle.addEventListener("click", () => this.open());
    this.todos.bind(this.root);
    attachTooltip(this.root);
    this.heldByPress = pressGuard(this.root, window, () => this.render());
    this.root.addEventListener("click", (event) => this.handleClick(event));
    this.replayBar.addEventListener("click", (event) => this.handleClick(event));
    this.replayBar.addEventListener("keydown", (event) => {
      if (this.opened) this.handleKey(event);
    });
    this.replayBar.querySelector("input")!.addEventListener("input", (event) => {
      this.pause();
      this.showFrame(Number((event.target as HTMLInputElement).value));
    });
    this.root.addEventListener("change", (event) => this.handleChange(event));
    this.root.addEventListener("input", (event) => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.sysQuery !== undefined) { this.systemQuery = input.value; this.systemServiceLimit = 40; this.render(); return; }
      if (input.dataset.sysProcessQuery !== undefined) { this.systemProcessQuery = input.value; this.systemProcessLimit = 40; this.render(); return; }
      if (this.communications.input(input)) return;
      if (this.todos.input(input, this.content)) return;
      if (this.controls.input(input)) return;
      this.answerInput(input);
      if (input.dataset.evidence) this.evidence.set(input.dataset.evidence, input.value);
      if (input.dataset.ev && this.calendarForm) {
        const key = input.dataset.ev as keyof EventDraft;
        this.calendarForm = { ...this.calendarForm, [key]: input.type === "checkbox" ? input.checked : input.value };
        if (key === "allDay") this.render();
      }
    });
    this.root.addEventListener("submit", (event) => {
      if (this.communications.submit(event.target as HTMLFormElement)) { event.preventDefault(); return; }
      if (this.todos.submit(event.target as HTMLFormElement)) { event.preventDefault(); return; }
      if (!(event.target as HTMLElement).matches("[data-cal-form]")) return;
      event.preventDefault();
      void this.saveEvent();
    });
    this.root.addEventListener("keydown", (event) => { if (!pressOptionKey(event)) this.handleKey(event); });
    document.addEventListener("focusin", (event) => {
      const modal = this.activeModal();
      if (modal && !modal.contains(event.target as Node)) modal.focus({ preventScroll: true });
    });
    setInterval(() => {
      if (document.visibilityState !== "hidden") {
        void this.refreshOperations();
        if (this.opened && this.replayIndex < 0) { this.refreshAnswers(); void this.controls.refresh(); }
        if (this.opened && this.tab === "overview") void this.communications.refresh();
        if (this.opened && (this.tab === "automation" || this.tab === "overview")) void this.loadSystem(false);
        if (this.opened && this.tab === "automation" && this.systemSection === "scheduled") void this.loadAutomation(false);
      }
    }, 10_000);
    setInterval(() => {
      if (document.visibilityState !== "hidden") void this.refreshInbox();
    }, 60_000);
    void this.github.refresh();
    setInterval(() => {
      if (document.visibilityState !== "hidden") void this.github.refresh();
    }, 120_000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.pause();
      else {
        void this.refreshOperations();
        void this.refreshInbox();
      }
    });
    void this.refreshOperations();
    void this.refreshInbox();
    void this.todos.refresh();
    if (matchMedia(MOBILE).matches) this.open();
  }

  open(tab?: Tab): void {
    if (!this.opened) this.lastFocus = document.activeElement as HTMLElement | null;
    this.opened = true;
    this.root.hidden = false;
    const stage = document.querySelector<HTMLElement>("#stage");
    if (stage) { stage.inert = true; stage.setAttribute("aria-hidden", "true"); }
    this.toggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("ops-open");
    this.setTab(tab ?? this.tab);
    this.root.focus({ preventScroll: true });
    this.refreshAnswers();
    void this.controls.refresh();
  }

  showAgent(id: string): void {
    this.selected.overview = id;
    this.open("overview");
    this.detailOpen = true;
    this.render();
    if (id === this.askingId) this.content.scrollTo({ top: 0 });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    this.syncModal();
    const stage = document.querySelector<HTMLElement>("#stage");
    if (stage) { stage.inert = false; stage.removeAttribute("aria-hidden"); }
    this.toggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("ops-open");
    this.callbacks.state?.(false, this.tab);
    const target = this.lastFocus?.isConnected && this.lastFocus !== document.body && this.lastFocus.getClientRects().length ? this.lastFocus : document.querySelector<HTMLElement>('[data-go="office"]');
    (target?.getClientRects().length ? target : this.toggle).focus({ preventScroll: true });
  }

  update(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.communications.update(snapshot, this.connected, this.replayIndex >= 0);
    this.updateFilters();
    this.render();
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.communications.update(this.snapshot, connected, this.replayIndex >= 0);
    this.renderStatus();
    if (this.tab === "overview") this.render();
  }

  private updateFilters(): void {
    const projects = [...new Set([...(this.snapshot?.agents.map((agent) => agent.project) ?? []), ...(this.operations?.tasks.map((task) => task.agent.project) ?? []), ...(this.snapshot?.projects.repos.map((repo) => repo.name) ?? []), this.projectSelect.value].filter(Boolean))].sort();
    const key = projects.join("\n");
    if (this.projectSelect.dataset.key === key) return;
    const selected = this.projectSelect.value;
    this.projectSelect.innerHTML = `<option value="">Tất cả</option>${projects.map((project) => `<option value="${text(project)}">${text(project)}</option>`).join("")}`;
    this.projectSelect.value = selected;
    this.projectSelect.dataset.key = key;
  }

  private async read<T>(endpoint: string, query?: URLSearchParams, timeout = 12_000): Promise<T> {
    const response = await fetch(`${endpoint}${query?.size ? `?${query}` : ""}`, { cache: "no-store", signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(response.status === 401 ? "Phiên truy cập hết hạn. Tải lại trang để đăng nhập." : `Không đọc được dữ liệu (${response.status}).`);
    return await response.json() as T;
  }

  private async refreshOperations(): Promise<void> {
    if (this.operationsBusy) { this.refreshAgain = true; return; }
    this.operationsBusy = true;
    try {
      this.operations = await this.read<OperationsSnapshot>("/api/operations");
      this.callbacks.operations?.(this.operations);
      this.error = "";
      this.updateFilters();
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Không nối được trung tâm điều hành.";
    } finally {
      this.operationsBusy = false;
      this.render();
      if (this.refreshAgain) { this.refreshAgain = false; void this.refreshOperations(); }
    }
  }

  private async refreshInbox(force = false): Promise<void> {
    if (this.inboxBusy) {
      this.inboxRefreshAgain = true;
      this.inboxForceAgain ||= force;
      return;
    }
    this.inboxBusy = true;
    try {
      const query = force ? new URLSearchParams({ refresh: "1" }) : undefined;
      this.inbox = await this.read<InboxSnapshot>("/api/inbox", query);
      this.inboxError = "";
      this.callbacks.inbox?.(this.inbox);
    } catch (error) {
      this.inboxError = error instanceof Error ? error.message : "Không đọc được Gmail & lịch.";
    } finally {
      this.inboxBusy = false;
      this.render();
      if (this.inboxRefreshAgain) {
        const forceAgain = this.inboxForceAgain;
        this.inboxRefreshAgain = false;
        this.inboxForceAgain = false;
        void this.refreshInbox(forceAgain);
      }
    }
  }

  private inboxUnread(): number {
    return this.inbox?.accounts.reduce((sum, account) => sum + (account.unread ?? 0), 0) ?? 0;
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      const active = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    this.content.setAttribute("aria-labelledby", `ops-tab-${tab}`);
    this.content.dataset.layout = tab === "overview" ? "overview" : SPLIT_TABS.includes(tab) ? "split" : "flow";
    this.title.textContent = TABS.find(([id]) => id === tab)![1];
    this.detailOpen = false;
    if (this.opened) this.callbacks.state?.(true, tab);
    this.replayControls.hidden = tab !== "overview" || !this.replayControlsOpen;
    this.root.querySelector<HTMLButtonElement>('[data-action="toggle-replay"]')!.hidden = tab !== "overview";
    this.toolbar.dataset.filters = FILTER_TABS.includes(tab) ? "on" : "off";
    this.signature = "";
    this.render();
    if (tab === "overview") void this.communications.refresh();
    if (tab === "automation") void this.loadAutomation(false);
    if (tab === "automation" || tab === "overview") void this.loadSystem(false);
    if (tab === "mail" || tab === "calendar") void this.refreshInbox();
    if (tab === "calendar") void this.loadCalendar();
    if (tab === "github" && !this.github.data) void this.github.refresh();
  }

  private async loadSystem(force: boolean): Promise<void> {
    if (this.systemLoading || (!force && Date.now() - this.systemAt < 30_000)) return;
    this.systemLoading = true;
    this.systemAt = Date.now();
    this.render();
    try {
      this.system = await this.read<SystemReport>("/api/system");
      this.systemError = "";
    } catch (error) {
      this.systemError = error instanceof Error ? error.message : "Không đọc được trạng thái hệ thống.";
    } finally {
      this.systemLoading = false;
      this.render();
    }
  }

  private async loadAutomation(force: boolean): Promise<void> {
    if (this.automationLoading || (!force && this.automation && Date.now() - this.automationAt < AUTOMATION_CACHE_MS)) return;
    this.automationLoading = true;
    this.automationError = "";
    this.render();
    try {
      this.automation = await this.read<AutomationReport>("/api/automation");
      this.automationAt = Date.now();
    } catch (error) {
      this.automationError = error instanceof Error ? error.message : "Không đọc được trạng thái tác vụ.";
    } finally {
      this.automationLoading = false;
      this.render();
    }
  }

  private async loadReplay(): Promise<void> {
    const query = new URLSearchParams();
    const from = this.root.querySelector<HTMLInputElement>('[data-input="from"]')!.value;
    const to = this.root.querySelector<HTMLInputElement>('[data-input="to"]')!.value;
    const fromMs = Date.parse(`${from}:00+07:00`);
    const toMs = Date.parse(`${to}:00+07:00`);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs || toMs - fromMs > 7 * 86_400_000) {
      this.setNotice("Chọn thời gian bắt đầu trước kết thúc, tối đa 7 ngày.");
      return;
    }
    query.set("from", new Date(fromMs).toISOString());
    query.set("to", new Date(toMs).toISOString());
    const version = ++this.queryVersion;
    this.setNotice("Đang nạp khung hình…");
    try {
      const data = await this.read<ReplayResponse>("/api/replay", query);
      if (version !== this.queryVersion) return;
      this.exitReplay();
      this.replayData = data;
      if (data.frames.length) {
        this.showFrame(0);
        this.setNotice(`Đã nạp ${data.frames.length} khung hình${data.truncated ? "; khoảng thời gian đã được giới hạn, chọn ngắn hơn để xem chi tiết" : ""}. Đóng bảng để xem văn phòng 3D.`);
      } else this.setNotice("Chưa có khung hình trong khoảng đã chọn.");
    } catch (error) {
      if (version === this.queryVersion) this.setNotice(error instanceof Error ? error.message : "Không đọc được khung hình.");
    } finally {
      if (version === this.queryVersion) this.render();
    }
  }

  private handleClick(event: Event): void {
    const systemTarget = (event.target as Element).closest<HTMLElement>("[data-sys-section], [data-sys-all], [data-sys-processes], [data-sys-more-processes], [data-sys-more-services], [data-sys-open]");
    if (systemTarget) {
      if (systemTarget.dataset.sysOpen) {
        this.automationMachine = systemTarget.dataset.sysOpen as MachineId;
        try { localStorage.setItem("msc-automation-machine", this.automationMachine); } catch {}
        this.systemSection = "background";
        this.systemFilter = "error";
        this.systemQuery = "";
        this.systemServiceLimit = 40;
        this.setTab("automation");
        return;
      }
      if (systemTarget.dataset.sysSection) {
        this.systemSection = systemTarget.dataset.sysSection as SystemSection;
        if (this.systemSection === "scheduled") void this.loadAutomation(false);
      }
      if (systemTarget.dataset.sysAll !== undefined) { this.systemAllServices = !this.systemAllServices; this.systemServiceLimit = 40; }
      if (systemTarget.dataset.sysProcesses !== undefined) this.systemProcesses = !this.systemProcesses;
      if (systemTarget.dataset.sysMoreProcesses !== undefined) this.systemProcessLimit += 40;
      if (systemTarget.dataset.sysMoreServices !== undefined) this.systemServiceLimit += 40;
      this.render();
      return;
    }
    if (this.controls.click(event.target as Element, this.replayIndex < 0)) return;
    if (this.answerClick(event.target as Element)) return;
    if (this.tab === "overview" && this.communications.click(event.target as Element)) return;
    if (this.tab === "projects" && this.todos.click(event.target as Element)) return;
    if (this.tab === "github" && this.github.click(event.target as Element)) return;
    const target = (event.target as Element).closest<HTMLElement>("[data-action], [data-au-machine], [data-tab], [data-agent], [data-verify], [data-expand], [data-select], [data-mailbox], [data-mail], [data-cal-mode], [data-cal-day], [data-event]");
    if (!target) return;
    if (target.dataset.mailbox) {
      this.mailbox = target.dataset.mailbox;
      this.reader = null;
      this.render();
      return;
    }
    if (target.dataset.mail) { void this.openMail(target.dataset.mail); return; }
    if (target.dataset.auMachine) {
      this.automationMachine = target.dataset.auMachine as MachineId;
      this.systemQuery = "";
      this.systemFilter = "all";
      this.systemProcessQuery = "";
      this.systemProcessLimit = 40;
      this.systemServiceLimit = 40;
      try { localStorage.setItem("msc-automation-machine", this.automationMachine); } catch {}
      this.render();
      return;
    }
    if (target.dataset.calMode) { this.showCalendar(target.dataset.calMode as CalendarMode, this.calendarAnchor); return; }
    if (target.dataset.calDay) { this.showCalendar("day", target.dataset.calDay); return; }
    if (target.dataset.event) { this.calendarEvent = target.dataset.event; this.render(); this.content.querySelector<HTMLElement>(".gc-close")?.focus(); return; }
    if (target.dataset.select) {
      this.select(target.dataset.select);
      if (this.tab === "overview" && target.dataset.select === this.askingId) this.content.scrollTo({ top: 0 });
      return;
    }
    if (target.dataset.expand) {
      const id = target.dataset.expand;
      if (!this.expanded.delete(id)) this.expanded.add(id);
      this.render();
      return;
    }
    if (target.dataset.verify) { void this.verifyTask(target.dataset.verify, target.dataset.outcome ?? ""); return; }
    if (target.dataset.tab) return this.setTab(target.dataset.tab as Tab);
    if (target.dataset.agent) {
      this.close();
      this.callbacks.selectAgent(target.dataset.agent);
      return;
    }
    switch (target.dataset.action) {
      case "close": this.close(); break;
      case "compose":
        this.communications.openComposer();
        this.content.querySelector<HTMLElement>(".overview-communications")?.scrollIntoView({ block: "nearest" });
        this.content.querySelector<HTMLTextAreaElement>("#comm-draft")?.focus({ preventScroll: true });
        break;
      case "toggle-replay":
        this.replayControlsOpen = !this.replayControlsOpen;
        this.replayControls.hidden = !this.replayControlsOpen;
        target.setAttribute("aria-expanded", String(this.replayControlsOpen));
        break;
      case "back":
        this.detailOpen = false;
        this.render();
        this.content.querySelector<HTMLElement>(`[data-select="${CSS.escape(this.selected[this.tab] ?? "")}"]`)?.focus();
        break;
      case "refresh":
        void this.refreshOperations();
        void this.refreshInbox(this.tab === "mail" || this.tab === "calendar");
        this.refreshAnswers();
        void this.controls.refresh();
        if (this.tab === "github") void this.github.refresh(true);
        if (this.tab === "automation") void this.loadAutomation(true);
        if (this.tab === "automation" || this.tab === "overview") void this.loadSystem(true);
        if (this.tab === "overview") void this.communications.refresh();
        if (this.tab === "projects") void this.todos.refresh();
        if (this.tab === "calendar") { this.calendarData.clear(); void this.loadCalendar(); }
        break;
      case "github": this.setTab("github"); break;
      case "cal-close": this.closeEvent(); break;
      case "cal-create": this.openForm(newDraft(this.calendarMode === "day" ? this.calendarAnchor : todayKey(Date.now()), Date.now())); break;
      case "cal-edit": { const event = this.currentEvents().find((entry) => entry.id === this.calendarEvent); if (event) this.openForm(draftFromEvent(event)); break; }
      case "cal-cancel": this.calendarForm = null; this.calendarFormError = ""; this.render(); break;
      case "cal-delete": void this.deleteEvent(); break;
      case "cal-today": this.showCalendar(this.calendarMode, todayKey(Date.now())); break;
      case "cal-prev": this.showCalendar(this.calendarMode, shiftAnchor(this.calendarMode, this.calendarAnchor, -1)); break;
      case "cal-next": this.showCalendar(this.calendarMode, shiftAnchor(this.calendarMode, this.calendarAnchor, 1)); break;
      case "mail-delete": void this.deleteMail(); break;
      case "mail-back": this.reader = null; this.render(); break;
      case "load-replay": void this.loadReplay(); break;
      case "live": this.exitReplay(); break;
      case "play": this.togglePlayback(); break;
    }
  }

  private handleChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (this.communications.change(target)) return;
    if (this.controls.change(target)) return;
    if (target.dataset.sysFilter !== undefined) { this.systemFilter = target.value as SystemFilter; this.systemServiceLimit = 40; this.render(); return; }
    if (target.dataset.calDate !== undefined) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(target.value)) this.showCalendar(this.calendarMode, target.value);
      return;
    }
    if (target.dataset.action === "effects") {
      this.effects = target.checked;
      try { localStorage.setItem("msc-effects", this.effects ? "on" : "off"); } catch {}
      this.callbacks.effects(this.effects);
      return;
    }
    if (target.dataset.filter) {
      this.queryVersion++;
      if (this.replayIndex >= 0) this.exitReplay();
      this.render();
    }
  }

  private activeModal(): HTMLElement | null {
    return this.opened ? this.content.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]') : null;
  }

  private syncModal(trigger: HTMLElement | null = null): void {
    for (const [element, inert] of this.modalBackground) element.inert = inert;
    this.modalBackground.clear();
    const modal = this.activeModal();
    if (!modal) {
      if (this.modalFocus && this.opened) {
        const key = this.modalFocus.dataset.key;
        const target = this.modalFocus.isConnected ? this.modalFocus : key ? [...this.content.querySelectorAll<HTMLElement>("[data-key]")].find((element) => element.dataset.key === key) : null;
        (target ?? this.root).focus({ preventScroll: true });
      }
      this.modalFocus = null;
      return;
    }
    this.modalFocus ??= trigger ?? document.activeElement as HTMLElement;
    for (let current: HTMLElement = modal; current.parentElement; current = current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== current && !sibling.matches(".td-pop-back, .gc-pop-back, .pw-drawer-back, dialog")) {
          this.modalBackground.set(sibling, sibling.inert);
          sibling.inert = true;
        }
      }
    }
    if (!modal.contains(document.activeElement) && !document.querySelector("dialog[open]")) modal.focus({ preventScroll: true });
  }

  private handleKey(event: KeyboardEvent): void {
    if (this.tab === "projects" && this.todos.keydown(event)) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === "Escape" && this.calendarForm && this.tab === "calendar") { event.stopPropagation(); this.calendarForm = null; this.calendarFormError = ""; this.render(); return; }
    if (event.key === "Escape" && this.calendarEvent && this.tab === "calendar") { event.stopPropagation(); this.closeEvent(); return; }
    if (event.key === "Escape") { event.stopPropagation(); this.close(); return; }
    const systemTab = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sys-section]");
    if (systemTab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = [...this.root.querySelectorAll<HTMLButtonElement>("[data-sys-section]")];
      const index = tabs.indexOf(systemTab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      const section = tabs[next].dataset.sysSection;
      tabs[next].click();
      this.root.querySelector<HTMLButtonElement>(`[data-sys-section="${section}"]`)?.focus({ preventScroll: true });
      return;
    }
    const tab = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tab]");
    if (tab && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = TABS.findIndex(([id]) => id === this.tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) + TABS.length) % TABS.length;
      this.setTab(TABS[next][0]);
      this.root.querySelector<HTMLButtonElement>(`[data-tab="${this.tab}"]`)!.focus();
    }
    const modal = this.activeModal();
    if (event.key === "Tab" && modal) {
      const focusable = [...modal.querySelectorAll<HTMLElement>('button, a[href], input, textarea, select, iframe, [tabindex]')].filter((element) => element.getClientRects().length > 0 && !element.matches(":disabled") && !element.closest("[inert]") && element.tabIndex >= 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first) { event.preventDefault(); modal.focus(); }
      else if (!focusable.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }

  private setNotice(message: string): void {
    this.notice.textContent = message;
    this.notice.hidden = !message;
  }

  private renderTabCounts(counts: Partial<Record<Tab, number>>): void {
    for (const badge of this.root.querySelectorAll<HTMLElement>("[data-count-for]")) {
      const value = counts[badge.dataset.countFor as Tab] ?? 0;
      badge.textContent = String(value);
      badge.hidden = value === 0;
      badge.dataset.tone = badge.dataset.countFor === "github" || badge.dataset.countFor === "overview" ? "alert" : "neutral";
    }
  }

  private renderStatus(): void {
    const stale = !this.connected || !this.operations || Date.now() - Date.parse(this.operations.generatedAt) > 45_000;
    this.status.dataset.stale = String(stale);
    this.status.textContent = this.error || (this.replayIndex >= 0 ? "Đang xem lại · Các bảng điều hành vẫn hiển thị dữ liệu trực tiếp" : stale ? "Đang chờ dữ liệu mới · Thông tin có thể đã cũ" : `Trực tiếp · Cập nhật ${time(this.operations!.generatedAt)} · Giờ Việt Nam`);
  }

  private render(): void {
    this.renderStatus();
    const count = this.github.count();
    this.toggle.setAttribute("aria-label", `Mở trung tâm điều hành${count ? `, ${count} việc trên GitHub cần xem` : ""}`);
    this.renderTabCounts({ overview: this.reviewTasks().length, github: count, projects: this.todos.openCount(), mail: this.inboxUnread(), calendar: eventsToday(this.inbox, Date.now()), automation: this.systemError ? 0 : systemAlerts(this.system).reduce((sum, entry) => sum + entry.count, 0) });
    if (!this.opened) return;
    const communicationSnapshot = this.replayIndex >= 0 ? this.replayData?.frames[this.replayIndex]?.snapshot ?? this.snapshot : this.snapshot;
    this.communications.update(communicationSnapshot, this.connected, this.replayIndex >= 0);
    let html = "";
    if (this.tab === "mail") html = this.mailMarkup();
    else if (this.tab === "github") html = this.githubMarkup();
    else if (this.tab === "calendar") html = this.calendarMarkup();
    else if (this.tab === "projects") html = this.todos.markup();
    else if (this.tab === "quota") html = this.quotaMarkup();
    else if (!this.snapshot) html = empty("Đang nối văn phòng", "Dữ liệu sẽ xuất hiện khi hub gửi bản cập nhật đầu tiên.");
    else if (this.tab === "overview") html = this.overviewMarkup();
    else if (this.tab === "automation") html = systemView({ report: this.system, loading: this.systemLoading, error: this.systemError, machine: this.automationMachine, section: this.systemSection, query: this.systemQuery, filter: this.systemFilter, allServices: this.systemAllServices, processes: this.systemProcesses, processQuery: this.systemProcessQuery, processLimit: this.systemProcessLimit, serviceLimit: this.systemServiceLimit, automation: { report: this.automation, loading: this.automationLoading, error: this.automationError, machine: this.automationMachine } });
    else if (!this.operations) html = empty("Chưa đọc được dữ liệu điều hành", this.error || "Đang lấy dữ liệu từ hub…");
    if (html === this.signature || this.heldByPress()) return;
    this.signature = html;
    const scroll = this.content.scrollTop;
    const listScroll = this.content.querySelector(".ops-list")?.scrollTop ?? 0;
    const paneScroll = this.content.querySelector(".ops-pane")?.scrollTop ?? 0;
    const weekScroll = this.content.querySelector(".gc-scroll")?.scrollTop ?? null;
    const focused = this.content.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const key = focused?.dataset.agent ?? focused?.dataset.key;
    const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement ? [focused.selectionStart, focused.selectionEnd] : null;
    this.content.innerHTML = html;
    this.content.scrollTop = scroll;
    const list = this.content.querySelector(".ops-list");
    const pane = this.content.querySelector(".ops-pane");
    if (list) list.scrollTop = listScroll;
    if (pane) pane.scrollTop = paneScroll;
    const week = this.content.querySelector(".gc-scroll");
    if (week) week.scrollTop = weekScroll ?? calendarScrollTop(Date.now());
    this.syncModal(focused);
    if (key) {
      const next = [...this.content.querySelectorAll<HTMLElement>("[data-agent], [data-key]")].find((element) => (element.dataset.agent ?? element.dataset.key) === key);
      next?.focus({ preventScroll: true });
      if (selection && selection[0] !== null && selection[1] !== null && (next instanceof HTMLTextAreaElement || next instanceof HTMLInputElement)) next.setSelectionRange(selection[0], selection[1]);
    }
  }

  private answersChanged(): void {
    this.render();
    this.onAnswersChanged();
  }

  refreshAnswers(): void {
    void this.replies.refresh();
    if (this.snapshot?.agents.some((agent) => agent.pending)) void this.decisions.refresh();
  }

  answerMarkup(agent: AgentInfo, online: boolean): string {
    const live = this.replayIndex < 0;
    const direct = this.replies.markup(agent, live);
    if (!agent.pending || !live || this.replies.hasQuestion(agent.id) || this.replies.settling(agent) || this.replies.awaiting(agent)) return direct;
    return direct + this.decisions.markup(agent, online, safeLink(agent.nativeUrl));
  }

  private inlineAnswer(agent: AgentInfo, online: boolean): string {
    if (this.tab === "overview" && agent.id === this.askingId) return '<p class="ops-source-note">Câu hỏi của agent này đang hiện ở đầu trang.</p>';
    return this.answerMarkup(agent, online);
  }

  private askingMarkup(agents: AgentInfo[]): string {
    this.askingId = null;
    if (this.replayIndex >= 0) return "";
    const asking = agents.filter((agent) => agent.pending || this.replies.hasQuestion(agent.id)).sort((a, b) => (a.pending?.askedAt ?? "").localeCompare(b.pending?.askedAt ?? ""));
    if (!asking.length) return "";
    const current = asking.find((agent) => agent.id === this.selected.overview) ?? asking[0];
    this.askingId = current.id;
    const online = this.snapshot?.machines.find((machine) => machine.id === current.machine)?.online === true;
    const others = asking.length > 1 ? `<div class="overview-ask-switch" role="group" aria-label="Chọn câu hỏi">${asking.map((agent) => `<button type="button" data-select="${text(agent.id)}" data-key="ask-switch:${text(agent.id)}" aria-pressed="${agent.id === current.id}">${text(agent.project)}</button>`).join("")}</div>` : "";
    return `<section class="overview-asks" aria-label="Câu hỏi đang chờ sếp"><header class="overview-ask-who"><strong>${text(current.project)}</strong><span>${text(current.task || current.title)}</span></header>${others}${this.answerMarkup(current, online)}</section>`;
  }

  answerSignature(agent: AgentInfo): string {
    return this.replies.signature(agent.id) + this.replies.awaiting(agent) + this.decisions.signature(agent);
  }

  answerInput(target: HTMLInputElement | HTMLTextAreaElement): void {
    if (!this.decisions.input(target)) this.replies.input(target);
  }

  answerClick(target: Element): boolean {
    const live = this.replayIndex < 0;
    return this.decisions.click(target, live) || this.replies.click(target, live);
  }

  private async verifyTask(id: string, outcomeAt: string): Promise<void> {
    if (this.verifying) return;
    if (this.replayIndex >= 0) return this.setNotice("Về trực tiếp trước khi xác nhận nghiệm thu.");
    const task = this.operations?.tasks.find((item) => item.id === id);
    if (!task?.agent.outcome || task.agent.outcome.status !== "completed" || task.agent.outcome.at !== outcomeAt) return this.setNotice("Lượt làm việc đã thay đổi. Làm mới để kiểm tra lại.");
    const evidenceKey = `${id}:${outcomeAt}`;
    const evidence = this.evidence.get(evidenceKey)?.trim();
    if (!evidence) return this.setNotice("Ghi kết quả kiểm tra hoặc liên kết bằng chứng trước khi xác nhận hoàn tất.");
    this.verifying = id;
    this.render();
    try {
      const response = await fetch("/api/tasks/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: id, outcomeAt, evidence }), signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(response.status === 409 ? "Lượt làm việc đã thay đổi. Làm mới và kiểm tra kết quả hiện tại." : `Không lưu được xác nhận (${response.status}).`);
      this.evidence.delete(evidenceKey);
      this.setNotice("Đã lưu: sếp đã xác nhận hoàn tất. Đây là nghiệm thu công việc, không phải duyệt quyền của ứng dụng.");
      await this.refreshOperations();
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : "Chưa xác nhận được kết quả. Kiểm tra lại trước khi thử lần nữa.");
    } finally {
      this.verifying = null;
      this.render();
    }
  }

  private agentMarkup(agent: AgentInfo, evidence?: string, pane = false): string {
    const online = this.snapshot?.machines.find((machine) => machine.id === agent.machine)?.online;
    const current = this.snapshot?.agents.some((entry) => entry.id === agent.id);
    const state = online ? agent.state : "offline";
    const detail = evidence || agent.progress || agent.detail || "";
    const chat = link(agent.nativeUrl, "Mở chat gốc").replace("<a ", `<a title="${text(CHAT_NOTE)}" aria-description="${text(CHAT_NOTE)}" `);
    const heading = pane ? `<h2 class="ops-view-title">${text(agent.task || agent.title)}</h2>` : `<h3 class="ops-title" title="${text(agent.task || agent.title)}">${text(agent.task || agent.title)}</h3>`;
    return `<article class="${pane ? "ops-view" : "ops-card"} ops-agent" data-state="${state}"><div class="ops-card-top"><span class="ops-app" data-app="${agent.app}">${APP_NAMES[agent.app]}</span><span class="ops-state" data-state="${state}">${online ? STATE_NAMES[agent.state] : "Mất kết nối"}</span></div>${heading}<p class="ops-meta ops-where">${icon("project", "ops-icon ops-icon-sm")}<span>${text(agent.project)}</span><span class="ops-dot" aria-hidden="true">·</span>${icon("machine", "ops-icon ops-icon-sm")}<span>${text(agent.machine)}</span>${agent.branch ? `<code class="ops-branch">${text(agent.branch)}</code>` : ""}</p>${agent.pending && this.replayIndex >= 0 ? `<div class="ops-question"><b>Cần sếp trả lời</b><p>${text(agent.pending.question)}</p></div>` : ""}${this.inlineAnswer(agent, online === true)}${this.controls.markup(agent, this.replayIndex < 0)}${pane ? '<h3 class="ops-view-label">Tiến độ gần nhất</h3>' : ""}${this.detailMarkup(`${this.tab}:${agent.id}`, detail, !pane)}<footer><time datetime="${text(agent.updatedAt)}">Cập nhật ${time(agent.updatedAt)}</time><div class="ops-actions">${chat}${current ? `<button type="button" class="ops-primary" data-agent="${text(agent.id)}">Xem trong văn phòng</button>` : '<small class="ops-meta">Phiên đã kết thúc</small>'}</div></footer></article>`;
  }

  private detailMarkup(id: string, detail: string, clamp = true): string {
    if (!detail.trim()) return '<p class="ops-detail ops-muted">Chưa có hoạt động</p>';
    const long = clamp && (detail.length > LONG_DETAIL || detail.split("\n").length > 5);
    const open = this.expanded.has(id);
    return `<div class="ops-detail ops-md" data-clamped="${long && !open}">${renderMarkdown(readable(detail))}</div>${long ? `<button type="button" class="ops-more" data-expand="${text(id)}" data-key="expand:${text(id)}" aria-expanded="${open}">${open ? "Thu gọn" : "Xem thêm"}</button>` : ""}`;
  }

  private select(id: string): void {
    this.selected[this.tab] = id;
    this.detailOpen = true;
    this.render();
    if (matchMedia(MOBILE).matches) {
      this.content.querySelector<HTMLElement>(".ops-split")?.scrollIntoView({ block: "nearest" });
      this.content.querySelector<HTMLElement>(".ops-back")?.focus({ preventScroll: true });
    }
  }

  private split<T>(label: string, groups: [string, T[]][], key: (item: T) => string, row: (item: T, active: boolean) => string, pane: (item: T) => string, footer = "", head?: (title: string, list: T[]) => string): string {
    const items = groups.flatMap(([, list]) => list);
    const current = items.find((item) => key(item) === this.selected[this.tab]) ?? items[0];
    this.selected[this.tab] = key(current);
    const list = groups.filter(([, list]) => list.length).map(([title, list]) => `<div class="ops-group" role="group" aria-label="${text(title)}"><h3>${head ? head(title, list) : `${text(title)}<span>${list.length}</span>`}</h3>${list.map((item) => row(item, item === current)).join("")}</div>`).join("");
    return `<div class="ops-split" data-detail="${this.detailOpen}"><div class="ops-list" aria-label="${text(label)}">${list}${footer}</div><section class="ops-pane" aria-label="Chi tiết"><button type="button" class="ops-back" data-action="back">${icon("back")}<span>Quay lại danh sách</span></button>${pane(current)}</section></div>`;
  }

  private agentRow(agent: AgentInfo, active: boolean): string {
    const online = this.snapshot?.machines.find((machine) => machine.id === agent.machine)?.online;
    const state = online ? agent.state : "offline";
    const side = agent.pending ? '<span class="ops-pill" data-tone="amber">Chờ trả lời</span>' : `<span class="ops-row-state" data-state="${state}">${online ? STATE_NAMES[agent.state] : "Mất kết nối"}</span>`;
    return `<button type="button" class="ops-row" data-select="${text(agent.id)}" data-key="row:${text(agent.id)}" aria-current="${active}"><span class="ops-led" data-state="${state}" aria-hidden="true"></span><span class="ops-row-main"><span class="ops-row-title">${text(agent.task || agent.title)}</span><span class="ops-row-meta"><b data-app="${agent.app}">${APP_NAMES[agent.app]}</b> · ${text(agent.project)} · ${text(agent.machine)}</span></span><span class="ops-row-side"><time datetime="${text(agent.updatedAt)}">${ago(agent.updatedAt)}</time>${side}</span></button>`;
  }

  private kpis(agents: AgentInfo[], attention: number): string {
    const online = new Set(this.snapshot?.machines.filter((machine) => machine.online && this.connected).map((machine) => machine.id));
    const active = agents.filter((agent) => online.has(agent.machine) && ["working", "thinking"].includes(agent.state)).length;
    const waiting = agents.filter((agent) => online.has(agent.machine) && (agent.pending || agent.state === "waiting")).length;
    const reviews = this.reviewTasks().length;
    return `<div class="ops-kpis"><div class="ops-kpi" data-tone="${active ? "green" : "neutral"}"><strong>${active}</strong><span>Đang làm<small>Agent đang hoạt động</small></span></div><div class="ops-kpi" data-tone="${waiting ? "amber" : "neutral"}"><strong>${waiting}</strong><span>Chờ sếp<small>Cần trả lời hoặc quyết định</small></span></div><div class="ops-kpi" data-tone="${reviews ? "violet" : "neutral"}"><strong>${reviews}</strong><span>Cần nghiệm thu<small>Chưa xác nhận hoàn tất</small></span></div><button type="button" class="ops-kpi" data-action="github" data-tone="${attention ? "amber" : "neutral"}"><strong>${attention}</strong><span>GitHub<small>Mở các việc cần xem →</small></span></button></div>`;
  }

  private reviewTasks(): TaskCard[] {
    return this.operations?.tasks.filter((task) => task.stage === "review") ?? [];
  }

  private agentAlerts(): Map<string, AttentionItem[]> {
    const alerts = new Map<string, AttentionItem[]>();
    for (const item of this.operations?.attention ?? []) {
      if (!AGENT_ALERTS.includes(item.kind)) continue;
      for (const id of item.agentIds) alerts.set(id, [...(alerts.get(id) ?? []), item]);
    }
    return alerts;
  }

  private overviewMarkup(): string {
    const agents = this.snapshot!.agents;
    const attention = this.github.count();
    const reviews = this.reviewTasks();
    const alerts = this.agentAlerts();
    const reviewIds = new Set(reviews.map((task) => task.agent.id));
    const flagged = agents.filter((agent) => !reviewIds.has(agent.id) && alerts.has(agent.id));
    const rest = agents.filter((agent) => !reviewIds.has(agent.id) && !alerts.has(agent.id));
    const waiting = rest.filter((agent) => agent.pending || agent.state === "waiting" || this.replies.hasQuestion(agent.id));
    const active = rest.filter((agent) => !waiting.includes(agent) && ["working", "thinking"].includes(agent.state));
    const idle = rest.filter((agent) => !waiting.includes(agent) && !active.includes(agent));
    const groups: [string, AgentInfo[]][] = [["Cần nghiệm thu", reviews.map((task) => task.agent)], ["Cần kiểm tra", flagged], ["Chờ sếp", waiting], ["Đang làm", active], ["Rảnh", idle]];
    const asks = this.askingMarkup(agents);
    const pane = (agent: AgentInfo) => {
      const task = reviews.find((entry) => entry.agent.id === agent.id);
      if (task) return this.taskMarkup(task);
      return `${(alerts.get(agent.id) ?? []).map((item) => this.attentionCard(item)).join("")}${this.agentMarkup(agent, undefined, true)}`;
    };
    const footer = this.operations ? coverage(this.operations.coverage) : "";
    const body = groups.some(([, list]) => list.length) ? this.split("Danh sách agent", groups, (agent) => agent.id, (agent, current) => this.agentRow(agent, current), pane) : empty("Chưa có agent nào", "Agent đang chạy trên các máy sẽ hiện tại đây.");
    const priority = reviews.length + flagged.length + waiting.length;
    const projects = new Set(agents.map((agent) => agent.project)).size;
    return `<div class="overview-board"><header class="overview-heading"><div><h2>Điều hành công việc</h2><p>${priority ? `${priority} việc cần sếp xem · ` : ""}${agents.length} agent trên ${projects} dự án</p></div><button type="button" class="ops-primary" data-action="compose" data-key="overview-compose" ${this.replayIndex >= 0 ? "disabled" : ""}>${icon("send")}Giao việc</button></header>${asks}${this.kpis(agents, attention)}<section class="overview-machines" aria-label="Kết nối ba máy">${this.communications.machineMarkup()}</section>${this.systemError || this.replayIndex >= 0 ? "" : systemOverview(this.system)}<div class="overview-columns"><section class="overview-workspace" aria-labelledby="overview-agents-title"><header class="overview-section-heading"><div><h2 id="overview-agents-title">Agent & nghiệm thu</h2><p>Ưu tiên việc chờ xử lý, rồi đến các phiên đang làm.</p></div><span class="overview-total">${agents.length} agent</span></header>${body}</section><aside class="overview-communications" aria-label="Giao tiếp và giao việc">${this.communications.markup(true)}</aside></div><footer class="overview-footnote">${footer}</footer></div>`;
  }

  private attentionCard(item: AttentionItem, pane = false): string {
    const agent = item.kind === "question" ? this.snapshot?.agents.find((entry) => item.agentIds.includes(entry.id)) : null;
    const heading = pane ? `<h2 class="ops-view-title">${text(item.title)}</h2>` : `<h3 class="ops-title">${text(item.title)}</h3>`;
    return `<article class="${pane ? "ops-view" : "ops-card"} ops-attention" data-severity="${item.severity}"><div class="ops-card-top"><span class="ops-category">${KIND_NAMES[item.kind]}</span><span class="ops-state" data-state="${item.severity === "error" ? "offline" : "waiting"}">${item.severity === "error" ? "Nghiêm trọng" : "Cần xem"}</span></div>${heading}<p class="ops-meta">${text([item.project, item.machine].filter(Boolean).join(" · "))}</p>${this.detailMarkup(`${this.tab}:attention:${item.id}`, item.detail, !pane)}${agent ? this.inlineAnswer(agent, this.snapshot?.machines.find((machine) => machine.id === agent.machine)?.online === true) : ""}<footer><time datetime="${text(item.since)}">${waited(item.since)}</time><div class="ops-actions">${link(item.url, "Mở nguồn")}${item.agentIds.map((id, index) => `<button type="button" class="ops-primary" data-agent="${text(id)}">${item.agentIds.length > 1 ? `Xem agent ${index + 1}` : "Xem trong văn phòng"}</button>`).join("")}</div></footer>${item.kind === "question" ? '<small class="ops-source-note">Câu hỏi tự biến mất khi nguồn xác nhận đã trả lời. Liên kết chat mở ứng dụng trên thiết bị đang xem.</small>' : ""}</article>`;
  }

  private githubMarkup(): string {
    const blank = this.github.emptyState();
    if (blank) return empty(blank.title, blank.detail);
    const now = Date.now();
    const match = (item: GitItem) => !this.projectSelect.value || item.project === this.projectSelect.value;
    const groups = this.github.groups(match);
    const summary = this.github.summary(match);
    if (!groups.some(([, list]) => list.length)) return `${summary}${empty("GitHub đang sạch", "Không có CI lỗi, pull request, issue, cảnh báo bảo mật hay thông báo chưa đọc.")}`;
    return `${summary}${this.github.board(match, now)}`;
  }

  private taskMarkup(task: TaskCard): string {
    const evidenceKey = `${task.id}:${task.agent.outcome?.at ?? ""}`;
    const verify = this.tab === "overview" && this.replayIndex < 0 && task.stage === "review" && task.agent.outcome?.status === "completed" && task.online ? `<div class="ops-verify"><label>Bằng chứng nghiệm thu<textarea aria-label="Bằng chứng nghiệm thu" maxlength="1000" rows="2" data-key="evidence:${text(evidenceKey)}" data-evidence="${text(evidenceKey)}" placeholder="Kết quả kiểm thử, liên kết hoặc nội dung sếp đã kiểm tra…">${text(this.evidence.get(evidenceKey) ?? "")}</textarea></label><button type="button" data-verify="${text(task.id)}" data-outcome="${text(task.agent.outcome.at)}" data-key="verify:${text(evidenceKey)}" ${this.verifying ? "disabled" : ""}>${this.verifying === task.id ? "Đang lưu…" : "Xác nhận hoàn tất"}</button></div>` : task.stage === "completed" ? '<p class="ops-verified">Sếp đã xác nhận hoàn tất</p>' : "";
    return `${this.agentMarkup(task.agent, task.evidence).replace('class="ops-card ops-agent"', 'class="ops-card ops-agent ops-task"').replace("</article>", `${verify}</article>`)}${task.inferred ? '<small class="ops-inferred">Phân loại theo hoạt động đang quan sát</small>' : ""}`;
  }



  private quotaMarkup(): string {
    return `<div class="qc-embed"><iframe class="qc-frame" src="/quota/web/" title="Quota Control"></iframe></div>`;
  }


  private mailMarkup(): string {
    if (!this.inbox) return empty("Đang đọc Gmail", this.inboxError || "Đang tải hộp thư từ hub…");
    return mailView(this.inbox, this.mailbox, Date.now(), this.reader);
  }

  private async deleteMail(): Promise<void> {
    const reader = this.reader;
    if (!reader?.mail || reader.deleting) return;
    this.reader = { ...reader, deleting: true };
    this.render();
    let error = "";
    try {
      const response = await fetch(`/api/mail?id=${encodeURIComponent(reader.id)}`, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) error = response.status === 401 ? "Phiên truy cập hết hạn. Tải lại trang để đăng nhập." : ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `Lỗi ${response.status}.`;
    } catch {
      error = "Hub không trả lời kịp. Thử lại sau.";
    }
    if (this.reader?.id !== reader.id) return;
    if (error) {
      this.reader = { ...reader, deleting: false };
      this.setNotice(`Chưa xóa được thư: ${error}`);
      this.render();
      return;
    }
    if (this.inbox) this.inbox = { ...this.inbox, accounts: this.inbox.accounts.map((account) => ({ ...account, recent: account.recent.filter((message) => message.id !== reader.id), labels: account.labels?.map((label) => ({ ...label, recent: label.recent.filter((message) => message.id !== reader.id) })) })) };
    this.reader = null;
    this.setNotice("Đã chuyển thư vào Thùng rác của Gmail.");
    this.render();
    setTimeout(() => this.setNotice(""), 6000);
  }

  githubChanged(): void {
    void this.github.refresh();
  }

  inboxChanged(): void {
    void this.refreshInbox();
  }

  todosChanged(): void {
    void this.todos.refresh();
  }

  private async openMail(id: string): Promise<void> {
    this.reader = { id, mail: null, error: "" };
    this.render();
    let mail: MailContent | null = null;
    let error = "";
    try {
      const response = await fetch(`/api/mail?id=${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (response.ok) mail = await response.json() as MailContent;
      else error = response.status === 401 ? "Phiên truy cập hết hạn. Tải lại trang để đăng nhập." : ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `Lỗi ${response.status}.`;
    } catch {
      error = "Hub không trả lời kịp. Thử lại sau.";
    }
    if (this.reader?.id !== id) return;
    this.reader = { ...this.reader, mail, error };
    this.render();
  }

  private calendarKey(): string {
    const range = calendarRange(this.calendarMode, this.calendarAnchor);
    return `${range.from}-${range.to}`;
  }

  private currentEvents(): CalendarEvent[] {
    return this.calendarData.get(this.calendarKey())?.events ?? this.inbox?.events ?? [];
  }

  private openForm(draft: EventDraft): void {
    this.calendarEvent = null;
    this.calendarForm = draft;
    this.calendarFormError = "";
    this.render();
    this.content.querySelector<HTMLInputElement>('[data-ev="title"]')?.focus();
  }

  private async writeEvent(method: string, id: string | null, body?: unknown): Promise<string> {
    const target = id ? `/api/calendar/events/${encodeURIComponent(id.replace(/^local:/, ""))}` : "/api/calendar/events";
    try {
      const response = await fetch(target, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
      if (response.ok) return "";
      if (response.status === 401) return "Phiên truy cập hết hạn. Tải lại trang để đăng nhập.";
      return ((await response.json().catch(() => null)) as { error?: string } | null)?.error ?? `Lỗi ${response.status}.`;
    } catch {
      return "Hub không trả lời kịp. Thử lại sau.";
    }
  }

  private async saveEvent(): Promise<void> {
    const draft = this.calendarForm;
    if (!draft || this.calendarSaving) return;
    const input = draftToInput(draft);
    if (typeof input === "string") { this.calendarFormError = input; this.render(); return; }
    this.calendarSaving = true;
    this.calendarFormError = "";
    this.render();
    const error = await this.writeEvent(draft.id ? "PUT" : "POST", draft.id, input);
    this.calendarSaving = false;
    if (error) { this.calendarFormError = error; this.render(); return; }
    this.calendarForm = null;
    this.calendarData.clear();
    this.calendarAnchor = todayKey(Date.parse(input.start));
    this.render();
    void this.loadCalendar();
  }

  private async deleteEvent(): Promise<void> {
    const event = this.currentEvents().find((entry) => entry.id === this.calendarEvent);
    if (!event?.local || !window.confirm(`Xóa sự kiện “${event.title}”?`)) return;
    const error = await this.writeEvent("DELETE", event.id);
    if (error) { window.alert(error); return; }
    this.calendarEvent = null;
    this.calendarData.clear();
    this.render();
    void this.loadCalendar();
  }

  private closeEvent(): void {
    const id = this.calendarEvent;
    this.calendarEvent = null;
    this.render();
    if (id) this.content.querySelector<HTMLElement>(`[data-event="${CSS.escape(id)}"]`)?.focus();
  }

  private showCalendar(mode: CalendarMode, anchor: string): void {
    this.calendarEvent = null;
    this.calendarMode = mode;
    this.calendarAnchor = anchor;
    this.render();
    void this.loadCalendar();
  }

  private async loadCalendar(): Promise<void> {
    const key = this.calendarKey();
    const cached = this.calendarData.get(key);
    if ((cached && Date.now() - cached.at < CALENDAR_CACHE_MS) || this.calendarLoading === key) return;
    const range = calendarRange(this.calendarMode, this.calendarAnchor);
    this.calendarLoading = key;
    this.calendarError = "";
    this.render();
    try {
      const response = await fetch(`/api/calendar?from=${range.from}&to=${range.to}`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(response.status === 401 ? "Phiên truy cập hết hạn. Tải lại trang để đăng nhập." : `Không tải được lịch (${response.status}).`);
      const body = await response.json() as { events: CalendarEvent[] };
      this.calendarData.set(key, { at: Date.now(), events: body.events });
    } catch (error) {
      if (this.calendarKey() === key) this.calendarError = error instanceof Error && error.name !== "TimeoutError" ? error.message : "Hub không trả lời kịp.";
    } finally {
      if (this.calendarLoading === key) this.calendarLoading = "";
      this.render();
    }
  }

  private calendarMarkup(): string {
    if (!this.inbox) return empty("Đang đọc Google Calendar", this.inboxError || "Đang tải lịch từ hub…");
    const key = this.calendarKey();
    return calendarView(this.inbox, Date.now(), { mode: this.calendarMode, anchor: this.calendarAnchor, events: this.calendarData.get(key)?.events ?? null, loading: this.calendarLoading === key, error: this.calendarError, selected: this.calendarEvent, form: this.calendarForm, saving: this.calendarSaving, formError: this.calendarFormError });
  }

  private showFrame(index: number): void {
    const frames = this.replayData?.frames;
    if (!frames?.length) return;
    this.replayIndex = Math.max(0, Math.min(frames.length - 1, index));
    const frame = frames[this.replayIndex];
    this.replayBar.hidden = false;
    this.root.setAttribute("aria-owns", "operations-replay");
    document.body.classList.add("ops-replaying");
    const range = this.replayBar.querySelector<HTMLInputElement>("input")!;
    range.max = String(frames.length - 1);
    range.value = String(this.replayIndex);
    this.replayBar.querySelector(".ops-replay-time")!.textContent = `${time(frame.at)} · ${this.replayIndex + 1}/${frames.length}`;
    this.callbacks.replay(frame.snapshot);
    this.render();
  }

  private pause(): void {
    clearInterval(this.playback);
    this.playback = 0;
    this.replayBar.querySelector('[data-action="play"]')!.textContent = "Phát";
  }

  private togglePlayback(): void {
    if (this.playback) return this.pause();
    if (!this.replayData?.frames.length) return;
    if (this.replayIndex >= this.replayData.frames.length - 1) this.showFrame(0);
    this.replayBar.querySelector('[data-action="play"]')!.textContent = "Tạm dừng";
    this.playback = window.setInterval(() => {
      if (this.replayIndex >= this.replayData!.frames.length - 1) return this.pause();
      this.showFrame(this.replayIndex + 1);
    }, 1000);
  }

  private exitReplay(): void {
    this.pause();
    this.replayIndex = -1;
    this.replayBar.hidden = true;
    this.root.removeAttribute("aria-owns");
    document.body.classList.remove("ops-replaying");
    this.callbacks.replay(null);
    this.render();
  }

}
