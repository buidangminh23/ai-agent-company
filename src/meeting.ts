import { L } from "../shared/i18n.ts";
import type { AgentInfo, AgentState, MachineId, RoleId } from "../shared/types.ts";
import type { SeatTarget } from "./agents.ts";
import type { LoungeCue } from "./scene/lounge.ts";
import type { CeoMeetingStatus, MeetingAgenda } from "./scene/ceo.ts";
import { MEETING_STEPS, type MeetingState } from "./scene/ceo-timeline.ts";
import { meetingLayout, type MeetingSpot } from "./scene/layout.ts";
import { crewKind } from "./crew.ts";

const FRESH_MS = 2 * 60_000;
const REPEAT_MS = 3 * 60_000;
const GAP_MS = 20_000;
const MAX_CALLERS = 4;
const STAFF_ROLES: RoleId[] = ["po", "ba", "backend", "test", "uiux"];
const SECRETARY = "life:ceo:assistant";
const SEAT_BACK = 0.85;
const CHEER_S = 1.6;
const AGREE_AFTER_S = 1.2;
const JOIN_PHASES = new Set<Phase>(["waiting", "meetRise", "meetWalk", "meetSit", "meetOpen"]);
const SEATED_PHASES = new Set<Phase>([...JOIN_PHASES, "meetOrder", "meetListen", "meetApprove"]);
const PRESENT_PHASES = new Set<Phase>(["meetListen"]);
const LOOK_AT_CEO = new Set<Phase>(["meetSit", "meetOpen", "meetOrder", "meetApprove"]);
const MEETING_CIRCLE = { id: "meeting", activity: "chat" as const };
const NO_CUES = new Map<string, LoungeCue>();

type Phase = MeetingState | "waiting";

export interface MeetingCall extends MeetingAgenda {
  machine: MachineId;
  agentIds: string[];
}

export interface MeetingBoard {
  kind: MeetingAgenda["kind"];
  project: string;
  title: string;
  step: string;
  people: number;
}

export interface MeetingHost {
  requestMeeting(agenda: MeetingAgenda): number;
  meetingStatus(): CeoMeetingStatus | null;
}

export interface MeetingStage {
  stage(cues: Map<string, LoungeCue>): void;
  say(id: string, text: string | null): void;
}

interface Seen {
  task: string;
  state: AgentState;
  calledAt: number;
}

interface ActiveMeeting {
  call: MeetingCall;
  token: number;
  attendees: string[] | null;
  spoken: Set<string>;
}

function taskOf(agent: AgentInfo): string {
  return (agent.task?.trim() || agent.title.trim()).replace(/\s+/g, " ");
}

function isFresh(agent: AgentInfo, now: number): boolean {
  const at = Math.max(Date.parse(agent.updatedAt) || 0, Date.parse(agent.lastActivityAt ?? "") || 0);
  return now - at <= FRESH_MS;
}

function busy(state: AgentState): boolean {
  return state === "working" || state === "thinking";
}

function stepLabel(phase: Phase): string {
  return phase === "waiting" ? L("Chờ sếp vào họp") : MEETING_STEPS.find((step) => step.state === phase)?.label ?? "";
}

function chairTarget(spot: MeetingSpot, index: number, secretary: boolean): SeatTarget {
  const approach = { x: spot.x - Math.sin(spot.facing) * SEAT_BACK, z: spot.z - Math.cos(spot.facing) * SEAT_BACK };
  return { key: `meeting:seat:${index}`, x: spot.x, z: spot.z, facing: spot.facing, pose: "sit", approach, circle: MEETING_CIRCLE, ...(secretary ? { task: "inspect" as const } : {}) };
}

function cue(lookAt: { x: number; z: number }, laugh = 0): LoungeCue {
  return { activity: "chat", lookAt, speaking: false, laugh, shooter: false, shotPhase: 0, cheer: 0 };
}

export function mergeCall(into: MeetingCall, call: MeetingCall): void {
  for (const id of call.agentIds) if (!into.agentIds.includes(id) && into.agentIds.length < MAX_CALLERS) into.agentIds.push(id);
  if (call.kind === "project" && into.kind !== "project") {
    into.kind = "project";
    into.project = call.project;
  }
  into.title = call.title;
}

export class MeetingDirector {
  private primed = false;
  private readonly seen = new Map<string, Seen>();
  private readonly projects = new Set<string>();
  private queued: MeetingCall | null = null;
  private active: ActiveMeeting | null = null;
  private phase: Phase | null = null;
  private time = 0;
  private nextAt = 0;
  private staged = false;

  observe(agents: AgentInfo[], now: number): void {
    const leaders = agents.filter((a) => !crewKind(a.id) && a.parentId === null);
    for (const agent of leaders) {
      const call = this.callFor(agent, now);
      if (call) this.enqueue(call);
    }
    this.primed = true;
  }

  private callFor(agent: AgentInfo, now: number): MeetingCall | null {
    const project = agent.project.trim();
    const key = project.toLowerCase();
    const newProject = key !== "" && !this.projects.has(key);
    if (key) this.projects.add(key);
    const task = taskOf(agent);
    const before = this.seen.get(agent.id);
    this.seen.set(agent.id, { task, state: agent.state, calledAt: before?.calledAt ?? -Infinity });
    if (!this.primed || !busy(agent.state) || !isFresh(agent, now)) return null;
    const ordered = !before || (task !== "" && task !== before.task) || before.state === "idle";
    if (!ordered || now - (before?.calledAt ?? -Infinity) < REPEAT_MS) return null;
    this.seen.get(agent.id)!.calledAt = now;
    return { kind: newProject ? "project" : "order", project: project || L("Việc mới"), title: task || L("Việc mới"), machine: agent.machine, agentIds: [agent.id] };
  }

  private enqueue(call: MeetingCall): void {
    if (this.active && this.phase && JOIN_PHASES.has(this.phase)) mergeCall(this.active.call, call);
    else if (this.queued) mergeCall(this.queued, call);
    else this.queued = call;
  }

  pending(): MeetingCall | null {
    return this.active?.call ?? this.queued;
  }

  board(): MeetingBoard | null {
    if (!this.active || !this.phase) return null;
    const { call } = this.active;
    return { kind: call.kind, project: call.project, title: call.title, step: stepLabel(this.phase), people: this.participants().length + 1 };
  }

  private participants(): string[] {
    if (!this.active) return [];
    return [...this.active.call.agentIds, ...(this.active.attendees ?? [])];
  }

  private presenter(): string | null {
    return this.participants()[0] ?? null;
  }

  pins(crew: AgentInfo[]): Map<string, SeatTarget> {
    const out = new Map<string, SeatTarget>();
    const active = this.active;
    if (!active || !this.phase || !SEATED_PHASES.has(this.phase)) return out;
    const room = meetingLayout();
    const presenter = this.presenter();
    const presenting = PRESENT_PHASES.has(this.phase);
    active.attendees = this.pickAttendees(crew, active.call.machine, room.chairs.length - active.call.agentIds.length);
    this.participants().forEach((id, index) => {
      if (id === presenter && presenting) out.set(id, { key: "meeting:presenter", ...room.presenter, pose: "stand", approach: null, task: "present" });
      else {
        if (index < room.chairs.length) out.set(id, chairTarget(room.chairs[index], index, id === SECRETARY));
      }
    });
    return out;
  }

  private pickAttendees(crew: AgentInfo[], machine: MachineId, capacity: number): string[] {
    const available = crew.filter((agent) => !agent.pending && agent.state !== "waiting" && (agent.id === SECRETARY || crewKind(agent.id) === "staff" || !crewKind(agent.id)));
    const present = new Set(available.map((agent) => agent.id));
    const callers = new Set(this.active!.call.agentIds);
    const preferred = STAFF_ROLES.map((role) => `staff:${machine}:${role}`);
    const candidates = [
      ...(this.active!.attendees ?? []), SECRETARY, ...preferred,
      ...available.filter((agent) => agent.machine === machine).map((agent) => agent.id),
      ...available.map((agent) => agent.id),
    ];
    return [...new Set(candidates)].filter((id) => present.has(id) && !callers.has(id)).slice(0, Math.max(0, capacity));
  }

  frame(host: MeetingHost, stage: MeetingStage, now: number): boolean {
    const before = this.phase;
    if (this.active) {
      const status = host.meetingStatus();
      if (!status || status.token !== this.active.token) this.finish(stage, now);
      else {
        this.phase = status.state;
        this.time = status.time;
      }
    }
    if (!this.active && this.queued && now >= this.nextAt) {
      this.active = { call: this.queued, token: host.requestMeeting(this.queued), attendees: null, spoken: new Set() };
      this.queued = null;
      this.phase = "waiting";
      this.time = 0;
    }
    if (this.active) this.direct(stage);
    return before !== this.phase;
  }

  private direct(stage: MeetingStage): void {
    const phase = this.phase!;
    const room = meetingLayout();
    const presenter = this.presenter();
    const presenting = PRESENT_PHASES.has(phase);
    const cues = new Map<string, LoungeCue>();
    for (const id of this.participants()) {
      if (presenting && id === presenter) continue;
      if (phase === "meetListen") cues.set(id, cue(room.presenter));
      else if (LOOK_AT_CEO.has(phase)) cues.set(id, cue(room.head, phase === "meetApprove" ? Math.max(0, 1 - this.time / CHEER_S) : 0));
    }
    stage.stage(cues);
    this.staged = true;
    this.speak(stage, phase, presenter);
  }

  private speak(stage: MeetingStage, phase: Phase, presenter: string | null): void {
    const active = this.active!;
    const agreeing = phase === "meetApprove" && this.time >= AGREE_AFTER_S;
    for (const id of active.call.agentIds) {
      let line: string | null = null;
      if (phase === "meetListen" && id === presenter) line = L("Kế hoạch: {0}", active.call.title);
      else if (agreeing) line = id === presenter ? L("Rõ! Bắt tay vào làm ngay.") : L("Rõ, thưa sếp!");
      if (line === null && !active.spoken.has(id)) continue;
      stage.say(id, line);
      if (line === null) active.spoken.delete(id);
      else active.spoken.add(id);
    }
  }

  private finish(stage: MeetingStage, now: number): void {
    for (const id of this.active?.spoken ?? []) stage.say(id, null);
    if (this.staged) stage.stage(NO_CUES);
    this.staged = false;
    this.active = null;
    this.phase = null;
    this.time = 0;
    this.nextAt = now + GAP_MS;
  }
}
