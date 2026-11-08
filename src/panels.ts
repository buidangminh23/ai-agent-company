import { L, locale } from "../shared/i18n.ts";
import type { Snapshot } from "../shared/types.ts";
import type { CanvasPanel } from "./scene/labels.ts";
import type { Panels } from "./scene/build.ts";
import type { MeetingBoard } from "./meeting.ts";

const NAVY = "#071833";
const LINE = "rgba(120,170,255,0.22)";
const WHITE = "#f2f6fc";
const MUTED = "#8fa6c6";
const BLUE = "#2f8bff";
const GREEN = "#39d97a";
const RED = "#ff5a5a";
const AMBER = "#ffb547";
const FONT = "Inter, Segoe UI, sans-serif";

const APP_DOT: Record<string, string> = { claude: "#d97757", codex: "#6b72ff", antigravity: "#4285f4" };

function font(g: CanvasRenderingContext2D, weight: number, size: number): void {
  g.font = `${weight} ${size}px ${FONT}`;
}

function clipText(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function notConnected(g: CanvasRenderingContext2D, x: number, y: number, note: string, maxWidth = Infinity): void {
  g.fillStyle = AMBER;
  font(g, 700, 26);
  g.fillText(L("Chưa nối nguồn"), x, y);
  g.fillStyle = MUTED;
  font(g, 500, 21);
  g.fillText(clipText(g, note, maxWidth), x, y + 34);
}

export const QUOTA_APPS = ["claude", "codex", "antigravity"] as const;

function ledStat(g: CanvasRenderingContext2D, x: number, y: number, value: string, label: string, color: string): void {
  g.textAlign = "center";
  g.fillStyle = color;
  font(g, 800, 92);
  g.fillText(value, x, y);
  g.fillStyle = MUTED;
  font(g, 600, 26);
  g.fillText(label, x, y + 44);
}

export function drawLed(p: CanvasPanel, snap: Snapshot | null = null): void {
  const g = p.ctx;
  const W = p.width;
  const H = p.height;
  g.fillStyle = "#020409";
  g.fillRect(0, 0, W, H);
  g.fillStyle = WHITE;
  g.textAlign = "center";
  font(g, 800, 42);
  g.fillText("AI AGENT COMPANY", W / 2, H * 0.17);
  if (!snap) {
    g.fillStyle = MUTED;
    font(g, 600, 28);
    g.fillText(L("Đang nối hub…"), W / 2, H * 0.55);
    p.commit();
    return;
  }
  const waiting = snap.agents.filter((agent) => agent.state === "waiting").length;
  const row = H * 0.56;
  ledStat(g, W * 0.17, row, String(snap.activity.agentsWorking), L("agent đang làm"), GREEN);
  ledStat(g, W * 0.39, row, String(waiting), L("chờ duyệt"), waiting ? AMBER : MUTED);
  ledStat(g, W * 0.61, row, `${snap.activity.machinesOnline}/${snap.activity.machinesTotal}`, L("máy online"), snap.activity.machinesOnline ? BLUE : RED);
  ledStat(g, W * 0.83, row, String(snap.activity.tasksToday), L("lượt hôm nay"), WHITE);
  g.fillStyle = MUTED;
  font(g, 500, 22);
  g.fillText(L("Cập nhật {0}", new Date(snap.generatedAt).toLocaleTimeString(locale())), W / 2, H * 0.9);
  p.commit();
}

function header(g: CanvasRenderingContext2D, W: number, title: string): void {
  g.fillStyle = NAVY;
  g.fillRect(0, 0, W, 1000);
  g.fillStyle = WHITE;
  g.textAlign = "left";
  font(g, 800, 30);
  g.fillText(title, 24, 46);
}

function dot(g: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  g.fillStyle = color;
  g.beginPath();
  g.arc(x, y, 9, 0, Math.PI * 2);
  g.fill();
}

function headerNote(g: CanvasRenderingContext2D, W: number, text: string): void {
  g.fillStyle = MUTED;
  font(g, 600, 20);
  g.textAlign = "right";
  g.fillText(text, W - 28, 44);
  g.textAlign = "left";
}

function columnTitles(g: CanvasRenderingContext2D, y: number, cols: [string, number][]): void {
  g.fillStyle = MUTED;
  font(g, 600, 17);
  g.textAlign = "left";
  for (const [label, x] of cols) g.fillText(label, x, y);
}

const ROW_STEP = 52;
const ROW_TOP = 132;

function machineDetail(m: Snapshot["machines"][number]): { cpu: string; ram: string; up: string } | null {
  if (!m.online || !m.memTotal) return null;
  const gb = (v: number) => (v / 2 ** 30).toFixed(1);
  return { cpu: `${m.cpu}%`, ram: `${gb(m.memUsed!)}/${(m.memTotal / 2 ** 30).toFixed(0)} GB`, up: `${Math.floor((m.uptimeSec ?? 0) / 3600)}g` };
}

function drawSites(g: CanvasRenderingContext2D, snap: Snapshot, x: number): void {
  columnTitles(g, 88, [["Website", x], [L("Mã"), x + 360], [L("Phản hồi"), x + 450]]);
  snap.sites.forEach((s, i) => {
    const y = ROW_TOP + i * ROW_STEP;
    dot(g, x + 9, y - 8, s.ok ? GREEN : RED);
    g.fillStyle = WHITE;
    font(g, 700, 24);
    g.fillText(clipText(g, s.label, 320), x + 30, y);
    g.fillStyle = s.ok ? GREEN : RED;
    g.fillText(String(s.status ?? "—"), x + 360, y);
    g.fillStyle = s.ok ? MUTED : RED;
    font(g, 500, 20);
    g.fillText(clipText(g, s.ok ? `${s.latencyMs ?? "—"} ms` : s.note, 220), x + 450, y);
  });
}

function drawMachineRows(g: CanvasRenderingContext2D, snap: Snapshot, x: number): void {
  columnTitles(g, 88, [[L("Máy"), x], ["CPU", x + 330], ["RAM", x + 430], [L("Chạy"), x + 600]]);
  snap.machines.forEach((m, i) => {
    const y = ROW_TOP + i * ROW_STEP;
    const d = machineDetail(m);
    dot(g, x + 9, y - 8, m.online ? GREEN : RED);
    g.fillStyle = WHITE;
    font(g, 700, 24);
    g.fillText(clipText(g, m.id, 290), x + 30, y);
    if (!d) {
      g.fillStyle = m.source === "none" ? MUTED : RED;
      font(g, 500, 20);
      g.fillText(m.source === "none" ? L("Chưa cài collector") : L("Mất kết nối"), x + 330, y);
      return;
    }
    g.fillStyle = GREEN;
    g.fillText(d.cpu, x + 330, y);
    g.fillStyle = MUTED;
    font(g, 500, 20);
    g.fillText(d.ram, x + 430, y);
    g.fillText(d.up, x + 600, y);
  });
}

export function drawServerWall(p: CanvasPanel, snap: Snapshot): void {
  const g = p.ctx;
  const W = p.width;
  header(g, W, L("TRẠNG THÁI HỆ THỐNG"));
  const sitesOk = snap.sites.filter((s) => s.ok).length;
  const online = snap.machines.filter((m) => m.online).length;
  headerNote(g, W, L("{0}/{1} web ổn · {2}/{3} máy online", sitesOk, snap.sites.length, online, snap.machines.length));
  const mid = Math.round(W * 0.47);
  g.fillStyle = LINE;
  g.fillRect(mid, 70, 2, p.height - 100);
  drawSites(g, snap, 28);
  drawMachineRows(g, snap, mid + 36);
  g.fillStyle = MUTED;
  font(g, 500, 18);
  g.fillText(L("Cập nhật {0}", new Date(snap.generatedAt).toLocaleTimeString(locale())), 28, p.height - 24);
  p.commit();
}

const RECEPTION_ROW_TOP = 96;
const RECEPTION_ROW_STEP = 108;
const RECEPTION_LATENCY_X = 1412;

function receptionRow(g: CanvasRenderingContext2D, site: Snapshot["sites"][number], y: number, W: number): void {
  g.textAlign = "left";
  g.fillStyle = WHITE;
  font(g, 800, 48);
  g.fillText(clipText(g, site.label, 520), 28, y + 56);
  g.fillStyle = site.ok ? GREEN : RED;
  font(g, 800, 40);
  g.fillText(site.ok ? L("Hoạt động") : L("Có lỗi"), 560, y + 46);
  g.fillStyle = MUTED;
  font(g, 500, 22);
  g.fillText(clipText(g, site.ok ? `HTTP ${site.status ?? "—"}` : site.note, W - 1000), 560, y + 80);
  if (!site.ok) return;
  g.textAlign = "right";
  g.fillStyle = GREEN;
  font(g, 800, 60);
  g.fillText(`${site.latencyMs ?? "—"}`, RECEPTION_LATENCY_X, y + 52);
  g.fillStyle = MUTED;
  font(g, 600, 22);
  g.fillText(L("ms phản hồi"), RECEPTION_LATENCY_X, y + 84);
}

export function drawReception(p: CanvasPanel, snap: Snapshot): void {
  const g = p.ctx;
  g.fillStyle = NAVY;
  g.fillRect(0, 0, p.width, p.height);
  g.fillStyle = WHITE;
  g.textAlign = "left";
  font(g, 800, 40);
  g.fillText(L("TRẠNG THÁI WEB"), 28, 56);
  if (!snap.sites.length) {
    g.fillStyle = MUTED;
    font(g, 600, 30);
    g.fillText(L("Chưa cấu hình web nào. Đặt MSC_SITES trong .env của hub."), 28, RECEPTION_ROW_TOP + 56);
  }
  snap.sites.slice(0, 3).forEach((site, i) => {
    const y = RECEPTION_ROW_TOP + i * RECEPTION_ROW_STEP;
    if (i) {
      g.fillStyle = LINE;
      g.fillRect(28, y - 6, p.width - 56, 2);
    }
    receptionRow(g, site, y, p.width);
  });
  p.commit();
}

const STATE_COLOR: Record<string, string> = {
  success: GREEN,
  failure: RED,
  error: RED,
  pending: AMBER,
  in_progress: AMBER,
  queued: AMBER,
  inactive: MUTED,
  expected: AMBER,
};

function stateDot(g: CanvasRenderingContext2D, x: number, y: number, state: string | null): void {
  g.fillStyle = state ? STATE_COLOR[state] ?? MUTED : "rgba(143,166,198,0.35)";
  g.beginPath();
  g.arc(x, y, 9, 0, Math.PI * 2);
  g.fill();
}

function agentsByProject(snap: Snapshot): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of snap.agents) {
    if (a.state === "idle") continue;
    const key = a.project.toLowerCase();
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

function wrapLines(g: CanvasRenderingContext2D, text: string, max: number, limit: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width <= max || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit - 1), clipText(g, lines.slice(limit - 1).join(" "), max)];
}

function drawAgenda(p: CanvasPanel, board: MeetingBoard): void {
  const g = p.ctx;
  header(g, p.width, board.kind === "project" ? L("KHỞI ĐỘNG DỰ ÁN") : L("HỌP GIAO VIỆC"));
  headerNote(g, p.width, board.step);
  g.fillStyle = AMBER;
  font(g, 800, 40);
  g.fillText(clipText(g, board.project, p.width - 56), 28, 116);
  g.fillStyle = MUTED;
  font(g, 600, 18);
  g.fillText(L("NỘI DUNG SẾP GIAO"), 28, 160);
  g.fillStyle = WHITE;
  font(g, 600, 28);
  wrapLines(g, board.title, p.width - 56, 4).forEach((line, i) => g.fillText(line, 28, 200 + i * 40));
  g.fillStyle = GREEN;
  font(g, 600, 19);
  g.fillText(L("Sếp chủ trì · {0} người dự họp", board.people), 28, p.height - 24);
  p.commit();
}

export function drawMeeting(p: CanvasPanel, snap: Snapshot, board: MeetingBoard | null = null): void {
  if (board) {
    drawAgenda(p, board);
    return;
  }
  const g = p.ctx;
  header(g, p.width, L("BẢNG DỰ ÁN"));
  g.textAlign = "left";
  if (!snap.projects.connected) {
    notConnected(g, 28, 110, snap.projects.note);
    p.commit();
    return;
  }
  const working = agentsByProject(snap);
  g.fillStyle = MUTED;
  font(g, 600, 18);
  g.fillText("Deploy", 640, 82);
  g.fillText("CI", 780, 82);
  g.fillText("Agent", 880, 82);
  const repos = snap.projects.repos.filter((r) => !r.isArchived).slice(0, 6);
  repos.forEach((r, i) => {
    const y = 120 + i * 50;
    g.fillStyle = WHITE;
    font(g, 700, 24);
    g.textAlign = "left";
    g.fillText(clipText(g, r.name, 440), 28, y);
    g.fillStyle = MUTED;
    font(g, 500, 18);
    g.fillText(r.pushedAt.slice(0, 10), 480, y);
    stateDot(g, 660, y - 8, r.deploy?.state ?? null);
    stateDot(g, 790, y - 8, r.ci);
    const n = working.get(r.name.toLowerCase()) ?? 0;
    g.fillStyle = n ? GREEN : MUTED;
    font(g, 700, 22);
    g.fillText(String(n), 890, y);
  });
  p.commit();
}

export function drawTraining(p: CanvasPanel, snap: Snapshot): void {
  const g = p.ctx;
  header(g, p.width, L("THƯ VIỆN SKILL"));
  g.textAlign = "left";
  if (!snap.skills.connected) {
    notConnected(g, 28, 110, snap.skills.note);
    p.commit();
    return;
  }
  const total = snap.skills.total;
  headerNote(g, p.width, `${total.toLocaleString(locale())} skill`);
  columnTitles(g, 88, [[L("Nguồn"), 28], [L("Số skill"), 440], [L("Tỉ lệ"), 640]]);
  snap.skills.groups.slice(0, 4).forEach((grp, i) => {
    const y = ROW_TOP + i * ROW_STEP;
    const share = total ? grp.count / total : 0;
    dot(g, 37, y - 8, APP_DOT[grp.source.toLowerCase()] ?? BLUE);
    g.fillStyle = WHITE;
    font(g, 700, 24);
    g.fillText(clipText(g, grp.source, 380), 58, y);
    g.fillStyle = GREEN;
    g.fillText(grp.count.toLocaleString(locale()), 440, y);
    g.fillStyle = MUTED;
    font(g, 500, 20);
    g.fillText(`${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`, 640, y);
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.fillRect(740, y - 14, 220, 10);
    g.fillStyle = APP_DOT[grp.source.toLowerCase()] ?? BLUE;
    g.fillRect(740, y - 14, Math.max(4, 220 * share), 10);
  });
  g.fillStyle = MUTED;
  font(g, 500, 18);
  g.fillText(L("{0} nguồn · trên máy hub", snap.skills.groups.length), 28, p.height - 24);
  p.commit();
}

export function drawStorage(p: CanvasPanel, snap: Snapshot): void {
  const g = p.ctx;
  header(g, p.width, L("BẢN PHÁT HÀNH"));
  g.textAlign = "left";
  if (!snap.projects.connected) {
    notConnected(g, 28, 110, snap.projects.note);
    p.commit();
    return;
  }
  const releases = snap.projects.repos
    .filter((r) => r.release)
    .sort((a, b) => b.release!.publishedAt.localeCompare(a.release!.publishedAt))
    .slice(0, 5);
  if (!releases.length) {
    g.fillStyle = MUTED;
    font(g, 500, 22);
    g.fillText(L("Chưa có bản phát hành"), 28, 110);
  }
  releases.forEach((r, i) => {
    const y = 104 + i * 46;
    g.fillStyle = WHITE;
    font(g, 700, 22);
    g.fillText(clipText(g, r.name, 400), 28, y);
    g.fillStyle = GREEN;
    font(g, 700, 22);
    g.fillText(r.release!.tag, 440, y);
    g.fillStyle = MUTED;
    font(g, 500, 18);
    g.fillText(r.release!.publishedAt.slice(0, 10), 640, y);
  });
  const archived = snap.projects.repos.filter((r) => r.isArchived).length;
  g.fillStyle = MUTED;
  font(g, 500, 18);
  g.fillText(L("{0} repo · {1} đã lưu trữ", snap.projects.repos.length, archived), 28, p.height - 24);
  p.commit();
}

export function drawAll(panels: Panels, snap: Snapshot): void {
  drawLed(panels.led, snap);
  drawServerWall(panels.serverWall, snap);
  drawReception(panels.reception, snap);
  drawMeeting(panels.meeting, snap);
  drawTraining(panels.training, snap);
  drawStorage(panels.storage, snap);
  drawMachines(panels, snap);
}

const HISTORY_LEN = 60;
const history = new Map<string, { cpu: number[]; rx: number[]; tx: number[]; at: string }>();

function pushHistory(m: Snapshot["machines"][number]): { cpu: number[]; rx: number[]; tx: number[] } {
  const h = history.get(m.id) ?? { cpu: [], rx: [], tx: [], at: "" };
  if (m.online && h.at !== m.checkedAt) {
    h.at = m.checkedAt;
    h.cpu.push(m.cpu ?? 0);
    h.rx.push(m.netRxBps ?? 0);
    h.tx.push(m.netTxBps ?? 0);
    for (const arr of [h.cpu, h.rx, h.tx]) if (arr.length > HISTORY_LEN) arr.shift();
  }
  history.set(m.id, h);
  return h;
}

function gb(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(bytes >= 100 * 2 ** 30 ? 0 : 1);
}

function rate(bps: number | null): string {
  if (bps === null) return "—";
  const mbit = (bps * 8) / 1e6;
  return mbit >= 1 ? `${mbit.toFixed(1)} Mb/s` : `${((bps * 8) / 1e3).toFixed(0)} kb/s`;
}

function meter(g: CanvasRenderingContext2D, label: string, value: string, ratio: number, y: number, W: number): void {
  g.textAlign = "left";
  g.fillStyle = MUTED;
  font(g, 600, 22);
  g.fillText(label, 28, y);
  g.textAlign = "right";
  g.fillStyle = WHITE;
  font(g, 700, 22);
  g.fillText(value, W - 28, y);
  const r = Math.max(0, Math.min(1, ratio));
  g.fillStyle = "rgba(255,255,255,0.08)";
  g.fillRect(28, y + 10, W - 56, 12);
  g.fillStyle = r > 0.85 ? RED : r > 0.6 ? AMBER : BLUE;
  g.fillRect(28, y + 10, (W - 56) * r, 12);
}

function spark(g: CanvasRenderingContext2D, data: number[], x: number, y: number, w: number, h: number, color: string, max?: number): void {
  if (data.length < 2) return;
  const top = max ?? Math.max(...data, 1);
  g.strokeStyle = color;
  g.lineWidth = 3;
  g.beginPath();
  data.forEach((v, i) => {
    const px = x + (w * i) / (HISTORY_LEN - 1);
    const py = y + h - (h * Math.min(v, top)) / top;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  });
  g.stroke();
}

function drawMachine(p: CanvasPanel, m: Snapshot["machines"][number], accent: string): void {
  const g = p.ctx;
  const { width: W, height: H } = p;
  const h = pushHistory(m);
  g.fillStyle = NAVY;
  g.fillRect(0, 0, W, H);
  g.fillStyle = accent;
  g.fillRect(0, 0, W, 8);
  g.textAlign = "left";
  g.fillStyle = m.online ? GREEN : RED;
  g.beginPath();
  g.arc(36, 52, 11, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = WHITE;
  font(g, 800, 34);
  g.fillText(m.id, 58, 64);
  g.fillStyle = MUTED;
  font(g, 500, 19);
  g.fillText(clipText(g, [m.os, m.cpuModel && L("{0} · {1} luồng", m.cpuModel, m.cores)].filter(Boolean).join(" · ") || "", W - 56), 28, 98);
  if (!m.online) {
    g.fillStyle = AMBER;
    font(g, 700, 30);
    g.fillText(m.source === "none" ? L("Chưa cài collector") : L("Mất kết nối collector"), 28, 200);
    g.fillStyle = MUTED;
    font(g, 500, 21);
    g.fillText(L("Giai đoạn 2: chạy hub ở chế độ collector trên máy này qua Tailscale"), 28, 240);
    p.commit();
    return;
  }
  meter(g, "CPU", `${m.cpu}%`, (m.cpu ?? 0) / 100, 150, W);
  spark(g, h.cpu, 28, 180, W - 56, 50, BLUE, 100);
  meter(g, "RAM", `${gb(m.memUsed ?? 0)} / ${gb(m.memTotal ?? 1)} GB`, (m.memUsed ?? 0) / (m.memTotal ?? 1), 268, W);
  const gpu = m.gpu;
  const dy = gpu ? 0 : 62;
  if (gpu) meter(g, `GPU · ${gpu.tempC ?? "—"}°C · ${gpu.powerW?.toFixed(0) ?? "—"}W`, `${gpu.util}% · ${gb(gpu.memUsed)}/${gb(gpu.memTotal)} GB`, gpu.util / 100, 330, W);
  meter(g, L("Ổ đĩa"), m.diskTotal ? `${gb(m.diskUsed ?? 0)} / ${gb(m.diskTotal)} GB` : "—", m.diskTotal ? (m.diskUsed ?? 0) / m.diskTotal : 0, 392 - dy, W);
  g.textAlign = "left";
  g.fillStyle = MUTED;
  font(g, 600, 22);
  g.fillText(L("Mạng"), 28, 454 - dy);
  g.fillStyle = GREEN;
  font(g, 700, 22);
  g.fillText(`↓ ${rate(m.netRxBps)}`, 120, 454 - dy);
  g.fillStyle = AMBER;
  g.fillText(`↑ ${rate(m.netTxBps)}`, 340, 454 - dy);
  const netMax = Math.max(...h.rx, ...h.tx, 1);
  spark(g, h.rx, 28, 468 - dy, W - 56, 50, GREEN, netMax);
  spark(g, h.tx, 28, 468 - dy, W - 56, 50, AMBER, netMax);
  g.fillStyle = MUTED;
  font(g, 500, 19);
  const up = m.uptimeSec ?? 0;
  g.fillText(L("LAN {0} · Tailscale {1} · chạy {2}n {3}g", m.lanIp ?? "—", m.tailscaleIp ?? "—", Math.floor(up / 86400), Math.floor((up % 86400) / 3600)), 28, 568 - dy);
  p.commit();
}

const MACHINE_ACCENTS = ["#2f8bff", "#2fd46b", "#ff7a2f"];

export function drawMachines(panels: Panels, snap: Snapshot): void {
  snap.machines.forEach((m, i) => panels.machines[i] && drawMachine(panels.machines[i], m, MACHINE_ACCENTS[i]));
}
