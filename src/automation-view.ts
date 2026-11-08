import { byMachineOrder, MACHINE_LABELS } from "../shared/types.ts";
import type { MachineId } from "../shared/types.ts";
import type { AutomationJob, AutomationReport, FigureKey, JobGroup, JobStatus, MachineAutomation } from "../shared/automation.ts";
import { escapeHtml } from "./markdown.ts";

const TIMEZONE = "Asia/Ho_Chi_Minh";
const STATUS_LABELS: Record<JobStatus, string> = { ok: "Ổn", warn: "Cần xem", error: "Lỗi", stale: "Quá hạn", missing: "Không có" };
const ATTENTION: JobStatus[] = ["error", "stale", "warn"];
const GROUPS: [JobGroup, string][] = [["sync", "Đồng bộ code"], ["update", "Cập nhật"], ["cleanup", "Dọn dẹp"]];
const MB_PER_GB = 1024;

export interface AutomationState {
  report: AutomationReport | null;
  loading: boolean;
  error: string;
  machine: MachineId | null;
  embedded?: boolean;
}

function text(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

function ago(value: string | null): string {
  if (!value) return "chưa có";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "vừa xong";
  if (minutes < 60) return `${minutes} phút trước`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} giờ trước`;
  return new Date(value).toLocaleString("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE });
}

function clock(value: string): string {
  return new Date(value).toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", timeZone: TIMEZONE });
}

function total(machines: MachineAutomation[], key: FigureKey): number {
  return machines.flatMap((machine) => machine.jobs).reduce((sum, job) => sum + (job.figures[key] ?? 0), 0);
}

function size(mb: number): string {
  return mb >= MB_PER_GB ? `${(mb / MB_PER_GB).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} GB` : `${mb.toLocaleString("vi-VN")} MB`;
}

function stats(machines: MachineAutomation[]): string {
  const jobs = machines.flatMap((machine) => machine.jobs).filter((job) => job.status !== "missing");
  const ok = jobs.filter((job) => job.status === "ok").length;
  const attention = jobs.length - ok;
  const cells: [string, string, string, string][] = [
    [`${ok}/${jobs.length}`, "Tác vụ đang ổn", attention ? "amber" : "green", `trên ${machines.filter((machine) => machine.reported).length} máy đã báo`],
    [String(attention), "Cần sếp xem", attention ? "amber" : "neutral", attention ? "lỗi, quá hạn hoặc cảnh báo" : "không có gì bất thường"],
    [total(machines, "pulled").toLocaleString("vi-VN"), "Lượt kéo code mới", "neutral", machines.length === 1 ? "hôm nay, máy đang chọn" : "hôm nay, mọi máy"],
    [total(machines, "updated").toLocaleString("vi-VN"), "Bản cập nhật đã cài", "neutral", "app, tool, skill hôm nay"],
    [size(total(machines, "reclaimedMb")), "Dung lượng đã dọn", "neutral", "cache hôm nay"],
  ];
  return `<div class="ops-stats au-stats">${cells.map(([value, label, tone, note]) => `<div data-tone="${tone}"><strong>${value}</strong><span>${label}</span><small>${note}</small></div>`).join("")}</div>`;
}

function pill(status: JobStatus): string {
  return `<span class="au-pill" data-status="${status}">${STATUS_LABELS[status]}</span>`;
}

function jobCard(job: AutomationJob): string {
  const details = job.details.length ? `<ul class="au-details">${job.details.map((line) => `<li>${text(line)}</li>`).join("")}</ul>` : "";
  const when = job.lastRun ? `<time datetime="${text(job.lastRun)}" title="${text(clock(job.lastRun))}">${text(job.lastRunLabel)} ${ago(job.lastRun)}</time>` : `<span>${text(job.lastRunLabel)}: chưa có</span>`;
  return `<article class="ops-card au-job" data-status="${job.status}"><div class="au-job-head"><h3>${text(job.name)}</h3>${pill(job.status)}</div><p class="au-meta"><span>${text(job.schedule)}</span><span aria-hidden="true">·</span>${when}</p><p class="au-summary">${text(job.summary)}</p>${details}</article>`;
}

function attentionRows(machine: MachineAutomation): AutomationJob[] {
  return machine.jobs.filter((job) => ATTENTION.includes(job.status)).sort((a, b) => ATTENTION.indexOf(a.status) - ATTENTION.indexOf(b.status));
}

function machineTone(machine: MachineAutomation): JobStatus {
  if (!machine.reported) return machine.online ? "stale" : "error";
  return ATTENTION.find((status) => machine.jobs.some((job) => job.status === status)) ?? "ok";
}

function machineTab(machine: MachineAutomation, active: boolean): string {
  const jobs = machine.jobs.filter((job) => job.status !== "missing");
  const ok = jobs.filter((job) => job.status === "ok").length;
  const attention = jobs.length - ok;
  const line = !machine.reported ? (machine.online ? "Chưa gửi trạng thái" : "Mất kết nối với hub") : `${ok}/${jobs.length} ổn${attention ? ` · ${attention} cần xem` : ""}`;
  return `<button type="button" class="au-machine" data-au-machine="${text(machine.id)}" data-status="${machineTone(machine)}" aria-pressed="${active}" data-key="au-machine:${text(machine.id)}"><span class="au-machine-head"><b>${text(MACHINE_LABELS[machine.id] ?? machine.id)}</b><span class="ops-led" data-state="${machine.online ? "working" : "offline"}" aria-hidden="true"></span></span><small>${text(machine.id)}</small><span class="au-machine-line">${text(line)}</span></button>`;
}

function machinePanel(machine: MachineAutomation, embedded = false): string {
  const status = machine.checkedAt ? `Đọc log lúc ${clock(machine.checkedAt)}` : "";
  const heading = embedded ? "" : `<h2>${text(MACHINE_LABELS[machine.id] ?? machine.id)} <span>${text(machine.id)}</span>${status ? `<small>${text(status)}</small>` : ""}</h2>`;
  if (!machine.reported) {
    const note = machine.online ? "Collector trên máy này chưa chạy bản mới nên chưa gửi trạng thái tác vụ. Cập nhật collector rồi chờ tối đa 5 phút." : "Máy đang mất kết nối với hub nên chưa đọc được log tác vụ.";
    return `<section class="ops-section au-panel">${heading}<p class="ops-muted">${note}</p></section>`;
  }
  const present = machine.jobs.filter((job) => job.status !== "missing");
  const missing = machine.jobs.filter((job) => job.status === "missing");
  const rows = attentionRows(machine);
  const attention = rows.length ? `<div class="au-group"><h3>Cần sếp xem <span>${rows.length}</span></h3><ul class="au-attention">${rows.map((job) => `<li>${pill(job.status)}<div><b>${text(job.name)}</b><small>${text(job.details.find((line) => /^Lỗi|^Đang chờ|^Nguồn lỗi|^Cảnh báo/.test(line)) ?? job.summary)}</small></div></li>`).join("")}</ul></div>` : "";
  const groups = GROUPS.map(([group, label]) => {
    const jobs = present.filter((job) => job.group === group);
    return jobs.length ? `<div class="au-group"><h3>${label} <span>${jobs.length}</span></h3><div class="ops-grid">${jobs.map(jobCard).join("")}</div></div>` : "";
  }).join("");
  const absent = missing.length ? `<p class="ops-muted au-absent">Không có trên máy này: ${missing.map((job) => text(job.name)).join(", ")}.</p>` : "";
  return `<section class="ops-section au-panel">${heading}${attention}${present.length ? groups : '<p class="ops-muted">Không tìm thấy log tác vụ nào trên máy này.</p>'}${absent}</section>`;
}

export function automationView(state: AutomationState): string {
  const heading = `<div class="ops-section-heading"><h2>Tác vụ tự động</h2><p>Báo cáo hằng ngày của đồng bộ repo, cập nhật app/tool/driver/skill và dọn cache trên từng máy. Số "hôm nay" tính từ 0 giờ Việt Nam; mỗi máy đọc lại log 5 phút một lần.</p></div>`;
  if (!state.report) return `${heading}<div class="ops-empty"><strong>${state.loading ? "Đang đọc trạng thái tác vụ" : "Chưa đọc được trạng thái tác vụ"}</strong><p>${text(state.error || "Hub gom log từ các máy qua collector.")}</p></div>`;
  const machines = [...state.report.machines].sort((a, b) => byMachineOrder(a.id, b.id));
  if (!machines.length) return `${heading}${stats(machines)}`;
  const selected = machines.find((machine) => machine.id === state.machine) ?? machines[0];
  if (state.embedded) return `<div class="sys-section-heading"><div><h2>Tác vụ định kỳ</h2><p>Đồng bộ, cập nhật và dọn dẹp · số hôm nay tính từ 0 giờ Việt Nam · đọc log mỗi 5 phút.</p></div></div>${state.error ? `<p class="ops-muted">${text(state.error)}</p>` : ""}${stats([selected])}${machinePanel(selected, true)}`;
  const tabs = `<div class="au-machines" role="group" aria-label="Chọn máy">${machines.map((machine) => machineTab(machine, machine === selected)).join("")}</div>`;
  return `${heading}${state.error ? `<p class="ops-muted">${text(state.error)}</p>` : ""}${stats(machines)}${tabs}${machinePanel(selected)}`;
}
