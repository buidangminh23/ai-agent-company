import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentApp, AgentInfo, MachineId } from "../shared/types.ts";
import type { AgentControlState, ControlAction, ControlList, ControlReceipt, ControlStatus, ControlSubmission } from "../shared/controls.ts";
import { MACHINES, UUID, allowedHostSet, authenticated, authority, collectorUrls, freshAgents, header, readJsonBody, readRemoteJson, sameOriginWrite, send } from "./http-common.ts";
import { ControlBrokerError, controlCapability, controlState, controlSubmission, unavailableControl } from "./controls.ts";
import type { ControlBroker } from "./controls.ts";

export interface ControlHttpOptions {
  broker: Pick<ControlBroker, "list" | "submit" | "receipt">;
  self: MachineId;
  getLocalAgents: () => Promise<AgentInfo[]>;
  getAgents: () => AgentInfo[];
  collectors: ReadonlyMap<MachineId, string>;
  token: string;
  remoteToken: string;
  allowedHosts: readonly string[];
  isMachineOnline?: (machine: MachineId) => boolean;
  timeoutMs?: number;
  remoteWriteTimeoutMs?: number;
  fetch?: typeof fetch;
}

const BODY_LIMIT = 16 * 1024;
const REMOTE_LIMIT = 512 * 1024;
const LIST_PATH = "/api/agent-controls";
const COLLECTOR_PATH = "/collector/agent-controls";
const APPS: readonly AgentApp[] = ["claude", "codex", "antigravity"];
const ACTIONS: readonly ControlAction[] = ["stop", "settings"];
const STATUSES: readonly ControlStatus[] = ["pending", "done", "rejected", "unknown"];
const REMOTE_UNVERIFIED = "Không xác minh được kênh điều khiển trên máy đích";
const fail = (statusCode: number, message: string) => new ControlBrokerError(statusCode, message);
const BODY_MESSAGES = { type: "Cần gửi dữ liệu JSON", encoding: "Không hỗ trợ nội dung nén", tooLarge: "Nội dung thao tác quá dài", timeout: "Hết thời gian nhận thao tác; chưa gửi", invalid: "Dữ liệu điều khiển không hợp lệ", incomplete: "Không nhận đủ dữ liệu thao tác" };

function controllable(agent: AgentInfo, machine: MachineId): boolean {
  return agent.machine === machine && APPS.includes(agent.app) && !agent.parentId;
}

function unavailableAgent(agent: AgentInfo, reason: string): AgentControlState {
  return { agentId: agent.id, app: agent.app, machine: agent.machine, send: { available: false, reason }, ...unavailableControl(reason) };
}

function publicControls(value: unknown, machine: MachineId, agents: AgentInfo[]): AgentControlState[] {
  if (!value || typeof value !== "object") throw new Error("invalid list");
  const list = value as ControlList;
  if (!Array.isArray(list.agents) || list.agents.length > 256) throw new Error("invalid list");
  return list.agents.flatMap((entry): AgentControlState[] => {
    if (!entry || typeof entry !== "object" || entry.machine !== machine || !APPS.includes(entry.app) || typeof entry.agentId !== "string") throw new Error("invalid entry");
    if (!agents.some((agent) => agent.id === entry.agentId && agent.app === entry.app && controllable(agent, machine))) return [];
    const native = controlState(entry);
    const sendable = controlCapability(entry.send);
    if (!native || !sendable) throw new Error("invalid entry");
    return [{ agentId: entry.agentId, app: entry.app, machine, send: sendable, ...native }];
  });
}

function publicReceipt(value: unknown, requestId: string): ControlReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("invalid receipt");
  const row = value as ControlReceipt;
  if (typeof row.requestId !== "string" || row.requestId.toLowerCase() !== requestId.toLowerCase() || typeof row.agentId !== "string" || row.agentId.length > 300 || !ACTIONS.includes(row.action) || !STATUSES.includes(row.status) || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string" || typeof row.detail !== "string") throw new Error("invalid receipt");
  return { requestId: row.requestId, agentId: row.agentId, action: row.action, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, detail: row.detail.slice(0, 500) };
}

export function createControlHandler(options: ControlHttpOptions): (req: IncomingMessage, res: ServerResponse, url?: URL) => boolean {
  const timeoutMs = options.timeoutMs ?? 10000;
  const writeTimeoutMs = options.remoteWriteTimeoutMs ?? timeoutMs * 2 + 5000;
  const allowedHosts = allowedHostSet(options.allowedHosts);
  const fetcher = options.fetch ?? fetch;
  const collectors = collectorUrls(options.collectors, options.self);
  const fresh = async () => (await freshAgents(options.getLocalAgents, timeoutMs, () => fail(503, "Chưa xác minh được trạng thái mới của ứng dụng; chưa gửi"))).filter((agent) => agent.machine === options.self);

  const remote = async (machine: MachineId, pathname: string, body?: ControlSubmission) => {
    const base = collectors.get(machine);
    if (!base || !options.remoteToken) throw fail(503, "Kênh điều khiển từ xa chưa được cấu hình");
    const response = await fetcher(new URL(pathname, base), {
      method: body ? "POST" : "GET",
      headers: { "x-msc-token": options.remoteToken, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(body ? writeTimeoutMs : timeoutMs),
    });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw fail(503, "Máy đích từ chối mã truy cập nội bộ; chưa gửi"); }
    const value = await readRemoteJson(response, REMOTE_LIMIT);
    if (!response.ok) throw fail(response.status >= 400 && response.status < 500 ? response.status : 502, "Máy đích chưa xác nhận được thao tác");
    return value;
  };

  const list = async (res: ServerResponse, internal: boolean) => {
    const agents = options.getAgents();
    const local = await options.broker.list(await fresh());
    if (internal) { send(res, 200, local); return; }
    const result: ControlList = { generatedAt: new Date().toISOString(), agents: [...local.agents] };
    await Promise.all([...collectors.keys()].filter((machine) => options.isMachineOnline?.(machine) ?? agents.some((agent) => agent.machine === machine)).map(async (machine) => {
      try {
        result.agents.push(...publicControls(await remote(machine, COLLECTOR_PATH), machine, agents));
      } catch {
        result.agents.push(...agents.filter((agent) => controllable(agent, machine)).map((agent) => unavailableAgent(agent, REMOTE_UNVERIFIED)));
      }
    }));
    const seen = new Set<string>();
    result.agents = result.agents.filter((entry) => !seen.has(`${entry.machine}\0${entry.agentId}`) && Boolean(seen.add(`${entry.machine}\0${entry.agentId}`))).slice(0, 256);
    send(res, 200, result);
  };

  const submit = async (req: IncomingMessage, res: ServerResponse, host: string, internal: boolean) => {
    if (!internal && !sameOriginWrite(req, host, "x-msc-control", "human-web")) throw fail(403, "Chỉ nhận thao tác điều khiển trực tiếp từ trang này");
    const body = controlSubmission(await readJsonBody(req, BODY_LIMIT, timeoutMs, fail, BODY_MESSAGES));
    const { machine } = body;
    if (machine === options.self) { send(res, 200, await options.broker.submit(body, await fresh())); return; }
    if (internal || !collectors.has(machine) || !options.getAgents().some((agent) => agent.id === body.agentId && (agent.app === "claude" || agent.app === "codex") && controllable(agent, machine)) || options.isMachineOnline?.(machine) === false) throw fail(409, "Không xác minh được đúng agent trên máy đích");
    if (!options.remoteToken) throw fail(503, "Kênh điều khiển từ xa chưa được cấu hình");
    try {
      const received = publicReceipt(await remote(machine, COLLECTOR_PATH, body), body.requestId);
      if (!received || received.agentId !== body.agentId || received.action !== body.action) throw new Error("receipt mismatch");
      send(res, 200, received);
    } catch (error) {
      if (error instanceof ControlBrokerError && error.statusCode !== 502) throw error;
      send(res, 502, { error: "Chưa xác nhận được kết quả trên máy đích; không gửi lại, kiểm tra biên nhận", status: "unknown", requestId: body.requestId });
    }
  };

  const run = async (req: IncomingMessage, res: ServerResponse, url: URL, internal: boolean) => {
    const host = authority(header(req, "host"));
    if (!host || !allowedHosts.has(host)) throw fail(403, "Địa chỉ truy cập không được phép");
    if (!authenticated(req, options.token, internal)) throw fail(401, "Cần đăng nhập bằng mã truy cập để điều khiển agent");
    const root = internal ? COLLECTOR_PATH : LIST_PATH;
    if (url.pathname === root && req.method === "GET") return list(res, internal);
    if (url.pathname === root && req.method === "POST") return submit(req, res, host, internal);
    if (url.pathname.startsWith(`${root}/`) && req.method === "GET") {
      const requestId = url.pathname.slice(root.length + 1);
      const machine = (url.searchParams.get("machine") ?? (internal ? options.self : "")) as MachineId;
      if (!UUID.test(requestId) || !MACHINES.includes(machine)) throw fail(400, "Mã gửi hoặc máy đích không hợp lệ");
      if (machine === options.self) { send(res, 200, options.broker.receipt(requestId)); return; }
      if (internal || !collectors.has(machine)) throw fail(409, "Máy đích không được cấu hình");
      send(res, 200, publicReceipt(await remote(machine, `${COLLECTOR_PATH}/${requestId}`), requestId));
      return;
    }
    throw fail(405, "Phương thức không được hỗ trợ");
  };

  return (req, res, givenUrl) => {
    const url = givenUrl ?? new URL(req.url ?? "/", "http://hub");
    const internal = url.pathname === COLLECTOR_PATH || url.pathname.startsWith(`${COLLECTOR_PATH}/`);
    if (!internal && url.pathname !== LIST_PATH && !url.pathname.startsWith(`${LIST_PATH}/`)) return false;
    void run(req, res, url, internal).catch((error: unknown) => {
      if (!req.complete) res.setHeader("connection", "close");
      send(res, error instanceof ControlBrokerError ? error.statusCode : 502, { error: error instanceof ControlBrokerError ? error.message : "Không xác minh được ứng dụng đích; kiểm tra biên nhận trước khi gửi tiếp" });
    });
    return true;
  };
}
