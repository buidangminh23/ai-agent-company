import { MACHINE_LABELS, byMachineOrder } from "../shared/types.ts";
import type { MachineId } from "../shared/types.ts";
import { serviceAttention, systemFresh } from "../shared/system.ts";
import type { BackgroundService, MachineSystem, ServiceState, SystemProcess, SystemReport } from "../shared/system.ts";
import { automationView } from "./automation-view.ts";
import type { AutomationState } from "./automation-view.ts";
import { escapeHtml } from "./markdown.ts";

export type SystemSection = "background" | "scheduled" | "resources";
export type SystemFilter = "all" | ServiceState;

export interface SystemViewState {
  report: SystemReport | null;
  loading: boolean;
  error: string;
  machine: MachineId | null;
  section: SystemSection;
  query: string;
  filter: SystemFilter;
  allServices: boolean;
  processes: boolean;
  processQuery: string;
  processLimit: number;
  serviceLimit: number;
  automation: AutomationState;
}

const STATE_LABELS: Record<ServiceState, string> = { running: "Đang chạy", stopped: "Đã dừng", error: "Có lỗi", unknown: "Chưa rõ" };
const SECTIONS: [SystemSection, string][] = [["background", "Chạy ngầm"], ["scheduled", "Tác vụ định kỳ"], ["resources", "Tài nguyên"]];
const KINDS = [["service", "Dịch vụ hệ thống", "Dịch vụ được hệ điều hành quản lý"], ["container", "Docker", "Ứng dụng chạy trong container"], ["app", "Ứng dụng nền", "Các ứng dụng và công cụ đang hoạt động"]] as const;
const TIMEZONE = "Asia/Ho_Chi_Minh";

function text(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

export function formatSystemBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toLocaleString("vi-VN", { maximumFractionDigits: unit > 1 ? 1 : 0 })} ${units[unit]}`;
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
}

function duration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const minutes = Math.floor(Math.max(0, value) / 60);
  if (minutes < 1) return "< 1 phút";
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} giờ ${minutes % 60} phút` : `${Math.floor(hours / 24)} ngày ${hours % 24} giờ`;
}

function clock(value: string | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("vi-VN", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "chưa có";
}

function statePill(state: ServiceState): string {
  return `<span class="sys-state" data-state="${state}"><i aria-hidden="true"></i>${STATE_LABELS[state]}</span>`;
}

export function systemAlerts(report: SystemReport | null, now = Date.now()): { machine: MachineSystem; count: number }[] {
  return (report?.machines ?? []).filter((machine) => systemFresh(machine, now)).map((machine) => ({ machine, count: machine.inventory!.services.filter(serviceAttention).length })).filter((entry) => entry.count > 0).sort((a, b) => byMachineOrder(a.machine.id, b.machine.id));
}

export function systemOverview(report: SystemReport | null): string {
  const alerts = systemAlerts(report);
  if (!alerts.length) return "";
  return `<section class="sys-overview" aria-label="Dịch vụ cần kiểm tra">${alerts.map(({ machine, count }) => `<button type="button" data-sys-open="${text(machine.id)}"><span class="sys-state" data-state="error"><i aria-hidden="true"></i>${count} dịch vụ có lỗi</span><strong>${text(MACHINE_LABELS[machine.id])}</strong><span>Xem hệ thống <span aria-hidden="true">→</span></span></button>`).join("")}</section>`;
}

function machineButton(machine: MachineSystem, active: boolean): string {
  const fresh = systemFresh(machine);
  const errors = fresh ? machine.inventory!.services.filter(serviceAttention).length : 0;
  const state = !machine.online ? "offline" : !machine.inventory ? "pending" : !fresh ? "stale" : errors ? "error" : machine.inventory.issues.length ? "partial" : "online";
  const label = { offline: "Mất kết nối", pending: "Chưa có dữ liệu", stale: "Dữ liệu đã cũ", error: `${errors} dịch vụ có lỗi`, partial: "Dữ liệu chưa đủ", online: "Đang kết nối" }[state];
  return `<button type="button" class="sys-machine" data-au-machine="${text(machine.id)}" data-key="au-machine:${text(machine.id)}" aria-pressed="${active}"><span class="sys-machine-top"><strong>${text(MACHINE_LABELS[machine.id])}</strong><span class="sys-machine-mark" aria-hidden="true">${active ? "●" : "○"}</span></span><small>${text(machine.id)}</small><span class="sys-connection" data-state="${state}"><i aria-hidden="true"></i>${label}</span></button>`;
}

function availability(machine: MachineSystem): string {
  if (!machine.online) return `<div class="sys-notice" data-tone="muted"><strong>Máy đang mất kết nối</strong><p>Chưa thể xác nhận trạng thái hiện tại.${machine.inventory ? ` Dữ liệu bên dưới được ghi nhận lúc ${clock(machine.inventory.checkedAt)} và có thể đã thay đổi.` : " Dữ liệu sẽ xuất hiện khi máy kết nối lại."}</p></div>`;
  if (!machine.inventory) return `<div class="sys-notice"><strong>Chưa nhận dữ liệu chạy ngầm</strong><p>Máy đã kết nối. Cần collector có hỗ trợ Hệ thống để gửi danh sách dịch vụ và tiến trình.</p></div>`;
  if (!systemFresh(machine)) return `<div class="sys-notice"><strong>Đang hiển thị lần ghi nhận trước</strong><p>Dữ liệu dịch vụ lúc ${clock(machine.inventory.checkedAt)} chưa được cập nhật lại. Trạng thái bên dưới có thể đã thay đổi.</p></div>`;
  if (machine.inventory.issues.length) return `<div class="sys-notice"><strong>Một phần dữ liệu chưa đọc được</strong><ul>${machine.inventory.issues.map((issue) => `<li>${text(issue)}</li>`).join("")}</ul></div>`;
  return "";
}

function healthFresh(machine: MachineSystem): boolean {
  const age = Date.now() - Date.parse(machine.health.checkedAt);
  return machine.online && Number.isFinite(age) && age >= -30_000 && age <= 120_000;
}

function quickStats(machine: MachineSystem): string {
  const inventory = machine.inventory;
  const fresh = systemFresh(machine);
  const health = healthFresh(machine);
  const running = inventory?.services.filter((service) => service.state === "running").length;
  const errors = inventory?.services.filter(serviceAttention).length;
  const ram = machine.health.memTotal && machine.health.memUsed !== null ? machine.health.memUsed / machine.health.memTotal * 100 : null;
  const cells = [
    [fresh ? String(running) : "—", "Dịch vụ đang chạy", inventory ? `${inventory.services.length} dịch vụ được ghi nhận` : "Chờ dữ liệu từ máy", "neutral"],
    [fresh ? String(errors) : "—", "Dịch vụ có lỗi", fresh ? (errors ? "Ưu tiên kiểm tra" : "Trong dữ liệu đã đọc") : "Chưa xác nhận hiện tại", fresh && errors ? "error" : "neutral"],
    [health ? percent(machine.health.cpu) : "—", "CPU toàn máy", machine.health.cores ? `${machine.health.cores} luồng xử lý` : "Mức sử dụng hiện tại", "neutral"],
    [health ? percent(ram) : "—", "Bộ nhớ RAM", health ? `${formatSystemBytes(machine.health.memUsed)} / ${formatSystemBytes(machine.health.memTotal)}` : "Chờ dữ liệu mới", "neutral"],
  ];
  return `<div class="sys-stats">${cells.map(([value, label, note, tone]) => `<div data-tone="${tone}"><span>${label}</span><strong>${value}</strong><small>${text(note)}</small></div>`).join("")}</div>`;
}

export function visibleServices(services: BackgroundService[], state: Pick<SystemViewState, "query" | "filter" | "allServices">): BackgroundService[] {
  const query = state.query.trim().toLocaleLowerCase("vi");
  return services.filter((service) => (state.allServices || service.important || serviceAttention(service)) && (state.filter === "all" || service.state === state.filter) && (!query || `${service.name} ${service.description} ${service.pid ?? ""}`.toLocaleLowerCase("vi").includes(query))).sort((a, b) => Number(serviceAttention(b)) - Number(serviceAttention(a)) || Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name));
}

function serviceRow(service: BackgroundService): string {
  return `<tr data-state="${service.state}"><td class="sys-service-name"><strong>${text(service.name)}</strong><span>${text(service.description)}</span>${service.pid !== null ? `<small>PID ${service.pid}</small>` : ""}${service.detail ? `<small class="sys-detail">${text(service.detail)}</small>` : ""}</td><td data-label="Trạng thái">${statePill(service.state)}</td><td class="sys-num" data-label="CPU">${percent(service.cpuPercent)}</td><td class="sys-num" data-label="RAM">${formatSystemBytes(service.memoryBytes)}</td><td class="sys-num" data-label="Đã chạy">${duration(service.uptimeSec)}</td></tr>`;
}

function background(machine: MachineSystem, state: SystemViewState): string {
  const inventory = machine.inventory;
  if (!inventory) return "";
  const services = visibleServices(inventory.services, state);
  const shown = services.slice(0, state.serviceLimit);
  const importantCount = inventory.services.filter((service) => service.important || serviceAttention(service)).length;
  const filters: [SystemFilter, string][] = [["all", "Tất cả trạng thái"], ["running", "Đang chạy"], ["error", "Có lỗi"], ["stopped", "Đã dừng"], ["unknown", "Chưa rõ"]];
  const controls = `<div class="sys-controls"><label class="sys-search"><span>Tìm dịch vụ</span><input type="search" aria-label="Tìm dịch vụ" data-sys-query data-key="sys-query" value="${text(state.query)}" placeholder="Tên dịch vụ hoặc PID…" autocomplete="off"></label><label class="sys-filter"><span>Trạng thái</span><select aria-label="Trạng thái" data-sys-filter data-key="sys-filter">${filters.map(([value, label]) => `<option value="${value}"${value === state.filter ? " selected" : ""}>${label}</option>`).join("")}</select></label><button type="button" data-sys-all data-key="sys-all" aria-pressed="${state.allServices}">${state.allServices ? `Chỉ dịch vụ chính (${importantCount})` : `Xem mọi dịch vụ (${inventory.services.length})`}</button></div>`;
  const groups = KINDS.map(([kind, label, description]) => {
    const rows = shown.filter((service) => service.kind === kind);
    if (!rows.length) return "";
    return `<section class="sys-service-group"><header><div><h3>${label} <span>${rows.length}</span></h3><p>${description}</p></div></header><div class="sys-table-wrap"><table class="sys-table"><thead><tr><th scope="col">Dịch vụ</th><th scope="col">Trạng thái</th><th scope="col" class="sys-num">CPU</th><th scope="col" class="sys-num">RAM</th><th scope="col" class="sys-num">Đã chạy</th></tr></thead><tbody>${rows.map(serviceRow).join("")}</tbody></table></div></section>`;
  }).join("");
  return `<div class="sys-section-heading"><div><h2>Dịch vụ & ứng dụng nền</h2><p>${state.allServices ? "Toàn bộ dịch vụ đã đọc từ máy." : "Các dịch vụ chính và mọi dịch vụ đang báo lỗi."} Đã dừng không đồng nghĩa với lỗi.</p></div><span class="sys-count">${services.length} kết quả</span></div>${controls}${groups || '<div class="sys-empty"><strong>Không có dịch vụ phù hợp</strong><p>Thử đổi trạng thái, từ khóa hoặc mở mọi dịch vụ.</p></div>'}${services.length > shown.length ? `<div class="sys-more"><span>Đang hiện ${shown.length}/${services.length} dịch vụ</span><button type="button" data-sys-more-services data-key="sys-more-services">Xem thêm 40</button></div>` : ""}<div class="sys-process-toggle"><div><h3>Tiến trình trên máy</h3><p>Tra cứu toàn bộ ${inventory.processes.length} tiến trình theo tên và PID.</p></div><button type="button" data-sys-processes data-key="sys-processes" aria-expanded="${state.processes}" aria-controls="sys-process-list">${state.processes ? "Thu gọn tiến trình" : "Xem mọi tiến trình"}</button></div>${state.processes ? processPanel(inventory.processes, state) : ""}<p class="sys-footnote">CPU/RAM là số đo của tiến trình liên quan; không cộng các dòng để tính tổng máy. Dấu — nghĩa là chưa đo được.</p>`;
}

function processRows(processes: SystemProcess[]): string {
  return processes.map((process) => `<tr><td class="sys-service-name"><strong>${text(process.name)}</strong><small>PID ${process.pid}</small></td><td class="sys-num" data-label="CPU">${percent(process.cpuPercent)}</td><td class="sys-num" data-label="RAM">${formatSystemBytes(process.memoryBytes)}</td><td class="sys-num" data-label="Đã chạy">${duration(process.uptimeSec)}</td></tr>`).join("");
}

function processTable(processes: SystemProcess[]): string {
  return `<div class="sys-table-wrap"><table class="sys-table sys-process-table"><thead><tr><th scope="col">Tiến trình</th><th scope="col" class="sys-num">CPU</th><th scope="col" class="sys-num">RAM</th><th scope="col" class="sys-num">Đã chạy</th></tr></thead><tbody>${processRows(processes)}</tbody></table></div>`;
}

function processPanel(processes: SystemProcess[], state: SystemViewState): string {
  const query = state.processQuery.trim().toLocaleLowerCase("vi");
  const matches = processes.filter((process) => `${process.name} ${process.pid}`.toLocaleLowerCase("vi").includes(query)).sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));
  const shown = matches.slice(0, state.processLimit);
  return `<section id="sys-process-list" class="sys-process-panel"><label class="sys-search"><span>Tìm tiến trình · sắp theo RAM giảm dần</span><input type="search" aria-label="Tìm tiến trình" data-sys-process-query data-key="sys-process-query" value="${text(state.processQuery)}" placeholder="Tên tiến trình hoặc PID…" autocomplete="off"></label>${shown.length ? processTable(shown) : '<p class="sys-empty">Không tìm thấy tiến trình phù hợp.</p>'}<div class="sys-more"><span>Đang hiện ${shown.length}/${matches.length} tiến trình</span>${matches.length > shown.length ? '<button type="button" data-sys-more-processes data-key="sys-more-processes">Xem thêm 40</button>' : ""}</div></section>`;
}

function resourceCard(title: string, value: string, ratio: number | null, description: string): string {
  const bounded = ratio !== null && Number.isFinite(ratio) ? Math.min(100, Math.max(0, ratio)) : null;
  return `<article class="sys-resource"><h3>${title}</h3><strong>${value}</strong>${bounded !== null ? `<meter min="0" max="100" value="${bounded}" aria-label="${title}">${percent(bounded)}</meter>` : '<div class="sys-meter-empty"></div>'}<p>${text(description)}</p></article>`;
}

function resources(machine: MachineSystem): string {
  const health = machine.health;
  const fresh = healthFresh(machine);
  const ratio = (used: number | null, total: number | null) => fresh && used !== null && total ? used / total * 100 : null;
  const cpu = fresh ? health.cpu : null;
  const memory = ratio(health.memUsed, health.memTotal);
  const disk = ratio(health.diskUsed, health.diskTotal);
  const top = [...(machine.inventory?.processes ?? [])].sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0)).slice(0, 8);
  const network = fresh ? `↓ ${formatSystemBytes(health.netRxBps)}/s · ↑ ${formatSystemBytes(health.netTxBps)}/s` : "—";
  return `<div class="sys-section-heading"><div><h2>Tài nguyên máy</h2><p>Mức sử dụng tại thời điểm ${clock(health.checkedAt)}.${fresh ? "" : " Đang chờ số đo mới."}</p></div></div><div class="sys-resources">${resourceCard("CPU", percent(cpu), cpu, health.cpuModel ?? "Chưa đọc được bộ xử lý")}${resourceCard("Bộ nhớ RAM", percent(memory), memory, fresh ? `${formatSystemBytes(health.memUsed)} đã dùng / ${formatSystemBytes(health.memTotal)}` : "Chưa có số đo hiện tại")}${resourceCard("Ổ đĩa hệ thống", percent(disk), disk, fresh ? `${formatSystemBytes(health.diskUsed)} đã dùng / ${formatSystemBytes(health.diskTotal)}` : "Chưa có số đo hiện tại")}</div><dl class="sys-machine-details"><div><dt>Hệ điều hành</dt><dd>${text(health.os ?? "—")}</dd></div><div><dt>Máy đã chạy</dt><dd>${fresh ? duration(health.uptimeSec) : "—"}</dd></div><div><dt>Mạng · tải xuống / tải lên</dt><dd>${network}</dd></div></dl>${top.length ? `<section class="sys-service-group"><header><div><h3>Tiến trình dùng nhiều RAM</h3><p>8 tiến trình đứng đầu · số đo lúc ${clock(machine.inventory?.checkedAt)}</p></div></header>${processTable(top)}</section>` : ""}`;
}

export function systemView(state: SystemViewState): string {
  const heading = `<div class="sys-heading"><div><p class="sys-eyebrow">THIẾT BỊ & VẬN HÀNH</p><h2>Mọi máy, một nơi theo dõi</h2><p>Dịch vụ chạy ngầm, lịch tự động và tài nguyên của từng máy.</p></div><span class="sys-refresh">${state.loading ? "Đang cập nhật…" : "Tự làm mới mỗi 30 giây"}</span></div>`;
  const error = state.error ? `<div class="sys-notice" role="status"><strong>Chưa làm mới được dữ liệu</strong><p>${text(state.error)}</p></div>` : "";
  if (!state.report?.machines.length) return `<div class="sys-view">${heading}${error}<div class="sys-empty"><strong>${state.loading ? "Đang đọc trạng thái các máy…" : "Chưa có dữ liệu hệ thống"}</strong><p>Danh sách sẽ xuất hiện khi hub nhận được báo cáo từ các máy.</p></div></div>`;
  const machines = [...state.report.machines].sort((a, b) => byMachineOrder(a.id, b.id));
  const machine = machines.find((entry) => entry.id === state.machine) ?? machines[0];
  const machineTabs = `<div class="sys-machines" role="group" aria-label="Chọn máy">${machines.map((entry) => machineButton(entry, entry.id === machine.id)).join("")}</div>`;
  const tabs = `<div class="sys-sections" role="tablist" aria-label="Nội dung hệ thống">${SECTIONS.map(([section, label]) => `<button type="button" role="tab" id="sys-tab-${section}" data-sys-section="${section}" data-key="sys-section:${section}" aria-selected="${state.section === section}" tabindex="${state.section === section ? 0 : -1}" aria-controls="sys-section-content">${label}</button>`).join("")}</div>`;
  const content = state.section === "scheduled" ? automationView({ ...state.automation, machine: machine.id, embedded: true }) : state.section === "resources" ? resources(machine) : background(machine, state);
  return `<div class="sys-view">${heading}${error}${machineTabs}${quickStats(machine)}${tabs}<div class="sys-selected-heading"><strong>${text(MACHINE_LABELS[machine.id])}</strong><span>Ghi nhận dịch vụ lúc ${clock(machine.inventory?.checkedAt)}</span></div>${availability(machine)}<div id="sys-section-content" role="tabpanel" aria-labelledby="sys-tab-${state.section}" tabindex="0">${content}</div></div>`;
}
