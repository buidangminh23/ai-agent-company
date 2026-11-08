import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentInfo } from "../shared/types.ts";
import type { DispatchAdapter } from "./dispatch.ts";
import type { DispatchStatus } from "../shared/dispatch.ts";

type BridgeModule = Record<string, any>;
export interface DispatchBridgeRuntime { native: BridgeModule; accounts: BridgeModule; peer: BridgeModule; desktop: BridgeModule; inbound: BridgeModule; antigravity?: BridgeModule }
const notSent = () => Object.assign(new Error("Destination unavailable"), { sent: false });
const samePath = (a: string, b: string) => {
  try {
    const left = realpathSync.native(a), right = realpathSync.native(b);
    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
  } catch { return false; }
};

function packageRoot(): string | null {
  const suffix = path.join("node_modules", "@minhspark", "codex-mcp-bridge");
  const roots = [process.env.MSC_BRIDGE_ROOT, path.join(path.dirname(process.execPath), suffix), path.join(path.dirname(realpathSync.native(process.execPath)), suffix), path.join(path.dirname(process.execPath), "..", "lib", suffix), path.join(os.homedir(), ".local", "lib", suffix), path.join(os.homedir(), ".npm-global", "lib", suffix), path.join(os.homedir(), "AppData", "Roaming", "npm", suffix), ...(process.platform === "win32" && process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, "nodejs", suffix)] : []), "/opt/homebrew/lib/node_modules/@minhspark/codex-mcp-bridge", "/usr/local/lib/node_modules/@minhspark/codex-mcp-bridge"];
  for (const root of roots) {
    if (!root || !path.isAbsolute(root)) continue;
    try {
      const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
      if (pkg.name === "@minhspark/codex-mcp-bridge" && existsSync(path.join(root, "src", "native-relay.mjs"))) return root;
    } catch {}
  }
  return null;
}

export function codexDispatchEvidence(result: any, agent: AgentInfo, requestId: string): { status: DispatchStatus; detail: string } | null {
  if ((result?.thread?.id ?? result?.thread?.threadId) !== agent.sessionId || typeof result.thread.cwd !== "string" || !samePath(result.thread.cwd, agent.cwd!) || !Array.isArray(result.turns)) return null;
  const marker = `[Human via AI Agent Company · ${requestId}]`;
  const turn = result.turns.find((entry: any) => Array.isArray(entry.items) && entry.items.some((item: any) => item.type === "userMessage" && Array.isArray(item.content) && item.content.some((content: any) => content.type === "text" && typeof content.text === "string" && content.text.startsWith(`${marker}\n`))));
  if (!turn) return null;
  if (turn.status === "completed" && turn.items.some((item: any) => item.type === "agentMessage" && item.phase === "final" && typeof item.text === "string" && item.text.trim())) return { status: "replied", detail: "Codex đã hoàn tất phản hồi cho tin nhắn trong chat đích" };
  return { status: "delivered", detail: "Đã xác nhận tin nhắn xuất hiện trong chat Codex đích" };
}

function antigravityModule(runtime: DispatchBridgeRuntime): BridgeModule {
  const module = runtime.antigravity;
  if (!module || !["inspectHumanConversation", "sendHumanMessage", "readHumanReceipt"].every(name => typeof module[name] === "function")) throw Object.assign(notSent(), { reason: "Bridge trên máy đích chưa hỗ trợ gửi tin từ dashboard tới Antigravity; cần cập nhật bridge" });
  return module;
}

function antigravityReceipt(value: any, agent: AgentInfo, requestId: string): { status: DispatchStatus; detail: string } | null {
  if (value === null) return null;
  if (!value || value.requestId !== requestId || value.conversationId !== agent.sessionId || value.surface !== "desktop" || typeof value.cwd !== "string" || !samePath(value.cwd, agent.cwd!) || value.sender?.provider !== "human-web" || value.sender?.id !== "minh-spark-company") throw new Error("Antigravity receipt identity mismatch");
  const states: Record<string, { status: DispatchStatus; detail: string }> = {
    pending: { status: "queued", detail: "Antigravity đã lưu yêu cầu và đang kiểm tra trước khi gửi" },
    accepted: { status: "accepted", detail: "Antigravity Desktop đã tiếp nhận tin nhắn; chưa xác nhận phản hồi" },
    refused: { status: "failed", detail: "Antigravity từ chối nhận tin nhắn" },
    failed: { status: "failed", detail: "Không gửi được tin nhắn tới Antigravity" },
    held: { status: "queued", detail: "Antigravity đang giữ yêu cầu chờ xử lý" },
    unknown: { status: "unknown", detail: "Chưa xác nhận được kết quả từ Antigravity; không tự gửi lại" },
    sent_unconfirmed: { status: "unknown", detail: "Đã chuyển tới Antigravity nhưng chưa có xác nhận; không tự gửi lại" },
  };
  return states[String(value.status)] ?? { status: "unknown", detail: "Antigravity trả trạng thái chưa xác minh; kiểm tra chat đích, không tự gửi lại" };
}

const REPLY_PENDING = "Tin trước gửi vào phiên này chưa xác nhận được phản hồi, nên bridge chưa cho gửi thêm để tránh gửi chồng; chưa chuyển nội dung";

export function createBridgeDispatchAdapter(options: { load?: () => Promise<DispatchBridgeRuntime> } = {}): DispatchAdapter {
  let loading: Promise<DispatchBridgeRuntime> | undefined;
  let peerEndpoint: any;
  let activeSends = 0;
  const pending = new Map<string, { endpoint: any; msgId: string; session: any; timer: ReturnType<typeof setTimeout> }>();
  const stopIdleEndpoint = () => {
    if (peerEndpoint && !activeSends && !pending.size) { peerEndpoint.stop(); peerEndpoint = undefined; }
  };
  const release = (id: string) => {
    const item = pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(id);
    stopIdleEndpoint();
  };
  const claudeReceipt = (status: string): { status: DispatchStatus; detail: string } | null => {
    if (status === "reply_received") return { status: "replied", detail: "Claude đã phản hồi tin nhắn trong chat đích" };
    if (["refused", "expired", "send_failed"].includes(status)) return { status: "failed", detail: "Claude từ chối hoặc hết thời gian nhận tin" };
    if (status === "delivered") return { status: "delivered", detail: "Claude xác nhận nhận tin nhắn" };
    if (status === "accepted") return { status: "accepted", detail: "Claude đã tiếp nhận yêu cầu; chưa có phản hồi" };
    return null;
  };
  const awaitingReply = (agent: AgentInfo) => {
    for (const [id, item] of pending) {
      if (item.session.sessionId !== agent.sessionId) continue;
      const result = claudeReceipt(item.endpoint.readDelivery(item.msgId)?.status);
      if (result && ["replied", "failed"].includes(result.status)) { release(id); continue; }
      return true;
    }
    return false;
  };
  const runtime = () => loading ??= (async () => {
    if (options.load) return options.load();
    const root = packageRoot();
    if (!root) throw notSent();
    const load = (name: string) => import(pathToFileURL(path.join(root, "src", `${name}.mjs`)).href);
    const [native, accounts, peer, desktop, inbound] = await Promise.all(["native-relay", "bridge-account-context", "peer-protocol", "claude-desktop-context", "claude-inbound-policy"].map(load));
    const antigravity = existsSync(path.join(root, "src", "antigravity-human.mjs")) ? await load("antigravity-human").catch(() => undefined) : undefined;
    return { native, accounts, peer, desktop, inbound, antigravity };
  })().catch(error => { loading = undefined; throw error; });

  async function codex(runtime: DispatchBridgeRuntime, agent: AgentInfo) {
    const accounts = runtime.accounts.requireBridgeAccounts(runtime.accounts.readBridgeAccounts());
    const relay = new runtime.native.NativeDesktopRelay({ timeoutMs: 5000 });
    const evidence = await relay.requestDesktop("read_thread", { threadId: agent.sessionId, hostId: "local", turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 1 }, { accountContext: accounts, beforeSend: () => runtime.accounts.assertAccountIdentity(accounts) });
    const thread = evidence.result?.thread;
    if (!thread || (thread.id ?? thread.threadId) !== agent.sessionId || typeof thread.cwd !== "string" || !samePath(thread.cwd, agent.cwd!)) throw notSent();
    return { relay, accounts };
  }

  function claude(runtime: DispatchBridgeRuntime, agent: AgentInfo) {
    const rawAccounts = runtime.accounts.readBridgeAccounts();
    const accounts = runtime.accounts.requireBridgeAccounts(rawAccounts);
    const sessions = runtime.peer.listClaudeSessions().filter((entry: any) => entry.alive && entry.entrypoint === "claude-desktop" && entry.sessionId === agent.sessionId && samePath(entry.cwd, agent.cwd!));
    if (sessions.length !== 1) throw notSent();
    const session = sessions[0];
    runtime.peer.assertClaudeSessionProcess(session);
    runtime.peer.assertClaudeSessionCwd(session, agent.cwd);
    const desktop = runtime.desktop.readClaudeDesktopContext(session, { account: rawAccounts.claude });
    if (desktop.status !== "matched" || desktop.accountFingerprint !== accounts.claude) throw notSent();
    const policy = runtime.inbound.readClaudeInboundPolicy(agent.cwd);
    if (policy.value !== "accept") throw Object.assign(notSent(), { reason: "Claude chưa cho phép nhận tin từ kênh bên ngoài; cần crossSessionInbound=accept do sếp cấu hình" });
    return { session: { ...session, desktop }, accounts };
  }

  return {
    async inspect(agent) {
      if (!agent.sessionId || !agent.cwd || agent.parentId) return { available: false, reason: "Phiên đích chưa đủ danh tính và thư mục" };
      try {
        const loaded = await runtime();
        if (agent.app === "antigravity") {
          const target = await antigravityModule(loaded).inspectHumanConversation({ conversationId: agent.sessionId, cwd: agent.cwd }, { timeoutMs: 5000 });
          if (target?.available !== true || target.conversationId !== agent.sessionId || target.surface !== "desktop" || typeof target.cwd !== "string" || !samePath(target.cwd, agent.cwd!)) throw notSent();
          return { available: true, reason: "Đã xác minh Antigravity Desktop, cuộc trò chuyện và thư mục đích" };
        }
        if (agent.app === "codex") await codex(loaded, agent);
        else {
          claude(loaded, agent);
          if (awaitingReply(agent)) throw Object.assign(notSent(), { reason: REPLY_PENDING });
        }
        return { available: true, reason: "Đã xác minh ứng dụng, tài khoản và phiên đích" };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const accountReason = message.startsWith("Claude account is unavailable:") ? "Bridge chưa xác minh được tài khoản Claude Desktop trên máy đích; mở Claude Desktop và hoàn tất đăng nhập." : message.startsWith("Codex account is unavailable:") ? "Bridge chưa xác minh được tài khoản Codex trên máy đích; mở Codex và hoàn tất đăng nhập." : undefined;
        const code = (error as { code?: string })?.code;
        const antigravityReason = agent.app === "antigravity" ? code === "ANTIGRAVITY_RECIPIENT_BUSY" ? "Cuộc trò chuyện Antigravity đang bận; chờ hoàn tất lượt hiện tại" : code === "ANTIGRAVITY_HUMAN_UNSUPPORTED" ? "Sidecar Antigravity chưa hỗ trợ gửi từ dashboard; cần cập nhật bridge và khởi động lại Antigravity" : "Chưa kết nối hoặc chưa xác minh đúng cuộc trò chuyện Antigravity Desktop" : undefined;
        return { available: false, reason: (error as { reason?: string })?.reason ?? accountReason ?? antigravityReason ?? "Chưa kết nối được bridge hoặc chưa xác minh đúng tài khoản, phiên đích" };
      }
    },
    async check(agent, requestId) {
      const loaded = await runtime();
      if (agent.app === "antigravity") {
        const value = await antigravityModule(loaded).readHumanReceipt({ requestId, conversationId: agent.sessionId, cwd: agent.cwd }, { timeoutMs: 5000 });
        return antigravityReceipt(value, agent, requestId);
      }
      if (agent.app === "codex") {
        const { relay, accounts } = await codex(loaded, agent);
        const response = await relay.requestDesktop("read_thread", { threadId: agent.sessionId, hostId: "local", turnLimit: 6, includeOutputs: false, maxOutputCharsPerItem: 1500 }, { timeoutMs: 5000, accountContext: accounts, beforeSend: () => loaded.accounts.assertAccountIdentity(accounts) });
        return codexDispatchEvidence(response.result, agent, requestId);
      }
      if (agent.app !== "claude") return null;
      const item = pending.get(requestId);
      if (!item) return null;
      const current = claude(loaded, agent).session;
      if (current.pid !== item.session.pid || current.socket !== item.session.socket || current.desktop.taskId !== item.session.desktop.taskId) { release(requestId); return null; }
      const result = claudeReceipt(item.endpoint.readDelivery(item.msgId)?.status);
      if (result && ["replied", "failed"].includes(result.status)) release(requestId);
      return result;
    },
    async send(agent, text, requestId) {
      const loaded = await runtime();
      if (agent.app === "antigravity") {
        let value;
        try { value = await antigravityModule(loaded).sendHumanMessage({ requestId, conversationId: agent.sessionId, cwd: agent.cwd, prompt: text }, { timeoutMs: 15000 }); }
        catch (error) {
          if ((error as { deliveryState?: string })?.deliveryState === "not_sent") throw Object.assign(error as object, { sent: false });
          throw error;
        }
        return antigravityReceipt(value, agent, requestId) ?? { status: "unknown", detail: "Antigravity chưa trả biên nhận; không tự gửi lại" };
      }
      if (agent.app === "codex") {
        let prepared;
        try { prepared = await codex(loaded, agent); } catch { throw notSent(); }
        const { relay, accounts } = prepared;
        const response = await relay.requestDesktop("send_message_to_thread", { threadId: agent.sessionId, prompt: text }, { timeoutMs: 15000, accountContext: accounts, beforeSend: () => loaded.accounts.assertAccountIdentity(accounts) });
        const result = response.result;
        if (result?.threadId !== agent.sessionId || result.success === false || result.isError === true || result.status !== undefined && !["accepted", "sent"].includes(result.status) || result.firstTurn && result.firstTurn.status !== "accepted") return { status: "unknown", detail: "Codex chưa xác nhận tiếp nhận yêu cầu; không tự gửi lại" };
        return { status: "accepted", detail: "Codex Desktop đã tiếp nhận yêu cầu vào đúng chat" };
      }
      if (agent.app !== "claude") throw notSent();
      const { session, accounts } = claude(loaded, agent);
      const endpoint = peerEndpoint ??= new loaded.peer.PeerEndpoint({ name: "human-web-minh-spark-company", cwd: process.cwd(), signalExit: false });
      endpoint.permissionMode = "prompting";
      activeSends++;
      try {
        await endpoint.start();
        const sent = await endpoint.sendAndWait(session.socket, text, { timeoutMs: 7000, permissionMode: "prompting", accountContext: accounts, transcriptSession: session, beforeSend: () => {
          loaded.accounts.assertAccountIdentity(accounts);
          const current = claude(loaded, agent).session;
          if (current.pid !== session.pid || current.socket !== session.socket || current.desktop.taskId !== session.desktop.taskId) throw notSent();
        } });
        const result = claudeReceipt(sent.reply ? "reply_received" : sent.delivery?.status);
        if (!result || !["replied", "failed"].includes(result.status)) {
          while (pending.size >= 32) release(pending.keys().next().value!);
          const timer = setTimeout(() => release(requestId), 30 * 60_000);
          timer.unref();
          pending.set(requestId, { endpoint, msgId: sent.msgId, session, timer });
        }
        return result ?? { status: "unknown", detail: "Đã chuyển tới kênh Claude nhưng chưa có xác nhận nhận tin; không tự gửi lại" };
      } catch (error) {
        if ((error as { code?: string })?.code === "PEER_REPLY_PENDING") throw Object.assign(notSent(), { reason: REPLY_PENDING });
        throw error;
      } finally { activeSends--; stopIdleEndpoint(); }
    },
  };
}
