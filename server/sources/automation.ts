import { open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AutomationJob, JobFigures, JobGroup, JobStatus } from "../../shared/automation.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const VN_OFFSET_MS = 7 * HOUR_MS;
const LAST_RUN_WINDOW_MS = 5 * 60_000;
const MAX_DETAILS = 8;
const KB = 1024;

export interface LogLine {
  at: number;
  text: string;
}

export interface JobResult {
  lastRun: number | null;
  status: JobStatus;
  summary: string;
  details: string[];
  figures: JobFigures;
}

export interface JobSpec {
  id: string;
  name: string;
  group: JobGroup;
  schedule: string;
  lastRunLabel: string;
  staleMs: number | null;
  file: string;
  bytes: number;
  parse: (text: string, now: number) => JobResult;
}

export function dayStart(now: number): number {
  return Math.floor((now + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
}

export function stamp(line: string): number | null {
  const iso = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
  if (iso) return Date.parse(iso[1]);
  const local = line.match(/^\[?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/);
  return local ? Date.parse(`${local[1]}T${local[2]}+07:00`) : null;
}

export function logLines(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const at = stamp(raw);
    if (at !== null) lines.push({ at, text: raw.trim() });
  }
  return lines;
}

function body(line: string): string {
  return line.replace(/^\[?\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\]?\s*/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].slice(0, MAX_DETAILS);
}

function result(lastRun: number | null, status: JobStatus, summary: string, details: string[] = [], figures: JobFigures = {}): JobResult {
  return { lastRun, status, summary, details, figures };
}

function noEntries(): JobResult {
  return result(null, "warn", "Có file log nhưng chưa có dòng nào đọc được.");
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("vi-VN")} ${noun}`;
}

function repoField(line: LogLine, index: number): string {
  return index < 3 ? (line.text.split(" | ")[index] ?? "").trim() : line.text.split(" | ").slice(3).join(" | ").trim();
}

export function parseRepoSync(text: string, now: number): JobResult {
  const lines = logLines(text);
  if (!lines.length) return noEntries();
  const lastRun = lines.at(-1)!.at;
  const today = lines.filter((line) => line.at >= dayStart(now));
  const pulled = new Map<string, number>();
  let pulls = 0;
  for (const line of today) {
    const message = repoField(line, 3);
    const repo = message.match(/^(.+?)(?: \[[^\]]*\])? : keo ve (\d+)/) ?? message.match(/^(Windows): keo ve (\d+)/);
    if (!repo || !Number(repo[2])) continue;
    pulled.set(repo[1], (pulled.get(repo[1]) ?? 0) + Number(repo[2]));
    pulls++;
  }
  const latest = lines.filter((line) => line.at >= lastRun - LAST_RUN_WINDOW_MS);
  const problems = (level: string) => unique(latest.filter((line) => repoField(line, 1) === level).map((line) => repoField(line, 3)));
  const errors = problems("error");
  const warnings = problems("warn");
  const commits = [...pulled.values()].reduce((sum, value) => sum + value, 0);
  const scan = [...latest].reverse().find((line) => /quet \d+ repo/.test(line.text));
  const scanText = scan ? ` · lượt gần nhất: ${repoField(scan, 3).replace("quet", "quét").replace("repo co thay doi", "repo có thay đổi")}` : "";
  const details = [...[...pulled].map(([repo, count]) => `Kéo về ${repo}: +${count} commit`), ...errors.map((line) => `Lỗi: ${line}`), ...warnings.map((line) => `Cảnh báo: ${line}`)];
  const status: JobStatus = errors.length ? "error" : warnings.length ? "warn" : "ok";
  return result(lastRun, status, `${commits ? `Hôm nay kéo về ${plural(commits, "commit")} ở ${plural(pulled.size, "repo")}` : "Hôm nay chưa có commit mới"}${scanText}`, unique(details), { pulled: pulls });
}

export function parseGithubSync(text: string, now: number): JobResult {
  const lines = logLines(text);
  if (!lines.length) return noEntries();
  const today = lines.filter((line) => line.at >= dayStart(now));
  const synced = new Map<string, number>();
  for (const line of today) {
    const match = body(line.text).match(/^SYNCED (.+) [0-9a-f]{7,}$/);
    if (match) synced.set(match[1], (synced.get(match[1]) ?? 0) + 1);
  }
  const done = [...lines].reverse().find((line) => body(line.text).startsWith("DONE"));
  const failed = Number(done?.text.match(/failed: (\d+)/)?.[1] ?? 0);
  const failures = unique(today.filter((line) => /^(FAIL|ERROR)/.test(body(line.text))).map((line) => body(line.text)));
  const total = [...synced.values()].reduce((sum, value) => sum + value, 0);
  const details = [...[...synced].map(([repo, count]) => `Cập nhật ${repo}: ${plural(count, "lần")}`), ...failures.map((line) => `Lỗi: ${line}`)];
  return result(lines.at(-1)!.at, failed ? "error" : "ok", total ? `Hôm nay cập nhật ${plural(total, "lần")} trên ${plural(synced.size, "repo")}` : "Hôm nay chưa có repo nào cần cập nhật", unique(details), { pulled: total });
}

export function parseHomeSync(text: string, now: number): JobResult {
  const lines = logLines(text);
  if (!lines.length) return noEntries();
  const today = lines.filter((line) => line.at >= dayStart(now));
  let copied = 0;
  let pushed = 0;
  let conflicts = 0;
  for (const line of today) {
    const match = line.text.match(/done in .*?copied (\d+).*?pushed (\d+).*?conflicts (\d+)/);
    if (!match) continue;
    copied += Number(match[1]);
    pushed += Number(match[2]);
    conflicts += Number(match[3]);
  }
  const last = lines.at(-1)!;
  const unreachable = /home PC unreachable/.test(last.text);
  const errors = unique(today.filter((line) => line.text.includes("[error]")).map((line) => body(line.text)));
  const status: JobStatus = errors.length ? "error" : conflicts || unreachable ? "warn" : "ok";
  const summary = unreachable ? "Lượt gần nhất không nối được máy nhà nên bỏ qua" : `Hôm nay chép ${plural(copied, "file")} về Mac, đẩy ${plural(pushed, "file")} về máy nhà`;
  return result(last.at, status, summary, [...(conflicts ? [`${plural(conflicts, "xung đột")} được giữ cả hai bản`] : []), ...errors]);
}

export function parseDailyUpdateState(text: string, now: number): JobResult {
  let state: { status?: string; steps?: Record<string, { status?: string; time?: string; message?: string }> };
  try { state = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return result(null, "warn", "Không đọc được file trạng thái DailyUpdate."); }
  const steps = Object.entries(state.steps ?? {}).map(([id, step]) => ({ id, status: step.status ?? "", at: Date.parse(step.time ?? ""), message: step.message ?? "" }));
  if (!steps.length) return result(null, "warn", "DailyUpdate chưa ghi bước nào.");
  const lastRun = Math.max(...steps.map((step) => step.at).filter(Number.isFinite));
  const failed = steps.filter((step) => /fail|error/i.test(step.status));
  const pending = steps.filter((step) => /pending/i.test(step.status));
  const packages = steps.filter((step) => step.id.startsWith("winget:") && step.id !== "winget:scan" && step.status === "Success" && step.at >= dayStart(now)).map((step) => step.id.slice("winget:".length));
  const ok = steps.filter((step) => step.status === "Success").length;
  const status: JobStatus = failed.length ? "error" : pending.length ? "warn" : "ok";
  const details = [...(packages.length ? [`Gói winget đã chạy cập nhật: ${packages.join(", ")}`] : []), ...failed.map((step) => `Lỗi ${step.id}: ${step.message}`), ...pending.map((step) => `Đang chờ ${step.id}: ${step.message}`)];
  return result(Number.isFinite(lastRun) ? lastRun : null, status, `${ok}/${steps.length} bước thành công${failed.length ? `, ${failed.length} lỗi` : ""}${pending.length ? `, ${pending.length} chờ máy rảnh hoặc khởi động lại` : ""}`, unique(details), { updated: packages.length });
}

export function parseMacUpdate(text: string, now: number): JobResult {
  const lines = logLines(text);
  if (!lines.length) return noEntries();
  const starts = lines.filter((line) => body(line.text).startsWith("START auto-update"));
  const begin = starts.at(-1)?.at ?? lines[0].at;
  const run = lines.filter((line) => line.at >= begin);
  const summary = [...run].reverse().find((line) => body(line.text).startsWith("SUMMARY"));
  const failures = Number(summary?.text.match(/failures=(\d+)/)?.[1] ?? 0);
  const pending = Number(summary?.text.match(/pending=(\d+)/)?.[1] ?? 0);
  const done = run.filter((line) => body(line.text).startsWith("SUCCESS")).map((line) => body(line.text).slice("SUCCESS ".length));
  const failed = run.filter((line) => /^(FAIL|ERROR)/.test(body(line.text))).map((line) => body(line.text));
  const status: JobStatus = !summary ? "warn" : failures ? "error" : pending ? "warn" : "ok";
  const outcome = summary ? `${plural(done.length, "bước")} thành công${failures ? `, ${failures} lỗi` : ""}${pending ? `, ${pending} đang chờ` : ""}` : "Lượt gần nhất chưa chạy xong";
  return result(begin, status, outcome, unique([...failed, ...(done.length ? [`Đã chạy: ${done.join(", ")}`] : [])]), { updated: begin >= dayStart(now) ? done.length : 0 });
}

function megabytes(value: string, unit: string): number {
  const amount = Number(value.includes(",") ? value.replace(/\./g, "").replace(",", ".") : value);
  const scale = unit.toUpperCase()[0];
  return scale === "G" ? amount * KB : scale === "K" ? amount / KB : amount;
}

export function size(mb: number): string {
  return mb >= KB ? `${(mb / KB).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} GB` : `${Math.round(mb).toLocaleString("vi-VN")} MB`;
}

export function parseCacheCleanup(text: string, now: number): JobResult {
  const lines = logLines(text);
  if (!lines.length) return noEntries();
  const summaries = lines.filter((line) => line.text.includes("SUMMARY reclaimed="));
  const last = summaries.at(-1);
  if (!last) return result(lines.at(-1)!.at, "warn", "Lượt gần nhất chưa chạy xong");
  const reclaimed = last.text.match(/reclaimed=([\d.,]+)\s*([KMG]B)/i);
  const free = last.text.match(/free=([\d.,]+)\s*([KMG]B)/i);
  const failures = Number(last.text.match(/failures=(\d+)/)?.[1] ?? 0);
  const today = summaries.filter((line) => line.at >= dayStart(now)).reduce((sum, line) => {
    const match = line.text.match(/reclaimed=([\d.,]+)\s*([KMG]B)/i);
    return sum + (match ? megabytes(match[1], match[2]) : 0);
  }, 0);
  const summary = `Lượt gần nhất dọn ${reclaimed ? size(megabytes(reclaimed[1], reclaimed[2])) : "?"}${free ? `, ổ còn trống ${size(megabytes(free[1], free[2]))}` : ""}`;
  return result(last.at, failures ? "warn" : "ok", summary, failures ? [`${plural(failures, "mục")} dọn không được`] : [], { reclaimedMb: Math.round(today) });
}

export function parseDrivers(text: string, now: number): JobResult {
  const lines = logLines(text);
  if (!lines.length) return noEntries();
  const done = lines.filter((line) => /\] done failures=/.test(line.text)).at(-1);
  const last = lines.at(-1)!;
  if (!done) return result(last.at, "ok", body(last.text).replace("[drivers] ", ""));
  const failures = Number(done.text.match(/failures=(\d+)/)?.[1] ?? 0);
  const pending = /pending=True/i.test(done.text);
  const run = lines.filter((line) => line.at >= done.at - LAST_RUN_WINDOW_MS && line.at <= done.at);
  const installed = run.filter((line) => /installed .*latest|Installed|install /.test(line.text) && !/ skip /.test(line.text)).map((line) => body(line.text).replace("[drivers] ", ""));
  const status: JobStatus = failures ? "error" : pending ? "warn" : "ok";
  return result(done.at, status, `${failures ? `${failures} lỗi` : "Không lỗi"}${pending ? ", có driver chờ khởi động lại" : ""}`, unique(installed));
}

export function parseSkillSync(text: string, now: number): JobResult {
  const lines = logLines(text);
  if (!lines.length) return noEntries();
  const today = lines.filter((line) => line.at >= dayStart(now));
  const kind = (line: LogLine) => body(line.text).split(" ")[0];
  const changed = today.filter((line) => ["UPDATED", "INSTALLED"].includes(kind(line))).map((line) => body(line.text));
  const errors = today.filter((line) => kind(line) === "ERROR").map((line) => body(line.text).replace(/^ERROR /, "").split(":")[0]);
  const latestErrors = lines.filter((line) => line.at >= lines.at(-1)!.at - LAST_RUN_WINDOW_MS && kind(line) === "ERROR");
  const status: JobStatus = latestErrors.length ? "warn" : "ok";
  const summary = `Hôm nay ${plural(changed.length, "skill/plugin")} được cập nhật${errors.length ? `, ${plural(new Set(errors).size, "nguồn")} lỗi` : ""}`;
  return result(lines.at(-1)!.at, status, summary, unique([...changed, ...unique(errors).map((name) => `Nguồn lỗi: ${name}`)]), { updated: changed.length });
}

export function parseChangeLog(noun: string) {
  return (text: string, now: number): JobResult => {
    const lines = logLines(text);
    if (!lines.length) return result(null, "ok", `Chưa ghi nhận ${noun} nào.`);
    const today = lines.filter((line) => line.at >= dayStart(now)).map((line) => body(line.text));
    const failed = today.filter((line) => /fail|error|lỗi/i.test(line));
    const applied = new Set(today.filter((line) => /INSTALLED|is applied/.test(line)).map((line) => line.replace(/ in (claude|codex)$/, "")));
    const summary = `Hôm nay ${applied.size ? `có ${plural(applied.size, noun)}` : `chưa có ${noun} nào`}${failed.length ? `, ${failed.length} dòng lỗi` : ""}`;
    return result(lines.at(-1)!.at, failed.length ? "warn" : "ok", summary, unique(today.slice(-MAX_DETAILS)), { updated: applied.size });
  };
}

const HOME = os.homedir();
const HOUR = HOUR_MS;
const CONFIG_FILE = (process.env.MSC_AUTOMATION_FILE ?? path.join(HOME, ".msc-company", "automation.json")).trim();
const GROUPS: readonly JobGroup[] = ["sync", "update", "cleanup"];

const PARSERS: Record<string, (text: string, now: number) => JobResult> = {
  "repo-sync": parseRepoSync,
  "github-sync": parseGithubSync,
  "home-sync": parseHomeSync,
  "daily-update-state": parseDailyUpdateState,
  "mac-update": parseMacUpdate,
  "cache-cleanup": parseCacheCleanup,
  drivers: parseDrivers,
  "skill-sync": parseSkillSync,
};

interface JobConfig {
  id?: unknown;
  name?: unknown;
  group?: unknown;
  schedule?: unknown;
  lastRunLabel?: unknown;
  staleHours?: unknown;
  file?: unknown;
  maxKb?: unknown;
  format?: unknown;
  noun?: unknown;
}

function expandHome(file: string): string {
  return file === "~" || file.startsWith("~/") || file.startsWith("~\\") ? path.join(HOME, file.slice(1)) : file;
}

export function parseJobConfig(raw: unknown, platform = process.platform): JobSpec[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? (raw as Record<string, unknown>)[platform] : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: JobConfig) => {
    if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.file !== "string") return [];
    const format = typeof entry.format === "string" ? entry.format : "change-log";
    const parse = format === "change-log" ? parseChangeLog(typeof entry.noun === "string" ? entry.noun : "thay đổi") : PARSERS[format];
    if (!parse) return [];
    const group = GROUPS.includes(entry.group as JobGroup) ? entry.group as JobGroup : "update";
    const staleHours = Number(entry.staleHours);
    const maxKb = Number(entry.maxKb);
    return [{
      id: entry.id,
      name: entry.name,
      group,
      schedule: typeof entry.schedule === "string" ? entry.schedule : "",
      lastRunLabel: typeof entry.lastRunLabel === "string" ? entry.lastRunLabel : "Chạy gần nhất",
      staleMs: Number.isFinite(staleHours) && staleHours > 0 ? staleHours * HOUR : null,
      file: expandHome(entry.file),
      bytes: (Number.isFinite(maxKb) && maxKb > 0 ? Math.min(maxKb, 4096) : 256) * KB,
      parse,
    }];
  });
}

export async function jobSpecs(platform = process.platform): Promise<JobSpec[]> {
  try {
    return parseJobConfig(JSON.parse(await readFile(CONFIG_FILE, "utf8")), platform);
  } catch {
    return [];
  }
}

async function tail(file: string, bytes: number): Promise<string | null> {
  let handle;
  try { handle = await open(file, "r"); } catch { return null; }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

export function toJob(spec: JobSpec, text: string | null, now: number): AutomationJob {
  const base = { id: spec.id, name: spec.name, group: spec.group, schedule: spec.schedule, lastRunLabel: spec.lastRunLabel };
  if (text === null) return { ...base, status: "missing", lastRun: null, summary: "Máy này không có tác vụ này hoặc chưa chạy lần nào.", details: [], figures: {} };
  const parsed = spec.parse(text, now);
  const stale = spec.staleMs !== null && parsed.lastRun !== null && now - parsed.lastRun > spec.staleMs;
  const status: JobStatus = stale && parsed.status !== "error" ? "stale" : parsed.status;
  return { ...base, status, lastRun: parsed.lastRun === null ? null : new Date(parsed.lastRun).toISOString(), summary: parsed.summary, details: parsed.details, figures: parsed.figures };
}

export async function readAutomation(now = Date.now()): Promise<AutomationJob[]> {
  return Promise.all((await jobSpecs()).map(async (spec) => toJob(spec, await tail(spec.file, spec.bytes).catch(() => null), now)));
}
