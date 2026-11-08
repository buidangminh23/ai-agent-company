import type { AgentInfo, AgentMessage, MessageStatus, SentMessage } from "./types.ts";

const MAX_MESSAGES = 40;

function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (p: string) => {
    const value = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
  };
  return norm(a) === norm(b);
}

export function messageStatus(message: Pick<AgentMessage, "status">): MessageStatus {
  return message.status ?? "unknown";
}

export function messageStatusLabel(status?: MessageStatus): string {
  const labels: Record<MessageStatus, string> = {
    queued: "Đang chờ gửi", sending: "Đang gửi", accepted: "Đã tiếp nhận yêu cầu",
    delivered: "Đã xác nhận nhận", replied: "Đã phản hồi", failed: "Gửi thất bại", unknown: "Chưa xác minh kết quả",
  };
  return labels[status ?? "unknown"];
}

export function findRecipient(sender: AgentInfo, sent: SentMessage, agents: AgentInfo[]): AgentInfo | null {
  const candidates = agents.filter((a) => a.app === sent.target.app && a.id !== sender.id && (!sent.target.machine || a.machine === sent.target.machine));
  const keys = new Set(sent.target.keys.filter(Boolean));
  if (keys.size) {
    const family = (agent: AgentInfo): string => {
      const visited = new Set<string>();
      while (agent.parentId && !visited.has(agent.id)) {
        visited.add(agent.id);
        const parent = agents.find((entry) => entry.id === agent.parentId);
        if (!parent) return agent.parentId;
        agent = parent;
      }
      return agent.id;
    };
    const native = sent.via === "agent-bridge" && sender.app === "codex" && sent.target.app === "codex";
    if (native) {
      const base = sender.aliases?.find((alias) => alias.startsWith("/root")) ?? (sender.parentId ? "" : "/root");
      if (base) for (const key of keys) if (!key.startsWith("/") && !key.includes(":")) keys.add(`${base}/${key}`);
    }
    const byKey = candidates.filter((a) => keys.has(a.id) || (a.sessionId && keys.has(a.sessionId)) || (a.aliases ?? []).some((alias) => keys.has(alias) && (!native || !alias.startsWith("/root") || family(a) === family(sender))));
    return byKey.length === 1 ? byKey[0] : null;
  }
  const byCwd = candidates.filter((a) => a.machine === (sent.target.machine ?? sender.machine) && a.parentId === null && samePath(a.cwd, sent.target.cwd));
  return byCwd.length === 1 ? byCwd[0] : null;
}

export function resolveMessages(agents: AgentInfo[]): AgentMessage[] {
  const out = new Map<string, AgentMessage>();
  for (const sender of agents) {
    for (const sent of sender.sent ?? []) {
      const recipient = findRecipient(sender, sent, agents);
      const value: AgentMessage = {
        id: sent.id, fromId: sender.id, toId: recipient?.id ?? "", at: sent.at, via: sent.via, summary: sent.summary,
        status: sent.status ?? "unknown", updatedAt: sent.updatedAt ?? sent.at,
        ...(sent.detail ? { detail: sent.detail } : {}), ...(sent.replyTo ? { replyTo: sent.replyTo } : {}),
        ...((recipient?.machine ?? sent.target.machine) ? { targetMachine: recipient?.machine ?? sent.target.machine } : {}),
        targetLabel: recipient?.title ?? `${sent.target.app} · chưa xác định phiên nhận`,
      };
      const previous = out.get(sent.id);
      if (!previous || (value.updatedAt ?? value.at) >= (previous.updatedAt ?? previous.at)) out.set(sent.id, value);
    }
  }
  return [...out.values()].sort((a, b) => (a.updatedAt ?? a.at).localeCompare(b.updatedAt ?? b.at)).slice(-MAX_MESSAGES);
}
