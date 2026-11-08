import { escapeHtml } from "./markdown.ts";
import "./charts.css";

export type Format = (value: number) => string;

export interface ColumnPoint {
  label: string;
  value: number;
  tip?: string;
}

export interface ColumnChartOptions {
  title: string;
  series: string;
  format: Format;
  overlay?: (number | null)[];
  overlayLabel?: string;
  height?: number;
  highlightLast?: boolean;
  maxLabels?: number;
}

export interface StackPoint {
  label: string;
  parts: number[];
}

export interface RankRow {
  label: string;
  value: number;
  note?: string;
  href?: string;
  icon?: string;
}

const SEQUENTIAL = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95"];
const ORDINAL = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab"];

function text(value: unknown): string {
  return escapeHtml(String(value ?? ""));
}

export function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trim(value / 1e9)} tỷ`;
  if (abs >= 1e6) return `${trim(value / 1e6)} tr`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return trim(value);
}

function trim(value: number): string {
  return value.toLocaleString("vi-VN", { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 });
}

export function vndCompact(value: number): string {
  return `${compactNumber(value)}₫`;
}

export function vndFull(value: number | null): string {
  return value === null ? "—" : `${Math.round(value).toLocaleString("vi-VN")}₫`;
}

export function percent(value: number | null, digits = 1): string {
  return value === null || !Number.isFinite(value) ? "—" : `${(value * 100).toLocaleString("vi-VN", { maximumFractionDigits: digits })}%`;
}

export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? magnitude * 10;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step * 0.001; tick += step) ticks.push(tick);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

function axis(ticks: number[], format: Format): string {
  const top = ticks[ticks.length - 1] || 1;
  return `<div class="viz-grid" aria-hidden="true">${ticks.map((tick) => `<span style="--y:${(tick / top) * 100}%"><em>${text(format(tick))}</em></span>`).join("")}</div>`;
}

function xLabels(labels: string[], max: number): string {
  const every = Math.max(1, Math.ceil(labels.length / max));
  const last = labels.length - 1;
  const shown = (index: number) => index === last || (index % every === 0 && last - index >= every);
  return `<div class="viz-x" aria-hidden="true" style="--n:${labels.length}">${labels.map((label, index) => `<span${shown(index) ? "" : " data-hide"}>${text(label)}</span>`).join("")}</div>`;
}

function legend(items: [string, string][]): string {
  return `<ul class="viz-legend">${items.map(([kind, label]) => `<li><i data-key="${kind}" aria-hidden="true"></i>${text(label)}</li>`).join("")}</ul>`;
}

function tableView(head: string[], rows: string[][]): string {
  return `<details class="viz-table"><summary>Xem bảng số</summary><div class="ops-table-scroll"><table class="ops-table"><thead><tr>${head.map((cell, index) => `<th${index ? ' class="ops-num"' : ""}>${text(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<td${index ? ' class="ops-num"' : ""}>${text(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
}

function linePath(values: (number | null)[], top: number): string {
  const n = values.length;
  let path = "";
  let drawing = false;
  values.forEach((value, index) => {
    if (value === null) { drawing = false; return; }
    const x = ((index + 0.5) / n) * 100;
    const y = 100 - (value / top) * 100;
    path += `${drawing ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)} `;
    drawing = true;
  });
  return path.trim();
}

export function columnChart(points: ColumnPoint[], options: ColumnChartOptions): string {
  if (!points.length) return `<p class="ops-muted">Chưa có số liệu.</p>`;
  const overlay = options.overlay ?? [];
  const peak = Math.max(1, ...points.map((point) => point.value), ...overlay.map((value) => value ?? 0));
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1];
  const columns = points.map((point, index) => {
    const height = point.value ? Math.max(1, (point.value / top) * 100) : 0;
    const extra = overlay[index] !== null && overlay[index] !== undefined ? ` · ${options.overlayLabel}: ${options.format(overlay[index]!)}` : "";
    const tip = point.tip ?? `${point.label}: ${options.format(point.value)}${extra}`;
    const current = options.highlightLast && index === points.length - 1 ? " data-current" : "";
    return `<span class="viz-col" data-tip="${text(tip)}"${current}><b style="--h:${height}%"></b></span>`;
  }).join("");
  const line = overlay.some((value) => value !== null) ? `<svg class="viz-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${linePath(overlay, top)}" vector-effect="non-scaling-stroke"/></svg>` : "";
  const keys: [string, string][] = line ? [["bar", options.series], ["line", options.overlayLabel ?? ""]] : [];
  const rows = points.map((point, index) => [point.label, options.format(point.value), ...(line ? [overlay[index] === null || overlay[index] === undefined ? "—" : options.format(overlay[index]!)] : [])]);
  return `<figure class="viz" role="img" aria-label="${text(options.title)}">${keys.length ? legend(keys) : ""}<div class="viz-plot" style="--height:${options.height ?? 12}rem">${axis(ticks, compactNumber)}<div class="viz-cols" style="--n:${points.length}">${columns}</div>${line}</div>${xLabels(points.map((point) => point.label), options.maxLabels ?? 8)}${tableView(["Kỳ", options.series, ...(line ? [options.overlayLabel ?? ""] : [])], rows)}</figure>`;
}

function swatchLegend(items: { label: string; color: string }[]): string {
  return `<ul class="viz-legend">${items.map((item) => `<li><i style="background:${item.color}" aria-hidden="true"></i>${text(item.label)}</li>`).join("")}</ul>`;
}

function segmentStyle(index: number, height: number, colors?: string[]): string {
  return colors ? ` style="--h:${height}%;background:${colors[index]}"` : ` data-slot="${index + 1}" style="--h:${height}%"`;
}

export function stackedColumns(points: StackPoint[], series: string[], title: string, format: Format, colors?: string[]): string {
  if (!points.length) return `<p class="ops-muted">Chưa có số liệu.</p>`;
  const peak = Math.max(1, ...points.map((point) => point.parts.reduce((sum, part) => sum + part, 0)));
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1];
  const columns = points.map((point) => {
    const total = point.parts.reduce((sum, part) => sum + part, 0);
    const tip = `${point.label}: ${series.map((name, index) => `${name} ${format(point.parts[index])}`).join(" · ")} · Tổng ${format(total)}`;
    const segments = point.parts.map((part, index) => (part ? `<b${segmentStyle(index, (part / top) * 100, colors)}></b>` : "")).join("");
    return `<span class="viz-col viz-stack" data-tip="${text(tip)}">${segments}</span>`;
  }).join("");
  const rows = points.map((point) => [point.label, ...point.parts.map(format), format(point.parts.reduce((sum, part) => sum + part, 0))]);
  const keys = colors ? swatchLegend(series.map((label, index) => ({ label, color: colors[index] }))) : legend(series.map((name, index) => [`slot${index + 1}`, name]));
  return `<figure class="viz" role="img" aria-label="${text(title)}">${keys}<div class="viz-plot" style="--height:12rem">${axis(ticks, compactNumber)}<div class="viz-cols" style="--n:${points.length}">${columns}</div></div>${xLabels(points.map((point) => point.label), 12)}${tableView(["Kỳ", ...series, "Tổng"], rows)}</figure>`;
}

export function groupedColumns(points: StackPoint[], series: string[], title: string, format: Format, colors: string[]): string {
  if (!points.length) return `<p class="ops-muted">Chưa có số liệu.</p>`;
  const peak = Math.max(1, ...points.flatMap((point) => point.parts));
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1];
  const columns = points.map((point) => {
    const tip = `${point.label}: ${series.map((name, index) => `${name} ${format(point.parts[index])}`).join(" · ")}`;
    const bars = point.parts.map((part, index) => `<b style="--h:${part ? Math.max(1, (part / top) * 100) : 0}%;background:${colors[index]}"></b>`).join("");
    return `<span class="viz-col viz-group" data-tip="${text(tip)}" style="--k:${series.length}">${bars}</span>`;
  }).join("");
  const rows = points.map((point) => [point.label, ...point.parts.map(format)]);
  return `<figure class="viz" role="img" aria-label="${text(title)}">${swatchLegend(series.map((label, index) => ({ label, color: colors[index] })))}<div class="viz-plot" style="--height:12rem">${axis(ticks, compactNumber)}<div class="viz-cols" style="--n:${points.length}">${columns}</div></div>${xLabels(points.map((point) => point.label), 12)}${tableView(["Kỳ", ...series], rows)}</figure>`;
}

export interface DonutPart {
  label: string;
  value: number;
  color: string;
}

export interface DonutOptions {
  title: string;
  center: string;
  caption: string;
  format: Format;
  empty?: string;
}

export function donut(parts: DonutPart[], options: DonutOptions): string {
  const visible = parts.filter((part) => part.value > 0);
  const total = visible.reduce((sum, part) => sum + part.value, 0);
  if (!total) return `<p class="ops-muted">${text(options.empty ?? "Chưa có số liệu.")}</p>`;
  const gap = visible.length > 1 ? 0.6 : 0;
  let offset = 0;
  const arcs = visible.map((part) => {
    const share = (part.value / total) * 100;
    const arc = `<circle class="viz-arc" cx="21" cy="21" r="15.9155" pathLength="100" stroke="${part.color}" stroke-dasharray="${Math.max(0, share - gap).toFixed(3)} ${(100 - Math.max(0, share - gap)).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}" data-tip="${text(`${part.label}: ${options.format(part.value)} · ${percent(part.value / total)}`)}"/>`;
    offset += share;
    return arc;
  }).join("");
  const items = visible.map((part) => `<li><i style="background:${part.color}" aria-hidden="true"></i><span class="viz-donut-label">${text(part.label)}</span><strong>${percent(part.value / total)}</strong><small>${text(options.format(part.value))}</small></li>`).join("");
  return `<figure class="viz viz-donut"><figcaption class="pw-sr">${text(`${options.title}: tổng ${options.center} ${options.caption}`)}</figcaption><div class="viz-donut-ring" aria-hidden="true"><svg viewBox="0 0 42 42"><circle class="viz-arc-track" cx="21" cy="21" r="15.9155"/>${arcs}</svg><span class="viz-donut-center"><strong>${text(options.center)}</strong><small>${text(options.caption)}</small></span></div><ul class="viz-donut-legend">${items}</ul></figure>`;
}

export type Tone = "blue" | "green" | "violet" | "amber" | "red" | "teal";

export interface KpiDelta {
  value: string;
  versus: string;
  tone: "up" | "down" | "flat";
}

export interface KpiCard {
  label: string;
  value: string;
  icon: string;
  tone: Tone;
  hint?: string;
  delta?: KpiDelta;
  note?: string;
  spark?: number[];
}

function areaSpark(values: number[]): string {
  if (values.length < 2 || !values.some((value) => value > 0)) return `<span class="kpi-spark" aria-hidden="true"></span>`;
  const max = Math.max(...values);
  const step = 100 / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(30 - (value / max) * 26 - 2).toFixed(2)}`);
  return `<svg class="kpi-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polygon points="0,30 ${points.join(" ")} 100,30"/><polyline points="${points.join(" ")}" vector-effect="non-scaling-stroke"/></svg>`;
}

export function kpiCards(cards: KpiCard[]): string {
  return `<div class="kpi-cards" data-count="${cards.length}">${cards.map((card) => {
    const hint = card.hint ? `<button type="button" class="kpi-hint" aria-label="Giải thích ${text(card.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg><span class="kpi-tip" role="tooltip">${text(card.hint)}</span></button>` : "";
    const delta = card.delta ? `<p class="kpi-delta" data-tone="${card.delta.tone}"><b>${text(card.delta.value)}</b> ${text(card.delta.versus)}</p>` : "";
    const note = card.note ? `<p class="kpi-note">${text(card.note)}</p>` : "";
    return `<article class="kpi-card" data-tone="${card.tone}"><header><span class="kpi-icon">${card.icon}</span><h3>${text(card.label)}</h3>${hint}</header><strong class="kpi-value" title="${text(card.value)}">${text(card.value)}</strong>${delta}${note}${card.spark ? areaSpark(card.spark) : ""}</article>`;
  }).join("")}</div>`;
}

export function heatmap(matrix: number[][], rows: string[], columns: string[], title: string, unit: string): string {
  const max = Math.max(0, ...matrix.flat());
  if (!max) return `<p class="ops-muted">Chưa đủ đơn để vẽ bản đồ nhiệt.</p>`;
  const cells = matrix.map((row, r) => `<span class="viz-heat-row">${text(rows[r])}</span>${row.map((value, c) => {
    const step = value ? Math.min(SEQUENTIAL.length - 1, Math.floor((value / max) * (SEQUENTIAL.length - 1))) : -1;
    return `<span class="viz-cell" data-tip="${text(`${rows[r]} ${columns[c]}: ${value} ${unit}`)}"${step < 0 ? " data-empty" : ` style="--c:${SEQUENTIAL[step]}"`}></span>`;
  }).join("")}`).join("");
  const head = `<span></span>${columns.map((label, index) => `<span class="viz-heat-col"${index % 3 ? " data-hide" : ""}>${text(label)}</span>`).join("")}`;
  const ramp = `<div class="viz-ramp" aria-hidden="true"><span>0</span><i style="background:linear-gradient(to right,${SEQUENTIAL.join(",")})"></i><span>${max} ${text(unit)}</span></div>`;
  return `<figure class="viz" role="img" aria-label="${text(title)}"><div class="viz-heat" style="--cols:${columns.length}">${head}${cells}</div>${ramp}${tableView(["", ...columns], matrix.map((row, r) => [rows[r], ...row.map(String)]))}</figure>`;
}

export function rankBars(rows: RankRow[], format: Format, empty = "Chưa có số liệu."): string {
  if (!rows.length) return `<p class="ops-muted">${text(empty)}</p>`;
  const max = Math.max(1, ...rows.map((row) => row.value));
  return `<ol class="viz-rank">${rows.map((row) => `<li data-tip="${text(`${row.label}: ${format(row.value)}${row.note ? ` · ${row.note}` : ""}`)}"><span class="viz-rank-head"><span class="viz-rank-label" title="${text(row.label)}">${row.icon ?? ""}${text(row.label)}</span><span class="viz-rank-value">${text(format(row.value))}${row.note ? `<small>${text(row.note)}</small>` : ""}</span></span><span class="viz-rank-bar" aria-hidden="true"><b style="--w:${(row.value / max) * 100}%"></b></span></li>`).join("")}</ol>`;
}

export function funnel(steps: { label: string; value: number | null }[], title: string): string {
  const max = Math.max(1, ...steps.map((step) => step.value ?? 0));
  return `<figure class="viz" role="img" aria-label="${text(title)}"><ol class="viz-funnel">${steps.map((step, index) => {
    const previous = index ? steps[index - 1].value : null;
    const rate = step.value !== null && previous ? step.value / previous : null;
    return `<li data-tip="${text(`${step.label}: ${step.value ?? "—"}${rate !== null ? ` · ${percent(rate)} so với bước trước` : ""}`)}"><span class="viz-funnel-label">${text(step.label)}</span><span class="viz-funnel-value">${step.value === null ? "—" : step.value.toLocaleString("vi-VN")}<small>${index ? `${percent(rate)} so với bước trước` : "điểm bắt đầu"}</small></span><span class="viz-funnel-bar"><b style="--w:${((step.value ?? 0) / max) * 100}%;--c:${ORDINAL[Math.min(index, ORDINAL.length - 1)]}"></b></span></li>`;
  }).join("")}</ol></figure>`;
}

export function shareBar(parts: { label: string; value: number }[], title: string, format: Format): string {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (!total) return `<p class="ops-muted">Chưa có số liệu.</p>`;
  const visible = parts.filter((part) => part.value > 0);
  return `<figure class="viz" role="img" aria-label="${text(title)}"><div class="viz-share">${visible.map((part, index) => `<b data-slot="${Math.min(index + 1, 3)}" data-tip="${text(`${part.label}: ${format(part.value)} · ${percent(part.value / total)}`)}" style="flex:${part.value}"></b>`).join("")}</div><ul class="viz-legend">${visible.map((part, index) => `<li><i data-key="slot${Math.min(index + 1, 3)}" aria-hidden="true"></i>${text(part.label)} <strong>${percent(part.value / total, 0)}</strong></li>`).join("")}</ul></figure>`;
}

export function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const max = Math.max(1, ...values);
  const step = 100 / (values.length - 1);
  const points = values.map((value, index) => `${(index * step).toFixed(2)},${(30 - (value / max) * 28 - 1).toFixed(2)}`).join(" ");
  return `<svg class="viz-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}" vector-effect="non-scaling-stroke"/></svg>`;
}

export interface StatTile {
  value: string;
  label: string;
  note?: string;
  tone?: "up" | "down" | "flat";
  spark?: number[];
}

export function statTiles(tiles: StatTile[]): string {
  return `<div class="ops-stats viz-stats">${tiles.map((tile) => `<div><strong title="${text(tile.value)}">${text(tile.value)}</strong><span>${text(tile.label)}</span>${tile.note ? `<small class="tr-delta" data-tone="${tile.tone ?? "flat"}">${text(tile.note)}</small>` : ""}${tile.spark ? sparkline(tile.spark) : ""}</div>`).join("")}</div>`;
}

export function deltaNote(change: number | null, versus: string): { note: string; tone: "up" | "down" | "flat" } {
  if (change === null) return { note: `chưa có số ${versus} để so`, tone: "flat" };
  const rounded = Math.round(change * 100);
  if (!rounded) return { note: `không đổi so với ${versus}`, tone: "flat" };
  return { note: `${rounded > 0 ? "▲" : "▼"} ${Math.abs(rounded)}% so với ${versus}`, tone: rounded > 0 ? "up" : "down" };
}

export function attachTooltip(root: HTMLElement): void {
  const tip = document.createElement("div");
  tip.className = "viz-tip";
  tip.setAttribute("role", "tooltip");
  tip.hidden = true;
  root.append(tip);
  let current: HTMLElement | null = null;
  root.addEventListener("pointermove", (event) => {
    const target = (event.target as Element).closest<HTMLElement>("[data-tip]");
    if (!target || !root.contains(target)) {
      tip.hidden = true;
      current?.removeAttribute("data-hover");
      current = null;
      return;
    }
    if (target !== current) {
      current?.removeAttribute("data-hover");
      current = target;
      target.setAttribute("data-hover", "");
      tip.textContent = target.dataset.tip ?? "";
    }
    tip.hidden = false;
    const x = Math.min(event.clientX + 12, innerWidth - tip.offsetWidth - 8);
    const y = event.clientY - tip.offsetHeight - 12;
    tip.style.translate = `${Math.max(8, x)}px ${y < 8 ? event.clientY + 16 : y}px`;
  });
  root.addEventListener("pointerleave", () => {
    tip.hidden = true;
    current?.removeAttribute("data-hover");
    current = null;
  });
}
