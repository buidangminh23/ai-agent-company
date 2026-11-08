import { L } from "../../shared/i18n.ts";
import { MACHINE_LABELS, type AgentInfo, type MachineId } from "../../shared/types.ts";
import type { ClaudeHookRegistry } from "../claude-hook.ts";
import type { NativeControlAdapter, NativeControlState } from "../controls.ts";

type Registry = Pick<ClaudeHookRegistry, "installed" | "stop" | "pending">;

export const CLAUDE_STOP_WARNING = L("Claude dừng ở lần gọi công cụ kế tiếp, phần chữ đang viết vẫn chạy hết");
export const CLAUDE_STOP_INTERRUPTED = L("Đã từ chối yêu cầu đang chờ và dừng lượt");
export const CLAUDE_STOP_FLAGGED = L("Đã đặt lệnh dừng; Claude dừng ở lần gọi công cụ kế tiếp, chưa có xác nhận từ Claude");
export const CLAUDE_SETTINGS_REASON = L("Claude Desktop chưa có kênh bên ngoài đã xác minh để đổi model, mức suy nghĩ hay chế độ quyền; sếp đổi trong app");

export function createClaudeControlAdapter(registry: Registry, machine: MachineId): NativeControlAdapter {
  const missing = L("Chưa cài hook điều khiển Claude trên {0}; chạy node server/claude-hook/install.mjs trên máy đó", MACHINE_LABELS[machine]);
  const local = (agent: AgentInfo) => agent.app === "claude" && agent.machine === machine && agent.parentId === null && typeof agent.sessionId === "string" && agent.sessionId.length > 0;
  const settings = (agent: AgentInfo): NativeControlState["settings"] => ({ available: false, reason: CLAUDE_SETTINGS_REASON, model: agent.model ?? null, effort: null, models: [] });
  return {
    app: "claude",
    async state(agent) {
      if (!local(agent)) {
        const reason = L("Phiên này không phải phiên Claude chính trên máy đang chạy hook");
        return { approvals: { available: false, reason }, questions: { available: false, reason }, stop: { available: false, reason, warning: CLAUDE_STOP_WARNING }, settings: settings(agent) };
      }
      const installed = registry.installed();
      const live = registry.pending(agent.sessionId!).length > 0;
      const prompts = { available: installed.permission || live, reason: installed.permission || live ? "" : missing };
      const stop = !installed.stop && !live ? { available: false, reason: missing } : agent.state === "idle" ? { available: false, reason: L("Claude đang rảnh, không có lượt nào để dừng") } : { available: true, reason: "" };
      return { approvals: { ...prompts }, questions: { ...prompts }, stop: { ...stop, warning: CLAUDE_STOP_WARNING }, settings: settings(agent) };
    },
    async stop(agent, context) {
      if (context.author !== "human-web" || context.signal.aborted || !local(agent) || agent.state === "idle" || !registry.installed().stop && !registry.pending(agent.sessionId!).length) return { status: "stale", detail: L("Phiên không còn chạy hoặc chưa cài hook dừng lượt; chưa gửi") };
      const result = registry.stop(agent.sessionId!);
      if (!result) return { status: "stale", detail: L("Mã phiên Claude không hợp lệ; chưa gửi") };
      return result.interrupted ? { status: "done", detail: CLAUDE_STOP_INTERRUPTED } : { status: "unknown", detail: CLAUDE_STOP_FLAGGED };
    },
    async settings() {
      return { status: "stale", detail: CLAUDE_SETTINGS_REASON };
    },
  };
}
