import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { GpuStats, MachineHealth, MachineId } from "../../shared/types.ts";

const run = promisify(execFile);
const CMD_TIMEOUT_MS = 3000;
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

let lastCpu = os.cpus().map((c) => c.times);
let lastNet: { rx: number; tx: number; at: number } | null = null;
let gpuAvailable = true;

function cpuPercent(): number {
  const now = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const p = lastCpu[i] ?? t;
    idle += t.idle - p.idle;
    total += t.user + t.nice + t.sys + t.irq + t.idle - (p.user + p.nice + p.sys + p.irq + p.idle);
  });
  lastCpu = now;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

async function netTotals(): Promise<{ rx: number; tx: number } | null> {
  try {
    if (IS_WIN) {
      const { stdout } = await run("netstat", ["-e"], { timeout: CMD_TIMEOUT_MS, windowsHide: true });
      const m = stdout.match(/Bytes\s+(\d+)\s+(\d+)/);
      return m ? { rx: Number(m[1]), tx: Number(m[2]) } : null;
    }
    if (IS_MAC) {
      const { stdout } = await run("netstat", ["-ibn"], { timeout: CMD_TIMEOUT_MS });
      let rx = 0;
      let tx = 0;
      const seen = new Set<string>();
      for (const line of stdout.split("\n").slice(1)) {
        const c = line.trim().split(/\s+/);
        if (c.length < 10 || !c[2]?.startsWith("<Link") || c[0].startsWith("lo") || seen.has(c[0])) continue;
        seen.add(c[0]);
        const shift = c.length >= 11 ? 0 : 1;
        rx += Number(c[6 - shift]) || 0;
        tx += Number(c[9 - shift]) || 0;
      }
      return { rx, tx };
    }
    const text = await readFile("/proc/net/dev", "utf8");
    let rx = 0;
    let tx = 0;
    for (const line of text.split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name.trim() === "lo") continue;
      const c = rest.trim().split(/\s+/);
      rx += Number(c[0]) || 0;
      tx += Number(c[8]) || 0;
    }
    return { rx, tx };
  } catch {
    return null;
  }
}

async function netRates(): Promise<{ rx: number | null; tx: number | null }> {
  const cur = await netTotals();
  if (!cur) return { rx: null, tx: null };
  const at = Date.now();
  const prev = lastNet;
  lastNet = { ...cur, at };
  if (!prev || at - prev.at <= 0) return { rx: null, tx: null };
  const sec = (at - prev.at) / 1000;
  const rx = cur.rx - prev.rx;
  const tx = cur.tx - prev.tx;
  return { rx: rx >= 0 ? Math.round(rx / sec) : null, tx: tx >= 0 ? Math.round(tx / sec) : null };
}

async function gpuStats(): Promise<GpuStats | null> {
  if (!gpuAvailable) return null;
  try {
    const { stdout } = await run(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw", "--format=csv,noheader,nounits"],
      { timeout: CMD_TIMEOUT_MS, windowsHide: true },
    );
    const [name, util, used, total, temp, power] = stdout.trim().split("\n")[0].split(",").map((s) => s.trim());
    const MIB = 1024 * 1024;
    return {
      name,
      util: Number(util),
      memUsed: Number(used) * MIB,
      memTotal: Number(total) * MIB,
      tempC: Number.isFinite(Number(temp)) ? Number(temp) : null,
      powerW: Number.isFinite(Number(power)) ? Number(power) : null,
    };
  } catch {
    gpuAvailable = false;
    return null;
  }
}

async function diskStats(): Promise<{ used: number | null; total: number | null }> {
  try {
    const s = await statfs(IS_WIN ? "C:\\" : IS_MAC ? "/System/Volumes/Data" : "/");
    const total = s.blocks * s.bsize;
    return { used: total - s.bavail * s.bsize, total };
  } catch {
    return { used: null, total: null };
  }
}

async function memUsed(): Promise<number> {
  const fallback = os.totalmem() - os.freemem();
  if (!IS_MAC) return fallback;
  try {
    const { stdout } = await run("vm_stat", [], { timeout: CMD_TIMEOUT_MS });
    const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
    const pages = (label: string) => Number(stdout.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
    const used = (pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor")) * pageSize;
    return used > 0 ? used : fallback;
  } catch {
    return fallback;
  }
}

function addresses(): { lan: string | null; tailscale: string | null } {
  let lan: string | null = null;
  let tailscale: string | null = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("100.")) tailscale ??= a.address;
      else if (/^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(a.address)) lan ??= a.address;
    }
  }
  return { lan, tailscale };
}

function osLabel(): string {
  if (IS_WIN) return `Windows ${os.release()}`;
  if (IS_MAC) return `macOS (Darwin ${os.release()})`;
  return `${os.type()} ${os.release()}`;
}

export async function localHealth(id: MachineId): Promise<MachineHealth> {
  const [net, gpu, disk, used] = await Promise.all([netRates(), gpuStats(), diskStats(), memUsed()]);
  const ip = addresses();
  const cpus = os.cpus();
  return {
    id,
    online: true,
    source: "local",
    cpu: cpuPercent(),
    cpuModel: cpus[0]?.model.trim() ?? null,
    cores: cpus.length,
    memUsed: used,
    memTotal: os.totalmem(),
    netRxBps: net.rx,
    netTxBps: net.tx,
    diskUsed: disk.used,
    diskTotal: disk.total,
    gpu,
    os: osLabel(),
    lanIp: ip.lan,
    tailscaleIp: ip.tailscale,
    uptimeSec: Math.round(os.uptime()),
    checkedAt: new Date().toISOString(),
  };
}
