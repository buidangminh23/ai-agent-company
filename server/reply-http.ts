import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentInfo, MachineId } from "../shared/types.ts";
import { replyFieldHints, replyFieldHintsValid } from "../shared/replies.ts";
import type { ReplyField, ReplyKind, ReplyList, ReplyQuestion, ReplyReceipt, ReplySubmission } from "../shared/replies.ts";
import { MACHINES, UUID, allowedHostSet, authenticated, authority, collectorUrls, freshAgents, header, readJsonBody, readRemoteJson, sameOriginWrite, send } from "./http-common.ts";
import { ReplyBrokerError } from "./replies.ts";
import type { ReplyBroker } from "./replies.ts";

export interface ReplyHttpOptions {
  broker: Pick<ReplyBroker, "list" | "answer" | "receipt">;
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

const HASH = /^[a-f0-9]{64}$/;
const BODY_LIMIT = 32 * 1024;
const REMOTE_LIMIT = 512 * 1024;
const KINDS: readonly ReplyKind[] = ["question", "approval", "plan"];
const fail = (statusCode: number, message: string) => new ReplyBrokerError(statusCode, message);
const BODY_MESSAGES = { type: "Cần gửi dữ liệu JSON", encoding: "Không hỗ trợ nội dung nén", tooLarge: "Nội dung câu trả lời quá dài", timeout: "Hết thời gian nhận câu trả lời; chưa gửi", invalid: "Dữ liệu trả lời không hợp lệ", incomplete: "Không nhận đủ dữ liệu câu trả lời" };

function plain(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max && !value.includes("\0");
}

function publicField(field: ReplyField): ReplyField {
  if (!field || typeof field.id !== "string" || field.id.length > 200 || typeof field.text !== "string" || field.text.length > 6000 || typeof field.multiSelect !== "boolean" || typeof field.allowFreeText !== "boolean" || !Array.isArray(field.options) || field.options.length > 30 || field.options.some((option) => typeof option !== "string" || option.length > 1000)) throw new Error("invalid field");
  if (field.optional !== undefined && typeof field.optional !== "boolean") throw new Error("invalid field");
  if (field.labels !== undefined && (!field.labels || typeof field.labels !== "object" || Array.isArray(field.labels) || Object.entries(field.labels).some(([option, label]) => !field.options.includes(option) || typeof label !== "string" || !label.trim() || label.length > 200))) throw new Error("invalid field");
  if (!replyFieldHintsValid(field)) throw new Error("invalid field");
  return { id: field.id, text: field.text, options: [...field.options], multiSelect: field.multiSelect, allowFreeText: field.allowFreeText, ...(field.labels ? { labels: Object.fromEntries(field.options.filter((option) => Object.hasOwn(field.labels!, option)).map((option) => [option, field.labels![option]])) } : {}), ...replyFieldHints(field), ...(field.optional ? { optional: true } : {}) };
}

function publicList(value: unknown, machine: MachineId, agents: AgentInfo[]): ReplyList {
  if (!value || typeof value !== "object") throw new Error("invalid list");
  const list = value as ReplyList;
  if (!Array.isArray(list.questions) || list.questions.length > 128 || !Array.isArray(list.unavailable) || list.unavailable.length > 256) throw new Error("invalid list");
  const questions = list.questions.map((question): ReplyQuestion => {
    if (!question || question.machine !== machine || (question.app !== "claude" && question.app !== "codex") || !HASH.test(question.id) || !KINDS.includes(question.kind) || typeof question.title !== "string" || !question.title.trim() || !plain(question.title, 300) || !plain(question.detail, 8000) || !agents.some((agent) => agent.id === question.agentId && agent.machine === machine && agent.app === question.app) || typeof question.threadId !== "string" || typeof question.nativeRequestId !== "string" || typeof question.askedAt !== "string" || !Array.isArray(question.fields) || question.fields.length < 1 || question.fields.length > 8) throw new Error("invalid question");
    return { id: question.id, kind: question.kind, title: question.title, detail: question.detail, agentId: question.agentId, app: question.app, machine, threadId: question.threadId, nativeRequestId: question.nativeRequestId, askedAt: question.askedAt, fields: question.fields.map(publicField) };
  });
  const unavailable = list.unavailable.filter((entry) => entry && entry.machine === machine && agents.some((agent) => agent.id === entry.agentId && agent.machine === machine && agent.app === entry.app)).map((entry) => ({ agentId: entry.agentId, app: entry.app, machine, reason: typeof entry.reason === "string" ? entry.reason.slice(0, 500) : "Không thể kết nối ứng dụng gốc" }));
  return { generatedAt: new Date().toISOString(), questions, unavailable };
}

function receipt(value: unknown, requestId: string): ReplyReceipt | null {
  if (value === null) return null;
  if (!value || typeof value !== "object") throw new Error("invalid receipt");
  const row = value as ReplyReceipt;
  if (row.requestId?.toLowerCase() !== requestId.toLowerCase() || !HASH.test(row.questionId) || typeof row.agentId !== "string" || row.agentId.length > 300 || !["pending", "answered", "rejected", "unknown"].includes(row.status) || typeof row.createdAt !== "string" || typeof row.updatedAt !== "string" || typeof row.detail !== "string") throw new Error("invalid receipt");
  return { requestId: row.requestId, questionId: row.questionId, agentId: row.agentId, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, detail: row.detail.slice(0, 500) };
}

export function createReplyHandler(options: ReplyHttpOptions): (req: IncomingMessage, res: ServerResponse, url?: URL) => boolean {
  const timeoutMs = options.timeoutMs ?? 10000;
  const allowedHosts = allowedHostSet(options.allowedHosts);
  const fetcher = options.fetch ?? fetch;
  const collectors = collectorUrls(options.collectors, options.self);
  const fresh = () => freshAgents(options.getLocalAgents, timeoutMs, () => fail(503, "Chưa xác minh được trạng thái mới của ứng dụng; chưa gửi"));

  const remote = async (machine: MachineId, pathname: string, body?: ReplySubmission) => {
    const base = collectors.get(machine);
    if (!base || !options.remoteToken) throw new ReplyBrokerError(503, "Kênh trả lời từ xa chưa được cấu hình");
    const response = await fetcher(new URL(pathname, base), {
      method: body ? "POST" : "GET",
      headers: { "x-msc-token": options.remoteToken, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify({ ...body, machine }) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new ReplyBrokerError(503, "Máy đích từ chối mã truy cập nội bộ; chưa gửi"); }
    const value = await readRemoteJson(response, REMOTE_LIMIT);
    if (!response.ok) throw new ReplyBrokerError(response.status >= 400 && response.status < 500 ? response.status : 502, "Máy đích chưa xác nhận được yêu cầu");
    return value;
  };

  const run = async (req: IncomingMessage, res: ServerResponse, url: URL, internal: boolean) => {
    const host = authority(header(req, "host"));
    if (!host || !allowedHosts.has(host)) throw new ReplyBrokerError(403, "Địa chỉ truy cập không được phép");
    if (!authenticated(req, options.token, internal)) throw new ReplyBrokerError(401, "Cần đăng nhập bằng mã truy cập để trả lời");
    const listPath = internal ? "/collector/reply-questions" : "/api/reply-questions";
    const answerPath = internal ? "/collector/replies" : "/api/replies";
    if (url.pathname === listPath && req.method === "GET") {
      const agents = options.getAgents();
      const localAgents = (await fresh()).filter((agent) => agent.machine === options.self);
      const local = await options.broker.list(localAgents);
      if (internal) { send(res, 200, local); return; }
      const result: ReplyList = { generatedAt: new Date().toISOString(), questions: [...local.questions], unavailable: [...local.unavailable] };
      await Promise.all([...collectors.keys()].filter((machine) => options.isMachineOnline?.(machine) ?? agents.some((agent) => agent.machine === machine)).map(async (machine) => {
        try {
          const list = publicList(await remote(machine, "/collector/reply-questions"), machine, agents);
          result.questions.push(...list.questions);
          result.unavailable.push(...list.unavailable);
        } catch {
          for (const agent of agents.filter((agent) => agent.machine === machine && (agent.app === "claude" || agent.app === "codex"))) result.unavailable.push({ agentId: agent.id, app: agent.app as "claude" | "codex", machine, reason: "Không xác minh được kênh trả lời trên máy đích" });
        }
      }));
      result.questions = result.questions.slice(0, 128);
      result.unavailable = result.unavailable.slice(0, 256);
      send(res, 200, result);
      return;
    }
    if (url.pathname === answerPath && req.method === "POST") {
      if (!internal && !sameOriginWrite(req, host, "x-msc-reply", "human-web")) throw new ReplyBrokerError(403, "Chỉ nhận thao tác trả lời trực tiếp từ trang này");
      const parsed = await readJsonBody(req, BODY_LIMIT, timeoutMs, fail, BODY_MESSAGES);
      const machine = parsed.machine as MachineId;
      if (!MACHINES.includes(machine) || typeof parsed.requestId !== "string" || !UUID.test(parsed.requestId) || typeof parsed.agentId !== "string" || parsed.agentId.length > 300 || typeof parsed.questionId !== "string" || !HASH.test(parsed.questionId)) throw new ReplyBrokerError(400, "Đích hoặc mã câu hỏi không hợp lệ");
      const body: ReplySubmission = { requestId: parsed.requestId, questionId: parsed.questionId, agentId: parsed.agentId, answers: parsed.answers as ReplySubmission["answers"] };
      if (machine === options.self) {
        const agents = (await fresh()).filter((agent) => agent.machine === options.self);
        send(res, 200, await options.broker.answer(body, agents));
        return;
      }
      if (internal || !collectors.has(machine) || !options.getAgents().some((agent) => agent.id === body.agentId && agent.machine === machine && (agent.app === "claude" || agent.app === "codex")) || options.isMachineOnline?.(machine) === false) throw new ReplyBrokerError(409, "Không xác minh được đúng agent trên máy đích");
      if (!options.remoteToken) throw new ReplyBrokerError(503, "Kênh trả lời từ xa chưa được cấu hình");
      try {
        const received = receipt(await remote(machine, "/collector/replies", body), body.requestId);
        if (!received || received.questionId !== body.questionId || received.agentId !== body.agentId) throw new Error("receipt mismatch");
        send(res, 200, received);
      } catch (error) {
        if (error instanceof ReplyBrokerError && error.statusCode !== 502) throw error;
        send(res, 502, { error: "Chưa xác nhận được kết quả trên máy đích; không gửi lại, kiểm tra biên nhận", status: "unknown", requestId: body.requestId });
      }
      return;
    }
    if (url.pathname.startsWith(`${answerPath}/`) && req.method === "GET") {
      const requestId = url.pathname.slice(answerPath.length + 1);
      const machine = (url.searchParams.get("machine") ?? (internal ? options.self : "")) as MachineId;
      if (!UUID.test(requestId) || !MACHINES.includes(machine)) throw new ReplyBrokerError(400, "Mã gửi hoặc máy đích không hợp lệ");
      if (machine === options.self) { send(res, 200, options.broker.receipt(requestId)); return; }
      if (internal || !collectors.has(machine)) throw new ReplyBrokerError(409, "Máy đích không được cấu hình");
      send(res, 200, receipt(await remote(machine, `/collector/replies/${requestId}`), requestId));
      return;
    }
    throw new ReplyBrokerError(405, "Phương thức không được hỗ trợ");
  };

  return (req, res, givenUrl) => {
    const url = givenUrl ?? new URL(req.url ?? "/", "http://hub");
    const internal = url.pathname === "/collector/reply-questions" || url.pathname === "/collector/replies" || url.pathname.startsWith("/collector/replies/");
    if (!internal && url.pathname !== "/api/reply-questions" && url.pathname !== "/api/replies" && !url.pathname.startsWith("/api/replies/")) return false;
    void run(req, res, url, internal).catch((error: unknown) => {
      if (!req.complete) res.setHeader("connection", "close");
      send(res, error instanceof ReplyBrokerError ? error.statusCode : 502, { error: error instanceof ReplyBrokerError ? error.message : "Không xác minh được ứng dụng đích; kiểm tra biên nhận trước khi gửi tiếp" });
    });
    return true;
  };
}
