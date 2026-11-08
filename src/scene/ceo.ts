import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { reducedMotion } from "../motion.ts";
import type { PersonRig } from "./props.ts";
import { ZONE_BY_ID, doorPoint, type MeetingLayout } from "./layout.ts";
import {
  CEO_TIMELINE, meetingSteps, sampleCeoRoute, sampleCeoTimeline, sampleMassageRoute, sampleMeeting, sampleWalk, walkPath,
  type CeoState, type CeoTimelineSample, type MeetingSample, type MeetingState, type MeetingStep, type PathPoint, type WalkPath,
} from "./ceo-timeline.ts";

export { CEO_TIMELINE, CEO_CYCLE_SECONDS, sampleCeoTimeline } from "./ceo-timeline.ts";

interface MassageChair {
  root: THREE.Group;
  back: THREE.Group;
  legRest: THREE.Group;
}

interface Pose {
  x: number;
  z: number;
  yaw: number;
  hip: number;
  lean: number;
  sway: number;
  headX: number;
  headY: number;
  headZ: number;
  leftThigh: number;
  rightThigh: number;
  leftKnee: number;
  rightKnee: number;
  chair: number;
  meetChair: number;
  recline: number;
  leftHand: THREE.Vector3;
  rightHand: THREE.Vector3;
}

const POSE_SCALARS = ["x", "z", "hip", "lean", "sway", "headX", "headY", "headZ", "leftThigh", "rightThigh", "leftKnee", "rightKnee", "chair", "meetChair", "recline"] as const;
const DOWN = new THREE.Vector3(0, -1, 0);
const POSE_TARGET = new THREE.Vector3();
const MUG_HOME = new THREE.Vector3(-0.42, 0.89, 0.4);
const PAPER_HOME = new THREE.Vector3(-0.12, 0.84, 0.2);
const PHONE_HOME = new THREE.Vector3(0.6, 0.845, 0.28);

function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function windowWeight(time: number, enter: number, entered: number, leave: number, left: number): number {
  return smooth((time - enter) / (entered - enter)) * (1 - smooth((time - leave) / (left - leave)));
}

function createPose(): Pose {
  return { x: 0, z: 0, yaw: 0, hip: 0.62, lean: 0, sway: 0, headX: 0, headY: 0, headZ: 0, leftThigh: -Math.PI / 2, rightThigh: -Math.PI / 2, leftKnee: Math.PI / 2, rightKnee: Math.PI / 2, chair: 0, meetChair: 0, recline: 0, leftHand: new THREE.Vector3(), rightHand: new THREE.Vector3() };
}

function seated(pose: Pose): void {
  pose.x = pose.z = pose.yaw = pose.lean = pose.sway = pose.headX = pose.headY = pose.headZ = pose.chair = pose.meetChair = pose.recline = 0;
  pose.hip = 0.62;
  pose.leftThigh = pose.rightThigh = -Math.PI / 2;
  pose.leftKnee = pose.rightKnee = Math.PI / 2;
  pose.leftHand.set(-0.225, 0.22, 0.425);
  pose.rightHand.set(0.225, 0.22, 0.425);
}

function standing(pose: Pose): void {
  pose.hip = 0.98;
  pose.leftThigh = pose.rightThigh = pose.leftKnee = pose.rightKnee = 0;
  pose.leftHand.set(-0.25, -0.04, 0.025);
  pose.rightHand.set(0.25, -0.04, 0.025);
  pose.chair = 0.75;
}

function walking(pose: Pose, time: number, speed: number): void {
  const gait = Math.sin(time * 5.6) * speed;
  pose.leftThigh = gait * 0.48;
  pose.rightThigh = -gait * 0.48;
  pose.leftKnee = Math.max(0, -gait) * 0.65;
  pose.rightKnee = Math.max(0, gait) * 0.65;
  pose.hip += Math.abs(Math.sin(time * 5.6)) * 0.014 * speed;
  pose.leftHand.z = 0.025 - gait * 0.15;
  pose.rightHand.z = 0.025 + gait * 0.15;
  pose.sway = gait * 0.018;
}

function massageLegs(pose: Pose, recline: number): void {
  const angle = 1.15 * recline;
  const dy = 0.56 - 0.2025 * Math.cos(angle) + 0.16 * Math.sin(angle) - 0.64;
  const dz = 0.2 + 0.22 * recline + 0.22 * Math.sin(angle) + 0.16 * Math.cos(angle);
  const spread = Math.acos(Math.min(1, Math.hypot(dy, dz) / 0.72));
  const thigh = Math.atan2(-dz, -dy) - spread;
  pose.leftThigh = pose.rightThigh = thigh;
  pose.leftKnee = pose.rightKnee = 2 * spread;
}

function samplePose(state: CeoState, time: number, duration: number, pose: Pose): void {
  seated(pose);
  const progress = Math.max(0, Math.min(1, time / duration));
  const activity = windowWeight(time, 0, 1.2, duration - 1.2, duration);
  const wave = Math.sin(time * 1.7);
  if (state === "typing") {
    pose.leftHand.y += Math.sin(time * 9.2) * 0.012 * activity;
    pose.rightHand.y += Math.sin(time * 10.1 + 1.4) * 0.012 * activity;
    pose.leftHand.x += Math.sin(time * 1.8) * 0.025 * activity;
    pose.rightHand.x += Math.sin(time * 1.4) * 0.025 * activity;
    pose.headX = 0.08 * activity;
    pose.headY = Math.sin(time * 0.4) * 0.08 * activity;
  } else if (state === "reviewing") {
    pose.headY = Math.sin(time * 0.55) * 0.43 * activity;
    pose.headX = -0.04 * activity;
    pose.rightHand.set(0.43, 0.23, 0.39);
  } else if (state === "reading") {
    const lift = windowWeight(time, 1, 3.5, 12, 15);
    pose.leftHand.lerp(POSE_TARGET.set(-0.14, 0.33, 0.35), lift);
    pose.rightHand.lerp(POSE_TARGET.set(0.14, 0.33, 0.35), lift);
    pose.headX = 0.24 * lift;
    pose.rightHand.y += Math.sin(time * 2.2) * 0.008 * lift;
  } else if (state === "coffee") {
    const reach = windowWeight(time, 0.5, 2.3, 13.2, 15.5);
    const sip = windowWeight(time, 3, 5.4, 9.5, 12.3);
    pose.leftHand.lerp(POSE_TARGET.set(-0.42, 0.23, 0.38), reach);
    pose.leftHand.lerp(POSE_TARGET.set(-0.07, 0.68, 0.18), sip);
    pose.headX = -0.075 * sip;
    pose.headY = -0.07 * sip;
    pose.rightHand.set(0.24, 0.21, 0.4);
  } else if (state === "phone") {
    const reach = windowWeight(time, 0.3, 2.2, 12.2, 14);
    const lift = windowWeight(time, 3, 5, 8.8, 11.2);
    pose.rightHand.lerp(POSE_TARGET.set(0.56, 0.24, 0.27), reach);
    pose.rightHand.lerp(POSE_TARGET.set(0.18, 0.75, -0.005), lift);
    pose.headY = -0.1 * lift;
    pose.headZ = -0.06 * lift;
    pose.headX = Math.sin(time * 1.2) * 0.045 * lift;
    pose.leftHand.y += Math.max(0, wave) * 0.055 * lift;
  } else if (state === "briefing") {
    pose.headY = 0.8 * activity;
    pose.rightHand.lerp(POSE_TARGET.set(0.5, 0.42 + wave * 0.035, 0.17), activity);
    pose.headX = Math.sin(time * 1.9) * 0.04 * activity;
    pose.sway = -0.035 * activity;
  } else if (state === "stretching") {
    pose.leftHand.lerp(POSE_TARGET.set(-0.3, 0.86, -0.06), activity);
    pose.rightHand.lerp(POSE_TARGET.set(0.3, 0.86, -0.06), activity);
    pose.lean = -0.08 * activity;
    pose.headZ = Math.sin(time * 0.65) * 0.12 * activity;
  } else if (state === "standing" || state === "sitting") {
    const amount = state === "standing" ? smooth(progress) : 1 - smooth(progress);
    pose.hip += 0.36 * amount;
    pose.z = -0.45 * amount;
    pose.chair = 0.75 * amount;
    pose.leftThigh *= 1 - amount;
    pose.rightThigh *= 1 - amount;
    pose.leftKnee *= 1 - amount;
    pose.rightKnee *= 1 - amount;
    pose.leftHand.lerp(POSE_TARGET.set(-0.25, -0.04, 0.025), amount);
    pose.rightHand.lerp(POSE_TARGET.set(0.25, -0.04, 0.025), amount);
    pose.lean = 0.12 * Math.sin(progress * Math.PI);
    if (state === "standing") pose.leftHand.lerp(POSE_TARGET.set(-0.16, 0.26, 0.28), smooth((time - 1.4) / 2.2));
  } else if (state === "walking" || state === "returning" || state === "massageWalking" || state === "massageReturning") {
    standing(pose);
    const route = state.startsWith("massage") ? sampleMassageRoute(progress, state === "massageReturning") : sampleCeoRoute(progress, state === "returning");
    pose.x = route.x;
    pose.z = route.z;
    pose.yaw = route.yaw;
    walking(pose, time, route.speed);
    pose.headY = Math.sin(time * 0.4) * 0.08 * route.speed;
    if (state === "walking" || state === "returning") pose.leftHand.lerp(POSE_TARGET.set(-0.16, 0.26, 0.28), state === "walking" ? 1 : 1 - smooth((time - duration + 2) / 2));
  } else if (state === "inspecting") {
    standing(pose);
    pose.z = 2.52;
    pose.yaw = Math.PI;
    pose.leftHand.set(-0.16, 0.26, 0.28).lerp(POSE_TARGET.set(-0.13, 0.33, 0.34), activity);
    pose.rightHand.lerp(POSE_TARGET.set(0.13 + Math.sin(time * 2) * 0.025, 0.34, 0.33), activity);
    pose.headX = 0.22 * activity;
    pose.headY = Math.sin(time * 0.6) * 0.22 * activity;
  } else if (state === "massageSitting" || state === "massageStanding") {
    standing(pose);
    const p = state === "massageSitting" ? progress : 1 - progress;
    const approach = smooth(p / 0.4);
    const sit = smooth((p - 0.4) / 0.6);
    pose.x = -4.35;
    pose.z = 1.1 - 0.6 * approach - 0.6 * sit;
    pose.hip = 0.98 - 0.34 * sit;
    massageLegs(pose, 0);
    pose.leftThigh *= sit;
    pose.rightThigh *= sit;
    pose.leftKnee *= sit;
    pose.rightKnee *= sit;
    pose.leftHand.lerp(POSE_TARGET.set(-0.43, 0.07, 0.2), sit);
    pose.rightHand.lerp(POSE_TARGET.set(0.43, 0.07, 0.2), sit);
  } else if (state === "massaging") {
    pose.x = -4.35;
    pose.z = -0.1;
    pose.hip = 0.64;
    pose.chair = 0.75;
    pose.recline = windowWeight(time, 0, 4, duration - 4, duration);
    pose.lean = -0.3 * pose.recline;
    massageLegs(pose, pose.recline);
    pose.leftHand.set(-0.43, 0.07, 0.2);
    pose.rightHand.set(0.43, 0.07, 0.2);
    pose.headX = -0.04 * pose.recline;
    pose.sway = Math.sin(time * 2) * 0.006 * pose.recline;
  } else if (state === "resting") {
    pose.lean = -0.11 * activity;
    pose.headX = -0.05 * activity;
    pose.leftHand.lerp(POSE_TARGET.set(-0.22, 0.04, 0.17), activity);
    pose.rightHand.lerp(POSE_TARGET.set(0.22, 0.04, 0.17), activity);
  }
}

export interface MeetingAgenda {
  kind: "project" | "order";
  project: string;
  title: string;
}

export interface CeoMeetingStatus {
  token: number;
  state: MeetingState | "waiting";
  time: number;
  duration: number;
}

interface MeetingGeometry {
  seat: PathPoint;
  stand: PathPoint;
  approach: PathPoint;
  yaw: number;
  back: PathPoint;
  chair: THREE.Object3D;
  chairBase: THREE.Vector3;
  table: THREE.Vector3;
  presenterLook: number;
}

interface MeetingRun {
  token: number;
  agenda: MeetingAgenda;
  startedAt: number;
  steps: MeetingStep[];
  walk: WalkPath;
  back: WalkPath;
  carried: boolean;
  entry: Pose;
}

const SEATED_STATES = new Set<CeoState>(["typing", "reviewing", "briefing", "stretching", "resting"]);
const MOVING_STATES = new Set<CeoState>(["walking", "returning", "massageWalking", "massageReturning"]);
const CARRYING_STATES = new Set<CeoState>(["walking", "returning"]);
const DESK_STAND: PathPoint = { x: 0, z: -0.45 };
const DESK_LANE_X = 3.4;
const DESK_FRONT_Z = 2.52;
const DESK_CLEAR_Z = 2.0;
const SEAT_FORWARD = 0.18;
const STAND_BACK = 0.45;
const CHAIR_OUT = 0.75;
const ROOM_APPROACH = 3.0;
const TABLE_PAPER_Y = 0.82;
const PAPER_REACH = 0.42;
const MAX_HEAD_TURN = 1.15;
const BLEND_S = 0.8;
const SITTING_START = CEO_TIMELINE.slice(0, CEO_TIMELINE.findIndex((entry) => entry.state === "sitting")).reduce((sum, entry) => sum + entry.duration, 0);
const CARRY_HAND = new THREE.Vector3(-0.16, 0.26, 0.28);
const STAND_LEFT = new THREE.Vector3(-0.25, -0.04, 0.025);
const STAND_RIGHT = new THREE.Vector3(0.25, -0.04, 0.025);
const BUBBLE_Y = 2.15;
const TITLE_MAX = 96;

function copyPose(from: Pose, to: Pose): void {
  for (const key of POSE_SCALARS) to[key] = from[key];
  to.yaw = from.yaw;
  to.leftHand.copy(from.leftHand);
  to.rightHand.copy(from.rightHand);
}

function blendPose(pose: Pose, previous: Pose, blend: number): void {
  for (const key of POSE_SCALARS) pose[key] = THREE.MathUtils.lerp(previous[key], pose[key], blend);
  pose.yaw = previous.yaw + Math.atan2(Math.sin(pose.yaw - previous.yaw), Math.cos(pose.yaw - previous.yaw)) * blend;
  pose.leftHand.lerp(previous.leftHand, 1 - blend);
  pose.rightHand.lerp(previous.rightHand, 1 - blend);
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function meetSeated(pose: Pose, geo: MeetingGeometry): void {
  seated(pose);
  pose.x = geo.seat.x;
  pose.z = geo.seat.z;
  pose.yaw = geo.yaw;
  pose.chair = CHAIR_OUT;
}

function meetTransition(pose: Pose, geo: MeetingGeometry, amount: number, progress: number): void {
  meetSeated(pose, geo);
  pose.hip += 0.36 * amount;
  pose.x += geo.back.x * STAND_BACK * amount;
  pose.z += geo.back.z * STAND_BACK * amount;
  pose.meetChair = CHAIR_OUT * amount;
  pose.leftThigh *= 1 - amount;
  pose.rightThigh *= 1 - amount;
  pose.leftKnee *= 1 - amount;
  pose.rightKnee *= 1 - amount;
  pose.leftHand.lerp(STAND_LEFT, amount);
  pose.rightHand.lerp(STAND_RIGHT, amount);
  pose.lean = 0.12 * Math.sin(progress * Math.PI);
}

function meetWalking(pose: Pose, path: WalkPath, time: number, carried: number): void {
  standing(pose);
  const route = sampleWalk(path, time);
  pose.x = route.x;
  pose.z = route.z;
  pose.yaw = route.yaw;
  walking(pose, time, route.speed);
  pose.headY = Math.sin(time * 0.4) * 0.08 * route.speed;
  pose.leftHand.lerp(CARRY_HAND, carried);
}

function meetOpening(pose: Pose, time: number, duration: number): void {
  const activity = windowWeight(time, 0, 1.2, duration - 1.2, duration);
  const welcome = windowWeight(time, 0.4, 1.6, 2.8, 4.0);
  pose.leftHand.lerp(POSE_TARGET.set(-0.34, 0.36, 0.32), welcome);
  pose.rightHand.lerp(POSE_TARGET.set(0.34, 0.36, 0.32), welcome);
  pose.headY = Math.sin(time * 0.9) * 0.45 * activity;
  pose.headX = -0.04 * welcome;
  pose.lean = -0.03 * welcome;
}

function meetOrdering(pose: Pose, time: number, duration: number): void {
  const activity = windowWeight(time, 0, 1, duration - 1.2, duration);
  const beat = Math.max(0, Math.sin(time * 3.4));
  pose.rightHand.lerp(POSE_TARGET.set(0.14 + Math.sin(time * 1.3) * 0.08, 0.42 + beat * 0.07, 0.5), activity);
  pose.leftHand.lerp(POSE_TARGET.set(-0.2, 0.22, 0.4), activity);
  pose.lean = 0.06 * activity;
  pose.headY = Math.sin(time * 0.45) * 0.4 * activity;
  pose.headX = (0.05 * beat - 0.02) * activity;
  pose.sway = Math.sin(time * 0.9) * 0.015 * activity;
}

function meetListening(pose: Pose, geo: MeetingGeometry, time: number, duration: number): void {
  const activity = windowWeight(time, 0, 1, duration - 1, duration);
  const notes = smooth((Math.sin(time * 0.55 - 1.2) - 0.35) / 0.4);
  pose.headY = THREE.MathUtils.lerp(geo.presenterLook, 0, notes) * activity;
  pose.headX = 0.2 * notes * activity;
  pose.rightHand.lerp(POSE_TARGET.set(0.06 + Math.sin(time * 8) * 0.015, 0.235 + Math.abs(Math.sin(time * 13)) * 0.008, 0.42), notes * activity);
  pose.leftHand.lerp(POSE_TARGET.set(-0.12, 0.22, 0.43), activity);
  pose.sway = Math.sign(geo.presenterLook) * 0.02 * (1 - notes) * activity;
}

function meetApproving(pose: Pose, time: number, duration: number): void {
  const activity = windowWeight(time, 0, 0.8, duration - 1, duration);
  const nod = windowWeight(time, 0.2, 0.6, 2.2, 2.8);
  const thumb = windowWeight(time, 1.4, 2.2, 3.8, 4.6);
  pose.headX = (0.08 + Math.sin(time * 7) * 0.1) * nod;
  pose.headY = Math.sin(time * 0.8) * 0.3 * (1 - nod) * activity;
  pose.rightHand.lerp(POSE_TARGET.set(0.2, 0.56, 0.3), thumb);
  pose.lean = -0.05 * activity;
}

function sampleMeetingPose(state: MeetingState, time: number, duration: number, run: MeetingRun, geo: MeetingGeometry, pose: Pose): void {
  const progress = Math.max(0, Math.min(1, time / duration));
  const carried = run.carried ? 1 : 0;
  if (state === "meetRise") {
    samplePose("standing", time, duration, pose);
    if (!run.carried) pose.leftHand.lerp(STAND_LEFT, 1);
    return;
  }
  if (state === "meetWalk") {
    meetWalking(pose, run.walk, time, carried);
    pose.meetChair = CHAIR_OUT * smooth((time - (duration - 3)) / 2.2);
    return;
  }
  if (state === "meetReturn") {
    meetWalking(pose, run.back, time, carried * (1 - smooth((time - duration + 2) / 2)));
    pose.meetChair = CHAIR_OUT * (1 - smooth(time / 2));
    return;
  }
  if (state === "meetSit" || state === "meetStand") {
    const amount = state === "meetStand" ? smooth(progress) : 1 - smooth(progress);
    meetTransition(pose, geo, amount, progress);
    if (state === "meetStand" && run.carried) pose.leftHand.lerp(CARRY_HAND, smooth((time - 1.2) / 1.6));
    return;
  }
  meetSeated(pose, geo);
  if (state === "meetOpen") meetOpening(pose, time, duration);
  else if (state === "meetOrder") meetOrdering(pose, time, duration);
  else if (state === "meetListen") meetListening(pose, geo, time, duration);
  else meetApproving(pose, time, duration);
}

function paperWeights(sample: MeetingSample, carried: boolean): { held: number; table: number } {
  if (!carried) return { held: 0, table: 0 };
  const t = sample.time;
  if (sample.state === "meetRise") return { held: smooth((t - 1.4) / 2.2), table: 0 };
  if (sample.state === "meetWalk") return { held: 1, table: 0 };
  if (sample.state === "meetReturn") return { held: 1 - smooth((t - sample.duration + 2) / 2), table: 0 };
  if (sample.state === "meetSit") return { held: 1, table: smooth((sample.progress - 0.3) / 0.45) };
  if (sample.state === "meetStand") return { held: 1, table: 1 - smooth((t - 1.2) / 1.4) };
  return { held: 1, table: 1 };
}

function bubbleText(sample: MeetingSample, agenda: MeetingAgenda): string | null {
  if (sample.state === "meetOpen") return agenda.kind === "project" ? `Khởi động dự án ${clip(agenda.project)}. Bắt đầu họp!` : `Họp nhanh về ${clip(agenda.project)}.`;
  if (sample.state === "meetOrder") return `Giao việc: ${clip(agenda.title)}`;
  if (sample.state === "meetListen" && sample.time < 3.5) return "Mời trình bày kế hoạch.";
  if (sample.state === "meetApprove" && sample.time > 0.6) return "Duyệt! Triển khai ngay.";
  return null;
}

export class CeoAnimator {
  state: CeoState | MeetingState = "typing";
  stateLabel = CEO_TIMELINE[0].label as string;
  phase = 0;
  readonly mug = new THREE.Group();
  readonly document = new THREE.Group();
  private readonly paperPage = new THREE.Group();
  readonly phone = new THREE.Group();
  private readonly base: THREE.Vector3;
  private readonly chairBase: THREE.Vector3;
  private readonly pose = createPose();
  private readonly previousPose = createPose();
  private readonly stage = new THREE.Group();
  private readonly shoulder = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly bend = new THREE.Vector3();
  private readonly elbow = new THREE.Vector3();
  private readonly upperDirection = new THREE.Vector3();
  private readonly foreDirection = new THREE.Vector3();
  private readonly localTarget = new THREE.Vector3();
  private readonly worldHand = new THREE.Vector3();
  private readonly inverse = new THREE.Quaternion();
  private readonly ownedMaterials: THREE.Material[] = [];
  private readonly airbags: { mesh: THREE.Object3D; scale: THREE.Vector3 }[] = [];
  private readonly bubble = document.createElement("div");
  private geo: MeetingGeometry | null = null;
  private request: { token: number; agenda: MeetingAgenda } | null = null;
  private run: MeetingRun | null = null;
  private current: MeetingSample | null = null;
  private tokens = 0;
  private cycleOffset = 0;

  constructor(readonly rig: PersonRig, readonly chair: THREE.Object3D, root: THREE.Group, readonly massage: MassageChair) {
    this.base = rig.root.position.clone();
    this.chairBase = chair.position.clone();
    massage.root.traverse((mesh) => {
      if (mesh.userData.massageAirbag) this.airbags.push({ mesh, scale: mesh.scale.clone() });
    });
    this.stage.position.copy(this.base);
    root.add(this.stage);
    this.stage.add(this.mug, this.document, this.phone);
    this.document.name = "ceo-document";
    const white = new THREE.MeshStandardMaterial({ color: 0xf3efdf, roughness: 0.5 });
    const ink = new THREE.MeshStandardMaterial({ color: 0x293b4d, roughness: 0.62 });
    const coffee = new THREE.MeshStandardMaterial({ color: 0x482e1d, roughness: 0.3 });
    const silver = new THREE.MeshStandardMaterial({ color: 0xb9c2cb, metalness: 0.5, roughness: 0.3 });
    const screen = new THREE.MeshStandardMaterial({ color: 0x1a5780, emissive: 0x123451, emissiveIntensity: 0.25 });
    this.ownedMaterials.push(white, ink, coffee, silver, screen);
    const mesh = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0) => {
      const part = new THREE.Mesh(geometry, material);
      part.position.set(x, y, z);
      part.castShadow = part.receiveShadow = true;
      part.userData.keep = true;
      parent.add(part);
      return part;
    };
    mesh(this.mug, new THREE.CylinderGeometry(0.057, 0.047, 0.12, 16, 1, true), white);
    mesh(this.mug, new THREE.CylinderGeometry(0.045, 0.045, 0.008, 16), white, 0, -0.056);
    mesh(this.mug, new THREE.CylinderGeometry(0.052, 0.052, 0.004, 16), coffee, 0, 0.049);
    mesh(this.mug, new THREE.TorusGeometry(0.055, 0.005, 6, 16), white, 0, 0.06).rotation.x = Math.PI / 2;
    mesh(this.mug, new THREE.TorusGeometry(0.035, 0.009, 6, 14, Math.PI * 1.65), white, -0.063, 0.005).rotation.z = 0.56;
    mesh(this.document, new THREE.BoxGeometry(0.29, 0.37, 0.012), ink);
    for (let page = 0; page < 2; page++) mesh(this.document, new THREE.BoxGeometry(0.255, 0.325, 0.002), white, page * 0.002, page * 0.001, 0.008 + page * 0.002);
    this.paperPage.position.set(-0.125, 0.002, 0.014);
    this.paperPage.name = "ceo-document-page";
    this.document.add(this.paperPage);
    mesh(this.paperPage, new THREE.BoxGeometry(0.25, 0.32, 0.002), white, 0.125, 0);
    mesh(this.document, new THREE.BoxGeometry(0.065, 0.025, 0.009), silver, 0, 0.17, 0.013);
    for (let i = 0; i < 5; i++) mesh(this.paperPage, new THREE.BoxGeometry(i === 0 ? 0.13 : 0.2, 0.008, 0.002), ink, 0.125, 0.11 - i * 0.045, 0.003);
    mesh(this.phone, new THREE.BoxGeometry(0.095, 0.18, 0.015), silver);
    mesh(this.phone, new THREE.BoxGeometry(0.083, 0.16, 0.003), screen, 0, 0, 0.009);
    mesh(this.phone, new THREE.BoxGeometry(0.025, 0.004, 0.002), ink, 0, 0.065, 0.012);
    mesh(this.phone, new THREE.CylinderGeometry(0.012, 0.012, 0.005, 10), ink, -0.025, 0.06, -0.011).rotation.x = Math.PI / 2;
    this.bubble.className = "ceo-say";
    this.bubble.hidden = true;
    const bubble = new CSS2DObject(this.bubble);
    bubble.center.set(0.5, 1);
    bubble.position.set(0, BUBBLE_Y, 0);
    this.rig.root.add(bubble);
    this.rig.root.userData.ceo = true;
    this.tick(0, 0);
  }

  attachMeeting(chair: THREE.Object3D, room: MeetingLayout): void {
    const forward = { x: Math.sin(room.head.facing), z: Math.cos(room.head.facing) };
    const person = { x: room.head.x + forward.x * SEAT_FORWARD, z: room.head.z + forward.z * SEAT_FORWARD };
    const seat = { x: person.x - this.base.x, z: person.z - this.base.z };
    const stand = { x: seat.x - forward.x * STAND_BACK, z: seat.z - forward.z * STAND_BACK };
    const look = Math.atan2(room.presenter.x - person.x, room.presenter.z - person.z);
    const turn = Math.atan2(Math.sin(look - room.head.facing), Math.cos(look - room.head.facing));
    this.geo = {
      seat, stand, approach: { x: stand.x, z: stand.z + ROOM_APPROACH }, yaw: room.head.facing, back: { x: -forward.x, z: -forward.z },
      chair, chairBase: chair.position.clone(),
      table: new THREE.Vector3(seat.x + forward.x * PAPER_REACH, TABLE_PAPER_Y, seat.z + forward.z * PAPER_REACH),
      presenterLook: Math.max(-MAX_HEAD_TURN, Math.min(MAX_HEAD_TURN, turn)),
    };
  }

  requestMeeting(agenda: MeetingAgenda): number {
    this.request = { token: ++this.tokens, agenda };
    return this.tokens;
  }

  get speechBubble(): HTMLElement {
    return this.bubble;
  }

  meetingStatus(): CeoMeetingStatus | null {
    if (this.run && this.current) return { token: this.run.token, state: this.current.state, time: this.current.time, duration: this.current.duration };
    if (this.request) return { token: this.request.token, state: "waiting", time: 0, duration: 0 };
    return null;
  }

  private local(point: { x: number; z: number }): PathPoint {
    return { x: point.x - this.base.x, z: point.z - this.base.z };
  }

  private hallway(): PathPoint[] {
    const office = doorPoint(ZONE_BY_ID.get("ceo")!);
    const room = doorPoint(ZONE_BY_ID.get("meeting")!);
    return [this.local(office.inside), this.local(office.outside), this.local(room.outside), this.local(room.inside)];
  }

  private routeTo(from: PathPoint, geo: MeetingGeometry): PathPoint[] {
    const points: PathPoint[] = [from];
    if (from.z < DESK_CLEAR_Z) {
      const lane = from.x < -0.5 ? -DESK_LANE_X : DESK_LANE_X;
      points.push({ x: lane, z: from.z }, { x: lane, z: DESK_FRONT_Z });
    }
    return [...points, ...this.hallway(), geo.approach, geo.stand];
  }

  private routeBack(geo: MeetingGeometry): PathPoint[] {
    return [geo.stand, geo.approach, ...this.hallway().reverse(), { x: DESK_LANE_X, z: DESK_FRONT_Z }, { x: DESK_LANE_X, z: DESK_STAND.z }, DESK_STAND];
  }

  private startMeeting(elapsed: number, quiet: boolean): void {
    const geo = this.geo;
    if (!this.request || this.run || !geo) return;
    const cycle = sampleCeoTimeline(quiet ? 30 : elapsed - this.cycleOffset);
    const seatedAtDesk = quiet || SEATED_STATES.has(cycle.state);
    if (!seatedAtDesk && !MOVING_STATES.has(cycle.state)) return;
    const from = seatedAtDesk ? DESK_STAND : { x: this.pose.x, z: this.pose.z };
    const walk = walkPath(this.routeTo(from, geo), seatedAtDesk ? 0 : this.pose.yaw, geo.yaw);
    const back = walkPath(this.routeBack(geo), geo.yaw, 0);
    const entry = createPose();
    copyPose(this.pose, entry);
    this.run = {
      ...this.request, startedAt: elapsed, walk, back, entry,
      steps: meetingSteps(seatedAtDesk, walk.duration, back.duration),
      carried: seatedAtDesk || CARRYING_STATES.has(cycle.state),
    };
    this.request = null;
  }

  private poseMeeting(sample: MeetingSample, run: MeetingRun, geo: MeetingGeometry, quiet: boolean): void {
    sampleMeetingPose(sample.state, sample.time, sample.duration, run, geo, this.pose);
    if (sample.index === 0) copyPose(run.entry, this.previousPose);
    else {
      const previous = run.steps[sample.index - 1];
      sampleMeetingPose(previous.state, previous.duration, previous.duration, run, geo, this.previousPose);
    }
    blendPose(this.pose, this.previousPose, quiet ? 1 : smooth(sample.time / BLEND_S));
    this.state = sample.state;
    this.stateLabel = sample.label;
    this.phase = sample.progress;
  }

  private poseCycle(elapsed: number, quiet: boolean): CeoTimelineSample {
    const sample = sampleCeoTimeline(quiet ? 30 : elapsed - this.cycleOffset);
    this.state = sample.state;
    this.stateLabel = quiet ? "Làm việc tại bàn" : sample.label;
    this.phase = sample.progress;
    samplePose(sample.state, quiet ? 0 : sample.time, sample.duration, this.pose);
    const previous = CEO_TIMELINE[(sample.index + CEO_TIMELINE.length - 1) % CEO_TIMELINE.length];
    samplePose(previous.state, previous.duration, previous.duration, this.previousPose);
    blendPose(this.pose, this.previousPose, quiet ? 1 : smooth(sample.time / BLEND_S));
    return sample;
  }

  private solveArm(index: number, target: THREE.Vector3): void {
    const arm = this.rig.arms[index];
    this.shoulder.copy(arm.upper.position);
    this.direction.copy(target).sub(this.shoulder);
    const distance = Math.max(0.045, Math.min(0.529, this.direction.length()));
    this.direction.normalize();
    this.localTarget.copy(this.shoulder).addScaledVector(this.direction, distance);
    this.bend.copy(DOWN).addScaledVector(this.direction, -DOWN.dot(this.direction));
    if (this.bend.lengthSq() < 0.001) this.bend.set(index ? 1 : -1, 0, 0);
    this.bend.normalize();
    const along = (0.25 * 0.25 - 0.28 * 0.28 + distance * distance) / (2 * distance);
    const outward = Math.sqrt(Math.max(0, 0.25 * 0.25 - along * along));
    this.elbow.copy(this.shoulder).addScaledVector(this.direction, along).addScaledVector(this.bend, outward);
    this.upperDirection.copy(this.elbow).sub(this.shoulder).normalize();
    arm.upper.quaternion.setFromUnitVectors(DOWN, this.upperDirection);
    this.inverse.copy(arm.upper.quaternion).invert();
    this.foreDirection.copy(this.localTarget).sub(this.elbow).normalize().applyQuaternion(this.inverse);
    arm.forearm.quaternion.setFromUnitVectors(DOWN, this.foreDirection);
    arm.hand.rotation.set(0, 0, index ? -0.08 : 0.08);
  }

  tick(_dt: number, elapsed: number): void {
    elapsed = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    const quiet = reducedMotion();
    this.startMeeting(elapsed, quiet);
    const run = this.run;
    this.current = run ? sampleMeeting(run.steps, elapsed - run.startedAt) : null;
    if (run && !this.current) {
      this.run = null;
      this.cycleOffset = elapsed - SITTING_START;
    }
    const meeting = this.run && this.current && this.geo ? this.current : null;
    const cycle = meeting ? null : this.poseCycle(elapsed, quiet);
    if (meeting && this.run && this.geo) this.poseMeeting(meeting, this.run, this.geo, quiet);
    this.applyPose(elapsed, quiet);
    if (meeting && this.run) this.placeMeetingProps(meeting, this.run);
    else if (cycle) this.placeCycleProps(cycle, quiet);
    const said = meeting && this.run ? bubbleText(meeting, this.run.agenda) : null;
    if (this.bubble.textContent !== (said ?? "")) this.bubble.textContent = said ?? "";
    this.bubble.hidden = said === null;
    this.rig.root.userData.ceoState = this.state;
    this.rig.root.userData.ceoStateLabel = this.stateLabel;
  }

  private applyPose(elapsed: number, quiet: boolean): void {
    const pose = this.pose;
    this.rig.root.position.set(this.base.x + pose.x, this.base.y, this.base.z + pose.z);
    this.rig.root.rotation.y = pose.yaw;
    const footClearance = 0.26 + Math.max(0.36 * Math.cos(pose.leftThigh) + 0.36 * Math.cos(pose.leftThigh + pose.leftKnee), 0.36 * Math.cos(pose.rightThigh) + 0.36 * Math.cos(pose.rightThigh + pose.rightKnee));
    this.rig.body.position.y = Math.max(pose.hip + (quiet ? 0 : Math.sin(elapsed * 1.5) * 0.0025), footClearance + Math.abs(Math.sin(pose.sway)) * 0.2);
    this.rig.body.rotation.set(pose.lean, 0, pose.sway);
    this.rig.head.rotation.set(pose.headX, pose.headY, pose.headZ);
    this.rig.legs[0].upper.rotation.x = pose.leftThigh - pose.lean;
    this.rig.legs[1].upper.rotation.x = pose.rightThigh - pose.lean;
    this.rig.legs[0].lower.rotation.x = pose.leftKnee;
    this.rig.legs[1].lower.rotation.x = pose.rightKnee;
    this.rig.legs[0].foot.rotation.x = -pose.leftThigh - pose.leftKnee;
    this.rig.legs[1].foot.rotation.x = -pose.rightThigh - pose.rightKnee;
    this.solveArm(0, pose.leftHand);
    this.solveArm(1, pose.rightHand);
    this.chair.position.z = this.chairBase.z - pose.chair;
    if (this.geo) this.geo.chair.position.set(this.geo.chairBase.x + this.geo.back.x * pose.meetChair, this.geo.chairBase.y, this.geo.chairBase.z + this.geo.back.z * pose.meetChair);
    this.massage.back.rotation.x = -0.35 * pose.recline;
    this.massage.legRest.rotation.x = -1.15 * pose.recline;
    this.massage.legRest.position.z = 0.35 + 0.22 * pose.recline;
    this.airbags.forEach(({ mesh, scale }, index) => {
      const pressure = 1 + pose.recline * 0.035 * (0.5 + Math.sin(elapsed * 1.7 + index * 0.8) * 0.5);
      mesh.scale.copy(scale).multiplyScalar(pressure);
    });
    this.rig.root.updateMatrixWorld(true);
    this.stage.updateMatrixWorld(true);
  }

  private placeDocument(held: number, support: number, home: THREE.Vector3, flatYaw = 0): void {
    const bodyRotation = this.rig.body.getWorldQuaternion(new THREE.Quaternion());
    const stageRotation = this.stage.getWorldQuaternion(new THREE.Quaternion()).invert();
    const heldRotation = bodyRotation.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-2.35, 0, Math.PI)));
    const heldLocalRotation = stageRotation.clone().multiply(heldRotation);
    const flatRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, flatYaw, Math.PI, "YXZ"));
    this.document.quaternion.copy(flatRotation).slerp(heldLocalRotation, held);
    const left = this.rig.arms[0].hand.getWorldPosition(new THREE.Vector3());
    const right = this.rig.arms[1].hand.getWorldPosition(new THREE.Vector3());
    const leftAnchor = new THREE.Vector3(0.137, -0.1, 0.028);
    const rightAnchor = new THREE.Vector3(-0.137, -0.1, 0.028);
    const centre = left.clone().sub(leftAnchor.clone().applyQuaternion(heldRotation));
    const twoHandCentre = left.clone().add(right).multiplyScalar(0.5).sub(new THREE.Vector3(0, -0.1, 0.028).applyQuaternion(heldRotation));
    centre.lerp(twoHandCentre, support);
    this.document.position.copy(home).lerp(this.stage.worldToLocal(centre), held);
    this.document.updateWorldMatrix(true, true);
    const anchors = [leftAnchor, rightAnchor];
    for (const index of [0, 1]) {
      const amount = held * (index === 0 ? 1 : support);
      if (amount <= 0) continue;
      const desired = this.rig.body.worldToLocal(this.document.localToWorld(anchors[index].clone()));
      const current = index === 0 ? this.pose.leftHand : this.pose.rightHand;
      this.solveArm(index, current.clone().lerp(desired, amount));
      this.rig.root.updateWorldMatrix(true, true);
      const hand = this.rig.arms[index].hand;
      const parentRotation = hand.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
      const gripRotation = parentRotation.multiply(this.document.getWorldQuaternion(new THREE.Quaternion()));
      hand.quaternion.slerp(gripRotation, amount);
    }
    this.rig.root.updateWorldMatrix(true, true);
    this.document.userData.paperGrip = { held, support, anchors: anchors.map(anchor => anchor.toArray()) };
  }

  private placeMeetingProps(sample: MeetingSample, run: MeetingRun): void {
    this.paperPage.rotation.y = 0;
    this.mug.position.copy(MUG_HOME);
    this.mug.rotation.set(0, 0, 0);
    this.phone.position.copy(PHONE_HOME);
    this.phone.rotation.set(-Math.PI / 2, 0, 0);
    const { held, table } = paperWeights(sample, run.carried);
    const home = PAPER_HOME.clone();
    if (this.geo) home.lerp(this.geo.table, table);
    this.placeDocument(held * (1 - table), 0, home, this.pose.yaw * table);
  }

  private placeCycleProps(sample: CeoTimelineSample, quiet: boolean): void {
    const pose = this.pose;
    const t = sample.time;
    const drinking = !quiet && sample.state === "coffee";
    const mugHeld = drinking ? windowWeight(t, 2.2, 3, 12.5, 13.3) : 0;
    const sip = drinking ? windowWeight(t, 3, 5.4, 9.5, 12.3) : 0;
    this.worldHand.set(0, -0.025, 0.035);
    this.rig.arms[0].hand.localToWorld(this.worldHand);
    this.stage.worldToLocal(this.worldHand);
    this.mug.position.copy(MUG_HOME).lerp(this.worldHand, mugHeld);
    this.mug.rotation.set(-0.3 * sip, pose.yaw * mugHeld, 0);
    const reading = !quiet && sample.state === "reading";
    const inspecting = !quiet && sample.state === "inspecting";
    const carrying = !quiet && (sample.state === "walking" || sample.state === "standing" || sample.state === "returning");
    let paperHeld = reading ? windowWeight(t, 1, 3.5, sample.duration - 4, sample.duration - 1) : inspecting ? 1 : 0;
    if (carrying) paperHeld = sample.state === "standing" ? smooth((t - 1.4) / 2.2) : sample.state === "returning" ? 1 - smooth((t - sample.duration + 2) / 2) : 1;
    const support = reading ? paperHeld : inspecting ? windowWeight(t, 0, 1.2, sample.duration - 1.2, sample.duration) : 0;
    const pageCheck = reading ? windowWeight(t, 7, 7.7, 8.3, 9) : inspecting ? windowWeight(t, 5, 5.7, 6.3, 7) : 0;
    this.paperPage.rotation.y = -pageCheck * 0.4;
    this.placeDocument(paperHeld, support, PAPER_HOME);
    const calling = !quiet && sample.state === "phone";
    const phoneHeld = calling ? windowWeight(t, 2.2, 3, 11.2, 12.2) : 0;
    this.worldHand.set(0.025, -0.01, 0.025);
    this.rig.arms[1].hand.localToWorld(this.worldHand);
    this.stage.worldToLocal(this.worldHand);
    this.phone.position.copy(PHONE_HOME).lerp(this.worldHand, phoneHeld);
    this.phone.rotation.set(-Math.PI / 2 * (1 - phoneHeld), (-Math.PI / 2 + pose.yaw) * phoneHeld, -0.1 * phoneHeld);
  }

  dispose(): void {
    for (const material of this.ownedMaterials) material.dispose();
    this.bubble.remove();
  }
}
