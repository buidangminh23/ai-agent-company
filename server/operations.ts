import { L } from "../shared/i18n.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentInfo, MachineId, Snapshot } from "../shared/types.ts";
import { deriveOperations, quotaKey, taskCard, type DailyReport, type HistoryCoverage, type HistoryEvent, type HistoryResponse, type OperationsSnapshot, type QuotaSample, type ReplayResponse } from "../shared/operations.ts";

interface StoreOptions {
  file?: string;
  retentionDays?: number;
  maxFrames?: number;
  maxEvents?: number;
  frameIntervalMs?: number;
}
interface RangeFilter {
  from: string;
  to: string;
  project?: string;
  machine?: string;
}
interface EventRow {
  id: number;
  at: string;
  kind: HistoryEvent["kind"];
  title: string;
  detail: string;
  agentId: string | null;
  project: string | null;
  machine: MachineId | null;
  url: string | null;
  data: string | null;
}

const DAY_MS = 86_400_000;
const MACHINES = new Set(["WORKSTATION", "SERVER", "LAPTOP"]);

function redact(value: string): string {
  return value.replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|Bearer\s+[\w.\/+~-]+)/gi, L("[đã ẩn]"))
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, L("$1[đã ẩn]"))
    .replace(/https?:\/\/[^\s<>]+/gi, (value) => {
      try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return L("[liên kết]"); }
    });
}

function safeAgent(agent: AgentInfo): AgentInfo {
  return { ...agent, title: redact(agent.title).slice(0, 200), task: agent.task ? redact(agent.task).slice(0, 1600) : undefined, progress: agent.progress ? redact(agent.progress).slice(0, 1600) : undefined, recap: agent.recap ? redact(agent.recap).slice(0, 1000) : undefined, detail: redact(agent.detail).slice(0, 600), files: agent.files?.slice(-30), pending: agent.pending ? { ...agent.pending, question: redact(agent.pending.question), options: agent.pending.options.map(redact) } : null, outcome: agent.outcome ? { ...agent.outcome, summary: redact(agent.outcome.summary).slice(0, 1600) } : undefined, repeatedError: agent.repeatedError ? { ...agent.repeatedError, summary: redact(agent.repeatedError.summary).slice(0, 600) } : undefined };
}

function eventValue(row: EventRow): HistoryEvent {
  return { id: row.id, at: row.at, kind: row.kind, title: row.title, detail: row.detail, ...(row.agentId ? { agentId: row.agentId } : {}), ...(row.project ? { project: row.project } : {}), ...(row.machine ? { machine: row.machine } : {}), ...(row.url ? { url: row.url } : {}) };
}

function matches(agent: AgentInfo, filter: Pick<RangeFilter, "project" | "machine">): boolean {
  return (!filter.project || agent.project === filter.project) && (!filter.machine || agent.machine === filter.machine);
}

function parseRange(url: URL): RangeFilter {
  const now = Date.now();
  const from = url.searchParams.get("from") ?? new Date(now - DAY_MS).toISOString();
  const to = url.searchParams.get("to") ?? new Date(now).toISOString();
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 7 * DAY_MS) throw new Error(L("Khoảng thời gian phải hợp lệ và không quá 7 ngày"));
  const project = url.searchParams.get("project") || undefined;
  const machine = url.searchParams.get("machine") || undefined;
  if ((project?.length ?? 0) > 200 || (machine && !MACHINES.has(machine))) throw new Error(L("Bộ lọc không hợp lệ"));
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString(), project, machine };
}

export function vietnamDayRange(date: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(L("Ngày phải có dạng YYYY-MM-DD"));
  const start = Date.parse(`${date}T00:00:00+07:00`);
  if (!Number.isFinite(start) || new Date(start + 7 * 3_600_000).toISOString().slice(0, 10) !== date) throw new Error(L("Ngày không hợp lệ"));
  return { from: new Date(start).toISOString(), to: new Date(start + DAY_MS - 1).toISOString() };
}

export class OperationsStore {
  private db: DatabaseSync | null = null;
  private previous: Snapshot | null = null;
  private lastFrame = 0;
  private lastPrune = 0;
  private error = "";
  private lastQuota = "";
  private readonly retentionDays: number;
  private readonly maxFrames: number;
  private readonly maxEvents: number;
  private readonly frameIntervalMs: number;

  constructor(options: StoreOptions = {}) {
    this.retentionDays = options.retentionDays ?? 7;
    this.maxFrames = options.maxFrames ?? 2880;
    this.maxEvents = options.maxEvents ?? 20_000;
    this.frameIntervalMs = options.frameIntervalMs ?? 60_000;
    try {
      const file = options.file ?? process.env.MSC_HISTORY_FILE ?? path.join(os.homedir(), ".msc-company", "operations.sqlite");
      if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.db = new DatabaseSync(file);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; PRAGMA journal_size_limit=4194304; PRAGMA max_page_count=65536;");
      this.db.exec("CREATE TABLE IF NOT EXISTS frames (at TEXT PRIMARY KEY, snapshot TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, agentId TEXT, project TEXT, machine TEXT, url TEXT, data TEXT); CREATE INDEX IF NOT EXISTS events_at ON events(at); CREATE TABLE IF NOT EXISTS quota_samples (key TEXT NOT NULL, at TEXT NOT NULL, row TEXT NOT NULL, PRIMARY KEY (key,at)); CREATE INDEX IF NOT EXISTS quota_at ON quota_samples(at);");
      this.db.exec("CREATE TABLE IF NOT EXISTS verifications (agentId TEXT NOT NULL, outcomeAt TEXT NOT NULL, at TEXT NOT NULL, evidence TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (agentId,outcomeAt))");
      const last = this.db.prepare("SELECT at,snapshot FROM frames ORDER BY at DESC LIMIT 1").get() as { at: string; snapshot: string } | undefined;
      if (last) {
        this.previous = JSON.parse(last.snapshot) as Snapshot;
        this.lastFrame = Date.parse(last.at);
      }
    } catch {
      this.error = L("Không mở được lịch sử trên đĩa; dữ liệu trực tiếp vẫn hoạt động");
      this.db?.close();
      this.db = null;
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  coverage(): HistoryCoverage {
    if (!this.db) return { from: null, to: null, retentionDays: this.retentionDays, persistent: false, note: this.error || L("Lịch sử chưa sẵn sàng") };
    try {
      const range = this.db.prepare("SELECT MIN(at) AS first, MAX(at) AS last FROM (SELECT at FROM frames UNION ALL SELECT at FROM events)").get() as { first: string | null; last: string | null };
      return { from: range.first, to: range.last, retentionDays: this.retentionDays, persistent: !this.error, note: this.error || L("Chỉ gồm dữ liệu đã quan sát; lưu tối đa 7 ngày, 2.880 khung hình và 20.000 sự kiện") };
    } catch {
      return { from: null, to: null, retentionDays: this.retentionDays, persistent: false, note: L("Không đọc được lịch sử trên đĩa") };
    }
  }

  observe(snapshot: Snapshot): void {
    if (!this.db) return;
    const now = Date.parse(snapshot.generatedAt);
    if (!Number.isFinite(now)) return;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const prev = new Map(this.previous?.agents.map((a) => [a.id, a]) ?? []);
      for (const raw of snapshot.agents) {
        const agent = safeAgent(raw);
        const old = prev.get(agent.id);
        const signature = (a: AgentInfo) => JSON.stringify([a.state, a.detail, a.task, a.pending, a.outcome, a.branch, a.repeatedError]);
        if (!old || signature(old) !== signature(agent)) {
          const kind = agent.outcome && JSON.stringify(agent.outcome) !== JSON.stringify(old?.outcome) ? "outcome" : agent.pending && JSON.stringify(agent.pending) !== JSON.stringify(old?.pending) ? "question" : "agent";
          this.insert({ at: snapshot.generatedAt, kind, title: agent.title, detail: agent.pending?.question ?? agent.outcome?.summary ?? agent.detail, agentId: agent.id, project: agent.project, machine: agent.machine, url: agent.nativeUrl }, agent);
        }
      }
      for (const machine of snapshot.machines) {
        const old = this.previous?.machines.find((m) => m.id === machine.id);
        if (!old || old.online !== machine.online) this.insert({ at: snapshot.generatedAt, kind: "machine", title: machine.id, detail: machine.online ? L("Đã kết nối collector") : L("Chưa kết nối collector"), machine: machine.id });
      }
      for (const site of snapshot.sites) {
        const old = this.previous?.sites.find((s) => s.url === site.url);
        if (!old || old.ok !== site.ok || old.status !== site.status) this.insert({ at: snapshot.generatedAt, kind: "site", title: site.label, detail: site.note, url: site.url });
      }
      for (const repo of snapshot.projects.repos) {
        const old = this.previous?.projects.repos.find((r) => r.name === repo.name);
        if (repo.deploy && (!old || JSON.stringify(old.deploy) !== JSON.stringify(repo.deploy))) this.insert({ at: snapshot.generatedAt, kind: "deploy", title: repo.name, detail: `${repo.deploy.environment}: ${repo.deploy.state}`, project: repo.name, url: repo.url });
        if (repo.ci && old?.ci !== repo.ci) this.insert({ at: snapshot.generatedAt, kind: "alert", title: `${repo.name}: CI`, detail: repo.ci, project: repo.name, url: repo.url });
      }
      const coverage = { from: null, to: null, retentionDays: this.retentionDays, persistent: true, note: "" };
      const currentAlerts = deriveOperations(snapshot, coverage).attention.filter((a) => a.kind === "stalled" || a.kind === "conflict" || a.id.startsWith("repeated:"));
      const oldAlerts = this.previous ? deriveOperations(this.previous, coverage).attention.filter((a) => a.kind === "stalled" || a.kind === "conflict" || a.id.startsWith("repeated:")) : [];
      for (const alert of currentAlerts) if (!oldAlerts.some((old) => old.id === alert.id && old.detail === alert.detail)) this.insert({ at: snapshot.generatedAt, kind: "alert", title: alert.title, detail: alert.detail, agentId: alert.agentIds[0], project: alert.project, machine: alert.machine, url: alert.url });
      for (const alert of oldAlerts) if (!currentAlerts.some((current) => current.id === alert.id)) this.insert({ at: snapshot.generatedAt, kind: "alert", title: alert.title, detail: L("Dấu hiệu cảnh báo không còn xuất hiện trong dữ liệu hiện tại"), agentId: alert.agentIds[0], project: alert.project, machine: alert.machine });
      const quotaAt = snapshot.quota.fetchedAt;
      const quotaSignature = JSON.stringify([quotaAt, snapshot.quota.rows]);
      if (snapshot.quota.connected && quotaAt && Number.isFinite(Date.parse(quotaAt)) && quotaSignature !== this.lastQuota) {
        const insert = this.db.prepare("INSERT OR IGNORE INTO quota_samples (key,at,row) VALUES (?,?,?)");
        for (const row of snapshot.quota.rows) if (Number.isFinite(row.remaining) && row.remaining >= 0 && row.remaining <= 100) insert.run(quotaKey(row), quotaAt, JSON.stringify(row));
        this.lastQuota = quotaSignature;
      }
      if (!this.lastFrame || now - this.lastFrame >= this.frameIntervalMs) {
        const compact = { ...snapshot, agents: snapshot.agents.map(safeAgent) };
        const serialized = JSON.stringify(compact);
        if (Buffer.byteLength(serialized) <= 512 * 1024) {
          this.db.prepare("INSERT OR REPLACE INTO frames (at,snapshot) VALUES (?,?)").run(snapshot.generatedAt, serialized);
          this.lastFrame = now;
        }
      }
      if (!this.lastPrune || now - this.lastPrune >= 60_000) {
        this.prune(now);
        this.lastPrune = now;
      }
      this.db.exec("COMMIT");
      this.previous = { ...snapshot, agents: snapshot.agents.map(safeAgent) };
      this.error = "";
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.error = L("Không ghi được lịch sử; có thể thiếu dữ liệu trong khoảng này");
    }
  }

  private insert(event: Omit<HistoryEvent, "id">, agent?: AgentInfo): void {
    this.db!.prepare("INSERT INTO events (at,kind,title,detail,agentId,project,machine,url,data) VALUES (?,?,?,?,?,?,?,?,?)").run(event.at, event.kind, redact(event.title).slice(0, 200), redact(event.detail).slice(0, 2000), event.agentId ?? null, event.project ?? null, event.machine ?? null, event.url ?? null, agent ? JSON.stringify(agent) : null);
  }

  private prune(now: number): void {
    const cutoff = new Date(now - this.retentionDays * DAY_MS).toISOString();
    this.db!.prepare("DELETE FROM frames WHERE at < ?").run(cutoff);
    this.db!.prepare("DELETE FROM events WHERE at < ?").run(cutoff);
    this.db!.prepare("DELETE FROM verifications WHERE at < ?").run(cutoff);
    this.db!.prepare("DELETE FROM quota_samples WHERE at < ?").run(new Date(now - 6 * 3_600_000).toISOString());
    this.db!.prepare("DELETE FROM frames WHERE at IN (SELECT at FROM frames ORDER BY at DESC LIMIT -1 OFFSET ?)").run(this.maxFrames);
    this.db!.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id DESC LIMIT -1 OFFSET ?)").run(this.maxEvents);
    this.db!.exec("DELETE FROM quota_samples WHERE rowid IN (SELECT rowid FROM quota_samples ORDER BY at DESC LIMIT -1 OFFSET 20000)");
  }

  operations(snapshot: Snapshot): OperationsSnapshot {
    let samples: QuotaSample[] = [];
    try {
      const rows = this.db?.prepare("SELECT at,row FROM quota_samples ORDER BY at DESC LIMIT 20000").all() as { at: string; row: string }[] | undefined;
      samples = rows?.map((r) => ({ at: r.at, row: JSON.parse(r.row) })) ?? [];
    } catch { this.error = L("Không đọc được dữ liệu dự báo hạn mức"); }
    return deriveOperations({ ...snapshot, agents: snapshot.agents.map((a) => this.verifiedAgent(a)) }, this.coverage(), samples);
  }

  private verifiedAgent(agent: AgentInfo, before = "9999-12-31T23:59:59.999Z"): AgentInfo {
    if (!this.db || agent.outcome?.status !== "completed") return agent;
    const review = this.db.prepare("SELECT evidence FROM verifications WHERE agentId = ? AND outcomeAt = ? AND at <= ?").get(agent.id, agent.outcome.at, before) as { evidence: string } | undefined;
    return review ? { ...agent, outcome: { ...agent.outcome, verified: true, summary: L("Sếp đã nghiệm thu: {0}", review.evidence) } } : agent;
  }

  verify(snapshot: Snapshot, agentId: string, outcomeAt: string, evidence: string): void {
    if (!this.db) throw new Error(L("Không ghi được nghiệm thu"));
    const agent = snapshot.agents.find((a) => a.id === agentId);
    if (!agent || agent.state !== "idle" || agent.pending || agent.outcome?.status !== "completed" || agent.outcome.at !== outcomeAt) throw new Error(L("Lượt công việc đã thay đổi; tải lại trước khi nghiệm thu"));
    if (!snapshot.machines.some((m) => m.id === agent.machine && m.online)) throw new Error(L("Máy đã mất kết nối; tải lại trước khi nghiệm thu"));
    const clean = redact(evidence.trim()).slice(0, 1000);
    if (!clean) throw new Error(L("Bằng chứng nghiệm thu không hợp lệ"));
    const at = new Date().toISOString();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = this.db.prepare("INSERT OR IGNORE INTO verifications (agentId,outcomeAt,at,evidence,data) VALUES (?,?,?,?,?)").run(agentId, outcomeAt, at, clean, JSON.stringify(safeAgent(agent)));
      if (result.changes) this.insert({ at, kind: "outcome", title: agent.title, detail: L("Sếp đã nghiệm thu: {0}", clean), agentId: agent.id, project: agent.project, machine: agent.machine, url: agent.nativeUrl }, this.verifiedAgent(agent));
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw new Error(L("Không ghi được nghiệm thu"));
    }
  }

  history(filter: RangeFilter, limit = 500): HistoryResponse {
    if (!this.db) return { events: [], coverage: this.coverage(), truncated: false };
    const rows = this.db.prepare("SELECT * FROM events WHERE at >= ? AND at <= ? AND (? IS NULL OR project = ?) AND (? IS NULL OR machine = ?) ORDER BY at DESC,id DESC LIMIT ?").all(filter.from, filter.to, filter.project ?? null, filter.project ?? null, filter.machine ?? null, filter.machine ?? null, limit + 1) as unknown as EventRow[];
    return { events: rows.slice(0, limit).map(eventValue), coverage: this.coverage(), truncated: rows.length > limit };
  }

  replay(filter: RangeFilter): ReplayResponse {
    if (!this.db) return { frames: [], coverage: this.coverage(), truncated: false };
    const rows = this.db.prepare("SELECT at,length(snapshot) AS bytes FROM frames WHERE at >= ? AND at <= ? ORDER BY at").all(filter.from, filter.to) as { at: string; bytes: number }[];
    const totalBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    const stride = Math.max(1, Math.ceil(rows.length / 239), Math.ceil(totalBytes / (8 * 1024 * 1024)));
    const selected = rows.filter((_, i) => i % stride === 0 || i === rows.length - 1);
    let used = 0;
    const frames = selected.filter((row) => {
      used += row.bytes;
      return used <= 8 * 1024 * 1024;
    }).map((row) => {
      const stored = this.db!.prepare("SELECT snapshot FROM frames WHERE at = ?").get(row.at) as { snapshot: string };
      const snapshot = JSON.parse(stored.snapshot) as Snapshot;
      if (filter.project || filter.machine) snapshot.agents = snapshot.agents.filter((a) => matches(a, filter));
      return { at: row.at, snapshot };
    });
    return { frames, coverage: this.coverage(), truncated: frames.length < rows.length };
  }

  report(date: string, filter: Pick<RangeFilter, "project" | "machine">): DailyReport {
    const range = { ...vietnamDayRange(date), ...filter };
    const history = this.history(range);
    const agents = new Map<string, AgentInfo>();
    let snapshot: Snapshot | null = null;
    if (this.db) {
      const frame = this.db.prepare("SELECT snapshot FROM frames WHERE at >= ? AND at <= ? ORDER BY at DESC LIMIT 1").get(range.from, range.to) as { snapshot: string } | undefined;
      if (frame) {
        snapshot = JSON.parse(frame.snapshot) as Snapshot;
        for (const agent of snapshot.agents) if (matches(agent, filter)) agents.set(agent.id, agent);
      }
      const rows = this.db.prepare("SELECT data,at FROM events WHERE id IN (SELECT MAX(id) FROM events WHERE data IS NOT NULL AND at >= ? AND at <= ? AND (? IS NULL OR project = ?) AND (? IS NULL OR machine = ?) GROUP BY agentId) ORDER BY at,id").all(range.from, range.to, filter.project ?? null, filter.project ?? null, filter.machine ?? null, filter.machine ?? null) as { data: string; at: string }[];
      for (const row of rows) {
        const agent = JSON.parse(row.data) as AgentInfo;
        const old = agents.get(agent.id);
        if (!old || agent.updatedAt >= old.updatedAt) agents.set(agent.id, agent);
      }
    }
    const tasks = [...agents.values()].map((a) => taskCard(this.verifiedAgent(a, range.to), snapshot?.machines.some((m) => m.id === a.machine && m.online) ?? false));
    const completed = tasks.filter((t) => t.stage === "completed");
    if (this.db) {
      const reviews = this.db.prepare("SELECT data,evidence,outcomeAt FROM verifications WHERE at >= ? AND at <= ? ORDER BY at").all(range.from, range.to) as { data: string; evidence: string; outcomeAt: string }[];
      for (const review of reviews) {
        const agent = JSON.parse(review.data) as AgentInfo;
        if (!matches(agent, filter) || completed.some((t) => t.agent.id === agent.id && t.agent.outcome?.at === review.outcomeAt)) continue;
        completed.push({ ...taskCard({ ...agent, pending: null, outcome: { status: "completed", at: review.outcomeAt, summary: L("Sếp đã nghiệm thu: {0}", review.evidence), verified: true } }, false), id: `${agent.id}:${review.outcomeAt}` });
      }
    }
    const review = tasks.filter((t) => t.stage === "review");
    const unfinished = tasks.filter((t) => !["completed", "review"].includes(t.stage));
    const attention = snapshot ? this.operations({ ...snapshot, agents: [...agents.values()] }).attention.filter((a) => (!filter.project || a.project === filter.project) && (!filter.machine || a.machine === filter.machine)) : [];
    return { date, timezone: "Asia/Ho_Chi_Minh", coverage: history.coverage, completed, review, unfinished, attention, events: history.events, summary: L("{0} việc có bằng chứng hoàn tất; {1} lượt cần xem lại; {2} việc còn dở; {3} mục cần xử lý trong dữ liệu đã ghi nhận.", completed.length, review.length, unfinished.length, attention.length), truncated: history.truncated };
  }

  handle(req: IncomingMessage, res: ServerResponse, url: URL, snapshot: Snapshot, latestSnapshot: () => Snapshot = () => snapshot): boolean {
    if (url.pathname === "/api/tasks/verify") {
      this.handleVerification(req, res, latestSnapshot);
      return true;
    }
    if (!["/api/operations", "/api/history", "/api/replay", "/api/report"].includes(url.pathname)) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end();
      return true;
    }
    try {
      let result: unknown;
      const filter = parseRange(url);
      if (url.pathname === "/api/operations") {
        const operations = this.operations(snapshot);
        operations.tasks = operations.tasks.filter((t) => matches(t.agent, filter));
        operations.attention = operations.attention.filter((a) => (!filter.project || a.project === filter.project) && (!filter.machine || a.machine === filter.machine));
        operations.conflicts = operations.conflicts.filter((c) => (!filter.project || c.project === filter.project) && (!filter.machine || c.machine === filter.machine));
        result = operations;
      } else if (url.pathname === "/api/history") result = this.history(filter);
      else if (url.pathname === "/api/replay") result = this.replay(filter);
      else {
        const date = url.searchParams.get("date") ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        result = this.report(date, filter);
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(result));
    } catch (error) {
      const invalid = error instanceof Error && /hợp lệ|invalid|YYYY-MM-DD|7 ngày|7 days/i.test(error.message);
      const message = invalid ? (error as Error).message : L("Không đọc được lịch sử; thử lại sau");
      res.writeHead(invalid ? 400 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    }
    return true;
  }

  private handleVerification(req: IncomingMessage, res: ServerResponse, latestSnapshot: () => Snapshot): void {
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    try {
      const origin = new URL(String(req.headers.origin ?? ""));
      if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) throw new Error("origin");
    } catch {
      reply(403, { error: L("Chỉ nhận nghiệm thu từ giao diện cùng nguồn") });
      return;
    }
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      reply(415, { error: L("Yêu cầu JSON") });
      return;
    }
    let body = "";
    let tooLarge = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > 4096) {
        tooLarge = true;
        reply(413, { error: L("Nội dung quá dài") });
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      let data: { agentId: string; outcomeAt: string; evidence: string };
      try {
        data = JSON.parse(body);
        if (!data || typeof data.agentId !== "string" || data.agentId.length > 300 || typeof data.outcomeAt !== "string" || !Number.isFinite(Date.parse(data.outcomeAt)) || typeof data.evidence !== "string" || !data.evidence.trim() || data.evidence.length > 1000) throw new Error("input");
      } catch {
        reply(400, { error: L("Dữ liệu nghiệm thu không hợp lệ") });
        return;
      }
      try {
        this.verify(latestSnapshot(), data.agentId, data.outcomeAt, data.evidence);
        reply(200, { ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : L("Không ghi được nghiệm thu");
        reply(/tải lại/.test(message) ? 409 : 503, { error: /tải lại|Không ghi|không hợp lệ/.test(message) ? message : L("Không ghi được nghiệm thu") });
      }
    });
  }
}
