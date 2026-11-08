import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentInfo, MachineId } from "../shared/types.ts";
import type { DispatchList, DispatchReceipt, DispatchSubmission } from "../shared/dispatch.ts";
import { DispatchBroker, DispatchError, DISPATCH_ID, validateDispatch } from "./dispatch.ts";

export interface DispatchHttpOptions {
  broker: DispatchBroker;
  self: MachineId;
  getLocalAgents: () => Promise<AgentInfo[]>;
  getAgents: () => AgentInfo[];
  collectors: ReadonlyMap<MachineId, string>;
  token: string;
  remoteToken: string;
  allowedHosts: readonly string[];
  isMachineOnline?: (machine: MachineId) => boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const header = (req: IncomingMessage, key: string) => typeof req.headers[key] === "string" ? req.headers[key] as string : "";
function authorized(value: string, expected: string): boolean {
  const a = Buffer.from(value), b = Buffer.from(expected);
  return Boolean(expected && value.length < 4096 && a.length === b.length && timingSafeEqual(a, b));
}
function cookie(req: IncomingMessage): string {
  try {
    const values = header(req, "cookie").split(";").map(value => value.trim()).filter(value => value.startsWith("msc_token="));
    return values.length === 1 ? decodeURIComponent(values[0].slice(10)) : "";
  } catch { return ""; }
}
function send(res: ServerResponse, code: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}
async function bounded<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([fn(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new DispatchError(503, "Hết thời gian xác minh máy đích")), ms); })]); }
  finally { clearTimeout(timer!); }
}
async function input(req: IncomingMessage, timeout: number): Promise<DispatchSubmission> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, "content-type")) || header(req, "content-encoding") && header(req, "content-encoding") !== "identity") throw new DispatchError(415, "Cần nội dung JSON không nén");
  const declared = header(req, "content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 65536)) throw new DispatchError(413, "Nội dung quá dài");
  return bounded(async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) throw new DispatchError(413, "Nội dung quá dài");
      chunks.push(chunk);
    }
    try { return validateDispatch(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch (error) { if (error instanceof DispatchError) throw error; throw new DispatchError(400, "JSON không hợp lệ"); }
  }, timeout);
}

function publicReceipt(value: unknown, machine: MachineId, id?: string): DispatchReceipt {
  const item = value as DispatchReceipt;
  if (!item || !DISPATCH_ID.test(item.id) || id && item.id !== id || item.targetMachine !== machine || typeof item.targetAgentId !== "string" || item.targetAgentId.length > 300 || !["queued", "sending", "accepted", "delivered", "replied", "failed", "unknown"].includes(item.status) || !Number.isFinite(Date.parse(item.at)) || !Number.isFinite(Date.parse(item.updatedAt)) || typeof item.summary !== "string" || item.summary.length > 200 || typeof item.detail !== "string" || item.detail.length > 1000 || item.author !== "human-web") throw new Error("invalid receipt");
  return { id: item.id, status: item.status, targetAgentId: item.targetAgentId, targetMachine: machine, summary: item.summary, at: item.at, updatedAt: item.updatedAt, detail: item.detail, author: "human-web" };
}

export function createDispatchHandler(options: DispatchHttpOptions): (req: IncomingMessage, res: ServerResponse, url?: URL) => boolean {
  const timeout = options.timeoutMs ?? 25000;
  const hosts = new Set(options.allowedHosts.map(host => host.toLowerCase()));
  const collectors = new Map<MachineId, URL>();
  for (const [machine, value] of options.collectors) {
    try {
      const url = new URL(value);
      if (machine !== options.self && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") collectors.set(machine, url);
    } catch {}
  }
  const remote = async (machine: MachineId, suffix = "", body?: DispatchSubmission): Promise<unknown> => {
    const base = collectors.get(machine);
    if (!base || !options.remoteToken) throw new DispatchError(503, "Chưa cấu hình kênh gửi tới máy này");
    const response = await (options.fetch ?? fetch)(new URL(`/collector/communications${suffix}`, base), {
      method: body ? "POST" : "GET", headers: { "x-msc-token": options.remoteToken, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("remote response"); }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 512 * 1024) throw new Error("remote too large");
        chunks.push(result.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
  const local = () => bounded(options.getLocalAgents, timeout).then(agents => agents.filter(agent => agent.machine === options.self));
  const run = async (req: IncomingMessage, res: ServerResponse, url: URL, internal: boolean) => {
    const host = header(req, "host").toLowerCase();
    if (!hosts.has(host)) throw new DispatchError(403, "Địa chỉ truy cập không được phép");
    if (!authorized(header(req, "x-msc-token"), options.token) && (internal || !authorized(cookie(req), options.token))) throw new DispatchError(401, "Cần đăng nhập bằng mã truy cập");
    const base = internal ? "/collector/communications" : "/api/communications";
    if (req.method === "GET" && url.pathname === base) {
      const agents = await local();
      await options.broker.refresh(agents);
      const result: DispatchList = { generatedAt: new Date().toISOString(), targets: await options.broker.targets(agents), receipts: options.broker.receipts() };
      if (!internal) await Promise.all([...collectors.keys()].map(async machine => {
        const remoteAgents = options.getAgents().filter(agent => agent.machine === machine && !agent.parentId);
        try {
          if (options.isMachineOnline?.(machine) === false) throw new Error("offline");
          const received = await remote(machine) as DispatchList;
          if (!Array.isArray(received.targets) || received.targets.length > 128 || !Array.isArray(received.receipts) || received.receipts.length > 100) throw new Error("invalid remote list");
          for (const agent of remoteAgents) {
            const target = received.targets.find(item => item.agentId === agent.id && item.machine === machine && item.app === agent.app);
            result.targets.push({ agentId: agent.id, machine, app: agent.app, project: agent.project, title: agent.title, available: target?.available === true, reason: typeof target?.reason === "string" ? target.reason.slice(0, 500) : "Chưa xác minh được kênh gửi" });
          }
          for (const item of received.receipts) {
            const remoteReceipt = publicReceipt(item, machine);
            const receipt = options.broker.reconcile(remoteReceipt) ?? remoteReceipt;
            const existing = result.receipts.findIndex(entry => entry.id === receipt.id);
            if (existing >= 0) result.receipts[existing] = receipt;
            else result.receipts.push(receipt);
          }
        } catch {
          for (const agent of remoteAgents) result.targets.push({ agentId: agent.id, machine, app: agent.app, project: agent.project, title: agent.title, available: false, reason: "Máy đích mất kết nối hoặc collector chưa hỗ trợ giao tiếp" });
        }
      }));
      result.receipts = result.receipts.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100);
      send(res, 200, result);
      return;
    }
    if (req.method === "POST" && url.pathname === base) {
      if (!internal) {
        let origin: URL;
        try { origin = new URL(header(req, "origin")); } catch { throw new DispatchError(403, "Nguồn gửi không hợp lệ"); }
        if (!["http:", "https:"].includes(origin.protocol) || origin.host.toLowerCase() !== host || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password || header(req, "sec-fetch-site") && header(req, "sec-fetch-site") !== "same-origin" || header(req, "x-msc-communication") !== "human-web") throw new DispatchError(403, "Chỉ nhận thao tác gửi trực tiếp từ trang này");
      }
      const body = await input(req, timeout);
      if (body.targetMachine === options.self) send(res, 200, await options.broker.submit(body, await local()));
      else {
        if (internal || !collectors.has(body.targetMachine) || options.isMachineOnline?.(body.targetMachine) === false) throw new DispatchError(409, "Máy đích chưa sẵn sàng; chưa gửi");
        send(res, 200, await options.broker.submit(body, options.getAgents(), async submission => publicReceipt(await remote(submission.targetMachine, "", submission), submission.targetMachine, submission.requestId)));
      }
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith(`${base}/`)) {
      const id = url.pathname.slice(base.length + 1).toLowerCase();
      const machine = (url.searchParams.get("machine") ?? options.self) as MachineId;
      if (!DISPATCH_ID.test(id)) throw new DispatchError(400, "Mã gửi không hợp lệ");
      if (machine === options.self) { await options.broker.refresh(await local(), id); send(res, 200, options.broker.receipt(id)); return; }
      if (internal || !collectors.has(machine)) throw new DispatchError(400, "Máy đích không hợp lệ");
      try {
        const value = await remote(machine, `/${id}`);
        const remoteReceipt = value === null ? null : publicReceipt(value, machine, id);
        const receipt = remoteReceipt ? options.broker.reconcile(remoteReceipt) ?? remoteReceipt : options.broker.receipt(id);
        send(res, 200, receipt);
      } catch { send(res, 200, options.broker.receipt(id)); }
      return;
    }
    throw new DispatchError(405, "Phương thức không được hỗ trợ");
  };
  return (req, res, supplied) => {
    const url = supplied ?? new URL(req.url ?? "/", "http://hub");
    const internal = url.pathname === "/collector/communications" || url.pathname.startsWith("/collector/communications/");
    if (!internal && url.pathname !== "/api/communications" && !url.pathname.startsWith("/api/communications/")) return false;
    void run(req, res, url, internal).catch(error => {
      if (!req.complete) { req.pause(); res.setHeader("connection", "close"); }
      send(res, error instanceof DispatchError ? error.statusCode : 502, { error: error instanceof DispatchError ? error.message : "Không xác minh được kết quả; kiểm tra biên nhận trước khi gửi tiếp" });
    });
    return true;
  };
}
