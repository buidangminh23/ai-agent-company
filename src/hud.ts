import type { AgentInfo, MachineId, Snapshot } from "../shared/types.ts";
import type { InboxSnapshot } from "../shared/inbox.ts";
import { eventsToday } from "./inbox-views.ts";
import { trainingFocus } from "../shared/training.ts";
import type { ZoneId } from "./scene/layout.ts";
import type { OperationsSnapshot } from "../shared/operations.ts";
import { todoCounts, vietnamDay, type Todo } from "../shared/todos.ts";
import { icon, type ICONS, type Tab } from "./dashboard.ts";
import { escapeHtml } from "./markdown.ts";
import { mascotPortrait } from "./scene/portraits.ts";
import { QUOTA_APPS } from "./panels.ts";
import "./hud.css";

type Destination = Tab | "office";

interface HudCallbacks {
  open: (tab: Tab) => void;
  office: () => void;
  room: (zone: ZoneId) => void;
}

interface RoomLink {
  zone: ZoneId;
  label: string;
  icon: keyof typeof ICONS;
  machine?: MachineId;
  count: (agents: AgentInfo[]) => number;
}

const NAV: [Destination, string, keyof typeof ICONS][] = [
  ["office", "Văn phòng", "home"],
  ["overview", "Tổng quan", "grid"],
  ["github", "GitHub", "git"],
  ["projects", "Công việc", "board"],
  ["mail", "Thư", "mail"],
  ["calendar", "Lịch", "calendar"],
  ["automation", "Hệ thống", "auto"],
  ["quota", "Hạn mức AI", "gauge"],
];
const ROOMS: RoomLink[] = [
  { zone: "room2", label: "WORKSTATION", icon: "machine", machine: "WORKSTATION", count: (agents) => busyOn(agents, "WORKSTATION") },
  { zone: "room3", label: "LAPTOP", icon: "machine", machine: "LAPTOP", count: (agents) => busyOn(agents, "LAPTOP") },
  { zone: "room1", label: "SERVER", icon: "machine", machine: "SERVER", count: (agents) => busyOn(agents, "SERVER") },
  { zone: "training", label: "Phòng đào tạo", icon: "agent", count: (agents) => agents.filter((a) => a.state !== "idle" && trainingFocus(a)).length },
  { zone: "meeting", label: "Phòng họp", icon: "chat", count: () => 0 },
  { zone: "server", label: "Phòng máy chủ", icon: "project", count: () => 0 },
  { zone: "general", label: "Văn phòng chung", icon: "target", count: () => 0 },
];
const APP_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
const QUOTA_ACCOUNTS = 6;
const WINDOW_SHORT: Record<string, string> = { Tuần: "T", Fable: "F" };

function busyOn(agents: AgentInfo[], machine: MachineId): number {
  return agents.filter((a) => a.machine === machine && (a.state === "working" || a.state === "thinking")).length;
}

function text(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function quotaTone(remaining: number): string {
  return remaining < 20 ? "red" : remaining < 50 ? "amber" : "blue";
}

function accountName(account: string): string {
  return account.split("@")[0] || account;
}

interface QuotaWindow {
  app: string;
  account: string;
  window: string;
  remaining: number;
}

function quotaAccounts(rows: QuotaWindow[]): { app: string; account: string; windows: QuotaWindow[] }[] {
  const order = (app: string) => QUOTA_APPS.indexOf(app as (typeof QUOTA_APPS)[number]);
  const groups = new Map<string, { app: string; account: string; windows: QuotaWindow[] }>();
  for (const row of rows) {
    if (order(row.app) < 0) continue;
    const key = `${row.app}|${row.account}`;
    if (!groups.has(key)) groups.set(key, { app: row.app, account: row.account, windows: [] });
    groups.get(key)!.windows.push(row);
  }
  return [...groups.values()];
}

export class OfficeHud {
  private readonly rail = document.createElement("nav");
  private readonly strip = document.createElement("section");
  private readonly cards: HTMLDivElement;
  private snapshot: Snapshot | null = null;
  private operations: OperationsSnapshot | null = null;
  private inbox: InboxSnapshot | null = null;
  private todos: Todo[] = [];
  private githubCount = 0;
  private signature = "";
  private active: Destination = "office";

  constructor(private readonly callbacks: HudCallbacks) {
    document.body.classList.add("hud-on");
    this.rail.className = "hud-rail";
    this.rail.setAttribute("aria-label", "Điều hướng văn phòng");
    const nav = NAV.map(([id, label, name]) => `<button type="button" data-go="${id}" aria-current="${id === "office"}" title="${label}">${icon(name)}<span class="hud-rail-label">${label}</span><span class="hud-count" data-count-for="${id}" hidden></span></button>`).join("");
    const rooms = ROOMS.map((room) => `<button type="button" data-room="${room.zone}" title="Đi tới ${room.label}">${icon(room.icon)}<span class="hud-rail-label">${room.label}</span>${room.machine ? `<span class="hud-room-dot" data-dot-for="${room.zone}" role="img" aria-label="Chưa có dữ liệu máy"></span>` : ""}<span class="hud-count" data-room-count="${room.zone}" hidden></span></button>`).join("");
    this.rail.innerHTML = `${nav}<p class="hud-rail-heading">Phòng</p>${rooms}`;
    this.strip.className = "hud-strip";
    this.strip.setAttribute("aria-label", "Số liệu điều hành");
    this.strip.innerHTML = `<div class="hud-cards"></div>`;
    this.cards = this.strip.querySelector(".hud-cards")!;
    const brand = document.querySelector(".brand");
    document.body.append(...[brand, this.rail, this.strip].filter((node): node is Element => node !== null));
    this.rail.addEventListener("click", (event) => this.navigate(event));
    this.strip.addEventListener("click", (event) => this.handleStrip(event));
  }

  insets(): { left: number; top: number } {
    const shown = (element: Element) => element.getClientRects().length > 0;
    const left = shown(this.rail) ? this.rail.getBoundingClientRect().right : 0;
    if (shown(this.strip)) return { left, top: this.strip.getBoundingClientRect().bottom };
    return { left, top: document.querySelector(".brand")?.getBoundingClientRect().bottom ?? 0 };
  }

  watchLayout(callback: () => void): void {
    const observer = new ResizeObserver(callback);
    for (const element of [this.rail, this.strip, document.querySelector(".brand")]) if (element) observer.observe(element);
  }

  update(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.render();
  }

  updateOperations(operations: OperationsSnapshot): void {
    this.operations = operations;
    this.render();
  }

  updateTodos(todos: Todo[]): void {
    this.todos = todos;
    this.render();
  }

  updateGitHub(count: number): void {
    this.githubCount = count;
    this.renderCounts();
  }

  updateInbox(inbox: InboxSnapshot): void {
    this.inbox = inbox;
    this.renderCounts();
  }

  setState(open: boolean, tab: Tab): void {
    this.active = open ? tab : "office";
    for (const button of this.rail.querySelectorAll<HTMLButtonElement>("[data-go]")) button.setAttribute("aria-current", String(button.dataset.go === this.active));
  }

  private navigate(event: Event): void {
    const room = (event.target as Element).closest<HTMLElement>("[data-room]")?.dataset.room as ZoneId | undefined;
    if (room) return this.callbacks.room(room);
    const target = (event.target as Element).closest<HTMLElement>("[data-go]")?.dataset.go as Destination | undefined;
    if (!target) return;
    if (target === "office") this.callbacks.office();
    else this.callbacks.open(target);
  }

  private handleStrip(event: Event): void {
    const target = (event.target as Element).closest<HTMLElement>("[data-open]")?.dataset.open;
    if (target) this.callbacks.open(target as Tab);
  }

  private render(): void {
    this.renderCounts();
    if (!this.snapshot) return;
    const html = [this.agentsCard(), this.tasksCard(), this.quotaCard(), this.systemCard()].join("");
    if (html === this.signature) return;
    this.signature = html;
    this.cards.innerHTML = html;
  }

  private renderCounts(): void {
    const counts: Partial<Record<Destination, number>> = {
      overview: this.operations?.tasks.filter((task) => task.stage === "review").length ?? 0,
      github: this.githubCount,
      projects: this.todos.filter((todo) => todo.status !== "done").length,
      mail: this.inbox?.accounts.reduce((sum, account) => sum + (account.unread ?? 0), 0) ?? 0,
      calendar: eventsToday(this.inbox, Date.now()),
    };
    for (const badge of this.rail.querySelectorAll<HTMLElement>("[data-count-for]")) {
      const value = counts[badge.dataset.countFor as Destination] ?? 0;
      badge.textContent = String(value);
      badge.hidden = value === 0;
      badge.dataset.tone = badge.dataset.countFor === "github" || badge.dataset.countFor === "overview" ? "alert" : "neutral";
    }
    if (this.snapshot) this.renderRooms(this.snapshot);
  }

  private renderRooms(snapshot: Snapshot): void {
    for (const room of ROOMS) {
      const badge = this.rail.querySelector<HTMLElement>(`[data-room-count="${room.zone}"]`)!;
      const value = room.count(snapshot.agents);
      badge.textContent = String(value);
      badge.hidden = value === 0;
      badge.dataset.tone = "neutral";
      badge.title = `${value} agent đang làm`;
      if (!room.machine) continue;
      const online = snapshot.machines.find((machine) => machine.id === room.machine)?.online ?? false;
      const dot = this.rail.querySelector<HTMLElement>(`[data-dot-for="${room.zone}"]`)!;
      dot.dataset.online = String(online);
      dot.setAttribute("aria-label", online ? "Máy đang kết nối" : "Máy mất kết nối");
    }
  }

  private agentsCard(): string {
    const agents = this.snapshot!.agents;
    const totals = QUOTA_APPS.map((app) => [app, agents.filter((agent) => agent.app === app).length] as const);
    const label = totals.map(([app, total]) => `${APP_LABELS[app]} ${total}`).join(", ");
    const mascots = totals.map(([app, total]) => `<span class="hud-mascot" data-empty="${total === 0}"><img src="${mascotPortrait(app)}" alt="" width="40" height="40"><strong>${total}</strong><small>${APP_LABELS[app]}</small></span>`).join("");
    return `<button type="button" class="hud-card" data-open="overview" aria-label="Agent AI: ${label}. Mở tổng quan"><span class="hud-card-title">Agent AI<span class="hud-total">${agents.length} agent</span></span><span class="hud-mascots">${mascots}</span></button>`;
  }

  private tasksCard(): string {
    const counts = todoCounts(this.todos, vietnamDay(Date.now()));
    const items: [string, number, string][] = [["blue", counts.todo, "Cần làm"], ["green", counts.doing, "Đang làm"], ["amber", counts.overdue, "Quá hạn"], ["gray", counts.doneToday, "Xong hôm nay"]];
    const label = items.map(([, value, name]) => `${value} ${name.toLowerCase()}`).join(", ");
    return `<button type="button" class="hud-card" data-open="projects" aria-label="Việc cá nhân: ${label}. Mở bảng công việc"><span class="hud-card-title">Việc cá nhân</span><span class="hud-stages">${items.map(([tone, value, name]) => `<span class="hud-stage" data-tone="${tone}"><strong>${value}</strong><small>${name}</small></span>`).join("")}</span></button>`;
  }

  private quotaRows(): QuotaWindow[] {
    if (this.operations?.forecasts.length) return this.operations.forecasts;
    return this.snapshot!.quota.connected ? this.snapshot!.quota.rows : [];
  }

  private quotaCard(): string {
    const groups = quotaAccounts(this.quotaRows());
    if (!groups.length) return `<button type="button" class="hud-card" data-open="quota"><span class="hud-card-title">Hạn mức AI</span><span class="hud-empty">Chưa nối Quota Control</span></button>`;
    const shown = groups.slice(0, QUOTA_ACCOUNTS);
    const more = groups.length - shown.length;
    const accounts = shown.map(({ app, account, windows }) => {
      const summary = windows.map((row) => `${row.window} ${Math.round(row.remaining)}%`).join(", ");
      const rows = windows.map((row) => `<span class="hud-window"><small><span class="hud-long">${text(row.window)}</span><span class="hud-short">${text(WINDOW_SHORT[row.window] ?? row.window)}</span></small><strong data-tone="${quotaTone(row.remaining)}">${Math.round(row.remaining)}%</strong></span>`).join("");
      return `<span class="hud-account" title="${text(APP_LABELS[app] ?? app)} · ${text(account)} · ${text(summary)}"><span class="hud-account-head"><img src="/logos/${text(app)}.svg" alt="${text(APP_LABELS[app] ?? app)}" width="12" height="12"><span class="hud-account-name">${text(accountName(account))}</span></span><span class="hud-windows">${rows}</span></span>`;
    }).join("");
    return `<button type="button" class="hud-card" data-open="quota" aria-label="Hạn mức AI của ${groups.length} tài khoản. Mở hạn mức"><span class="hud-card-title">Hạn mức AI${more ? `<span class="hud-total">+${more} tài khoản</span>` : ""}</span><span class="hud-accounts">${accounts}</span></button>`;
  }

  private systemCard(): string {
    const { machines, sites } = this.snapshot!;
    const online = machines.filter((machine) => machine.online).length;
    const healthy = sites.filter((site) => site.ok).length;
    const failing = this.operations?.attention.filter((item) => item.kind === "failure").length ?? 0;
    const checks: [boolean, string][] = [
      [online === machines.length, `${online}/${machines.length} máy kết nối`],
      [healthy === sites.length, `${healthy}/${sites.length} website hoạt động`],
      [failing === 0, failing ? `${failing} lỗi cần xem` : "Không có lỗi"],
    ];
    const ok = checks.every(([pass]) => pass);
    return `<button type="button" class="hud-card" data-open="overview" aria-label="Trạng thái hệ thống: ${ok ? "ổn định" : "cần chú ý"}"><span class="hud-card-title">Trạng thái hệ thống<span class="hud-tag" data-tone="${ok ? "green" : "amber"}">${ok ? "Ổn định" : "Cần chú ý"}</span></span><span class="hud-checks">${checks.map(([pass, label]) => `<span data-pass="${pass}">${icon(pass ? "check" : "warn")}${text(label)}</span>`).join("")}</span></button>`;
  }
}
