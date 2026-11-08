import { L, locale } from "../shared/i18n.ts";
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

const STATE_LABELS: Record<ServiceState, string> = { running: L("Đang chạy"), stopped: L("Đã dừng"), error: L("Có lỗi"), unknown: L("Chưa rõ") };
const SECTIONS: [SystemSection, string][] = [["background", L("Chạy ngầm")], ["scheduled", L("Tác vụ định kỳ")], ["resources", L("Tài nguyên")]];
const KINDS = [["service", L("Dịch vụ hệ thống"), L("Dịch vụ được hệ điều hành quản lý")], ["container", "Docker", L("Ứng dụng chạy trong container")], ["app", L("Ứng dụng nền"), L("Các ứng dụng và công cụ đang hoạt động")]] as const;
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
  return `${size.toLocaleString(locale(), { maximumFractionDigits: unit > 1 ? 1 : 0 })} ${units[unit]}`;
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "—" : `${value.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`;
}

function duration(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const minutes = Math.floor(Math.max(0, value) / 60);
  if (minutes < 1) return L("< 1 phút");
  if (minutes < 60) return L("{0} phút", minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? L("{0} giờ {1} phút", hours, minutes % 60) : L("{0} ngày {1} giờ", Math.floor(hours / 24), hours % 24);
}

function clock(value: string | undefined): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale(), { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : L("chưa có");
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
  return L("<section class=\"sys-overview\" aria-label=\"Dịch vụ cần kiểm tra\">{0}</section>", alerts.map(({ machine, count }) => L("<button type=\"button\" data-sys-open=\"{0}\"><span class=\"sys-state\" data-state=\"error\"><i aria-hidden=\"true\"></i>{1} dịch vụ có lỗi</span><strong>{2}</strong><span>Xem hệ thống <span aria-hidden=\"true\">→</span></span></button>", text(machine.id), count, text(MACHINE_LABELS[machine.id]))).join(""));
}

function machineButton(machine: MachineSystem, active: boolean): string {
  const fresh = systemFresh(machine);
  const errors = fresh ? machine.inventory!.services.filter(serviceAttention).length : 0;
  const state = !machine.online ? "offline" : !machine.inventory ? "pending" : !fresh ? "stale" : errors ? "error" : machine.inventory.issues.length ? "partial" : "online";
  const label = { offline: L("Mất kết nối"), pending: L("Chưa có dữ liệu"), stale: L("Dữ liệu đã cũ"), error: L("{0} dịch vụ có lỗi", errors), partial: L("Dữ liệu chưa đủ"), online: L("Đang kết nối") }[state];
  return `<button type="button" class="sys-machine" data-au-machine="${text(machine.id)}" data-key="au-machine:${text(machine.id)}" aria-pressed="${active}"><span class="sys-machine-top"><strong>${text(MACHINE_LABELS[machine.id])}</strong><span class="sys-machine-mark" aria-hidden="true">${active ? "●" : "○"}</span></span><small>${text(machine.id)}</small><span class="sys-connection" data-state="${state}"><i aria-hidden="true"></i>${label}</span></button>`;
}

function availability(machine: MachineSystem): string {
  if (!machine.online) return L("<div class=\"sys-notice\" data-tone=\"muted\"><strong>Máy đang mất kết nối</strong><p>Chưa thể xác nhận trạng thái hiện tại.{0}</p></div>", machine.inventory ? L(" Dữ liệu bên dưới được ghi nhận lúc {0} và có thể đã thay đổi.", clock(machine.inventory.checkedAt)) : L(" Dữ liệu sẽ xuất hiện khi máy kết nối lại."));
  if (!machine.inventory) return L("<div class=\"sys-notice\"><strong>Chưa nhận dữ liệu chạy ngầm</strong><p>Máy đã kết nối. Cần collector có hỗ trợ Hệ thống để gửi danh sách dịch vụ và tiến trình.</p></div>");
  if (!systemFresh(machine)) return L("<div class=\"sys-notice\"><strong>Đang hiển thị lần ghi nhận trước</strong><p>Dữ liệu dịch vụ lúc {0} chưa được cập nhật lại. Trạng thái bên dưới có thể đã thay đổi.</p></div>", clock(machine.inventory.checkedAt));
  if (machine.inventory.issues.length) return L("<div class=\"sys-notice\"><strong>Một phần dữ liệu chưa đọc được</strong><ul>{0}</ul></div>", machine.inventory.issues.map((issue) => `<li>${text(issue)}</li>`).join(""));
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
    [fresh ? String(running) : "—", L("Dịch vụ đang chạy"), inventory ? L("{0} dịch vụ được ghi nhận", inventory.services.length) : L("Chờ dữ liệu từ máy"), "neutral"],
    [fresh ? String(errors) : "—", L("Dịch vụ có lỗi"), fresh ? (errors ? L("Ưu tiên kiểm tra") : L("Trong dữ liệu đã đọc")) : L("Chưa xác nhận hiện tại"), fresh && errors ? "error" : "neutral"],
    [health ? percent(machine.health.cpu) : "—", L("CPU toàn máy"), machine.health.cores ? L("{0} luồng xử lý", machine.health.cores) : L("Mức sử dụng hiện tại"), "neutral"],
    [health ? percent(ram) : "—", L("Bộ nhớ RAM"), health ? `${formatSystemBytes(machine.health.memUsed)} / ${formatSystemBytes(machine.health.memTotal)}` : L("Chờ dữ liệu mới"), "neutral"],
  ];
  return `<div class="sys-stats">${cells.map(([value, label, note, tone]) => `<div data-tone="${tone}"><span>${label}</span><strong>${value}</strong><small>${text(note)}</small></div>`).join("")}</div>`;
}

export function visibleServices(services: BackgroundService[], state: Pick<SystemViewState, "query" | "filter" | "allServices">): BackgroundService[] {
  const query = state.query.trim().toLocaleLowerCase("vi");
  return services.filter((service) => (state.allServices || service.important || serviceAttention(service)) && (state.filter === "all" || service.state === state.filter) && (!query || `${service.name} ${service.description} ${service.pid ?? ""}`.toLocaleLowerCase("vi").includes(query))).sort((a, b) => Number(serviceAttention(b)) - Number(serviceAttention(a)) || Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name));
}

function serviceRow(service: BackgroundService): string {
  return L("<tr data-state=\"{0}\"><td class=\"sys-service-name\"><strong>{1}</strong><span>{2}</span>{3}{4}</td><td data-label=\"Trạng thái\">{5}</td><td class=\"sys-num\" data-label=\"CPU\">{6}</td><td class=\"sys-num\" data-label=\"RAM\">{7}</td><td class=\"sys-num\" data-label=\"Đã chạy\">{8}</td></tr>", service.state, text(service.name), text(service.description), service.pid !== null ? `<small>PID ${service.pid}</small>` : "", service.detail ? `<small class="sys-detail">${text(service.detail)}</small>` : "", statePill(service.state), percent(service.cpuPercent), formatSystemBytes(service.memoryBytes), duration(service.uptimeSec));
}

function background(machine: MachineSystem, state: SystemViewState): string {
  const inventory = machine.inventory;
  if (!inventory) return "";
  const services = visibleServices(inventory.services, state);
  const shown = services.slice(0, state.serviceLimit);
  const importantCount = inventory.services.filter((service) => service.important || serviceAttention(service)).length;
  const filters: [SystemFilter, string][] = [["all", L("Tất cả trạng thái")], ["running", L("Đang chạy")], ["error", L("Có lỗi")], ["stopped", L("Đã dừng")], ["unknown", L("Chưa rõ")]];
  const controls = L("<div class=\"sys-controls\"><label class=\"sys-search\"><span>Tìm dịch vụ</span><input type=\"search\" aria-label=\"Tìm dịch vụ\" data-sys-query data-key=\"sys-query\" value=\"{0}\" placeholder=\"Tên dịch vụ hoặc PID…\" autocomplete=\"off\"></label><label class=\"sys-filter\"><span>Trạng thái</span><select aria-label=\"Trạng thái\" data-sys-filter data-key=\"sys-filter\">{1}</select></label><button type=\"button\" data-sys-all data-key=\"sys-all\" aria-pressed=\"{2}\">{3}</button></div>", text(state.query), filters.map(([value, label]) => `<option value="${value}"${value === state.filter ? " selected" : ""}>${label}</option>`).join(""), state.allServices, state.allServices ? L("Chỉ dịch vụ chính ({0})", importantCount) : L("Xem mọi dịch vụ ({0})", inventory.services.length));
  const groups = KINDS.map(([kind, label, description]) => {
    const rows = shown.filter((service) => service.kind === kind);
    if (!rows.length) return "";
    return L("<section class=\"sys-service-group\"><header><div><h3>{0} <span>{1}</span></h3><p>{2}</p></div></header><div class=\"sys-table-wrap\"><table class=\"sys-table\"><thead><tr><th scope=\"col\">Dịch vụ</th><th scope=\"col\">Trạng thái</th><th scope=\"col\" class=\"sys-num\">CPU</th><th scope=\"col\" class=\"sys-num\">RAM</th><th scope=\"col\" class=\"sys-num\">Đã chạy</th></tr></thead><tbody>{3}</tbody></table></div></section>", label, rows.length, description, rows.map(serviceRow).join(""));
  }).join("");
  return L("<div class=\"sys-section-heading\"><div><h2>Dịch vụ & ứng dụng nền</h2><p>{0} Đã dừng không đồng nghĩa với lỗi.</p></div><span class=\"sys-count\">{1} kết quả</span></div>{2}{3}{4}<div class=\"sys-process-toggle\"><div><h3>Tiến trình trên máy</h3><p>Tra cứu toàn bộ {5} tiến trình theo tên và PID.</p></div><button type=\"button\" data-sys-processes data-key=\"sys-processes\" aria-expanded=\"{6}\" aria-controls=\"sys-process-list\">{7}</button></div>{8}<p class=\"sys-footnote\">CPU/RAM là số đo của tiến trình liên quan; không cộng các dòng để tính tổng máy. Dấu — nghĩa là chưa đo được.</p>", state.allServices ? L("Toàn bộ dịch vụ đã đọc từ máy.") : L("Các dịch vụ chính và mọi dịch vụ đang báo lỗi."), services.length, controls, groups || L("<div class=\"sys-empty\"><strong>Không có dịch vụ phù hợp</strong><p>Thử đổi trạng thái, từ khóa hoặc mở mọi dịch vụ.</p></div>"), services.length > shown.length ? L("<div class=\"sys-more\"><span>Đang hiện {0}/{1} dịch vụ</span><button type=\"button\" data-sys-more-services data-key=\"sys-more-services\">Xem thêm 40</button></div>", shown.length, services.length) : "", inventory.processes.length, state.processes, state.processes ? L("Thu gọn tiến trình") : L("Xem mọi tiến trình"), state.processes ? processPanel(inventory.processes, state) : "");
}

function processRows(processes: SystemProcess[]): string {
  return processes.map((process) => L("<tr><td class=\"sys-service-name\"><strong>{0}</strong><small>PID {1}</small></td><td class=\"sys-num\" data-label=\"CPU\">{2}</td><td class=\"sys-num\" data-label=\"RAM\">{3}</td><td class=\"sys-num\" data-label=\"Đã chạy\">{4}</td></tr>", text(process.name), process.pid, percent(process.cpuPercent), formatSystemBytes(process.memoryBytes), duration(process.uptimeSec))).join("");
}

function processTable(processes: SystemProcess[]): string {
  return L("<div class=\"sys-table-wrap\"><table class=\"sys-table sys-process-table\"><thead><tr><th scope=\"col\">Tiến trình</th><th scope=\"col\" class=\"sys-num\">CPU</th><th scope=\"col\" class=\"sys-num\">RAM</th><th scope=\"col\" class=\"sys-num\">Đã chạy</th></tr></thead><tbody>{0}</tbody></table></div>", processRows(processes));
}

function processPanel(processes: SystemProcess[], state: SystemViewState): string {
  const query = state.processQuery.trim().toLocaleLowerCase("vi");
  const matches = processes.filter((process) => `${process.name} ${process.pid}`.toLocaleLowerCase("vi").includes(query)).sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0));
  const shown = matches.slice(0, state.processLimit);
  return L("<section id=\"sys-process-list\" class=\"sys-process-panel\"><label class=\"sys-search\"><span>Tìm tiến trình · sắp theo RAM giảm dần</span><input type=\"search\" aria-label=\"Tìm tiến trình\" data-sys-process-query data-key=\"sys-process-query\" value=\"{0}\" placeholder=\"Tên tiến trình hoặc PID…\" autocomplete=\"off\"></label>{1}<div class=\"sys-more\"><span>Đang hiện {2}/{3} tiến trình</span>{4}</div></section>", text(state.processQuery), shown.length ? processTable(shown) : L("<p class=\"sys-empty\">Không tìm thấy tiến trình phù hợp.</p>"), shown.length, matches.length, matches.length > shown.length ? L("<button type=\"button\" data-sys-more-processes data-key=\"sys-more-processes\">Xem thêm 40</button>") : "");
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
  return L("<div class=\"sys-section-heading\"><div><h2>Tài nguyên máy</h2><p>Mức sử dụng tại thời điểm {0}.{1}</p></div></div><div class=\"sys-resources\">{2}{3}{4}</div><dl class=\"sys-machine-details\"><div><dt>Hệ điều hành</dt><dd>{5}</dd></div><div><dt>Máy đã chạy</dt><dd>{6}</dd></div><div><dt>Mạng · tải xuống / tải lên</dt><dd>{7}</dd></div></dl>{8}", clock(health.checkedAt), fresh ? "" : L(" Đang chờ số đo mới."), resourceCard("CPU", percent(cpu), cpu, health.cpuModel ?? L("Chưa đọc được bộ xử lý")), resourceCard(L("Bộ nhớ RAM"), percent(memory), memory, fresh ? L("{0} đã dùng / {1}", formatSystemBytes(health.memUsed), formatSystemBytes(health.memTotal)) : L("Chưa có số đo hiện tại")), resourceCard(L("Ổ đĩa hệ thống"), percent(disk), disk, fresh ? L("{0} đã dùng / {1}", formatSystemBytes(health.diskUsed), formatSystemBytes(health.diskTotal)) : L("Chưa có số đo hiện tại")), text(health.os ?? "—"), fresh ? duration(health.uptimeSec) : "—", network, top.length ? L("<section class=\"sys-service-group\"><header><div><h3>Tiến trình dùng nhiều RAM</h3><p>8 tiến trình đứng đầu · số đo lúc {0}</p></div></header>{1}</section>", clock(machine.inventory?.checkedAt), processTable(top)) : "");
}

export function systemView(state: SystemViewState): string {
  const heading = L("<div class=\"sys-heading\"><div><p class=\"sys-eyebrow\">THIẾT BỊ & VẬN HÀNH</p><h2>Mọi máy, một nơi theo dõi</h2><p>Dịch vụ chạy ngầm, lịch tự động và tài nguyên của từng máy.</p></div><span class=\"sys-refresh\">{0}</span></div>", state.loading ? L("Đang cập nhật…") : L("Tự làm mới mỗi 30 giây"));
  const error = state.error ? L("<div class=\"sys-notice\" role=\"status\"><strong>Chưa làm mới được dữ liệu</strong><p>{0}</p></div>", text(state.error)) : "";
  if (!state.report?.machines.length) return L("<div class=\"sys-view\">{0}{1}<div class=\"sys-empty\"><strong>{2}</strong><p>Danh sách sẽ xuất hiện khi hub nhận được báo cáo từ các máy.</p></div></div>", heading, error, state.loading ? L("Đang đọc trạng thái các máy…") : L("Chưa có dữ liệu hệ thống"));
  const machines = [...state.report.machines].sort((a, b) => byMachineOrder(a.id, b.id));
  const machine = machines.find((entry) => entry.id === state.machine) ?? machines[0];
  const machineTabs = L("<div class=\"sys-machines\" role=\"group\" aria-label=\"Chọn máy\">{0}</div>", machines.map((entry) => machineButton(entry, entry.id === machine.id)).join(""));
  const tabs = L("<div class=\"sys-sections\" role=\"tablist\" aria-label=\"Nội dung hệ thống\">{0}</div>", SECTIONS.map(([section, label]) => `<button type="button" role="tab" id="sys-tab-${section}" data-sys-section="${section}" data-key="sys-section:${section}" aria-selected="${state.section === section}" tabindex="${state.section === section ? 0 : -1}" aria-controls="sys-section-content">${label}</button>`).join(""));
  const content = state.section === "scheduled" ? automationView({ ...state.automation, machine: machine.id, embedded: true }) : state.section === "resources" ? resources(machine) : background(machine, state);
  return L("<div class=\"sys-view\">{0}{1}{2}{3}{4}<div class=\"sys-selected-heading\"><strong>{5}</strong><span>Ghi nhận dịch vụ lúc {6}</span></div>{7}<div id=\"sys-section-content\" role=\"tabpanel\" aria-labelledby=\"sys-tab-{8}\" tabindex=\"0\">{9}</div></div>", heading, error, machineTabs, quickStats(machine), tabs, text(MACHINE_LABELS[machine.id]), clock(machine.inventory?.checkedAt), availability(machine), state.section, content);
}
