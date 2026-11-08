import { L } from "../shared/i18n.ts";
import "./env.ts";
import { httpsRedirect, isHttps, isLoopback, tokenCookie } from "./access.ts";
import { timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentInfo, MachineHealth, MachineId, ProjectsSnapshot, QuotaSnapshot, RoleId, SiteStatus, SkillsSnapshot, Snapshot } from "../shared/types.ts";
import { countClaudeToday, readClaude } from "./sources/claude.ts";
import { countCodexToday, readCodex } from "./sources/codex.ts";
import { readAntigravity } from "./sources/antigravity.ts";
import { SITES, checkSite, readQuota } from "./sources/external.ts";
import { readProjects } from "./sources/github.ts";
import { localHealth } from "./sources/machine.ts";
import { resolveAgentRoles } from "../shared/role-resolve.ts";
import { readSkills } from "./sources/skills.ts";
import { readYouTube } from "./sources/youtube.ts";
import { YouTubeAccount, YouTubeError } from "./sources/youtube-account.ts";
import { YT_FEEDS, type YtFeedKind } from "../shared/youtube.ts";
import { readAutomation } from "./sources/automation.ts";
import { demoAgents, demoHealth, demoProjects, demoQuota, demoSites, demoSkills } from "./demo.ts";
import type { AutomationJob, AutomationReport } from "../shared/automation.ts";
import { readSystemInventory } from "./sources/system.ts";
import type { SystemInventory, SystemReport } from "../shared/system.ts";
import { resolveMessages } from "../shared/messages.ts";
import { serveStatic } from "./static.ts";
import { proxyQuota } from "./sources/quota-app.ts";
import { OperationsStore } from "./operations.ts";
import { ReplyBroker } from "./replies.ts";
import { createCodexReplyAdapter } from "./reply-adapters/codex.ts";
import { createReplyHandler } from "./reply-http.ts";
import { createClaudeReplyAdapter } from "./reply-adapters/claude.ts";
import { ClaudeHookRegistry } from "./claude-hook.ts";
import { ControlBroker } from "./controls.ts";
import { createControlHandler } from "./control-http.ts";
import { createClaudeControlAdapter } from "./control-adapters/claude.ts";
import { createCodexControlAdapter } from "./control-adapters/codex.ts";
import { DispatchBroker } from "./dispatch.ts";
import { createBridgeDispatchAdapter } from "./dispatch-bridge.ts";
import { createDispatchHandler } from "./dispatch-http.ts";
import { localEvents, MailSync, parseAccounts, readCalendarRange, readInbox, readMail, trashMail } from "./sources/inbox.ts";
import { watchMailbox } from "./sources/imap-idle.ts";
import { LOCAL_PREFIX, LocalEventError, validateInput } from "./sources/local-events.ts";
import { TodoError, TodoStore, validateCreate, validatePatch } from "./sources/todos.ts";
import { EMPTY_INBOX, inboxContentKey, mergeMailAccount, type InboxSnapshot, type MailContent } from "../shared/inbox.ts";
import { EMPTY_GITHUB, parsePinned, type GitAction, type GitHubSnapshot } from "../shared/github.ts";
import { markAllRead, readGitHub, runGitAction } from "./sources/github-items.ts";

const MACHINES: MachineId[] = ["WORKSTATION", "SERVER", "LAPTOP"];
const PORT = Number(process.env.MSC_PORT ?? 5190);
const HOSTS = [...new Set((process.env.MSC_HOST ?? "127.0.0.1").split(",").map((h) => h.trim()).filter(Boolean))];
const AGENT_POLL_MS = 2000;
const SLOW_POLL_MS = 15000;
const COUNT_POLL_MS = 30000;
const STREAM_PING_MS = 10000;
const PROJECTS_POLL_MS = 300000;
const INBOX_POLL_MS = 120000;
const MAIL_POLL_MS = 30000;
const AUTOMATION_POLL_MS = 300000;
const SYSTEM_POLL_MS = 30000;
const GITHUB_POLL_MS = 120000;
const GITHUB_PINNED = parsePinned(process.env.MSC_GITHUB_PINNED ?? "");
const GITHUB_ACTIONS: GitAction[] = ["rerun", "merge", "close", "read"];
const COLLECTOR_TIMEOUT_MS = 2500;
const IS_COLLECTOR = process.env.MSC_ROLE === "collector";
const DEMO = /^(1|true|yes|on)$/i.test((process.env.MSC_DEMO ?? "").trim());
const PUBLIC_URL = (process.env.MSC_PUBLIC_URL ?? "").trim();
const TOKEN = (process.env.MSC_TOKEN ?? "").trim();
const REMOTE_TOKEN = (process.env.MSC_COLLECTOR_TOKEN ?? TOKEN).trim();
const operations = IS_COLLECTOR ? null : new OperationsStore();
const TOKEN_HEADER = "x-msc-token";

const TOKEN_COOKIE = "msc_token";
const TOKEN_FIELD = "key";
const LOGIN_PATH = "/login";
const LOGIN_BODY_MAX = 2048;
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;
const HOST_RETRY_MS = 10000;
function sameToken(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenOk(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true;
  return sameToken(String(req.headers[TOKEN_HEADER] ?? ""));
}

function cookieToken(req: http.IncomingMessage): string {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === TOKEN_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

function viewerOk(req: http.IncomingMessage): boolean {
  if (!TOKEN || isLoopback(req)) return true;
  return tokenOk(req) || sameToken(cookieToken(req));
}

function sendLogin(res: http.ServerResponse, wrong: boolean): void {
  res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(L("<!doctype html><html lang=\"vi\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>AI Agent Company</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaf0;font:16px system-ui,sans-serif}form{display:grid;gap:12px;width:min(340px,calc(100vw - 32px))}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #333a46;background:#171a21;color:inherit}button{background:#2d6cdf;border-color:#2d6cdf;cursor:pointer}p{margin:0;color:#ff7b7b}</style></head><body><form method=\"post\" action=\"{0}\"><label for=\"k\">Mã truy cập</label><input id=\"k\" name=\"{1}\" type=\"password\" autocomplete=\"current-password\" autofocus required>{2}<button type=\"submit\">Vào</button></form></body></html>", LOGIN_PATH, TOKEN_FIELD, wrong ? L("<p>Mã không đúng</p>") : ""));
}

function setTokenCookie(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(303, {
    location: "/",
    "set-cookie": tokenCookie(TOKEN_COOKIE, TOKEN, COOKIE_MAX_AGE_S, isHttps(req)),
    "cache-control": "no-store",
  });
  res.end();
}

function handleLogin(req: http.IncomingMessage, res: http.ServerResponse): void {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => {
    body += chunk;
    if (body.length > LOGIN_BODY_MAX) req.destroy();
  });
  req.on("end", () => {
    const key = new URLSearchParams(body).get(TOKEN_FIELD) ?? "";
    if (TOKEN && sameToken(key.trim())) setTokenCookie(req, res);
    else sendLogin(res, true);
  });
}

function resolveMachine(): MachineId {
  const fromEnv = process.env.MSC_MACHINE as MachineId | undefined;
  if (fromEnv && MACHINES.includes(fromEnv)) return fromEnv;
  return process.platform === "darwin" ? "LAPTOP" : "WORKSTATION";
}

function parseCollectors(): Map<MachineId, string> {
  const map = new Map<MachineId, string>();
  for (const pair of (process.env.MSC_COLLECTORS ?? "").split(",")) {
    const [id, url] = pair.split("=").map((s) => s?.trim());
    if (id && url && MACHINES.includes(id as MachineId)) map.set(id as MachineId, url.replace(/\/+$/, ""));
  }
  return map;
}

const SELF = resolveMachine();
const COLLECTORS = parseCollectors();

interface MachineFeed {
  agents: AgentInfo[];
  health: MachineHealth;
  tasksToday: number;
  automation?: AutomationJob[];
  automationAt?: string;
  system?: SystemInventory;
}

let localFeed: MachineFeed = { agents: [], health: offlineHealth(SELF), tasksToday: 0 };
const dispatch = new DispatchBroker({ adapter: createBridgeDispatchAdapter(), onChange: () => setTimeout(() => broadcast(true), 0) });
const remoteFeeds = new Map<MachineId, MachineFeed>();
let automation: { jobs: AutomationJob[]; at: string } | null = null;
let systemInventory: SystemInventory | null = null;
const CLAUDE_HOOK_FILE = (process.env.MSC_CLAUDE_HOOK_FILE ?? "").trim();
const claudeHooks = new ClaudeHookRegistry({ machine: SELF, getLocalAgents: readLocalAgents, ...(CLAUDE_HOOK_FILE ? { endpointFile: CLAUDE_HOOK_FILE } : {}) });
const replies = new ReplyBroker({ adapters: [createCodexReplyAdapter(SELF), createClaudeReplyAdapter(claudeHooks, SELF)], timeoutMs: 12_000 });
const controls = new ControlBroker({
  adapters: [createCodexControlAdapter(SELF), createClaudeControlAdapter(claudeHooks, SELF)],
  timeoutMs: 15_000,
  send: async (agents) => new Map((await dispatch.targets(agents)).map((target) => [target.agentId, { available: target.available, reason: target.reason }])),
});
const ACTION_HOSTS = [...HOSTS.filter((host) => host !== "0.0.0.0" && host !== "::").map((host) => `${host.includes(":") ? `[${host}]` : host}:${PORT}`), ...(PUBLIC_URL ? [new URL(PUBLIC_URL).host] : []), ...(process.env.MSC_REPLY_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean)];
const handleDispatch = createDispatchHandler({
  broker: dispatch,
  self: SELF,
  getLocalAgents: readLocalAgents,
  getAgents: () => buildSnapshot().agents,
  collectors: IS_COLLECTOR ? new Map() : COLLECTORS,
  token: TOKEN,
  remoteToken: REMOTE_TOKEN,
  allowedHosts: ACTION_HOSTS,
  isMachineOnline: (machine) => buildSnapshot().machines.some((entry) => entry.id === machine && entry.online),
  timeoutMs: 30_000,
});
const handleReplies = createReplyHandler({
  broker: replies,
  self: SELF,
  getLocalAgents: readLocalAgents,
  getAgents: () => buildSnapshot().agents,
  collectors: IS_COLLECTOR ? new Map() : COLLECTORS,
  token: TOKEN,
  remoteToken: REMOTE_TOKEN,
  allowedHosts: ACTION_HOSTS,
  isMachineOnline: (machine) => buildSnapshot().machines.some((entry) => entry.id === machine && entry.online),
  timeoutMs: 30_000,
});
const handleControls = createControlHandler({
  broker: controls,
  self: SELF,
  getLocalAgents: readLocalAgents,
  getAgents: () => buildSnapshot().agents,
  collectors: IS_COLLECTOR ? new Map() : COLLECTORS,
  token: TOKEN,
  remoteToken: REMOTE_TOKEN,
  allowedHosts: ACTION_HOSTS,
  isMachineOnline: (machine) => buildSnapshot().machines.some((entry) => entry.id === machine && entry.online),
  timeoutMs: 30_000,
});
let quota: QuotaSnapshot = { connected: false, rows: [], fetchedAt: null };
let sites: SiteStatus[] = [];
let tasksToday = 0;
let skills: SkillsSnapshot = { connected: false, note: L("Đang đọc thư viện skill"), total: 0, groups: [] };
let projects: ProjectsSnapshot = { connected: false, note: L("Đang đọc GitHub"), repos: [], fetchedAt: null };
let inbox: InboxSnapshot = EMPTY_INBOX;
let inboxPromise: Promise<void> | null = null;
const MAX_EVENT_BODY = 16 * 1024;

function sameOrigin(req: IncomingMessage): boolean {
  try {
    const origin = new URL(String(req.headers.origin ?? ""));
    const site = req.headers["sec-fetch-site"];
    return ["http:", "https:"].includes(origin.protocol) && origin.host === req.headers.host && (!site || site === "same-origin");
  } catch {
    return false;
  }
}

function readJson(req: IncomingMessage, limit: number, invalid = L("Dữ liệu sự kiện không hợp lệ")): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      size += Buffer.byteLength(chunk);
      if (size > limit) {
        reject(new LocalEventError(L("Nội dung quá dài")));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new LocalEventError(invalid));
      }
    });
    req.on("error", reject);
  });
}

async function handleLocalEvent(req: IncomingMessage, res: ServerResponse, rawId: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const id = rawId.startsWith(LOCAL_PREFIX) ? rawId.slice(LOCAL_PREFIX.length) : rawId;
  const allowed = id ? ["PUT", "DELETE"] : ["POST"];
  if (!allowed.includes(req.method ?? "")) {
    res.writeHead(405, { Allow: allowed.join(", ") }).end();
    return;
  }
  if (!sameOrigin(req)) return reply(403, { error: L("Chỉ nhận thao tác từ chính trang này") });
  if (id && !/^[0-9a-f-]{36}$/.test(id)) return reply(404, { error: L("Không tìm thấy sự kiện") });
  try {
    if (req.method === "DELETE") return localEvents.remove(id) ? reply(200, { ok: true }) : reply(404, { error: L("Không tìm thấy sự kiện") });
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415, { error: L("Yêu cầu JSON") });
    const input = validateInput(await readJson(req, MAX_EVENT_BODY));
    if (req.method === "POST") return reply(201, localEvents.create(input));
    const updated = localEvents.update(id, input);
    return updated ? reply(200, updated) : reply(404, { error: L("Không tìm thấy sự kiện") });
  } catch (error) {
    if (error instanceof LocalEventError) return reply(400, { error: error.message });
    console.error("[calendar] local event write failed:", error instanceof Error ? error.message : error);
    return reply(500, { error: L("Không lưu được sự kiện trên hub") });
  }
}

const todos = new TodoStore();
const MAX_TODO_BODY = 8 * 1024;

async function handleTodos(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const allowed = id ? ["PATCH", "DELETE"] : ["GET", "POST"];
  if (!allowed.includes(req.method ?? "")) {
    res.writeHead(405, { Allow: allowed.join(", ") }).end();
    return;
  }
  try {
    if (req.method === "GET") return reply(200, { todos: todos.list() });
    if (!sameOrigin(req)) return reply(403, { error: L("Chỉ nhận thao tác từ chính trang này") });
    if (id && !/^[0-9a-f-]{36}$/.test(id)) return reply(404, { error: L("Không tìm thấy việc") });
    let status = 200;
    let body: unknown = { ok: true };
    if (req.method === "DELETE") {
      if (!todos.remove(id)) return reply(404, { error: L("Không tìm thấy việc") });
    } else {
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415, { error: L("Yêu cầu JSON") });
      const raw = await readJson(req, MAX_TODO_BODY, L("Dữ liệu công việc không hợp lệ"));
      if (req.method === "POST") {
        status = 201;
        body = todos.create(validateCreate(raw));
      } else {
        body = todos.update(id, validatePatch(raw));
        if (!body) return reply(404, { error: L("Không tìm thấy việc") });
      }
    }
    for (const client of clients) client.write("event: todos\ndata: {}\n\n");
    return reply(status, body);
  } catch (error) {
    if (error instanceof TodoError || error instanceof LocalEventError) return reply(400, { error: error.message });
    console.error("[todos] write failed:", error instanceof Error ? error.message : error);
    return reply(500, { error: L("Không lưu được việc trên hub") });
  }
}

const youtubeAccount = new YouTubeAccount();

async function handleYouTube(req: IncomingMessage, res: ServerResponse, route: string, query: URLSearchParams): Promise<void> {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const method = req.method ?? "GET";
  if (method !== "GET" && !sameOrigin(req)) return reply(403, { error: L("Chỉ nhận thao tác từ chính trang này") });
  try {
    if (route === "status" && method === "GET") return reply(200, youtubeAccount.status());
    if (route === "connect" && method === "POST") return reply(200, await youtubeAccount.startDeviceFlow());
    if (route === "cancel" && method === "POST") {
      youtubeAccount.cancelDeviceFlow();
      return reply(200, youtubeAccount.status());
    }
    if (route === "logout" && method === "POST") return reply(200, await youtubeAccount.logout());
    const kind = route.startsWith("feed/") ? route.slice("feed/".length) : "";
    if (method === "GET" && (YT_FEEDS as readonly string[]).includes(kind)) {
      return reply(200, await youtubeAccount.feed(kind as YtFeedKind, query.get("q") ?? query.get("id") ?? ""));
    }
    return reply(404, { error: L("Không có thao tác này") });
  } catch (error) {
    if (error instanceof YouTubeError) return reply(error.status, { error: error.message });
    console.error("[youtube] request failed:", error instanceof Error ? error.message : error);
    return reply(502, { error: L("Không kết nối được YouTube. Thử lại sau.") });
  }
}
const mailCache = new Map<string, MailContent>();
const mailPending = new Map<string, Promise<MailContent | null>>();
const MAIL_CACHE_SIZE = 30;

function rememberMail(id: string, mail: MailContent | null): MailContent | null {
  if (!mail) return null;
  mailCache.set(id, mail);
  if (mailCache.size > MAIL_CACHE_SIZE) mailCache.delete(mailCache.keys().next().value!);
  return mail;
}

function trackMail(id: string, job: Promise<MailContent | null>): Promise<MailContent | null> {
  const tracked = job.then((mail) => rememberMail(id, mail)).finally(() => {
    if (mailPending.get(id) === tracked) mailPending.delete(id);
  });
  mailPending.set(id, tracked);
  return tracked;
}

function cachedMail(id: string): Promise<MailContent | null> {
  const hit = mailCache.get(id);
  if (hit) return Promise.resolve(hit);
  return mailPending.get(id) ?? trackMail(id, readMail(id));
}

async function readLocalAgents(): Promise<AgentInfo[]> {
  const results = await Promise.allSettled([readClaude(SELF), readCodex(SELF), Promise.resolve(readAntigravity(SELF))]);
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).map(withHookWait);
}

function withHookWait(agent: AgentInfo): AgentInfo {
  if (agent.app !== "claude" || agent.parentId || !agent.sessionId) return agent;
  const first = claudeHooks.pending(agent.sessionId)[0];
  if (!first) return agent;
  const question = first.toolName === "AskUserQuestion" ? L("Claude đang hỏi sếp") : first.toolName === "ExitPlanMode" ? L("Claude chờ duyệt kế hoạch") : L("Claude xin quyền dùng {0}", first.toolName);
  return { ...agent, state: "waiting", pending: agent.pending ?? { question, options: [], askedAt: first.receivedAt, kind: "question" } };
}

async function pollRemote(id: MachineId, url: string): Promise<void> {
  try {
    const res = await fetch(`${url}/collector`, {
      headers: REMOTE_TOKEN ? { [TOKEN_HEADER]: REMOTE_TOKEN } : {},
      signal: AbortSignal.timeout(COLLECTOR_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`collector ${id} HTTP ${res.status}`);
    remoteFeeds.set(id, (await res.json()) as MachineFeed);
  } catch {
    remoteFeeds.delete(id);
  }
}

function offlineHealth(id: MachineId): MachineHealth {
  return {
    id,
    online: false,
    source: COLLECTORS.has(id) ? "collector" : "none",
    cpu: null,
    cpuModel: null,
    cores: null,
    memUsed: null,
    memTotal: null,
    netRxBps: null,
    netTxBps: null,
    diskUsed: null,
    diskTotal: null,
    gpu: null,
    os: null,
    lanIp: null,
    tailscaleIp: null,
    uptimeSec: null,
    checkedAt: new Date().toISOString(),
  };
}

const firmRoles = new Map<string, RoleId>();

function buildSnapshot(): Snapshot {
  const feeds = new Map<MachineId, MachineFeed>([[SELF, localFeed], ...remoteFeeds]);
  const agents = resolveAgentRoles(DEMO ? demoAgents() : [...feeds.values()].flatMap((f) => f.agents), firmRoles);
  const machines = DEMO ? demoHealth() : MACHINES.map((id) => feeds.get(id)?.health ?? offlineHealth(id));
  const recent = agents.filter((a) => a.state !== "idle" || Date.now() - Date.parse(a.updatedAt) < 30 * 60_000);
  return {
    generatedAt: new Date().toISOString(),
    agents,
    messages: [...resolveMessages(agents), ...dispatch.receipts().map((receipt) => ({
      id: receipt.id, fromId: "human-web", toId: receipt.targetAgentId, targetMachine: receipt.targetMachine,
      via: "agent-bridge" as const, at: receipt.at, updatedAt: receipt.updatedAt,
      summary: receipt.summary, status: receipt.status, detail: receipt.detail,
    }))].sort((a, b) => (a.updatedAt ?? a.at).localeCompare(b.updatedAt ?? b.at)).slice(-100),
    machines,
    sites,
    quota,
    activity: {
      tasksToday: DEMO ? 37 : [...feeds.values()].reduce((n, f) => n + f.tasksToday, 0),
      activeProjects: new Set(recent.map((a) => `${a.machine}:${a.project}`)).size,
      agentsWorking: agents.filter((a) => a.state === "working" || a.state === "thinking").length,
      machinesOnline: machines.filter((m) => m.online).length,
      machinesTotal: machines.length,
    },
    skills,
    projects,
  };
}

const clients = new Set<http.ServerResponse>();
let lastPayload = "";

function broadcast(force = false): void {
  const snap = buildSnapshot();
  operations?.observe(snap);
  const { generatedAt, ...comparable } = snap;
  const key = JSON.stringify(comparable);
  if (!force && key === lastPayload) return;
  lastPayload = key;
  const data = `data: ${JSON.stringify(snap)}\n\n`;
  for (const res of clients) res.write(data);
  void generatedAt;
}

async function agentTick(): Promise<void> {
  const [localAgents, health] = await Promise.all([readLocalAgents(), localHealth(SELF)]);
  localFeed = { agents: localAgents, health, tasksToday, ...(automation ? { automation: automation.jobs, automationAt: automation.at } : {}), ...(systemInventory ? { system: systemInventory } : {}) };
  if (IS_COLLECTOR) return;
  await Promise.all([...COLLECTORS].map(([id, url]) => pollRemote(id, url)));
  broadcast();
}

async function slowTick(): Promise<void> {
  const [q, s] = await Promise.all([readQuota(), Promise.all(SITES.map((x) => checkSite(x.url, x.label)))]);
  quota = DEMO ? demoQuota() : q;
  sites = DEMO ? demoSites() : s;
  broadcast();
}

async function skillsTick(): Promise<void> {
  skills = DEMO ? demoSkills() : await readSkills();
  broadcast();
}

async function projectsTick(): Promise<void> {
  projects = DEMO ? demoProjects() : await readProjects();
  broadcast();
}

let github: GitHubSnapshot = EMPTY_GITHUB;
let githubRun: Promise<void> | null = null;

function githubTick(): Promise<void> {
  if (DEMO) {
    github = { ...EMPTY_GITHUB, connected: true, note: "", login: "demo", fetchedAt: new Date().toISOString(), repos: 4, items: [] };
    return Promise.resolve();
  }
  githubRun ??= readGitHub()
    .then((next) => {
      const changed = JSON.stringify(next.items) !== JSON.stringify(github.items) || next.connected !== github.connected || next.note !== github.note;
      github = next.connected || !github.connected ? next : { ...github, note: next.note };
      if (changed) for (const res of clients) res.write(`event: github
data: ${JSON.stringify(github.fetchedAt)}

`);
    })
    .finally(() => { githubRun = null; });
  return githubRun;
}

async function handleGitHubAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }).end();
    return;
  }
  if (!sameOrigin(req)) return reply(403, { error: L("Chỉ nhận thao tác từ chính trang này") });
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415, { error: L("Yêu cầu JSON") });
  try {
    const body = (await readJson(req, 4096)) as { id?: unknown; action?: unknown };
    if (body.action === "read-all") {
      await markAllRead();
    } else {
      const action = GITHUB_ACTIONS.find((entry) => entry === body.action);
      const item = github.items.find((entry) => entry.id === body.id);
      if (!action || !item) return reply(404, { error: L("Mục này đã thay đổi trên GitHub. Làm mới rồi thử lại.") });
      if (!item.actions.includes(action)) return reply(409, { error: L("Thao tác này không áp dụng cho mục đã chọn.") });
      await runGitAction(item, action);
    }
    if (githubRun) await githubRun.catch(() => undefined);
    await githubTick();
    return reply(200, { ok: true });
  } catch (error) {
    if (error instanceof LocalEventError) return reply(400, { error: error.message });
    return reply(502, { error: L("GitHub từ chối: {0}", error instanceof Error ? error.message : L("lỗi không rõ")) });
  }
}

let inboxDirty = false;
const inboxPushTimers = new Map<string, NodeJS.Timeout>();
const INBOX_PUSH_DEBOUNCE_MS = 1500;
const mailAccounts = parseAccounts(process.env.MSC_GMAIL_ACCOUNTS ?? "");
const mailSync = new MailSync(mailAccounts, (account) => publishInbox(mergeMailAccount(inbox, account, new Date().toISOString())), {
  onError: (error) => logInfo("mail refresh failed", { error: error instanceof Error ? error.message : "unknown" }),
});

function publishInbox(next: InboxSnapshot): void {
  const changed = inboxContentKey(next) !== inboxContentKey(inbox);
  inbox = next;
  if (changed) for (const res of clients) res.write(`event: inbox\ndata: ${JSON.stringify(next.fetchedAt)}\n\n`);
}

async function inboxTick(force = false): Promise<void> {
  if (inboxPromise) {
    if (force) inboxDirty = true;
    return inboxPromise;
  }
  inboxPromise = Promise.all([mailSync.refresh(), readInbox(Date.now(), undefined, [])])
    .then(([, next]) => {
      publishInbox({ ...next, configured: next.configured || mailAccounts.length > 0, accounts: inbox.accounts, fetchedAt: new Date().toISOString() });
    })
    .catch((error) => logInfo("inbox refresh failed", { error: error instanceof Error ? error.message : "unknown" }))
    .finally(() => {
      inboxPromise = null;
      if (inboxDirty) {
        inboxDirty = false;
        void inboxTick();
      }
    });
  return inboxPromise;
}

function mailChanged(address: string): void {
  if (inboxPushTimers.has(address)) return;
  logInfo("mail change pushed by Gmail", {});
  const timer = setTimeout(() => {
    inboxPushTimers.delete(address);
    void mailSync.refresh(address);
  }, INBOX_PUSH_DEBOUNCE_MS);
  inboxPushTimers.set(address, timer);
}

async function countTick(): Promise<void> {
  const [c, x] = await Promise.all([countClaudeToday(), countCodexToday()]);
  tasksToday = c + x;
}

async function automationTick(): Promise<void> {
  automation = { jobs: await readAutomation(), at: new Date().toISOString() };
}

async function systemTick(): Promise<void> {
  systemInventory = await readSystemInventory();
  localFeed = { ...localFeed, system: systemInventory };
}

function systemReport(): SystemReport {
  const feeds = new Map<MachineId, MachineFeed>([[SELF, localFeed], ...remoteFeeds]);
  return {
    generatedAt: new Date().toISOString(),
    machines: MACHINES.map((id) => {
      const feed = feeds.get(id);
      return { id, online: Boolean(feed?.health.online), health: feed?.health ?? offlineHealth(id), inventory: feed?.system ?? null };
    }),
  };
}

function automationReport(): AutomationReport {
  const feeds = new Map<MachineId, MachineFeed>([[SELF, localFeed], ...remoteFeeds]);
  return {
    generatedAt: new Date().toISOString(),
    machines: MACHINES.map((id) => {
      const feed = feeds.get(id);
      return { id, online: Boolean(feed?.health.online), reported: Array.isArray(feed?.automation), checkedAt: feed?.automationAt ?? null, jobs: feed?.automation ?? [] };
    }),
  };
}

function loop(fn: () => Promise<void>, ms: number): void {
  const run = () => fn().catch((err) => console.error(JSON.stringify({ level: "error", at: new Date().toISOString(), msg: String(err) }))).finally(() => setTimeout(run, ms));
  run();
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://hub");
  if (claudeHooks.handle(req, res, url)) return;
  const redirect = IS_COLLECTOR ? null : httpsRedirect(req, `${url.pathname}${url.search}`, PUBLIC_URL);
  if (redirect) {
    res.writeHead(308, { location: redirect, "cache-control": "no-store" });
    res.end();
    return;
  }
  if (handleReplies(req, res, url)) return;
  if (handleControls(req, res, url)) return;
  if (handleDispatch(req, res, url)) return;
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, machine: SELF, role: IS_COLLECTOR ? "collector" : "hub" }));
    return;
  }
  if (url.pathname === "/collector") {
    if (!tokenOk(req)) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(localFeed));
    return;
  }
  if (IS_COLLECTOR) {
    res.writeHead(404).end();
    return;
  }
  if (url.pathname === LOGIN_PATH && req.method === "POST") {
    handleLogin(req, res);
    return;
  }
  if (!viewerOk(req)) {
    if (url.pathname.startsWith("/api/")) res.writeHead(401).end();
    else sendLogin(res, false);
    return;
  }
  if (url.pathname === "/quota" || url.pathname.startsWith("/quota/")) {
    void proxyQuota(req, res, url);
    return;
  }
  if (operations?.handle(req, res, url, buildSnapshot(), buildSnapshot)) return;
  if (url.pathname === "/api/snapshot") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
    res.end(JSON.stringify(buildSnapshot()));
    return;
  }
  if (url.pathname === "/api/inbox") {
    const respond = () => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(inbox));
    };
    if (url.searchParams.get("refresh") === "1") void inboxTick(true);
    respond();
    return;
  }
  if (url.pathname === "/api/todos" || url.pathname.startsWith("/api/todos/")) {
    void handleTodos(req, res, url.pathname.slice("/api/todos/".length));
    return;
  }
  if (url.pathname === "/api/github") {
    const respond = () => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ...github, pinned: GITHUB_PINNED }));
    };
    if (url.searchParams.get("refresh") === "1") void githubTick().then(respond, respond);
    else respond();
    return;
  }
  if (url.pathname === "/api/github/action") {
    void handleGitHubAction(req, res);
    return;
  }
  if (url.pathname.startsWith("/api/youtube/")) {
    void handleYouTube(req, res, url.pathname.slice("/api/youtube/".length), url.searchParams);
    return;
  }
  if (url.pathname === "/api/youtube") {
    void readYouTube().then((feed) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(feed));
    });
    return;
  }
  if (url.pathname === "/api/automation") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(automationReport()));
    return;
  }
  if (url.pathname === "/api/system") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(systemReport()));
    return;
  }
  if (url.pathname === "/api/calendar/events" || url.pathname.startsWith("/api/calendar/events/")) {
    void handleLocalEvent(req, res, url.pathname.slice("/api/calendar/events/".length));
    return;
  }
  if (url.pathname === "/api/calendar") {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    readCalendarRange(Number(url.searchParams.get("from")), Number(url.searchParams.get("to"))).then(
      (range) => (range ? reply(200, range) : reply(400, { error: L("Khoảng thời gian không hợp lệ.") })),
      () => reply(502, { error: L("Không tải được lịch. Thử lại sau.") }),
    );
    return;
  }
  if (url.pathname === "/api/mail") {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const id = url.searchParams.get("id") ?? "";
    if (req.method === "DELETE") {
      if (!sameOrigin(req)) return reply(403, { error: L("Chỉ nhận thao tác từ chính trang này") });
      trashMail(id).then(
        (done) => {
          if (!done) return reply(404, { error: L("Không tìm thấy thư này.") });
          mailCache.delete(id);
          inbox = { ...inbox, accounts: inbox.accounts.map((account) => ({ ...account, recent: account.recent.filter((message) => message.id !== id) })) };
          for (const client of clients) client.write(`event: inbox\ndata: ${JSON.stringify(inbox.fetchedAt)}\n\n`);
          void inboxTick(true);
          reply(200, { ok: true });
        },
        () => reply(502, { error: L("Gmail không trả lời. Thử lại sau.") }),
      );
      return;
    }
    cachedMail(id).then(
      (mail) => (mail ? reply(200, mail) : reply(404, { error: L("Không tìm thấy thư này.") })),
      () => reply(502, { error: L("Gmail không trả lời. Thử lại sau.") }),
    );
    return;
  }
  if (url.pathname === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), STREAM_PING_MS);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }
  void serveStatic(url.pathname, res).then((served) => {
    if (!served) res.writeHead(404).end();
  });
}

function logInfo(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", at: new Date().toISOString(), msg, ...extra }));
}

function listenOn(host: string): void {
  const server = http.createServer(handleRequest);
  server.once("error", (err: NodeJS.ErrnoException) => {
    console.error(JSON.stringify({ level: "error", at: new Date().toISOString(), msg: `listen ${host}:${PORT} failed: ${err.code ?? err.message}, retry in ${HOST_RETRY_MS}ms` }));
    server.close();
    setTimeout(() => listenOn(host), HOST_RETRY_MS);
  });
  server.listen(PORT, host, () => {
    logInfo(`${IS_COLLECTOR ? "collector" : "hub"} ${SELF} on http://${host}:${PORT}`, { token: TOKEN ? "set" : "none" });
    if (host === HOOK_HOST) {
      void ensureHookEndpoint();
      setInterval(() => void ensureHookEndpoint(), HOOK_ENDPOINT_CHECK_MS).unref();
    }
  });
}

const HOOK_HOST = HOSTS.find((host) => host === "127.0.0.1" || host === "::1" || host === "localhost") ?? HOSTS[0];
const HOOK_ENDPOINT_CHECK_MS = 30_000;
let hookEndpointOwned: boolean | null = null;

async function ensureHookEndpoint(): Promise<void> {
  let owned = false;
  try { owned = await claudeHooks.ensureEndpoint({ host: HOOK_HOST, port: PORT }); } catch (error) {
    console.error(JSON.stringify({ level: "error", at: new Date().toISOString(), msg: `claude hook endpoint not written: ${error instanceof Error ? error.message : String(error)}` }));
  }
  if (owned !== hookEndpointOwned) logInfo(owned ? "claude hook endpoint owned" : "claude hook endpoint owned by another live hub; not taking it", { file: CLAUDE_HOOK_FILE || "default" });
  hookEndpointOwned = owned;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { claudeHooks.close(); process.exit(0); });

for (const host of HOSTS) listenOn(host);
logInfo("polling started", { collectors: [...COLLECTORS.keys()] });
void countTick().then(() => {
  loop(agentTick, AGENT_POLL_MS);
  if (!IS_COLLECTOR) {
    loop(slowTick, SLOW_POLL_MS);
    loop(projectsTick, PROJECTS_POLL_MS);
    loop(skillsTick, PROJECTS_POLL_MS);
    loop(githubTick, GITHUB_POLL_MS);
    loop(inboxTick, INBOX_POLL_MS);
    setTimeout(() => loop(() => mailSync.refresh(undefined, false), MAIL_POLL_MS), MAIL_POLL_MS);
    for (const account of mailAccounts) watchMailbox(account, () => mailChanged(account.address), { allMail: true });
  }
  loop(countTick, COUNT_POLL_MS);
  loop(automationTick, AUTOMATION_POLL_MS);
  loop(systemTick, SYSTEM_POLL_MS);
});
