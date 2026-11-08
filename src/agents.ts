import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import type { AgentInfo, AgentState } from "../shared/types.ts";
import { createMascot, mascotArmReach, mascotDeskPosture, mascotHandPosition, poseMascotSeated, reachMascotHand, resetMascotHands, type Mascot } from "./scene/mascots.ts";
import { GENERAL_SEATS, LOUNGE_SPOTS, QUEUE_SPOTS, constrainWalk, roleSeat, routeBetween, walkSegmentClear } from "./scene/layout.ts";
import { crewKind } from "./crew.ts";
import { isVisitor, traineeSeats } from "./life.ts";
import { TrainingDirector, trainingFocus, type TrainingCue, type TrainingMember } from "../shared/training.ts";
import { roleLabel } from "./roles-view.ts";
import { ROLES } from "../shared/roles.ts";
import type { MachineId, RoleId } from "../shared/types.ts";
import { escapeHtml, plainText } from "./markdown.ts";
import { APP_COLORS } from "./scene/mascots.ts";
import { FocusRing, animateStatusFx, createStatusFx, type StatusFx } from "./scene/effects.ts";
import { damp, dampAngle, easeOut, glance, reducedMotion, stepSpring, type Spring } from "./motion.ts";
import { LoungeDirector, animateLoungeProps, createLoungeProps, loungePose, type LoungeCue, type LoungeMember, type LoungePose, type LoungeProps } from "./scene/lounge.ts";
import type { LoungeActivity } from "./scene/layout.ts";
import { animateClipboard, animateTrainingProps, animateWorkProps, animateWorkstation, createTrainingProps, createWorkProps, resetWorkstation, sampleDeskAction, trainingPose, type TrainingPose, type TrainingProps, type WorkProps, type WorkTask } from "./scene/work.ts";
import { animateRackProps, createRackProps, finalizeRackProps, rackPose, rackShowsBoard, rackStep, type RackProps } from "./scene/rackwork.ts";

const FLOOR_Y = 0.1;
const SEAT_Y = 0.46;
const WALK_SPEED = 3.2;
const WALK_ACCEL = 9;
const TURN_RATE = 12;
const POSE_RATE = 14;
const STRIDE_PER_UNIT = 2.2;
const ENTER_SCALE = 0.72;
const EXIT_SECONDS = 0.28;
const MISSING_GRACE_SECONDS = 10;
const STAGGER_MS = 28;
const STAGGER_CAP_MS = 900;
const LABEL_EASE = 18;
const LABEL_TOP_MIN = 52;
const LABEL_VIEW_MARGIN = 24;
const LABEL_MAX_SHIFT = 128;
const LABEL_GAP = 8;
const LABEL_EPSILON = 0.05;
const LABEL_SEARCH_ROUNDS = 4;
const LABEL_HIDE_DELAY_MS = 900;
const LABEL_SHOW_DELAY_MS = 350;
const MIN_WALK_SPEED = 0.6;
const HOP_AIR = 0.32;
const HOP_LAND = 0.1;
const IDLE_TO_LOUNGE_MS = 5 * 60_000;
const ENTRY = { x: 0, z: 22.6 };
const PERSONAL_SPACE = 0.85;
const AVOID_PUSH = 2.4;
const PASS_SIDE = 0.55;

export const STATE_LABELS: Record<AgentState, string> = {
  thinking: "Đang nghĩ",
  working: "Đang làm",
  waiting: "Chờ sếp duyệt",
  idle: "Rảnh",
};

const GENERIC_DETAILS = new Set(["", "Đang suy nghĩ", "Đang chạy"]);

function activityText(info: AgentInfo): string {
  const detail = info.detail.trim();
  if (info.state === "idle" || GENERIC_DETAILS.has(detail)) return info.title;
  return detail;
}

type Pose = "sit" | "stand" | "lounge";

export type SeatTarget = Target;

interface Target {
  key: string;
  x: number;
  z: number;
  facing: number;
  pose: Pose;
  approach: { x: number; z: number } | null;
  task?: WorkTask;
  circle?: { id: string; activity: LoungeActivity };
  alt?: Target;
}

const PRESENT_CUE: LoungeCue = { activity: "chat", lookAt: null, speaking: true, laugh: 0, shooter: false, shotPhase: 0, cheer: 0 };

interface Entity {
  info: AgentInfo;
  mascot: Mascot;
  label: HTMLDivElement;
  tag: CSS2DObject;
  pos: THREE.Vector3;
  path: { x: number; z: number }[];
  target: Target;
  pose: Pose;
  facing: number;
  leaving: boolean;
  missingFor: number | null;
  phase: number;
  labelOffset: { x: number; y: number };
  labelSlot: { x: number; y: number } | null;
  labelShown: boolean;
  labelMarkup: string;
  labelPendingSince: number | null;
  baseScale: number;
  y: number;
  yaw: number;
  speed: number;
  stride: number;
  pop: Spring;
  appearAt: number;
  exitT: number;
  fx: StatusFx;
  lounge: LoungeProps | null;
  work: WorkProps | null;
  rack: RackProps | null;
  training: TrainingProps | null;
  lesson: TrainingCue | null;
  cue: LoungeCue | null;
  hasMug: boolean;
  lean: number;
  tilt: number;
  speech: string | null;
  seatBlend: number;
}

const MEET_GAP = 0.9;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export class AgentManager {
  private readonly entities = new Map<string, Entity>();
  private readonly scene: THREE.Scene;
  private readonly onSelect: (id: string) => void;
  private readonly onHover: (id: string | null) => void;
  private instant = true;
  private readonly homeSeats = new Map<string, Target>();
  private readonly trainees = new Map<string, number>();
  private readonly idleSince = new Map<string, number>();
  private lastPlacementAt = 0;
  private pins = new Map<string, Target>();
  private readonly ring: FocusRing;
  private focusId: string | null = null;
  private spawnIndex = 0;
  private clockMs = 0;
  private observedAt = Date.now();
  private readonly director = new LoungeDirector();
  private staged = new Map<string, LoungeCue>();
  private communicationCues = new Map<string, LoungeCue>();
  private communicationLines = new Map<string, string>();
  private trainingDirector = new TrainingDirector();
  private workstations: THREE.Object3D[] = [];
  private lastWorkstationScan = -Infinity;
  private readonly occupiedWorkstations = new Set<THREE.Object3D>();

  constructor(scene: THREE.Scene, onSelect: (id: string) => void, onHover: (id: string | null) => void) {
    this.scene = scene;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.ring = new FocusRing(scene);
  }

  focus(id: string | null): void {
    if (id === this.focusId) return;
    this.focusId = id;
    const ent = id ? this.entities.get(id) : undefined;
    if (ent) this.ring.retarget(APP_COLORS[ent.info.app]);
  }

  reset(): void {
    for (const desk of this.workstations) resetWorkstation(desk, 0, true);
    for (const ent of this.entities.values()) {
      this.scene.remove(ent.mascot.root);
      ent.label.remove();
    }
    this.entities.clear();
    this.homeSeats.clear();
    this.idleSince.clear();
    this.trainees.clear();
    this.communicationCues.clear();
    this.communicationLines.clear();
    this.staged.clear();
    this.trainingDirector = new TrainingDirector();
    this.instant = true;
    this.spawnIndex = 0;
  }

  get(id: string): AgentInfo | undefined {
    return this.entities.get(id)?.info;
  }

  position(id: string): THREE.Vector3 | null {
    const entity = this.entities.get(id);
    return entity && !entity.leaving ? entity.pos.clone() : null;
  }

  desk(id: string): { key: string; x: number; z: number } | null {
    return this.homeSeats.get(id) ?? null;
  }

  meetSpot(id: string, key: string): Target | null {
    const ent = this.entities.get(id);
    if (!ent || ent.leaving) return null;
    const seated = ent.target.pose === "sit" && ent.target.approach;
    const toward = seated ? { x: ent.target.x, z: ent.target.z } : { x: ent.pos.x, z: ent.pos.z };
    const spot = seated ? ent.target.approach! : { x: ent.pos.x, z: ent.pos.z + MEET_GAP };
    return { key, x: spot.x, z: spot.z, facing: Math.atan2(toward.x - spot.x, toward.z - spot.z), pose: "stand", approach: null };
  }

  arrived(id: string, key: string): boolean {
    const ent = this.entities.get(id);
    return Boolean(ent && ent.target.key === key && ent.path.length === 0);
  }

  stage(cues: Map<string, LoungeCue>): void {
    this.staged = cues;
  }

  communicate(cues: Map<string, LoungeCue>, lines: Map<string, string>): void {
    const changed = new Set([...this.communicationLines.keys(), ...lines.keys()]);
    this.communicationCues = cues;
    this.communicationLines = lines;
    for (const id of changed) {
      const entity = this.entities.get(id);
      if (entity) this.renderLabel(entity);
    }
  }

  say(id: string, text: string | null): void {
    const ent = this.entities.get(id);
    if (!ent || ent.speech === text) return;
    ent.speech = text;
    this.renderLabel(ent);
  }

  pickables(): THREE.Object3D[] {
    return [...this.entities.values()].map((e) => e.mascot.root);
  }

  coffeeGuests(): { x: number; z: number; mascot: Mascot }[] {
    return [...this.entities.values()]
      .filter((ent) => !ent.leaving && ent.path.length === 0 && ent.mascot.root.visible && this.loungeSpot(ent)?.activity === "bar")
      .map((ent) => ({ x: ent.pos.x, z: ent.pos.z, mascot: ent.mascot }));
  }

  idOf(obj: THREE.Object3D): string | null {
    for (const [id, e] of this.entities) {
      let o: THREE.Object3D | null = obj;
      while (o) {
        if (o === e.mascot.root) return id;
        o = o.parent;
      }
    }
    return null;
  }

  update(agents: AgentInfo[], pins: Map<string, Target> = new Map(), observedAt = Date.now()): void {
    this.observedAt = Number.isFinite(observedAt) ? observedAt : Date.now();
    this.pins = pins;
    for (const info of agents) {
      if (info.state !== "idle") this.idleSince.delete(info.id);
      else if (!this.idleSince.has(info.id)) {
        const previous = this.entities.get(info.id)?.info;
        this.idleSince.set(info.id, previous ? this.observedAt : Math.min(this.observedAt, Date.parse(info.updatedAt) || this.observedAt));
      }
    }
    const targets = this.assign(agents);
    queueMicrotask(() => (this.instant = false));
    const seen = new Set<string>();
    for (const info of agents) {
      seen.add(info.id);
      const target = targets.get(info.id)!;
      const ent = this.entities.get(info.id) ?? this.spawn(info, target);
      ent.info = info;
      ent.leaving = false;
      ent.missingFor = null;
      ent.exitT = 0;
      this.renderLabel(ent);
      if (ent.target.key !== target.key) this.retarget(ent, target);
    }
    for (const [id, ent] of this.entities) {
      if (seen.has(id) || ent.leaving) continue;
      if (!crewKind(id) && !isVisitor(id)) {
        ent.missingFor ??= 0;
        continue;
      }
      this.beginExit(ent);
    }
  }

  private assign(agents: AgentInfo[]): Map<string, Target> {
    const out = new Map<string, Target>();
    const now = this.observedAt;
    for (const a of agents) {
      const pin = this.pins.get(a.id);
      if (pin) out.set(a.id, pin);
    }
    agents = agents.filter((a) => !out.has(a.id));
    const waiting = agents.filter((a) => a.state === "waiting" || a.pending).sort((a, b) => (a.pending?.askedAt ?? "").localeCompare(b.pending?.askedAt ?? ""));
    waiting.forEach((a, i) => {
      const spot = QUEUE_SPOTS[i % QUEUE_SPOTS.length];
      out.set(a.id, { key: `queue:${i}`, x: spot.x, z: spot.z, facing: Math.PI, pose: "stand", approach: null });
    });
    this.seatTrainees(agents.filter((a) => !out.has(a.id) && a.state !== "idle" && trainingFocus(a)), out);
    const resting = agents.filter((a) => !out.has(a.id) && a.state === "idle" && now - (this.idleSince.get(a.id) ?? now) >= IDLE_TO_LOUNGE_MS).sort((a, b) => a.id.localeCompare(b.id));
    const freeSpots = new Set(this.freeLoungeSpots(out, resting.length));
    const assigned = new Map<string, number>();
    for (const a of resting) {
      const current = this.entities.get(a.id)?.target.key;
      const index = current?.startsWith("lounge:") ? Number(current.slice("lounge:".length)) : -1;
      if (freeSpots.delete(index)) assigned.set(a.id, index);
    }
    for (const a of resting) {
      const index = assigned.get(a.id) ?? freeSpots.values().next().value;
      if (index === undefined) continue;
      freeSpots.delete(index);
      const spot = LOUNGE_SPOTS[index];
      out.set(a.id, { key: `lounge:${index}`, x: spot.x, z: spot.z, facing: spot.facing, pose: spot.pose, approach: spot.approach });
    }
    const seated = new Set([...this.homeSeats.values()].map((seat) => seat.key));
    const rest = [...agents].sort((a, b) => a.id.localeCompare(b.id));
    for (const a of rest) {
      let home = this.homeSeats.get(a.id);
      if (a.role && (!home || home.key.startsWith("general:"))) {
        const seat = freeRoomSeat(a.machine, a.role, seated);
        if (seat) {
          if (home) seated.delete(home.key);
          seated.add(seat.key);
          home = { key: seat.key, x: seat.x, z: seat.z, facing: seat.facing, pose: "sit", approach: seat.lane };
        }
      }
      if (!home) {
        let general = 0;
        while (seated.has(`general:${general}`)) general++;
        const g = GENERAL_SEATS[general % GENERAL_SEATS.length];
        home = { key: `general:${general}`, x: g.x, z: g.z, facing: Math.PI, pose: "sit", approach: { x: g.x, z: g.z + 0.85 } };
        seated.add(home.key);
      }
      this.homeSeats.set(a.id, home);
      if (!out.has(a.id)) out.set(a.id, home);
    }
    return out;
  }

  private seatTrainees(learners: AgentInfo[], out: Map<string, Target>): void {
    const seats = traineeSeats();
    const learning = new Set(learners.map((a) => a.id));
    for (const id of this.trainees.keys()) if (!learning.has(id)) this.trainees.delete(id);
    const used = new Set(this.trainees.values());
    for (const a of [...learners].sort((x, y) => x.id.localeCompare(y.id))) {
      let index = this.trainees.get(a.id);
      if (index === undefined) {
        index = seats.findIndex((_, i) => !used.has(i));
        if (index < 0) continue;
        this.trainees.set(a.id, index);
        used.add(index);
      }
      out.set(a.id, seats[index]);
    }
  }

  realSeats(): Set<string> {
    const out = new Set<string>();
    for (const [id, seat] of this.homeSeats) {
      const ent = this.entities.get(id);
      if (ent && !ent.leaving && !crewKind(id)) out.add(seat.key);
    }
    return out;
  }

  private freeLoungeSpots(pinned: Map<string, Target>, wanted: number): number[] {
    const held = new Map<number, string>();
    for (const [id, target] of pinned) if (target.key.startsWith("lounge:")) held.set(Number(target.key.slice("lounge:".length)), id);
    const free = LOUNGE_SPOTS.map((_, i) => i).filter((i) => !held.has(i));
    for (const [index, id] of held) {
      if (free.length >= wanted) break;
      const alt = pinned.get(id)?.alt;
      if (!alt) continue;
      pinned.set(id, alt);
      free.push(index);
    }
    return free;
  }

  private spawn(info: AgentInfo, target: Target): Entity {
    const mascot = createMascot(info.app, info.parentId !== null);
    const label = document.createElement("div");
    label.className = "agent-tag";
    label.tabIndex = 0;
    label.setAttribute("role", "button");
    label.setAttribute("aria-controls", "agent-card");
    label.addEventListener("click", () => this.onSelect(info.id));
    label.addEventListener("pointerenter", () => this.onHover(info.id));
    label.addEventListener("pointerleave", () => this.onHover(null));
    label.addEventListener("focus", () => this.onHover(info.id));
    label.addEventListener("blur", () => this.onHover(null));
    label.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.onSelect(info.id);
    });
    const fx = createStatusFx(mascot.height);
    mascot.root.add(fx.root);
    const tagObj = new CSS2DObject(label);
    tagObj.center.set(0.5, 1);
    tagObj.position.set(0, mascot.height + 0.35, 0);
    mascot.root.add(tagObj);
    const start = new THREE.Vector3(target.x, FLOOR_Y, target.z);
    const baseScale = mascot.root.scale.x;
    const quiet = reducedMotion();
    const delay = this.instant ? Math.min(this.spawnIndex++ * STAGGER_MS, STAGGER_CAP_MS) : 0;
    const ent: Entity = {
      info, mascot, label, tag: tagObj, pos: start, path: [], target, pose: target.pose, facing: target.facing, leaving: false, missingFor: null, phase: Math.random() * 6, labelOffset: { x: 0, y: 0 }, labelSlot: null, labelShown: true, labelPendingSince: null, labelMarkup: "",
      baseScale, y: target.pose === "stand" ? FLOOR_Y : SEAT_Y, yaw: target.facing, speed: 0, stride: 0,
      pop: { x: quiet ? 1 : ENTER_SCALE, v: 0 }, appearAt: this.clockMs + (quiet ? 0 : delay), exitT: 0, fx, lounge: null, work: null, rack: null, training: null, lesson: null, cue: null, hasMug: hashOf(info.id) % 3 !== 0, lean: 0, tilt: 0, speech: null, seatBlend: target.pose === "stand" ? 0 : 1,
    };
    mascot.root.visible = delay === 0 || quiet;
    this.scene.add(mascot.root);
    this.entities.set(info.id, ent);
    if (!this.instant) {
      const entering = [...this.entities.values()].filter((other) => other !== ent && other.pos.z >= ENTRY.z - PERSONAL_SPACE && Math.abs(other.pos.x - ENTRY.x) < PERSONAL_SPACE).length;
      ent.pos.set(ENTRY.x, FLOOR_Y, ENTRY.z + entering * PERSONAL_SPACE);
      ent.y = FLOOR_Y;
      ent.yaw = 0;
      ent.pose = "stand";
      ent.target = { ...target, key: "", approach: null };
      this.retarget(ent, target);
    }
    return ent;
  }

  private retarget(ent: Entity, target: Target): void {
    const settled = ent.pose !== "stand" || ent.path.length === 0;
    const leaveVia = settled ? ent.target.approach : null;
    const from = leaveVia ?? { x: ent.pos.x, z: ent.pos.z };
    const dest = target.approach ?? { x: target.x, z: target.z };
    const route = routeBetween(from, dest);
    if (leaveVia) route.unshift(leaveVia);
    if (target.approach) route.push({ x: target.x, z: target.z });
    ent.path = route;
    ent.target = target;
    ent.pose = "stand";
    ent.label.classList.toggle("resting", target.key.startsWith("lounge:"));
  }

  private beginExit(ent: Entity): void {
    ent.leaving = true;
    this.homeSeats.delete(ent.info.id);
    this.retarget(ent, { key: "exit", x: ENTRY.x, z: ENTRY.z, facing: 0, pose: "stand", approach: null });
  }

  private renderLabel(ent: Entity): void {
    const { info } = ent;
    const kind = crewKind(info.id);
    ent.label.classList.toggle("crew", kind !== null);
    ent.label.classList.toggle("resting", ent.target.key.startsWith("lounge:"));
    if (kind) return;
    const role = roleLabel(info);
    ent.label.dataset.state = info.state;
    ent.label.dataset.app = info.app;
    ent.label.setAttribute("aria-label", `${info.project} · ${STATE_LABELS[info.state]} · ${info.title}`);
    ent.label.classList.toggle("sub", info.parentId !== null);
    const deciding = info.state === "idle" && info.pending?.kind === "decision";
    ent.label.dataset.decision = deciding ? "1" : "";
    const line = plainText(info.recap || info.progress || activityText(info));
    const speech = ent.speech ?? this.communicationLines.get(info.id) ?? null;
    ent.label.classList.toggle("speaking", speech !== null);
    const said = speech === null ? "" : `<q>${escapeHtml(speech)}</q>`;
    const markup = `<div class="agent-bubble-heading"><i></i><b>${escapeHtml(role)}</b><span>${deciding ? "Chờ sếp quyết" : STATE_LABELS[info.state]}</span></div><div class="agent-bubble-context"><strong>${escapeHtml(info.project)}</strong></div>${said || `<em>${escapeHtml(line)}</em>`}`;
    if (ent.labelMarkup === markup) return;
    ent.labelMarkup = markup;
    ent.label.innerHTML = markup;
  }

  tick(dt: number, t: number): void {
    this.clockMs = t * 1000;
    if (t - this.lastWorkstationScan >= 1 || t < this.lastWorkstationScan) {
      this.lastWorkstationScan = t;
      this.workstations = this.scene.getObjectsByProperty("name", "agent-workstation").filter(object => object.userData.workstation);
    }
    this.occupiedWorkstations.clear();
    for (const desk of this.workstations) resetWorkstation(desk, t, reducedMotion());
    for (const ent of this.entities.values()) {
      if (ent.missingFor === null || ent.leaving) continue;
      ent.missingFor += dt;
      if (ent.missingFor >= MISSING_GRACE_SECONDS) {
        this.beginExit(ent);
      }
    }
    if (t - this.lastPlacementAt >= 1) {
      this.lastPlacementAt = t;
      const targets = this.assign([...this.entities.values()].filter((ent) => !ent.leaving).map((ent) => ent.info));
      for (const [id, target] of targets) {
        const ent = this.entities.get(id)!;
        if (ent.target.key !== target.key) this.retarget(ent, target);
      }
    }
    this.assignCues(t);
    for (const [id, ent] of this.entities) {
      if (this.clockMs < ent.appearAt) continue;
      ent.mascot.root.visible = true;
      this.step(ent, dt);
      this.animate(ent, t, dt);
      if (ent.leaving && ent.path.length === 0) ent.exitT += dt;
      if (ent.exitT >= EXIT_SECONDS || (ent.leaving && ent.path.length === 0 && reducedMotion())) this.remove(id, ent);
    }
    const focused = this.focusId ? this.entities.get(this.focusId) : undefined;
    const shown = focused && !focused.leaving && focused.mascot.root.visible ? focused : undefined;
    this.ring.update(shown ? shown.pos : null, shown ? shown.baseScale : 1, t, dt);
  }

  private assignCues(t: number): void {
    const members: LoungeMember[] = [];
    const classMembers: TrainingMember[] = [];
    for (const [id, ent] of this.entities) {
      if (ent.leaving || ent.path.length > 0 || !ent.mascot.root.visible) continue;
      if (ent.target.task === "teach" || ent.target.task === "learn") {
        classMembers.push({ id, seat: ent.target.task === "teach" ? "host" : Number(ent.target.key.slice("training:".length)), x: ent.pos.x, z: ent.pos.z });
      }
      const spot = this.loungeSpot(ent);
      const circle = ent.target.circle ?? (spot ? { id: `lounge:${spot.activity}`, activity: spot.activity } : null);
      if (circle) members.push({ id, circle: circle.id, activity: circle.activity, x: ent.pos.x, z: ent.pos.z });
    }
    const cues = this.director.cues(members, t);
    const lessons = this.trainingDirector.cues(classMembers, t, reducedMotion());
    for (const [id, ent] of this.entities) {
      const presenting = ent.target.task === "present" && ent.path.length === 0 && !ent.leaving;
      const staged = ent.path.length === 0 && !ent.leaving ? this.staged.get(id) ?? this.communicationCues.get(id) : undefined;
      ent.lesson = lessons.get(id) ?? null;
      ent.cue = staged ?? (ent.lesson ? { ...PRESENT_CUE, lookAt: ent.lesson.lookAt, speaking: ent.lesson.speaking } : cues.get(id) ?? (presenting ? PRESENT_CUE : null));
      if (ent.cue && !ent.lounge) ent.lounge = createLoungeProps(ent.mascot);
      if (ent.lesson && !ent.training) ent.training = createTrainingProps(ent.mascot);
      if (ent.target.task && ent.target.task !== "teach" && ent.target.task !== "learn" && !ent.work) ent.work = createWorkProps(ent.mascot);
      if (ent.target.task === "rack" && !ent.rack) ent.rack = createRackProps(ent.mascot);
    }
  }

  private loungeSpot(ent: Entity): (typeof LOUNGE_SPOTS)[number] | null {
    if (!ent.target.key.startsWith("lounge:")) return null;
    const index = Number(ent.target.key.slice("lounge:".length));
    return LOUNGE_SPOTS[index % LOUNGE_SPOTS.length] ?? null;
  }

  private remove(id: string, ent: Entity): void {
    this.scene.remove(ent.mascot.root);
    ent.label.remove();
    this.entities.delete(id);
    this.homeSeats.delete(id);
    this.idleSince.delete(id);
  }

  layoutLabels(width: number, height: number, dt: number, reserved: readonly HTMLElement[] = []): void {
    const placed: Box[] = [];
    for (const el of reserved) placed.push(...this.reserve(el, width));
    const now = performance.now();
    const entities = [...this.entities.values()]
      .filter((ent) => !ent.leaving && !crewKind(ent.info.id) && !ent.target.key.startsWith("lounge:") && ent.label.style.display !== "none")
      .sort((a, b) => a.info.id.localeCompare(b.info.id));
    const blend = reducedMotion() ? 1 : 1 - Math.exp(-LABEL_EASE * dt);
    for (const [index, ent] of entities.entries()) {
      ent.tag.renderOrder = 10000 + entities.length - index + (ent.info.id === this.focusId ? 10000 : 0);
      const rect = ent.label.getBoundingClientRect();
      const baseLeft = rect.left - ent.labelOffset.x;
      const baseTop = rect.top - ent.labelOffset.y;
      const anchorX = baseLeft + rect.width / 2;
      const anchorY = baseTop + rect.height;
      const inView = anchorX >= LABEL_VIEW_MARGIN && anchorX <= width - LABEL_VIEW_MARGIN && anchorY >= LABEL_TOP_MIN && anchorY <= height - LABEL_VIEW_MARGIN;
      const slot = inView ? this.freeSlot(ent, rect, baseLeft, baseTop, placed, width, height) : null;
      const shown = this.settleLabel(ent, slot !== null, now);
      if (!slot && !shown) continue;
      const kept = ent.labelSlot ?? { x: 0, y: 0 };
      const goalX = slot ? slot.left - baseLeft : kept.x;
      const goalY = slot ? slot.top - baseTop : kept.y;
      ent.labelSlot = { x: goalX, y: goalY };
      const next = { x: ent.labelOffset.x + (goalX - ent.labelOffset.x) * blend, y: ent.labelOffset.y + (goalY - ent.labelOffset.y) * blend };
      const blocked = this.labelHit(baseLeft + next.x, baseTop + next.y, rect.width, rect.height, placed);
      ent.labelOffset = !shown || blocked ? { x: goalX, y: goalY } : next;
      ent.labelOffset.x = Math.round(ent.labelOffset.x * 64) / 64;
      ent.labelOffset.y = Math.round(ent.labelOffset.y * 64) / 64;
      ent.label.style.marginLeft = `${ent.labelOffset.x}px`;
      ent.label.style.marginTop = `${ent.labelOffset.y}px`;
      const left = baseLeft + goalX;
      const top = baseTop + goalY;
      placed.push({ left, top, right: left + rect.width, bottom: top + rect.height });
      if (shown) {
        const currentLeft = baseLeft + ent.labelOffset.x;
        const currentTop = baseTop + ent.labelOffset.y;
        placed.push({ left: currentLeft, top: currentTop, right: currentLeft + rect.width, bottom: currentTop + rect.height });
      }
    }
  }

  private settleLabel(ent: Entity, wanted: boolean, now: number): boolean {
    if (wanted === ent.labelShown) {
      ent.labelPendingSince = null;
      return ent.labelShown;
    }
    ent.labelPendingSince ??= now;
    if (now - ent.labelPendingSince >= (wanted ? LABEL_SHOW_DELAY_MS : LABEL_HIDE_DELAY_MS)) {
      ent.labelShown = wanted;
      ent.labelPendingSince = null;
      ent.label.classList.toggle("offview", !wanted);
    }
    return ent.labelShown;
  }

  private reserve(el: HTMLElement, width: number): Box[] {
    if (el.hidden || !el.isConnected) return [];
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return [];
    const base = box.left - (Number.parseFloat(el.style.marginLeft) || 0);
    const left = Math.max(LABEL_GAP, Math.min(base, width - box.width - LABEL_GAP));
    el.style.marginLeft = `${left - base}px`;
    return [{ left, top: box.top, right: left + box.width, bottom: box.bottom }];
  }

  private freeSlot(ent: Entity, rect: DOMRect, baseLeft: number, baseTop: number, placed: Box[], width: number, height: number): { left: number; top: number } | null {
    const w = rect.width;
    const h = rect.height;
    const clampLeft = (x: number) => Math.max(LABEL_GAP, Math.min(x, width - w - LABEL_GAP));
    const clampTop = (y: number) => Math.max(LABEL_TOP_MIN, Math.min(y, height - h - 12));
    const hitAt = (x: number, y: number) => this.labelHit(x, y, w, h, placed);
    const home = { left: clampLeft(baseLeft), top: clampTop(baseTop) };
    const kept = ent.labelSlot && { left: clampLeft(baseLeft + ent.labelSlot.x), top: clampTop(baseTop + ent.labelSlot.y) };
    const shift = (c: { left: number; top: number }) => Math.hypot(c.left - baseLeft, c.top - baseTop);
    if (kept && !hitAt(kept.left, kept.top) && shift(kept) <= LABEL_MAX_SHIFT) return kept;
    if (!hitAt(home.left, home.top)) return home;
    let frontier = [home];
    const seen = new Set<string>();
    let best: { left: number; top: number } | null = null;
    for (let round = 0; round < LABEL_SEARCH_ROUNDS && frontier.length; round++) {
      const next: { left: number; top: number }[] = [];
      for (const c of frontier) {
        const hit = hitAt(c.left, c.top);
        if (!hit) {
          if (shift(c) <= LABEL_MAX_SHIFT && (!best || shift(c) < shift(best))) best = c;
          continue;
        }
        for (const n of [{ left: c.left, top: hit.top - h - LABEL_GAP }, { left: c.left, top: hit.bottom + LABEL_GAP }, { left: hit.left - w - LABEL_GAP, top: c.top }, { left: hit.right + LABEL_GAP, top: c.top }]) {
          const cand = { left: clampLeft(n.left), top: clampTop(n.top) };
          const key = `${Math.round(cand.left)}:${Math.round(cand.top)}`;
          if (seen.has(key) || shift(cand) > LABEL_MAX_SHIFT) continue;
          seen.add(key);
          next.push(cand);
        }
      }
      frontier = next;
    }
    return best;
  }

  private labelHit(x: number, y: number, width: number, height: number, placed: Box[]): Box | undefined {
    return placed.find((box) => x < box.right + LABEL_GAP - LABEL_EPSILON && x + width + LABEL_GAP - LABEL_EPSILON > box.left && y < box.bottom + LABEL_GAP - LABEL_EPSILON && y + height + LABEL_GAP - LABEL_EPSILON > box.top);
  }

  private remaining(ent: Entity): number {
    let total = 0;
    let from = { x: ent.pos.x, z: ent.pos.z };
    for (const point of ent.path) {
      total += Math.hypot(point.x - from.x, point.z - from.z);
      from = point;
    }
    return total;
  }

  private step(ent: Entity, dt: number): void {
    const next = ent.path[0];
    if (!next) {
      ent.speed = 0;
      ent.pose = ent.target.pose;
      ent.facing = ent.target.facing;
      ent.yaw = dampAngle(ent.yaw, ent.facing, TURN_RATE, dt);
      return;
    }
    const brake = Math.sqrt(2 * WALK_ACCEL * this.remaining(ent));
    const wanted = Math.min(WALK_SPEED, Math.max(MIN_WALK_SPEED, brake)) * this.yieldFactor(ent, next);
    ent.speed = ent.speed < wanted ? Math.min(wanted, ent.speed + WALK_ACCEL * dt) : wanted;
    const dx = next.x - ent.pos.x;
    const dz = next.z - ent.pos.z;
    const dist = Math.hypot(dx, dz);
    const move = ent.speed * dt;
    const destination = dist <= move ? next : { x: ent.pos.x + dx / dist * move, z: ent.pos.z + dz / dist * move };
    const advanced = constrainWalk(ent.pos, destination);
    const travelled = Math.hypot(advanced.x - ent.pos.x, advanced.z - ent.pos.z);
    ent.stride += travelled * STRIDE_PER_UNIT;
    ent.pos.x = advanced.x;
    ent.pos.z = advanced.z;
    const arrived = Math.hypot(next.x - ent.pos.x, next.z - ent.pos.z) < 1e-5;
    if (arrived) ent.path.shift();
    if (dist > 1e-4) ent.facing = Math.atan2(dx, dz);
    ent.yaw = dampAngle(ent.yaw, ent.facing, TURN_RATE, dt);
    if (!arrived) this.keepApart(ent, dx, dz, dist, dt, travelled);
  }

  private neighbours(ent: Entity): Entity[] {
    const out: Entity[] = [];
    for (const other of this.entities.values()) {
      if (other === ent || !other.mascot.root.visible || other.exitT > 0) continue;
      if (Math.abs(other.pos.x - ent.pos.x) < PERSONAL_SPACE && Math.abs(other.pos.z - ent.pos.z) < PERSONAL_SPACE) out.push(other);
    }
    return out;
  }

  private yieldFactor(ent: Entity, next: { x: number; z: number }): number {
    const dx = next.x - ent.pos.x;
    const dz = next.z - ent.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    let factor = 1;
    for (const other of this.neighbours(ent)) {
      const ox = other.pos.x - ent.pos.x;
      const oz = other.pos.z - ent.pos.z;
      const d = Math.hypot(ox, oz);
      const ahead = (ox * dx + oz * dz) / len;
      if (ahead <= 0.05 || d >= PERSONAL_SPACE) continue;
      const sameWay = other.path.length > 0 && Math.cos(other.facing - ent.facing) > 0.5;
      const yieldsFirst = sameWay || other.path.length === 0 || ent.info.id > other.info.id;
      if (yieldsFirst) factor = Math.min(factor, Math.max(0.15, d / PERSONAL_SPACE - 0.2));
    }
    return factor;
  }

  private keepApart(ent: Entity, dx: number, dz: number, dist: number, dt: number, move: number): void {
    if (dist < 1e-4) return;
    const fx = dx / dist;
    const fz = dz / dist;
    let px = 0;
    let pz = 0;
    for (const other of this.neighbours(ent)) {
      const ox = ent.pos.x - other.pos.x;
      const oz = ent.pos.z - other.pos.z;
      const d = Math.hypot(ox, oz);
      if (d >= PERSONAL_SPACE) continue;
      const strength = (PERSONAL_SPACE - d) / PERSONAL_SPACE;
      const side = ox * -fz + oz * fx;
      const sign = Math.abs(side) > 0.05 ? Math.sign(side) : ent.info.id < other.info.id ? 1 : -1;
      px += (-fz * sign * PASS_SIDE + (d > 1e-4 ? ox / d : 0)) * strength;
      pz += (fx * sign * PASS_SIDE + (d > 1e-4 ? oz / d : 0)) * strength;
    }
    const lateral = px * -fz + pz * fx;
    const push = Math.max(-move * 0.5, Math.min(move * 0.5, lateral * AVOID_PUSH * dt));
    const separated = constrainWalk(ent.pos, { x: ent.pos.x - fz * push, z: ent.pos.z + fx * push });
    if (!walkSegmentClear(separated, ent.path[0])) return;
    ent.pos.x = separated.x;
    ent.pos.z = separated.z;
  }

  private animate(ent: Entity, t: number, dt: number): void {
    const { mascot, info } = ent;
    const quiet = reducedMotion();
    if (quiet) t = 0;
    resetMascotHands(mascot);
    const walking = ent.path.length > 0;
    const desk = !walking && !ent.leaving && !ent.cue && !ent.lesson && ent.pose === "sit" && (!ent.target.task || ent.target.task === "type")
      ? this.workstations.find(root => {
        if (this.occupiedWorkstations.has(root)) return false;
        const seat = root.localToWorld(new THREE.Vector3(0, 0, 0.58));
        return Math.hypot(seat.x - ent.pos.x, seat.z - ent.pos.z) < 0.2;
      }) : undefined;
    const deskSample = desk ? sampleDeskAction(info.state, t, ent.phase, quiet) : null;
    const gait = walking ? Math.min(1, ent.speed / WALK_SPEED) : 0;
    const hipHeight = Math.min(...mascot.legs.map((leg) => leg.position.y)) * ent.baseScale;
    const deskPosture = desk ? mascotDeskPosture(mascot, ent.baseScale) : null;
    const seatHeight = deskPosture?.seatHeight ?? SEAT_Y;
    const restY = ent.pose === "sit" ? seatHeight - hipHeight : ent.pose === "lounge" ? SEAT_Y + 0.02 - hipHeight : FLOOR_Y;
    ent.y = quiet ? restY : damp(ent.y, restY, POSE_RATE, dt);
    const swing = Math.sin(ent.stride * Math.PI);
    const task = ent.leaving ? undefined : ent.target.task;
    const mug = (ent.hasMug || ent.cue?.activity === "bar") && task === undefined;
    const busy = !walking && !ent.cue && ent.pose === "sit" && (info.state === "working" || task === "type");
    const social = ent.cue && !walking ? loungePose(ent.cue, ent.yaw, ent.pos, t, ent.phase, mug) : null;
    const racking = task === "rack" && !walking;
    const rack = racking ? rackPose(t, ent.phase) : null;
    const lesson = !walking && ent.lesson ? trainingPose(ent.lesson, ent.yaw, ent.pos, t, ent.phase, quiet) : null;
    const work = lesson ?? rack ?? (deskSample ? { arms: null, lean: deskPosture?.shoulderZ ? Math.min(0.035, deskSample.lean) : deskSample.lean, yaw: deskSample.yaw * (deskPosture?.shoulderZ ? 0.5 : 1) } : task && task !== "type" && task !== "rack" ? taskPose(task, walking, t, ent.phase) : null);
    this.animateLimbs(ent, t, dt, { walking, gait, swing, busy, quiet, arms: work?.arms ?? social?.arms ?? null, lesson, poolStep: social?.stepping ? Math.sin(t * 10) * 0.4 : 0 });
    const hop = this.waitHop(ent, t, walking || ent.pose !== "stand" || task !== undefined, quiet);
    const bob = (walking && !quiet ? Math.abs(swing) * 0.06 * gait : 0) + (social?.lift ?? 0) + (rack?.lift ?? 0);
    this.animateBody(ent, t, dt, { walking, gait, busy, quiet, social, work });
    const standingLegPitches = mascot.legs.map(leg => leg.rotation.x);
    const seated = !walking && ent.pose !== "stand";
    ent.seatBlend = quiet ? Number(seated) : damp(ent.seatBlend, Number(seated), 10, dt);
    poseMascotSeated(mascot, ent.seatBlend > 0.001 ? ent.seatBlend : 0, Boolean(desk));
    if (ent.seatBlend <= 0.001) mascot.legs.forEach((leg, index) => { leg.rotation.x = standingLegPitches[index]; });
    const hip = new THREE.Vector3(0, Math.min(...mascot.legs.map(leg => leg.position.y)), 0);
    const displacedHip = hip.clone().multiply(mascot.body.scale).applyQuaternion(mascot.body.quaternion);
    mascot.body.position.copy(hip.sub(displacedHip)).multiplyScalar(ent.seatBlend);
    stepSpring(ent.pop, 1, dt);
    const leave = ent.exitT > 0 ? easeOut(Math.min(1, ent.exitT / EXIT_SECONDS)) : 0;
    const s = ent.baseScale * ent.pop.x * (1 - leave * 0.35);
    mascot.root.scale.set(s / Math.sqrt(hop.squash), s * hop.squash, s / Math.sqrt(hop.squash));
    mascot.root.position.set(social?.stance?.x ?? ent.pos.x, ent.y + bob + hop.lift - leave * 0.2, social?.stance?.z ?? ent.pos.z);
    if (deskPosture) mascot.root.position.add(new THREE.Vector3(Math.sin(ent.yaw), 0, Math.cos(ent.yaw)).multiplyScalar((0.58 - deskPosture.seatZ) * ent.seatBlend));
    mascot.root.rotation.y = ent.yaw;
    animateStatusFx(ent.fx, !walking && info.state === "thinking", !walking && info.state === "waiting", t, dt, ent.phase);
    if (ent.lounge) animateLoungeProps(ent.lounge, walking ? null : ent.cue, social, mug, t, dt, ent.yaw);
    if (ent.work) {
      const still = !walking;
      const board = task === "inspect" || (task === "carry" && still) || (racking && rackShowsBoard(t, ent.phase));
      animateWorkProps(ent.work, { crate: task === "carry" && walking, board, can: task === "water", pouring: task === "water" && still && !quiet }, t, dt);
    }
    if (ent.rack) animateRackProps(ent.rack, racking && !ent.leaving, t, dt, ent.phase);
    if (ent.training) animateTrainingProps(ent.training, mascot, walking ? null : ent.lesson, t, dt, ent.phase, quiet);
    if (desk && deskSample) {
      this.occupiedWorkstations.add(desk);
      animateWorkstation(desk, mascot, deskSample, t, info.id);
    }
    if (busy && !desk && !lesson && !task?.match(/learn|rack/)) {
      const scale = mascot.root.scale.x;
      for (let i = 0; i < 2; i++) {
        const tap = quiet ? 0 : Math.max(0, Math.sin(t * 12 + ent.phase + i * Math.PI)) * 0.022;
        const reach = mascotArmReach(mascot, i);
        reachMascotHand(mascot, i, mascot.body, mascot.arms[i].position.x * 0.9, mascot.arms[i].position.y - 0.025 + tap / scale, reach * 0.85);
      }
    }
    if (ent.work?.crate.visible && task === "carry") {
      reachMascotHand(mascot, 0, ent.work.crate, -0.19, 0, -0.14);
      reachMascotHand(mascot, 1, ent.work.crate, 0.19, 0, -0.14);
    }
    if (ent.work) animateClipboard(ent.work, mascot, t, quiet);
    if (racking && ent.rack) {
      const step = rackStep(t, ent.phase);
      if (step.step === "console") {
        for (let i = 0; i < 2; i++) reachMascotHand(mascot, i, ent.rack.consoleGrips[i], 0, quiet ? 0 : Math.max(0, Math.sin(t * 12 + i * Math.PI)) * 0.01, 0);
      } else if (step.step === "pull" && ent.rack.slab.visible) {
        reachMascotHand(mascot, 0, ent.rack.pullGrips[0], 0, 0, 0);
        if (!ent.rack.caddy.visible) reachMascotHand(mascot, 1, ent.rack.pullGrips[1], 0, 0, 0);
      } else if (step.step === "cable") {
        reachMascotHand(mascot, 1, ent.rack.cableGrip, 0, 0, 0);
        const arm = mascot.arms[1];
        ent.rack.cable.position.copy(mascotHandPosition(mascot, 1, arm));
      }
      for (const prop of [ent.rack.caddy, ent.rack.cable, ent.rack.torch]) if (prop.visible) prop.position.copy(mascotHandPosition(mascot, 1, mascot.arms[1]));
    }
    if (ent.rack) finalizeRackProps(ent.rack, t, ent.phase);
  }

  private animateLimbs(ent: Entity, t: number, dt: number, m: { walking: boolean; gait: number; swing: number; busy: boolean; quiet: boolean; arms: [number, number] | null; lesson: TrainingPose | null; poolStep: number }): void {
    const p = t * 6 + ent.phase;
    ent.mascot.legs.forEach((leg, i) => {
      const goal = m.walking ? m.swing * (i % 2 ? -1 : 1) * 0.7 * m.gait : ent.pose === "stand" ? m.poolStep * (i % 2 ? -1 : 1) : -1.2;
      leg.rotation.x = m.quiet ? goal : damp(leg.rotation.x, goal, 20, dt);
    });
    ent.mascot.arms.forEach((arm, i) => {
      const social = m.arms?.[i === 0 ? 0 : 1];
      const goal = social !== undefined ? social : m.busy ? -0.9 + Math.sin(p * 3 + i * Math.PI) * 0.25 : m.walking ? m.swing * (i % 2 ? 1 : -1) * 0.5 * m.gait : m.poolStep * (i % 2 ? 1 : -1) * 0.7;
      arm.rotation.x = m.quiet ? goal : damp(arm.rotation.x, goal, 18, dt);
      arm.rotation.y = m.quiet ? 0 : damp(arm.rotation.y, 0, 18, dt);
      const spread = m.lesson?.spread[i === 0 ? 0 : 1] ?? 0;
      arm.rotation.z = m.quiet ? spread : damp(arm.rotation.z, spread, 12, dt);
      arm.position.z = 0;
    });
  }

  private waitHop(ent: Entity, t: number, walking: boolean, quiet: boolean): { lift: number; squash: number } {
    if (walking || quiet || ent.info.state !== "waiting") return { lift: 0, squash: 1 };
    const cycle = (t * 0.9 + ent.phase) % 1;
    if (cycle < HOP_AIR) {
      const arc = Math.sin((cycle / HOP_AIR) * Math.PI);
      return { lift: arc * 0.2, squash: 1 + arc * 0.06 };
    }
    if (cycle < HOP_AIR + HOP_LAND) return { lift: 0, squash: 1 - Math.sin(((cycle - HOP_AIR) / HOP_LAND) * Math.PI) * 0.1 };
    return { lift: 0, squash: 1 };
  }

  private animateBody(ent: Entity, t: number, dt: number, m: { walking: boolean; gait: number; busy: boolean; quiet: boolean; social: LoungePose | null; work: TaskPose | null }): void {
    const body = ent.mascot.body;
    const state = ent.info.state;
    const idle = !m.walking && state === "idle";
    const s = m.social;
    const lean = m.work?.lean ?? s?.lean ?? (m.walking ? 0.12 * m.gait : m.busy ? 0.06 + Math.sin(t * 9 + ent.phase) * 0.015 : 0);
    const roam = idle && !m.quiet ? glance(t, ent.phase, 0.5, 0.6) : 0;
    const look = m.work?.yaw ?? s?.bodyYaw ?? roam;
    const tilt = !m.walking && state === "thinking" && !m.quiet ? Math.sin(t * 2 + ent.phase) * 0.08 : 0;
    ent.lean = m.quiet ? 0 : damp(ent.lean, lean, 10, dt);
    ent.tilt = m.quiet ? 0 : damp(ent.tilt, tilt, 8, dt);
    body.rotation.order = ent.cue?.activity === "pool" ? "YXZ" : "XYZ";
    body.rotation.x = ent.lean + (s?.nod ?? 0);
    body.rotation.y = m.quiet ? 0 : damp(body.rotation.y, look, s ? ent.cue?.activity === "pool" ? 12 : 6 : 3, dt);
    body.rotation.z = ent.tilt + (s?.shake ?? 0);
    const breath = m.walking || m.quiet ? 0 : Math.sin(t * 2.2 + ent.phase) * 0.018;
    body.scale.set(1 - breath * 0.5, 1 + breath, 1 - breath * 0.5);
  }
}

interface TaskPose {
  arms: [number, number] | null;
  lean: number | null;
  yaw: number | null;
}

function taskPose(task: WorkTask, walking: boolean, t: number, phase: number): TaskPose | null {
  if (task === "carry") {
    if (walking) return { arms: [-1.3, -1.3], lean: 0.05, yaw: null };
    return { arms: [-1.5 + Math.sin(t * 1.3 + phase) * 0.12, -0.8 + Math.sin(t * 2.6 + phase) * 0.3], lean: 0.12, yaw: glance(t, phase, 0.25, 0.5) };
  }
  if (walking) return null;
  if (task === "present") return { arms: [-2.1 + Math.sin(t * 1.4 + phase) * 0.3, -0.5 + Math.sin(t * 3 + phase) * 0.35 * Math.max(0, Math.sin(t * 0.55 + phase))], lean: null, yaw: glance(t, phase, 0.4, 0.35) };
  if (task === "inspect") return { arms: [-1.5 + Math.sin(t * 1.1 + phase) * 0.15, -0.9 - Math.max(0, Math.sin(t * 2.2 + phase)) * 0.9], lean: 0.06, yaw: glance(t, phase, 0.35, 0.5) };
  if (task === "water") return { arms: [0, -1.05 + Math.sin(t * 1.6 + phase) * 0.08], lean: 0.18, yaw: glance(t, phase, 0.3, 0.45) };
  return null;
}

function freeRoomSeat(machine: MachineId, role: RoleId, seated: Set<string>): ReturnType<typeof roleSeat> | null {
  const own = roleSeat(machine, role);
  if (!seated.has(own.key)) return own;
  const free = ROLES.map((r) => roleSeat(machine, r.id)).filter((seat) => !seated.has(seat.key));
  if (!free.length) return null;
  return free.sort((a, b) => seatDistance(own, a) - seatDistance(own, b))[0];
}

function seatDistance(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.abs(from.x - to.x) + (Math.abs(from.z - to.z) > 0.1 ? 100 : 0);
}

export { escapeHtml };

function hashOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}
