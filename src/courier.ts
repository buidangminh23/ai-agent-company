import { L } from "../shared/i18n.ts";
import type { AgentMessage, MachineId } from "../shared/types.ts";
import { messageStatus, messageStatusLabel } from "../shared/messages.ts";
import type { AgentManager, SeatTarget } from "./agents.ts";
import type { LoungeCue } from "./scene/lounge.ts";
import { roleLabel } from "./roles-view.ts";

const FRESH_MS = 90_000;
const TALK_MS = 7_000;
const GIVE_UP_MS = 45_000;
const MAX_ACTIVE = 4;

type Stage = Pick<AgentManager, "get" | "position" | "meetSpot" | "arrived" | "communicate">;
interface Visit {
  message: AgentMessage;
  target: SeatTarget | null;
  startedAt: number;
  arrivedAt: number | null;
  revision: number;
}
function cue(lookAt: { x: number; z: number } | null, speaking: boolean): LoungeCue {
  return { activity: "chat", lookAt, speaking, laugh: 0, shooter: false, shotPhase: 0, cheer: 0 };
}
function fresh(message: AgentMessage, now: number): boolean {
  const age = now - Date.parse(message.updatedAt ?? message.at);
  return Number.isFinite(age) && age >= -5000 && age <= FRESH_MS;
}
export class Courier {
  private readonly seen = new Map<string, { signature: string; at: number }>();
  private queue: AgentMessage[] = [];
  private readonly visits = new Map<string, Visit>();

  reset(agents: Stage): void {
    this.queue = [];
    this.visits.clear();
    agents.communicate(new Map(), new Map());
  }
  observe(messages: AgentMessage[], now: number, live: boolean): void {
    for (const [id, value] of this.seen) if (now - value.at > 30 * 60_000) this.seen.delete(id);
    for (const message of messages) {
      const signature = JSON.stringify([messageStatus(message), message.toId, message.summary, message.detail]);
      if (this.seen.get(message.id)?.signature === signature) continue;
      this.seen.set(message.id, { signature, at: now });
      if (!live || !fresh(message, now)) continue;
      const active = this.visits.get(message.fromId);
      if (active?.message.id === message.id) {
        active.message = message;
        active.startedAt = now;
        active.arrivedAt = null;
      } else {
        this.queue = this.queue.filter((item) => item.id !== message.id);
        this.queue.push(message);
      }
    }
    this.queue = this.queue.slice(-24);
  }
  pins(agents: Stage, now: number, reserved: ReadonlySet<string> = new Set(), offline: ReadonlySet<MachineId> = new Set()): Map<string, SeatTarget> {
    const pins = new Map<string, SeatTarget>();
    const cues = new Map<string, LoungeCue>();
    const lines = new Map<string, string>();
    for (const [from, visit] of this.visits) {
      const elapsed = now - (visit.arrivedAt ?? visit.startedAt);
      if (now - visit.startedAt >= GIVE_UP_MS || visit.arrivedAt !== null && elapsed >= TALK_MS || !agents.position(from) || reserved.has(from) || reserved.has(visit.message.toId)) this.visits.delete(from);
    }
    const occupied = new Set([...reserved, ...[...this.visits.values()].flatMap((v) => [v.message.fromId, v.message.toId])]);
    const waiting: AgentMessage[] = [];
    for (const message of this.queue) {
      if (!fresh(message, now)) continue;
      if (this.visits.size >= MAX_ACTIVE || occupied.has(message.fromId) || occupied.has(message.toId) || !agents.position(message.fromId)) {
        waiting.push(message);
        continue;
      }
      this.visits.set(message.fromId, { message, target: null, startedAt: now, arrivedAt: null, revision: 0 });
      occupied.add(message.fromId);
      if (message.toId) occupied.add(message.toId);
    }
    this.queue = waiting;
    for (const [from, visit] of this.visits) {
      const message = visit.message;
      const state = messageStatus(message);
      const recipient = agents.get(message.toId);
      const targetMachine = recipient?.machine ?? message.targetMachine;
      const senderMachine = agents.get(from)?.machine;
      const senderOffline = senderMachine !== undefined && offline.has(senderMachine);
      const disconnected = senderOffline || targetMachine !== undefined && offline.has(targetMachine);
      const canVisit = !disconnected && ["accepted", "delivered", "replied"].includes(state);
      const next = canVisit ? agents.meetSpot(message.toId, `visit:${message.id}:${visit.revision}`) : null;
      if (next) {
        if (visit.target && Math.hypot(next.x - visit.target.x, next.z - visit.target.z) > 0.4) {
          visit.revision++;
          next.key = `visit:${message.id}:${visit.revision}`;
          visit.arrivedAt = null;
        }
        visit.target = next;
        pins.set(from, next);
        if (!agents.arrived(from, next.key)) continue;
      } else visit.target = null;
      visit.arrivedAt ??= now;
      const confirmed = state === "delivered" || state === "replied";
      const receiving = confirmed && Boolean(next) && now - visit.arrivedAt >= TALK_MS / 2;
      const label = disconnected ? senderOffline ? L("Máy gửi mất kết nối") : L("Máy đích mất kết nối") : messageStatusLabel(state);
      const toName = recipient ? roleLabel(recipient) : message.targetLabel ?? L("người nhận");
      lines.set(from, `${label} · ${toName}: ${message.summary}`);
      cues.set(from, cue(next ? agents.position(message.toId) : null, !receiving));
      if (confirmed && next) {
        cues.set(message.toId, cue(agents.position(from), receiving));
        if (receiving) lines.set(message.toId, state === "replied" ? L("Đã có phản hồi trong cuộc trao đổi.") : L("Đã xác nhận nhận tin."));
      }
    }
    agents.communicate(cues, lines);
    return pins;
  }
}
