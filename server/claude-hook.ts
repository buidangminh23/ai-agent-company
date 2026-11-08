import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentInfo, MachineId } from "../shared/types.ts";

export type ClaudeHookDecision = { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: "deny"; message: string; interrupt?: boolean };

export interface ClaudeHookEntry {
  id: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions: unknown[] | null;
  receivedAt: string;
}

export interface ClaudeHookRegistryOptions {
  machine: MachineId;
  getLocalAgents: () => Promise<AgentInfo[]>;
  home?: string;
  now?: () => number;
  agentsTimeoutMs?: number;
  endpointFile?: string;
  probeTimeoutMs?: number;
}

interface Held extends ClaudeHookEntry {
  res: ServerResponse;
  nonce: string;
}

export const CLAUDE_HOOK_PATH = "/hook/claude/permission";
export const CLAUDE_HOOK_MARKER = "claude-control-hook.mjs";
export const CLAUDE_STOP_MESSAGE = "Sếp đã dừng lượt này từ web công ty";
const MAX_PENDING = 64;
const BODY_LIMIT = 256 * 1024;
const INSTALL_CACHE_MS = 5000;
const SESSION = /^[A-Za-z0-9_-]{1,200}$/;
const NONCE = /^[a-f0-9]{32}$/;
const SECRET = /^[a-f0-9]{64}$/;
const PROBE_TIMEOUT_MS = 1500;

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const normalizedCwd = (value: string) => /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\") ? path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase() : path.posix.normalize(value).replace(/\/+$/, "") || "/";

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

function tokenEqual(value: string, expected: string): boolean {
  if (!expected || !value || value.length > 4096) return false;
  const given = Buffer.from(value);
  const target = Buffer.from(expected);
  return given.length === target.length && timingSafeEqual(given, target);
}

function reply(res: ServerResponse, status: number, body?: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (body === undefined) { res.writeHead(status, { "cache-control": "no-store" }); res.end(); return; }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

function gone(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return true;
  try { process.kill(pid as number, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export function claudeHookSignature(key: string, nonce: string, body: string | Buffer): string {
  return createHmac("sha256", key).update(`${nonce}\n`).update(body).digest("hex");
}

function signatureValid(key: string, nonce: string, body: string, signature: unknown): boolean {
  if (typeof signature !== "string" || !SECRET.test(signature)) return false;
  return timingSafeEqual(Buffer.from(claudeHookSignature(key, nonce, body), "hex"), Buffer.from(signature, "hex"));
}

export function probeClaudeHookEndpoint(endpoint: Record<string, unknown> | null, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const { url: raw, token, key } = endpoint ?? {};
  if (typeof raw !== "string" || typeof token !== "string" || typeof key !== "string" || !SECRET.test(token) || !SECRET.test(key)) return Promise.resolve(false);
  let url: URL;
  try { url = new URL(raw); } catch { return Promise.resolve(false); }
  if (url.protocol !== "http:" || url.pathname !== CLAUDE_HOOK_PATH || url.username || url.password) return Promise.resolve(false);
  const nonce = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); request.destroy(); resolve(value); };
    const request = http.request(url, { method: "GET", agent: false, headers: { "x-msc-hook-token": token, "x-msc-hook-nonce": nonce } }, (response) => {
      response.resume();
      response.once("end", () => done(response.statusCode === 204 && signatureValid(key, nonce, "", response.headers["x-msc-hook-signature"])));
      response.once("error", () => done(false));
      response.once("aborted", () => done(false));
    });
    const timer = setTimeout(() => done(false), timeoutMs);
    request.once("error", () => done(false));
    request.end();
  });
}

function readBody(req: IncomingMessage): Promise<Buffer | number> {
  const declared = header(req, "content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > BODY_LIMIT)) return Promise.resolve(413);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | number) => { if (done) return; done = true; req.off("data", data); if (typeof value === "number") req.pause(); resolve(value); };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > BODY_LIMIT) finish(413); else chunks.push(chunk); };
    req.on("data", data);
    req.once("end", () => finish(Buffer.concat(chunks)));
    req.once("error", () => finish(400));
    req.once("aborted", () => finish(400));
  });
}

function hookCommands(settings: Record<string, unknown> | null, event: string): boolean {
  const groups = record(settings?.hooks)?.[event];
  return Array.isArray(groups) && groups.some((group) => Array.isArray(record(group)?.hooks) && (record(group)!.hooks as unknown[]).some((hook) => typeof record(hook)?.command === "string" && (record(hook)!.command as string).includes(CLAUDE_HOOK_MARKER)));
}

export function validClaudeDecision(value: unknown): value is ClaudeHookDecision {
  const decision = record(value);
  if (!decision) return false;
  if (decision.behavior === "allow") return Object.keys(decision).every((key) => ["behavior", "updatedInput", "updatedPermissions"].includes(key)) && (decision.updatedInput === undefined || record(decision.updatedInput) !== null) && (decision.updatedPermissions === undefined || Array.isArray(decision.updatedPermissions));
  if (decision.behavior === "deny") return Object.keys(decision).every((key) => ["behavior", "message", "interrupt"].includes(key)) && typeof decision.message === "string" && decision.message.length > 0 && decision.message.length <= 8000 && (decision.interrupt === undefined || typeof decision.interrupt === "boolean");
  return false;
}

export class ClaudeHookRegistry {
  readonly token = randomBytes(32).toString("hex");
  readonly key = randomBytes(32).toString("hex");
  private readonly machine: MachineId;
  private readonly getLocalAgents: () => Promise<AgentInfo[]>;
  private readonly home: string;
  private readonly now: () => number;
  private readonly agentsTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly held = new Map<string, Held>();
  private installCache: { at: number; value: { permission: boolean; stop: boolean } } | null = null;
  private readonly endpointPath: string;
  private endpointFile: string | null = null;

  constructor(options: ClaudeHookRegistryOptions) {
    this.machine = options.machine;
    this.getLocalAgents = options.getLocalAgents;
    this.home = options.home ?? os.homedir();
    this.now = options.now ?? Date.now;
    this.agentsTimeoutMs = options.agentsTimeoutMs ?? 5000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.endpointPath = path.resolve(options.endpointFile ?? path.join(this.home, ".msc-company", "claude-hook.json"));
  }

  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (url.pathname !== CLAUDE_HOOK_PATH) return false;
    void this.receive(req, res).catch(() => reply(res, 500, { error: "hook" }));
    return true;
  }

  pending(sessionId: string): ClaudeHookEntry[] {
    return [...this.held.values()].filter((entry) => entry.sessionId === sessionId && !entry.res.destroyed && !entry.res.writableEnded).map(({ res: _res, nonce: _nonce, ...entry }) => structuredClone(entry));
  }

  resolve(id: string, decision: ClaudeHookDecision): boolean {
    const entry = this.held.get(id);
    if (!entry || !validClaudeDecision(decision)) return false;
    this.held.delete(id);
    if (entry.res.destroyed || entry.res.writableEnded || entry.res.headersSent) return false;
    const body = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    entry.res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-msc-hook-signature": claudeHookSignature(this.key, entry.nonce, body) });
    entry.res.end(body);
    return true;
  }

  stop(sessionId: string): { interrupted: boolean } | null {
    if (!SESSION.test(sessionId)) return null;
    let interrupted = false;
    for (const entry of [...this.held.values()]) if (entry.sessionId === sessionId && this.resolve(entry.id, { behavior: "deny", message: CLAUDE_STOP_MESSAGE, interrupt: true })) interrupted = true;
    if (interrupted) { this.clearStop(sessionId); return { interrupted }; }
    const dir = path.join(this.home, ".msc-company", "claude-control", "stop");
    this.secureDir(dir);
    const file = path.join(dir, sessionId);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ at: new Date(this.now()).toISOString(), author: "human-web" }), { mode: 0o600 });
    renameSync(temp, file);
    return { interrupted };
  }

  clearStop(sessionId: string): void {
    if (!SESSION.test(sessionId)) return;
    try { unlinkSync(path.join(this.home, ".msc-company", "claude-control", "stop", sessionId)); } catch {}
  }

  installed(): { permission: boolean; stop: boolean } {
    const at = this.now();
    if (this.installCache && at - this.installCache.at >= 0 && at - this.installCache.at < INSTALL_CACHE_MS) return { ...this.installCache.value };
    let settings: Record<string, unknown> | null = null;
    try { settings = record(JSON.parse(readFileSync(path.join(this.home, ".claude", "settings.json"), "utf8"))); } catch { settings = null; }
    const value = { permission: hookCommands(settings, "PermissionRequest"), stop: hookCommands(settings, "PreToolUse") && hookCommands(settings, "UserPromptSubmit") };
    this.installCache = { at, value };
    return { ...value };
  }

  writeEndpoint(address: { host: string; port: number }): string {
    const host = address.host === "0.0.0.0" || address.host === "" ? "127.0.0.1" : address.host === "::" ? "::1" : address.host;
    const url = `http://${host.includes(":") ? `[${host}]` : host}:${address.port}${CLAUDE_HOOK_PATH}`;
    const file = this.endpointPath;
    const dir = path.dirname(file);
    if (dir === path.resolve(this.home, ".msc-company")) this.secureDir(dir);
    else mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ url, token: this.token, key: this.key, pid: process.pid, machine: this.machine }, null, 2), { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temp, 0o600);
    renameSync(temp, file);
    this.endpointFile = file;
    return file;
  }

  async ensureEndpoint(address: { host: string; port: number }): Promise<boolean> {
    const current = this.readEndpoint();
    if (current === false) return false;
    if (current?.token === this.token && current.key === this.key && current.pid === process.pid) { this.endpointFile = this.endpointPath; return true; }
    if (current && current.pid !== process.pid && !gone(current.pid) && await probeClaudeHookEndpoint(current, this.probeTimeoutMs)) return false;
    const latest = this.readEndpoint();
    if (latest === false || JSON.stringify(latest) !== JSON.stringify(current)) return false;
    this.writeEndpoint(address);
    return true;
  }

  private readEndpoint(): Record<string, unknown> | null | false {
    try { return record(JSON.parse(readFileSync(this.endpointPath, "utf8"))); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError ? null : false; }
  }

  close(): void {
    for (const entry of this.held.values()) entry.res.destroy();
    this.held.clear();
    if (!this.endpointFile) return;
    try {
      const current = record(JSON.parse(readFileSync(this.endpointFile, "utf8")));
      if (current?.token === this.token) unlinkSync(this.endpointFile);
    } catch {}
    this.endpointFile = null;
  }

  private secureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") return;
    if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
    chmodSync(dir, 0o700);
  }

  private async freshAgents(): Promise<AgentInfo[] | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(this.getLocalAgents), new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.agentsTimeoutMs); })]);
    } catch { return null; } finally { clearTimeout(timer); }
  }

  private async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" && req.method !== "GET") { res.setHeader("allow", "GET, POST"); return reply(res, 405, { error: "method" }); }
    if (header(req, "origin") || !tokenEqual(header(req, "x-msc-hook-token"), this.token)) return reply(res, 403, { error: "token" });
    const nonce = header(req, "x-msc-hook-nonce");
    if (!NONCE.test(nonce)) return reply(res, 400, { error: "nonce" });
    if (req.method === "GET") { req.resume(); res.writeHead(204, { "cache-control": "no-store", "x-msc-hook-signature": claudeHookSignature(this.key, nonce, "") }); res.end(); return; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, "content-type"))) return reply(res, 415, { error: "json" });
    if (header(req, "content-encoding") && header(req, "content-encoding") !== "identity") return reply(res, 415, { error: "encoding" });
    const body = await readBody(req);
    if (typeof body === "number") { res.setHeader("connection", "close"); return reply(res, body, { error: "body" }); }
    let input: Record<string, unknown> | null = null;
    try { input = record(JSON.parse(body.toString("utf8"))); } catch { input = null; }
    const toolInput = record(input?.tool_input);
    if (!input || input.hook_event_name !== "PermissionRequest" || typeof input.session_id !== "string" || !SESSION.test(input.session_id) || typeof input.cwd !== "string" || !input.cwd || input.cwd.length > 4096 || typeof input.tool_name !== "string" || !input.tool_name || input.tool_name.length > 200 || !toolInput) return reply(res, 400, { error: "input" });
    if (input.permission_suggestions !== undefined && input.permission_suggestions !== null && !Array.isArray(input.permission_suggestions)) return reply(res, 400, { error: "input" });
    if (this.held.size >= MAX_PENDING) return reply(res, 429, { error: "full" });
    const agents = await this.freshAgents();
    if (!agents) return reply(res, 503, { error: "agents" });
    const sessionId = input.session_id;
    const cwd = normalizedCwd(input.cwd);
    const matches = agents.filter((agent) => agent.app === "claude" && agent.machine === this.machine && agent.parentId === null && agent.sessionId === sessionId && typeof agent.cwd === "string" && normalizedCwd(agent.cwd) === cwd);
    if (matches.length !== 1) return reply(res, 204);
    if (res.destroyed || this.held.size >= MAX_PENDING) return reply(res, 429, { error: "full" });
    const suggestions = Array.isArray(input.permission_suggestions) ? input.permission_suggestions : null;
    const entry: Held = { id: randomUUID(), sessionId, cwd: input.cwd, toolName: input.tool_name, toolInput, suggestions, receivedAt: new Date(this.now()).toISOString(), res, nonce };
    this.held.set(entry.id, entry);
    req.socket.setTimeout(0);
    res.once("close", () => { if (this.held.get(entry.id)?.res === res) this.held.delete(entry.id); });
  }
}
