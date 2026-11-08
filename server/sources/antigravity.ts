import { L } from "../../shared/i18n.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentInfo, AgentState, MachineId, SentMessage } from "../../shared/types.ts";
import { classifyRole } from "../../shared/roles.ts";
import { clip, projectName } from "./files.ts";
import { canonicalPath } from "./activity.ts";
import { WINDOW_MS, agentBridgePrompts, antigravitySentMessages } from "./messages.ts";

const DB_PATH = path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db");
const CONVERSATIONS_DIR = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
const OUTBOUND_DIR = path.join(os.homedir(), ".codex", "antigravity-bridge", "outbound-deliveries");
const AGENT_BRIDGE_SEND = Buffer.from("send_to_agent_task");
const VISIBLE_MS = 2 * 60 * 60_000;

interface Row {
  conversation_id: string;
  title: string;
  preview: string;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  parent_conversation_id: string;
  agent_name: string;
  killed: number;
}

function toState(status: string): AgentState {
  const tokens = status.toUpperCase().split("_");
  if (tokens.some((token) => ["IDLE", "INACTIVE", "COMPLETED", "COMPLETE", "DONE", "CANCELLED", "CANCELED", "STOPPED", "FAILED", "ERROR"].includes(token))) return "idle";
  if (tokens.includes("WAITING")) return "waiting";
  if (tokens.includes("RUNNING") || tokens.includes("ACTIVE")) return "working";
  return "idle";
}

function workspace(uris: string): string {
  try {
    const first = (JSON.parse(uris) as string[])[0] ?? "";
    if (!first.startsWith("file://")) return first;
    const parsed = new URL(first);
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/([a-z]:\/)/i, "$1");
    return parsed.hostname ? `//${parsed.hostname}${pathname}` : pathname;
  } catch {
    return "";
  }
}

function recentOutboundReceipts(now: number): any[] {
  try {
    return readdirSync(OUTBOUND_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(OUTBOUND_DIR, name))
      .filter((file) => now - statSync(file).mtimeMs <= WINDOW_MS)
      .flatMap((file) => {
        try {
          return [JSON.parse(readFileSync(file, "utf8"))];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function sentPrompts(conversationId: string, requestIds: Set<string>): Map<string, string> {
  const file = path.join(CONVERSATIONS_DIR, `${conversationId}.db`);
  if (!requestIds.size || !/^[\w-]+$/.test(conversationId) || !existsSync(file)) return new Map();
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const payloads = (db.prepare("select step_payload from steps").all() as { step_payload: Uint8Array | null }[]).flatMap((row) => {
      const buffer = row.step_payload ? Buffer.from(row.step_payload) : null;
      return buffer?.includes(AGENT_BRIDGE_SEND) ? [buffer.toString("utf8")] : [];
    });
    return agentBridgePrompts(payloads, requestIds);
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
}

function sentBy(receipts: any[], ownerId: string, conversationId: string, now: number): SentMessage[] {
  const own = receipts.filter((receipt) => receipt?.sender?.id === conversationId);
  if (!own.length) return [];
  const prompts = sentPrompts(conversationId, new Set(own.map((receipt) => receipt.requestId).filter((id) => typeof id === "string")));
  return antigravitySentMessages(own, ownerId, conversationId, prompts, now);
}

export function readAntigravity(machine: MachineId): AgentInfo[] {
  if (!existsSync(DB_PATH)) return [];
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const now = Date.now();
    const receipts = recentOutboundReceipts(now);
    const since = new Date(Date.now() - VISIBLE_MS).toISOString().replace("T", " ").slice(0, 19);
    const rows = db
      .prepare(
        "select conversation_id,title,preview,last_modified_time,workspace_uris,status,parent_conversation_id,agent_name,killed from conversation_summaries where last_modified_time >= ? order by last_modified_time desc limit 40",
      )
      .all(since) as unknown as Row[];
    return rows
      .filter((r) => !r.killed)
      .map((r) => {
        const title = clip(r.title || r.agent_name || r.preview || L("Hội thoại Antigravity"), 80);
        const state = toState(r.status);
        const rawAt = r.last_modified_time.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
        const at = new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(rawAt) ? rawAt : `${rawAt}Z`).toISOString();
        const cwd = workspace(r.workspace_uris);
        const tokens = r.status.toUpperCase().split("_");
        const outcome: AgentInfo["outcome"] = tokens.some((token) => ["FAILED", "ERROR"].includes(token))
          ? { status: "failed", at, summary: L("Ứng dụng ghi nhận lỗi"), verified: false }
          : tokens.some((token) => ["CANCELLED", "CANCELED", "STOPPED"].includes(token))
            ? { status: "aborted", at, summary: L("Ứng dụng ghi nhận lượt bị dừng"), verified: false }
            : tokens.some((token) => ["COMPLETED", "COMPLETE", "DONE"].includes(token))
              ? { status: "completed", at, summary: L("Ứng dụng ghi nhận kết thúc lượt; chưa xác minh kết quả công việc"), verified: false }
              : undefined;
        const id = `antigravity:${machine}:${r.conversation_id}`;
        return {
          id,
          app: "antigravity" as const,
          machine,
          cwd: canonicalPath(cwd, cwd),
          sessionId: r.conversation_id,
          lastActivityAt: at,
          outcome,
          title,
          project: projectName(workspace(r.workspace_uris)),
          role: classifyRole(`${r.title} ${r.preview}`, []),
          state,
          detail: state === "working" ? L("Đang chạy") : clip(r.preview, 90),
          parentId: r.parent_conversation_id ? `antigravity:${machine}:${r.parent_conversation_id}` : null,
          updatedAt: at,
          pending: null,
          sent: sentBy(receipts, id, r.conversation_id, now),
        };
      });
  } catch {
    return [];
  } finally {
    db.close();
  }
}
