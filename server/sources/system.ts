import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BackgroundService, ServiceState, SystemInventory, SystemProcess } from "../../shared/system.ts";

const run = promisify(execFile);
const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_CONTAINERS = 100;
const KNOWN = /tailscale|syncthing|cloudflared|runner|github|(?:codex|claude)(?:[.\-_ ](?:mcp|native))?[.\-_ ]bridge|quota|docker|ollama|mysql|postgres|redis|nginx|apache|httpd|node|python|pm2|^(?:msc|hub|collector|bot)$|(?:^|[.\-_])(?:msc|ai-agent-company)(?:$|[.\-_])/i;
const PROCESS_SCRIPT = "$ErrorActionPreference='Stop'; @(Get-Process | ForEach-Object { $cpu=$null; $start=$null; try {$cpu=$_.TotalProcessorTime.TotalSeconds} catch {}; try {$start=$_.StartTime.ToUniversalTime().ToString('o')} catch {}; [pscustomobject]@{pid=$_.Id;name=$_.ProcessName;cpu=$cpu;memory=$_.WorkingSet64;start=$start} }) | ConvertTo-Json -Compress";
const SERVICE_SCRIPT = "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,ProcessId,ExitCode,StartMode) | ConvertTo-Json -Compress";

export interface ProcessSample {
  pid: number;
  name: string;
  cpuSeconds: number | null;
  memoryBytes: number | null;
  uptimeSec: number | null;
  identity: string;
}

interface SampleHistory {
  at: number;
  samples: Map<number, ProcessSample>;
}

export type CommandRunner = (file: string, args: string[], timeout?: number) => Promise<string>;

async function command(file: string, args: string[], timeout = 6000): Promise<string> {
  const { stdout } = await run(file, args, { timeout, maxBuffer: MAX_BUFFER, windowsHide: true, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  return stdout;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function records(text: string): Record<string, unknown>[] {
  const data: unknown = JSON.parse(text.replace(/^\uFEFF/, "") || "[]");
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
}

function label(value: unknown): string {
  return String(value ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 160);
}

function processName(value: unknown): string {
  return path.win32.basename(path.posix.basename(label(value))).replace(/\.exe$/i, "");
}

function purpose(name: string, fallback: string): string {
  const descriptions: [RegExp, string][] = [
    [/tailscale/i, "Kết nối mạng riêng giữa các máy"],
    [/syncthing/i, "Đồng bộ tệp giữa các máy"],
    [/cloudflared/i, "Kết nối dịch vụ qua Cloudflare Tunnel"],
    [/runner/i, "Thực thi công việc CI/CD"],
    [/postgres|mysql|redis/i, "Dịch vụ lưu trữ dữ liệu"],
    [/docker/i, "Vận hành môi trường container"],
    [/quota/i, "Theo dõi hạn mức sử dụng"],
    [/(?:^|[.\-_])(?:ai-agent-company|msc)(?:$|[.\-_])/i, "Thành phần của AI Agent Company"],
    [/(?:codex|claude)(?:[.\-_ ](?:mcp|native))?[.\-_ ]bridge/i, "Kết nối ứng dụng và công cụ"],
    [/nginx|apache|httpd/i, "Máy chủ web"],
    [/ollama/i, "Chạy mô hình AI trên máy"],
  ];
  return descriptions.find(([pattern]) => pattern.test(name))?.[1] ?? fallback;
}

export function durationSeconds(value: string): number | null {
  const match = value.match(/^(?:(\d+)-)?(\d+):(\d{2}(?:\.\d+)?)(?::(\d{2}(?:\.\d+)?))?$/);
  if (!match) return numeric(value);
  const days = Number(match[1] ?? 0);
  return match[4] === undefined ? days * 86400 + Number(match[2]) * 60 + Number(match[3]) : days * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4]);
}

export function parseWindowsProcesses(text: string, now: number): ProcessSample[] {
  return records(text).flatMap((row) => {
    const pid = numeric(row.pid);
    if (!pid || !Number.isInteger(pid)) return [];
    const start = typeof row.start === "string" ? Date.parse(row.start) : NaN;
    return [{ pid, name: processName(row.name), cpuSeconds: numeric(row.cpu), memoryBytes: numeric(row.memory), uptimeSec: Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : null, identity: Number.isFinite(start) ? String(start) : "" }];
  });
}

export function parseUnixProcesses(text: string, now: number): ProcessSample[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+((?:\S+\s+){4}\d{4})\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    const uptimeSec = durationSeconds(match[3]);
    const start = Date.parse(match[2]);
    return [{ pid: Number(match[1]), name: processName(match[6]), cpuSeconds: durationSeconds(match[4]), memoryBytes: Number(match[5]) * 1024, uptimeSec: uptimeSec ?? (Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : null), identity: label(match[2]).replace(/\s+/g, " ") }];
  });
}

export class ProcessSampler {
  private history: SampleHistory | null = null;

  sample(samples: ProcessSample[], now: number, cores = os.cpus().length): SystemProcess[] {
    const previous = this.history;
    const elapsed = previous ? (now - previous.at) / 1000 : 0;
    this.history = { at: now, samples: new Map(samples.map((sample) => [sample.pid, sample])) };
    return samples.map((sample) => {
      const old = previous?.samples.get(sample.pid);
      const sameIdentity = Boolean(old && sample.identity && old.identity && sample.identity === old.identity);
      const delta = sample.cpuSeconds !== null && old?.cpuSeconds !== null && old?.cpuSeconds !== undefined ? sample.cpuSeconds - old.cpuSeconds : -1;
      const cpuPercent = sameIdentity && old?.name === sample.name && elapsed > 0 && delta >= 0 ? Math.min(100, Math.round(delta / elapsed / Math.max(1, cores) * 1000) / 10) : null;
      return { pid: sample.pid, name: sample.name, cpuPercent, memoryBytes: sample.memoryBytes, uptimeSec: sample.uptimeSec };
    }).sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0) || a.pid - b.pid);
  }
}

function service(id: string, name: string, state: ServiceState, pid: number | null, description: string, detail: string, processes: SystemProcess[]): BackgroundService {
  const proc = pid ? processes.find((entry) => entry.pid === pid) : null;
  const important = !/^launchd:com\.apple\./i.test(id) && (KNOWN.test(name) || KNOWN.test(id));
  return { id, name, description: purpose(`${name} ${id}`, description), kind: "service", state, pid, cpuPercent: proc?.cpuPercent ?? null, memoryBytes: proc?.memoryBytes ?? null, uptimeSec: proc?.uptimeSec ?? null, detail, important };
}

export function parseWindowsServices(text: string, processes: SystemProcess[]): BackgroundService[] {
  return records(text).map((row) => {
    const raw = String(row.State ?? "");
    const exitCode = numeric(row.ExitCode);
    const state: ServiceState = raw === "Running" ? "running" : raw === "Stopped" ? (exitCode && exitCode !== 1077 ? "error" : "stopped") : "unknown";
    const mode = row.StartMode === "Auto" ? "Tự khởi động" : row.StartMode === "Disabled" ? "Đã vô hiệu hóa" : "Khởi động theo nhu cầu";
    const detail = state === "error" ? `Dừng với mã lỗi ${exitCode}` : mode;
    return service(`windows:${label(row.Name)}`, label(row.DisplayName || row.Name), state, numeric(row.ProcessId) || null, "Dịch vụ Windows", detail, processes);
  });
}

export function parseLaunchAgents(text: string, processes: SystemProcess[]): BackgroundService[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\d+|-)\s+(-?\d+)\s+(\S+)$/);
    if (!match) return [];
    const pid = match[1] === "-" ? null : Number(match[1]);
    const exitCode = Number(match[2]);
    const state = pid ? "running" : exitCode > 0 ? "error" : exitCode < 0 ? "unknown" : "stopped";
    const detail = pid ? "Đang chạy" : exitCode < 0 ? `Lần trước dừng bởi tín hiệu ${-exitCode}; chưa xác định nguyên nhân` : exitCode > 0 ? `Lần chạy gần nhất kết thúc với mã ${exitCode}` : "Đang chờ hoặc đã dừng";
    return [service(`launchd:${label(match[3])}`, label(match[3]), state, pid, "Dịch vụ phiên đăng nhập macOS", detail, processes)];
  });
}

export function parseLinuxServices(text: string, processes: SystemProcess[]): BackgroundService[] {
  return records(text).map((row) => {
    const active = String(row.active ?? "");
    const state: ServiceState = active === "active" ? "running" : active === "failed" ? "error" : active === "inactive" ? "stopped" : "unknown";
    return service(`systemd:${label(row.unit)}`, label(row.unit), state, null, label(row.description) || "Dịch vụ Linux", state === "error" ? "systemd báo dịch vụ thất bại" : label(row.sub), processes);
  });
}

export function parseContainers(text: string, now: number): BackgroundService[] {
  return text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const row = records(line)[0];
    if (!row || !/^[a-f0-9]{12,64}$/.test(String(row.id ?? ""))) throw new Error("Invalid container metadata");
    const raw = String(row.status ?? "");
    const exitCode = numeric(row.exitCode);
    const unhealthy = row.health === "unhealthy";
    const state: ServiceState = unhealthy || raw === "dead" || raw === "restarting" || raw === "exited" && Boolean(exitCode) ? "error" : raw === "running" ? "running" : raw === "exited" || raw === "created" ? "stopped" : "unknown";
    const started = typeof row.startedAt === "string" ? Date.parse(row.startedAt) : NaN;
    return { id: `docker:${row.id}`, name: label(row.name).replace(/^\//, ""), description: "Docker container", kind: "container", state, pid: null, cpuPercent: null, memoryBytes: null, uptimeSec: raw === "running" && Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : null, detail: unhealthy ? "Health check không đạt" : raw === "restarting" ? "Đang khởi động lại" : state === "error" && exitCode ? `Kết thúc với mã lỗi ${exitCode}` : row.health === "starting" ? "Health check đang khởi động" : state === "running" ? "Đang chạy" : state === "stopped" ? "Đã dừng" : "Chưa xác định", important: true };
  });
}

export function applicationServices(processes: SystemProcess[], services: BackgroundService[]): BackgroundService[] {
  const servicePids = new Set(services.flatMap((entry) => entry.pid ? [entry.pid] : []));
  const groups = new Map<string, SystemProcess[]>();
  for (const proc of processes) {
    if (servicePids.has(proc.pid) || !KNOWN.test(proc.name)) continue;
    const key = proc.name.toLowerCase();
    groups.set(key, [...groups.get(key) ?? [], proc]);
  }
  return [...groups].map(([key, list]) => ({ id: `app:${key}`, name: list[0].name, description: purpose(key, "Ứng dụng chạy trên máy"), kind: "app", state: "running", pid: list.length === 1 ? list[0].pid : null, cpuPercent: list.every((proc) => proc.cpuPercent !== null) ? Math.min(100, list.reduce((sum, proc) => sum + proc.cpuPercent!, 0)) : null, memoryBytes: list.every((proc) => proc.memoryBytes !== null) ? list.reduce((sum, proc) => sum + proc.memoryBytes!, 0) : null, uptimeSec: list.every((proc) => proc.uptimeSec !== null) ? Math.max(...list.map((proc) => proc.uptimeSec!)) : null, detail: `${list.length} tiến trình`, important: true }));
}

function issue(source: string, error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return code === "ENOENT" ? `${source}: công cụ chưa được cài hoặc không có trong PATH.` : `${source}: chưa đọc được dữ liệu (thiếu quyền, hết thời gian hoặc dịch vụ chưa sẵn sàng).`;
}

const sampler = new ProcessSampler();

export async function collectSystemInventory(platform: NodeJS.Platform, execute: CommandRunner, sample: ProcessSampler, now = Date.now()): Promise<SystemInventory> {
  const issues: string[] = [];
  const collect = async <T>(source: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); } catch (error) { issues.push(issue(source, error)); return fallback; }
  };
  const readProcesses = async () => {
    const rows = platform === "win32" ? parseWindowsProcesses(await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SCRIPT]), now) : parseUnixProcesses(await execute("ps", platform === "darwin" ? ["-axo", "pid=,lstart=,etime=,time=,rss=,comm="] : ["-eo", "pid=,lstart=,etimes=,time=,rss=,comm="]), now);
    if (!rows.length) throw new Error("Empty process inventory");
    return sample.sample(rows, now);
  };
  const readServices = async () => {
    if (platform === "win32") return { text: await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SERVICE_SCRIPT]), parse: parseWindowsServices };
    if (platform === "darwin") return { text: await execute("launchctl", ["list"]), parse: parseLaunchAgents };
    return { text: await execute("systemctl", ["list-units", "--type=service", "--all", "--output=json", "--no-pager"]), parse: parseLinuxServices };
  };
  const readContainers = async (): Promise<BackgroundService[]> => {
    let idsText = "";
    let docker = "";
    const binaries = platform === "darwin" ? ["docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"] : ["docker"];
    for (const binary of binaries) {
      try {
        idsText = await execute(binary, ["ps", "-aq", "--no-trunc"], 5000);
        docker = binary;
        break;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
    }
    if (!docker) return [];
    const ids = idsText.split(/\s+/).filter((id) => /^[a-f0-9]{12,64}$/.test(id));
    if (!ids.length) return [];
    if (ids.length > MAX_CONTAINERS) issues.push(`Docker: chỉ hiển thị ${MAX_CONTAINERS} container đầu tiên.`);
    const template = '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}';
    return parseContainers(await execute(docker, ["inspect", "--format", template, ...ids.slice(0, MAX_CONTAINERS)], 5000), now);
  };
  const [processes, rawServices, containers] = await Promise.all([
    collect("Tiến trình", readProcesses, []),
    collect("Dịch vụ hệ điều hành", readServices, null),
    collect("Docker", readContainers, []),
  ]);
  let services: BackgroundService[] = [];
  if (rawServices) {
    try { services = rawServices.parse(rawServices.text, processes); } catch (error) { issues.push(issue("Dịch vụ hệ điều hành", error)); }
  }
  services.push(...applicationServices(processes, services), ...containers);
  services.sort((a, b) => Number(b.state === "error") - Number(a.state === "error") || Number(b.important) - Number(a.important) || a.name.localeCompare(b.name));
  return { checkedAt: new Date(now).toISOString(), services, processes, issues };
}

export function readSystemInventory(): Promise<SystemInventory> {
  return collectSystemInventory(process.platform, command, sampler);
}
