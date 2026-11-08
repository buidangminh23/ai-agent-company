import * as THREE from "three";
import { mascotArmReach, mascotHandPosition, reachMascotHand, type Mascot } from "./mascots.ts";
import type { LoungeActivity } from "./layout.ts";
import { damp, reducedMotion, shortestAngle } from "../motion.ts";
import { coffeeCycle } from "./coffee-timeline.ts";
import { EightBallRules, type ShotFacts } from "./eight-ball.ts";

const TURN_MIN_S = 2.4;
const TURN_SPREAD_S = 2.6;
const SHOT_S = 6.5;
const POOL_STRIKE_PHASE = 0.655;
const POOL_SIDE_CLEARANCE = 0.47;
const LAUGH_S = 0.9;
const LAUGH_CHANCE = 0.55;
const MAX_BODY_TURN = 1.15;
const SIP_WINDOW = 0.16;
const STEAM_PUFFS = 3;
const BUBBLE_DOTS = 3;

export interface LoungeMember {
  id: string;
  circle: string;
  activity: LoungeActivity;
  x: number;
  z: number;
}

export interface LoungeCue {
  activity: LoungeActivity;
  lookAt: { x: number; z: number } | null;
  speaking: boolean;
  laugh: number;
  shooter: boolean;
  shotPhase: number;
  cheer: number;
  poolAim?: { x: number; y: number; z: number; dx: number; dz: number; bridgeDistance?: number; bridgeY?: number; gripDistance?: number; stance?: { x: number; z: number }; approach?: { x: number; z: number }[] };
}

export interface LoungePose {
  arms: [number, number] | null;
  bodyYaw: number | null;
  lean: number | null;
  nod: number;
  shake: number;
  lift: number;
  sip: number;
  stroke: number;
  stance?: { x: number; z: number };
  stepping?: boolean;
}

interface Circle {
  speaker: string | null;
  since: number;
  until: number;
  laughers: Set<string>;
  poolWalkS?: number;
  poolReturnS?: number;
}

function centroid(points: { x: number; z: number }[]): { x: number; z: number } | null {
  if (!points.length) return null;
  return { x: points.reduce((s, p) => s + p.x, 0) / points.length, z: points.reduce((s, p) => s + p.z, 0) / points.length };
}

export class LoungeDirector {
  private readonly circles = new Map<string, Circle>();

  cues(members: LoungeMember[], t: number): Map<string, LoungeCue> {
    const out = new Map<string, LoungeCue>();
    const groups = new Map<string, LoungeMember[]>();
    for (const m of members) {
      const list = groups.get(m.circle) ?? [];
      list.push(m);
      groups.set(m.circle, list);
    }
    for (const key of this.circles.keys()) if (!groups.has(key)) this.circles.delete(key);
    for (const [key, group] of groups) {
      const activity = group[0].activity;
      const circle = this.circles.get(key) ?? { speaker: null, since: t, until: t, laughers: new Set<string>() };
      this.circles.set(key, circle);
      const rolling = activity === "pool" && billiardsTables.some(table => {
        if (!billiardsAttached(table.root) || !table.physics.moving) return false;
        const center = table.root.getWorldPosition(new THREE.Vector3());
        return Math.hypot(center.x - group[0].x, center.z - group[0].z) < 2.8;
      });
      if ((!rolling && t >= circle.until) || !group.some((m) => m.id === circle.speaker)) this.rotate(circle, group, t, activity);
      const speaker = group.find((m) => m.id === circle.speaker)!;
      for (const m of group) out.set(m.id, this.cue(m, group, speaker, circle, t));
    }
    return out;
  }

  private rotate(circle: Circle, group: LoungeMember[], t: number, activity: LoungeActivity): void {
    const others = group.filter((m) => m.id !== circle.speaker);
    let next = others.length ? others[Math.floor(Math.random() * others.length)] : group[0];
    if (activity === "pool") {
      const table = billiardsTables.find(entry => billiardsAttached(entry.root) && entry.root.getWorldPosition(new THREE.Vector3()).distanceTo(new THREE.Vector3(group[0].x, 0, group[0].z)) < 2.8);
      if (table) {
        if (table.physics.rules.winner !== null) table.physics.prepare();
        const players = [...group].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 2);
        next = players[table.physics.rules.currentPlayer % players.length];
      }
    }
    const hadSpeaker = circle.speaker !== null && group.length > 1;
    circle.laughers = new Set(hadSpeaker && activity !== "pool" ? group.filter((m) => m.id !== next.id && Math.random() < LAUGH_CHANCE).map((m) => m.id) : []);
    circle.speaker = next.id;
    circle.since = t;
    circle.until = t + (activity === "pool" ? SHOT_S : TURN_MIN_S + Math.random() * TURN_SPREAD_S);
    circle.poolWalkS = undefined;
    circle.poolReturnS = undefined;
  }

  private cue(m: LoungeMember, group: LoungeMember[], speaker: LoungeMember, circle: Circle, t: number): LoungeCue {
    const elapsed = t - circle.since;
    const isSpeaker = m.id === speaker.id;
    const crowd = group.length > 1;
    if (m.activity === "pool") {
      const walkS = circle.poolWalkS ?? SHOT_S * 0.24;
      const returnS = circle.poolReturnS ?? SHOT_S * 0.2;
      const strokeS = SHOT_S * 0.56;
      const shotPhase = Math.min(1, elapsed < walkS ? elapsed / walkS * 0.24 : elapsed < walkS + strokeS ? 0.24 + (elapsed - walkS) / SHOT_S : 0.8 + (elapsed - walkS - strokeS) / returnS * 0.2);
      const poolAim = isSpeaker ? billiardTurn(speaker, circle.since, shotPhase, t) : null;
      if (poolAim && circle.poolWalkS === undefined) {
        const path = poolAim.approach ?? [{ x: speaker.x, z: speaker.z }, poolAim.stance ?? speaker];
        const distance = path.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - path[index].x, point.z - path[index].z), 0);
        circle.poolWalkS = Math.max(SHOT_S * 0.24, distance * 0.75);
        circle.poolReturnS = Math.max(SHOT_S * 0.2, distance * 0.75);
        circle.until = circle.since + circle.poolWalkS + strokeS + circle.poolReturnS;
      }
      const cheer = !isSpeaker && shotPhase > 0.64 && shotPhase < 0.86 ? Math.sin(((shotPhase - 0.64) / 0.22) * Math.PI) : 0;
      return { activity: m.activity, lookAt: isSpeaker ? poolAim : { x: speaker.x, z: speaker.z }, speaking: false, laugh: 0, shooter: isSpeaker, shotPhase, cheer, ...(poolAim ? { poolAim } : {}) };
    }
    const lookAt = !crowd ? null : isSpeaker ? centroid(group.filter((g) => g.id !== m.id)) : { x: speaker.x, z: speaker.z };
    const laugh = circle.laughers.has(m.id) ? Math.max(0, 1 - elapsed / LAUGH_S) : 0;
    return { activity: m.activity, lookAt, speaking: isSpeaker && crowd, laugh, shooter: false, shotPhase: 0, cheer: 0 };
  }
}

function poolEase(phase: number, start: number, end: number): number {
  const u = THREE.MathUtils.clamp((phase - start) / (end - start), 0, 1);
  return u * u * (3 - 2 * u);
}

function shotStroke(phase: number): number {
  if (phase < 0.18) return -0.06;
  if (phase < 0.5) {
    const u = (phase - 0.18) / 0.32;
    return -0.06 - 0.035 * Math.pow(Math.sin(u * Math.PI * 2), 2);
  }
  if (phase < 0.6) return -0.06 - 0.11 * poolEase(phase, 0.5, 0.6);
  if (phase < POOL_STRIKE_PHASE) {
    const u = (phase - 0.6) / (POOL_STRIKE_PHASE - 0.6);
    return -0.17 + 0.17 * u * u;
  }
  if (phase < 0.7) {
    const u = (phase - POOL_STRIKE_PHASE) / (0.7 - POOL_STRIKE_PHASE);
    return 0.08 * (1 - Math.pow(1 - u, 4));
  }
  return 0.08 - 0.18 * poolEase(phase, 0.75, 0.88);
}

function poolStroke(cue: LoungeCue): number {
  const clearance = (cue.poolAim?.bridgeDistance ?? 0.34) - BILLIARD_RADIUS - 0.025;
  return shotStroke(cue.shotPhase) * THREE.MathUtils.clamp(clearance / 0.17, 0.05, 1);
}

function sipLevel(t: number, phase: number): number {
  const period = 6.5 + (phase % 1) * 2;
  const c = ((t + phase * 3) % period) / period;
  return c < SIP_WINDOW ? Math.sin((c / SIP_WINDOW) * Math.PI) : 0;
}

export function loungePose(cue: LoungeCue, yaw: number, pos: { x: number; z: number }, t: number, phase: number, hasMug: boolean): LoungePose {
  const pose: LoungePose = { arms: null, bodyYaw: null, lean: null, nod: 0, shake: 0, lift: 0, sip: 0, stroke: 0 };
  if (reducedMotion()) return { ...pose, arms: hasMug ? [0, -0.55] : null };
  if (cue.lookAt) {
    const want = shortestAngle(yaw, Math.atan2(cue.lookAt.x - pos.x, cue.lookAt.z - pos.z));
    pose.bodyYaw = Math.max(-MAX_BODY_TURN, Math.min(MAX_BODY_TURN, want));
  }
  if (cue.activity === "pool") return poolPose(cue, pose, t, pos, yaw);
  if (cue.activity === "bar" && hasMug) {
    const coffee = coffeeCycle(t);
    pose.bodyYaw = 0;
    pose.sip = coffee.sip;
    if (coffee.cupHeld) {
      pose.arms = [-0.15, -0.55 - pose.sip * 1.4];
      pose.nod = pose.sip * 0.05;
    } else {
      const reach = coffee.stage === "prepare" ? Math.sin(coffee.progress * Math.PI) : coffee.stage === "serve" || coffee.stage === "return" ? Math.sin(coffee.progress * Math.PI) : 0;
      pose.arms = [-0.12, -0.25 - reach * 0.95];
      pose.lean = reach * 0.08;
    }
    return pose;
  }
  const hold = hasMug ? -0.55 + Math.sin(t * 1.3 + phase) * 0.05 : 0;
  pose.sip = hasMug && !cue.speaking ? sipLevel(t, phase) : 0;
  const mugArm = hold + (-1.95 - hold) * pose.sip;
  if (cue.speaking) {
    const talk = -0.5 + Math.sin(t * 5.5 + phase) * 0.45;
    pose.arms = [talk, hasMug ? mugArm + Math.sin(t * 4 + phase) * 0.12 : -0.4 + Math.sin(t * 4.6 + phase + 1.3) * 0.4];
    pose.lift = Math.abs(Math.sin(t * 7 + phase)) * 0.025;
    pose.nod = Math.sin(t * 6 + phase) * 0.04;
  } else {
    pose.arms = [0, mugArm];
    pose.nod = Math.sin(t * 3.2 + phase) * 0.07 * Math.max(0, Math.sin(t * 0.8 + phase));
  }
  if (cue.laugh > 0) {
    pose.shake = Math.sin(t * 38) * 0.07 * cue.laugh;
    pose.lift += Math.abs(Math.sin(t * 16)) * 0.06 * cue.laugh;
    pose.arms = [-0.45 * cue.laugh, pose.arms[1] - 0.25 * cue.laugh];
  }
  return pose;
}

function poolPose(cue: LoungeCue, pose: LoungePose, t: number, pos: { x: number; z: number }, yaw: number): LoungePose {
  if (cue.shooter && cue.poolAim) {
    pose.stroke = poolStroke(cue);
    pose.arms = [-1.25, -1.35];
    const settle = poolEase(cue.shotPhase, 0, 0.24) * (1 - poolEase(cue.shotPhase, 0.8, 1));
    pose.bodyYaw = shortestAngle(yaw, Math.atan2(cue.poolAim.dx, cue.poolAim.dz));
    pose.lean = 0.22 * poolEase(cue.shotPhase, 0.24, 0.32) * (1 - poolEase(cue.shotPhase, 0.75, 0.8));
    if (cue.poolAim.stance) pose.stance = {
      x: THREE.MathUtils.lerp(pos.x, cue.poolAim.stance.x, settle),
      z: THREE.MathUtils.lerp(pos.z, cue.poolAim.stance.z, settle),
    };
    const path = cue.poolAim.approach;
    if (path && path.length > 1) {
      const lengths = path.slice(1).map((point, index) => Math.hypot(point.x - path[index].x, point.z - path[index].z));
      let remaining = lengths.reduce((sum, length) => sum + length, 0) * settle;
      for (let index = 0; index < lengths.length; index++) {
        if (remaining <= lengths[index] || index === lengths.length - 1) {
          const amount = lengths[index] > 0 ? remaining / lengths[index] : 1;
          pose.stance = { x: THREE.MathUtils.lerp(path[index].x, path[index + 1].x, amount), z: THREE.MathUtils.lerp(path[index].z, path[index + 1].z, amount) };
          if (settle < 0.999 && settle > 0.001) {
            const sign = cue.shotPhase < 0.5 ? 1 : -1;
            pose.bodyYaw = shortestAngle(yaw, Math.atan2((path[index + 1].x - path[index].x) * sign, (path[index + 1].z - path[index].z) * sign));
          }
          break;
        }
        remaining -= lengths[index];
      }
    }
    pose.stepping = Boolean(pose.stance && settle > 0.001 && settle < 0.999);
    if (pose.stepping) pose.arms = null;
    return pose;
  }
  pose.arms = [-2.6 * cue.cheer, -2.6 * cue.cheer];
  pose.lift = cue.cheer * 0.16;
  pose.nod = cue.cheer ? 0 : Math.sin(t * 1.4) * 0.03;
  return pose;
}

const mugMat = new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.35 });
const coffeeMat = new THREE.MeshStandardMaterial({ color: 0x4a2b17, roughness: 0.5 });
const steamMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35, roughness: 1 });
const cueMat = new THREE.MeshStandardMaterial({ color: 0xc9935a, roughness: 0.45 });
const cueTipMat = new THREE.MeshStandardMaterial({ color: 0x2a5bd7, roughness: 0.5 });
const bubbleMat = new THREE.MeshStandardMaterial({ color: 0xfbfbf8, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.6 });
const dotMat = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.6 });
const puffGeo = new THREE.BoxGeometry(0.035, 0.035, 0.035);
const dotGeo = new THREE.BoxGeometry(0.06, 0.06, 0.02);

export interface LoungeProps {
  mascot: Mascot;
  mug: THREE.Group;
  steam: THREE.Mesh[];
  cue: THREE.Group;
  bubble: THREE.Group;
  dots: THREE.Mesh[];
  mugLevel: number;
  cueLevel: number;
  bubbleLevel: number;
  poolArms: { root: THREE.Group; upper: THREE.Mesh; forearm: THREE.Mesh; hand: THREE.Mesh; shoulder: THREE.Vector3 }[];
  poolRest: { root: THREE.Group; shaft: THREE.Mesh; head: THREE.Mesh; rear: THREE.Mesh };
}

function armTip(arm: THREE.Object3D): number {
  const mesh = arm.children[0] as THREE.Mesh;
  const height = (mesh.geometry as THREE.BoxGeometry).parameters?.height ?? 0.15;
  return mesh.position.y - height / 2;
}

function buildMug(): { mug: THREE.Group; steam: THREE.Mesh[] } {
  const mug = new THREE.Group();
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.048, 0.11, 10), mugMat);
  const coffee = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.047, 0.01, 10), coffeeMat);
  coffee.position.y = 0.05;
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.06, 0.04), mugMat);
  handle.position.set(0.065, 0, 0);
  mug.add(cup, coffee, handle);
  const steam = Array.from({ length: STEAM_PUFFS }, () => new THREE.Mesh(puffGeo, steamMat));
  mug.add(...steam);
  return { mug, steam };
}

function buildCue(): THREE.Group {
  const cue = new THREE.Group();
  cue.name = "pool-cue";
  const stick = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 1.25), cueMat);
  stick.position.z = 0.35;
  const tip = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.05), cueTipMat);
  tip.position.z = 0.99;
  tip.name = "pool-cue-tip";
  cue.add(stick, tip);
  return cue;
}

function buildBubble(): { bubble: THREE.Group; dots: THREE.Mesh[] } {
  const bubble = new THREE.Group();
  const card = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.26, 0.05), bubbleMat);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.05), bubbleMat);
  tail.position.set(-0.12, -0.15, 0);
  tail.rotation.z = Math.PI / 4;
  bubble.add(card, tail);
  const dots = Array.from({ length: BUBBLE_DOTS }, (_, i) => {
    const dot = new THREE.Mesh(dotGeo, dotMat);
    dot.position.set((i - 1) * 0.12, 0, 0.035);
    return dot;
  });
  bubble.add(...dots);
  return { bubble, dots };
}

export function createLoungeProps(mascot: Mascot): LoungeProps {
  const { mug, steam } = buildMug();
  const hand = mascot.arms[mascot.arms.length - 1];
  mug.position.set(0, armTip(hand) - 0.04, 0.07);
  hand.add(mug);
  const cue = buildCue();
  cue.position.set(0.05, mascot.height * 0.42, 0.05);
  mascot.body.add(cue);
  const { bubble, dots } = buildBubble();
  bubble.position.set(0.22, mascot.height + 0.32, 0);
  mascot.root.add(bubble);
  for (const prop of [mug, cue, bubble]) prop.visible = false;
  const poolArms = mascot.arms.map((arm, index) => {
    const root = new THREE.Group();
    const material = (arm.children[0] as THREE.Mesh).material;
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1, 0.07), material);
    const forearm = new THREE.Mesh(new THREE.BoxGeometry(0.065, 1, 0.065), material);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(index ? 0.07 : 0.12, index ? 0.09 : 0.035, index ? 0.075 : 0.13), material);
    if (!index) {
      const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.04, 0.06), material);
      thumb.position.set(0.04, 0.03, 0.015);
      hand.add(thumb);
    }
    root.add(upper, forearm, hand); root.visible = false;
    mascot.body.add(root);
    const shoulder = arm.position.clone();
    return { root, upper, forearm, hand, shoulder };
  });
  const restRoot = new THREE.Group();
  restRoot.name = "pool-mechanical-bridge";
  mascot.body.add(restRoot);
  const restShaft = new THREE.Mesh(new THREE.BoxGeometry(0.023, 1, 0.023), cueMat);
  const restHead = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.04, 0.055), cueTipMat);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(0.025, 1, 0.025), cueMat);
  rear.name = "pool-cue-extension-grip";
  restRoot.add(restShaft, restHead, rear); restRoot.visible = false;
  return { mascot, mug, steam, cue, bubble, dots, mugLevel: 0, cueLevel: 0, bubbleLevel: 0, poolArms, poolRest: { root: restRoot, shaft: restShaft, head: restHead, rear } };
}

function poolArmSegment(mesh: THREE.Mesh, from: THREE.Vector3, to: THREE.Vector3): void {
  const direction = to.clone().sub(from);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.scale.y = direction.length();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
}

function reveal(prop: THREE.Object3D, level: number): void {
  prop.visible = level > 0.02;
  prop.scale.setScalar(0.6 + 0.4 * level);
}

export function animateLoungeProps(props: LoungeProps, cue: LoungeCue | null, pose: LoungePose | null, hasMug: boolean, t: number, dt: number, yaw: number): void {
  const still = reducedMotion();
  const holdingCoffee = cue?.activity !== "bar" || coffeeCycle(t).cupHeld;
  const mugGoal = cue && hasMug && cue.activity !== "pool" && cue.activity !== "bar" && holdingCoffee ? 1 : 0;
  props.mugLevel = cue?.activity === "bar" ? mugGoal : damp(props.mugLevel, mugGoal, 10, dt);
  const addressing = cue?.shooter && cue.poolAim && cue.shotPhase >= 0.32 && cue.shotPhase < 0.8;
  props.cueLevel = damp(props.cueLevel, addressing ? 1 : 0, 10, dt);
  props.bubbleLevel = damp(props.bubbleLevel, cue?.speaking ? 1 : 0, 14, dt);
  reveal(props.mug, props.mugLevel);
  reveal(props.cue, props.cueLevel);
  if (!addressing) props.cue.visible = false;
  reveal(props.bubble, props.bubbleLevel);
  const arm = props.mug.parent!;
  props.mug.rotation.x = -arm.rotation.x - (pose?.sip ?? 0) * 0.9;
  props.steam.forEach((puff, i) => {
    const k = still ? 0.4 : (t * 0.6 + i / STEAM_PUFFS) % 1;
    puff.position.set(still ? 0 : Math.sin(t * 2 + i * 2.1) * 0.02 * k, 0.07 + k * 0.22, 0);
    puff.scale.setScalar(Math.max(0.05, 1 - k) * (pose?.sip ? 0.3 : 1));
  });
  props.poolArms.forEach((arm, index) => {
    arm.root.visible = Boolean(cue?.poolAim && props.cue.visible);
    props.mascot.arms[index].children[0].visible = !arm.root.visible;
    props.mascot.arms[index].getObjectByName(`mascot-forearm-${index}`)!.children[0].visible = !arm.root.visible;
  });
  props.poolRest.root.visible = false;
  if (cue?.poolAim && props.cue.visible) {
    const aim = cue.poolAim;
    const stroke = still ? -0.015 : poolStroke(cue);
    const distance = 1.015 + BILLIARD_RADIUS - stroke;
    const lift = still ? 0 : 0.04 * (1 - poolEase(cue.shotPhase, 0.32, 0.36) + poolEase(cue.shotPhase, 0.76, 0.8));
    const gripDistance = aim.gripDistance ?? 1.08;
    const shaftLength = Math.max(1.5, gripDistance + 0.22);
    const shaft = props.cue.children[0];
    shaft.scale.z = (shaftLength - 0.04) / 1.25;
    shaft.position.z = 0.975 - (shaftLength - 0.04) / 2;
    props.mascot.body.updateWorldMatrix(true, false);
    const direction = new THREE.Vector3(aim.dx, -0.045, aim.dz).normalize();
    const origin = new THREE.Vector3(aim.x, aim.y + lift, aim.z).addScaledVector(direction, -distance);
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), direction);
    props.cue.parent!.updateWorldMatrix(true, false);
    props.cue.matrixAutoUpdate = false;
    props.cue.matrix.copy(props.cue.parent!.matrixWorld).invert().multiply(new THREE.Matrix4().compose(origin, rotation, new THREE.Vector3(1, 1, 1)));
    props.cue.matrixWorldNeedsUpdate = true;
    props.cue.updateWorldMatrix(true, false);
    props.poolArms.forEach((arm, index) => {
      const shoulder = props.mascot.arms[index].position.clone();
      const bridge = aim.bridgeDistance ?? 0.34;
      const worldWrist = index
        ? props.cue.localToWorld(new THREE.Vector3(0, -0.035, 1.015 + BILLIARD_RADIUS - gripDistance))
        : new THREE.Vector3(aim.x - aim.dx * bridge, (aim.bridgeY ?? aim.y - 0.015) + lift, aim.z - aim.dz * bridge);
      const requested = props.mascot.body.worldToLocal(worldWrist);
      const reach = mascotArmReach(props.mascot, index);
      const wrist = reachMascotHand(props.mascot, index, props.mascot.body, requested.x, requested.y, requested.z);
      const elbow = props.mascot.body.worldToLocal(props.mascot.arms[index].getObjectByName(`mascot-forearm-${index}`)!.getWorldPosition(new THREE.Vector3()));
      if (requested.distanceTo(shoulder) > reach - 0.001) {
        props.poolRest.root.visible = true;
        if (!index) {
          props.poolRest.head.position.copy(requested);
          props.poolRest.head.quaternion.copy(props.mascot.body.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation));
          poolArmSegment(props.poolRest.shaft, wrist, requested);
        } else poolArmSegment(props.poolRest.rear, wrist, requested);
      } else if (index) props.poolRest.rear.scale.y = 0;
      if (!index && requested.distanceTo(shoulder) <= reach - 0.001) {
        props.poolRest.shaft.scale.y = 0;
        props.poolRest.head.scale.setScalar(0);
      } else if (!index) props.poolRest.head.scale.setScalar(1);
      poolArmSegment(arm.upper, shoulder, elbow);
      poolArmSegment(arm.forearm, elbow, wrist);
      arm.hand.position.copy(wrist);
      arm.hand.quaternion.copy(props.mascot.body.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(rotation));
    });
  }
  props.bubble.rotation.y = -yaw;
  props.dots.forEach((dot, i) => (dot.position.y = still ? 0 : Math.max(0, Math.sin(t * 9 - i * 0.9)) * 0.045));
  if (props.mug.visible) {
    const mascot = props.mascot;
    const sip = pose?.sip ?? 0;
    const index = mascot.arms.length - 1;
    const shoulder = mascot.arms[index].position;
    reachMascotHand(mascot, index, mascot.body, shoulder.x * (1 - sip * 0.35), THREE.MathUtils.lerp(shoulder.y - 0.02, mascot.height * 0.6, sip), 0.18 - sip * 0.06);
    props.mug.position.copy(mascotHandPosition(mascot, index, mascot.arms[index]));
    mascot.arms[index].getWorldQuaternion(props.mug.quaternion).invert();
    props.mug.rotateX(-sip * 0.65);
  }
}

export interface BilliardBall {
  number: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  pocketed: boolean;
  sink: number;
}

export interface BilliardEvent {
  kind: "strike" | "collision" | "cushion" | "pocket" | "rack";
  x: number;
  z: number;
}

export const BILLIARD_RADIUS = 0.052;
const BALL_Y = 0.87 + BILLIARD_RADIUS;
const POCKETS = [-0.97, 0, 0.97].flatMap(x => [-0.49, 0.49].map(z => ({ x, z })));

export class BilliardsPhysics {
  readonly balls: BilliardBall[] = [];
  readonly events: BilliardEvent[] = [];
  shots = 0;
  readonly rules = new EightBallRules();
  private shot: ShotFacts | null = null;
  calledShot: { ball: number; pocket: number | null } | null = null;

  constructor() { this.rack(); }

  rack(): void {
    this.balls.length = 0;
    this.balls.push({ number: 0, x: -0.57, z: 0, vx: 0, vz: 0, pocketed: false, sink: 0 });
    const numbers = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 6, 13, 7, 14, 15];
    let index = 0;
    for (let row = 0; row < 5; row++) for (let column = 0; column <= row; column++) {
      this.balls.push({ number: numbers[index++], x: 0.15 + row * BILLIARD_RADIUS * 1.76, z: (column - row / 2) * BILLIARD_RADIUS * 2.04, vx: 0, vz: 0, pocketed: false, sink: 0 });
    }
    this.shots = 0;
    this.rules.reset();
    this.shot = null;
    this.calledShot = null;
    this.events.length = 0;
    this.events.push({ kind: "rack", x: 0.3, z: 0 });
  }

  get moving(): boolean { return this.balls.some(ball => !ball.pocketed && Math.hypot(ball.vx, ball.vz) > 0.025); }

  setupBreak(direction: { x: number; z: number }): void {
    if (this.shots || this.moving) return;
    const length = Math.hypot(direction.x, direction.z) || 1;
    const dx = direction.x / length, dz = direction.z / length;
    this.balls[0].x = -dx * 0.36; this.balls[0].z = -dz * 0.36;
    let index = 1;
    for (let row = 0; row < 5; row++) for (let column = 0; column <= row; column++) {
      const along = -0.04 + row * BILLIARD_RADIUS * 1.76;
      const across = (column - row / 2) * BILLIARD_RADIUS * 2.04;
      this.balls[index].x = dx * along - dz * across;
      this.balls[index++].z = dz * along + dx * across;
    }
    this.events.push({ kind: "rack", x: dx * 0.12, z: dz * 0.12 });
  }

  prepare(): void {
    if (this.moving) return;
    if (this.rules.winner !== null) { this.rack(); return; }
    const white = this.balls[0];
    if (!white.pocketed && !this.rules.ballInHand) return;
    for (const x of this.rules.behindHeadString ? [-0.7, -0.6, -0.8] : [-0.65, -0.45, 0, 0.45, 0.65]) for (const z of [0, -0.25, 0.25, -0.35, 0.35]) {
      if (this.balls.slice(1).some(ball => !ball.pocketed && Math.hypot(ball.x - x, ball.z - z) < BILLIARD_RADIUS * 2.1)) continue;
      Object.assign(white, { x, z, vx: 0, vz: 0, pocketed: false, sink: 0 });
      return;
    }
  }

  target(): BilliardBall | undefined {
    const white = this.balls[0];
    const legal = this.rules.legalTargets(this.balls.filter(ball => !ball.pocketed).map(ball => ball.number));
    return this.balls.slice(1).filter(ball => !ball.pocketed && legal.includes(ball.number)).sort((a, b) => Math.hypot(a.x - white.x, a.z - white.z) - Math.hypot(b.x - white.x, b.z - white.z))[0];
  }

  plan(): { x: number; z: number; power: number; ball: number; pocket: number | null } | null {
    const white = this.balls[0];
    if (!this.shots) return { x: 1, z: 0, power: 6.8, ball: 1, pocket: null };
    const legal = this.rules.legalTargets(this.balls.filter(ball => !ball.pocketed).map(ball => ball.number));
    const targets = this.balls.filter(ball => !ball.pocketed && legal.includes(ball.number));
    const clear = (from: { x: number; z: number }, to: { x: number; z: number }, ignored: number[]) => {
      const dx = to.x - from.x, dz = to.z - from.z, length2 = dx * dx + dz * dz;
      return this.balls.every(ball => {
        if (ball.pocketed || ignored.includes(ball.number)) return true;
        const along = Math.max(0, Math.min(1, ((ball.x - from.x) * dx + (ball.z - from.z) * dz) / (length2 || 1)));
        return Math.hypot(ball.x - from.x - dx * along, ball.z - from.z - dz * along) >= BILLIARD_RADIUS * 2.05;
      });
    };
    const shots: { x: number; z: number; power: number; ball: number; pocket: number; score: number }[] = [];
    for (const ball of targets) for (const [pocket, hole] of POCKETS.entries()) {
      const distance = Math.hypot(hole.x - ball.x, hole.z - ball.z);
      const ox = (hole.x - ball.x) / distance, oz = (hole.z - ball.z) / distance;
      const ghost = { x: ball.x - ox * BILLIARD_RADIUS * 2, z: ball.z - oz * BILLIARD_RADIUS * 2 };
      if (Math.abs(ghost.x) > 0.94 || Math.abs(ghost.z) > 0.44) continue;
      const travel = Math.hypot(ghost.x - white.x, ghost.z - white.z);
      const x = (ghost.x - white.x) / travel, z = (ghost.z - white.z) / travel;
      const cut = x * ox + z * oz;
      if (cut < 0.3 || !clear(white, ghost, [0, ball.number]) || !clear(ball, hole, [0, ball.number])) continue;
      if (this.rules.behindHeadString && ghost.x <= -0.5) continue;
      shots.push({ x, z, ball: ball.number, pocket, power: Math.min(3.4, (1.35 * distance + 0.35) / cut + 1.35 * travel), score: cut * 3 - travel - distance });
    }
    shots.sort((a, b) => b.score - a.score);
    if (shots[0]) return shots[0];
    for (const ball of targets.sort((a, b) => Math.hypot(a.x - white.x, a.z - white.z) - Math.hypot(b.x - white.x, b.z - white.z))) {
      if (!clear(white, ball, [0, ball.number]) || (this.rules.behindHeadString && ball.x <= -0.5)) continue;
      const distance = Math.hypot(ball.x - white.x, ball.z - white.z);
      return { x: (ball.x - white.x) / distance, z: (ball.z - white.z) / distance, power: 2.4, ball: ball.number, pocket: null };
    }
    const target = targets[0];
    if (!target) return null;
    const distance = Math.hypot(target.x - white.x, target.z - white.z) || 1;
    return { x: (target.x - white.x) / distance, z: (target.z - white.z) / distance, power: 2.4, ball: target.number, pocket: null };
  }

  strike(direction?: { x: number; z: number }, plan = this.plan()): boolean {
    if (this.moving || this.shot || this.balls[0].pocketed || this.rules.winner !== null) return false;
    const white = this.balls[0], target = this.target();
    if (!target) return false;
    const aim = direction ?? plan;
    if (!aim || !Number.isFinite(aim.x) || !Number.isFinite(aim.z) || Math.hypot(aim.x, aim.z) < 1e-6) return false;
    const angle = Math.atan2(aim.z, aim.x);
    const power = plan?.power ?? (this.shots ? 2.4 : 6.8);
    this.calledShot = plan ? { ball: plan.ball, pocket: plan.pocket } : null;
    this.shot = { breakShot: this.shots === 0, firstContact: null, pocketed: [], railAfterContact: false, objectRails: [], remainingBefore: this.balls.filter(ball => ball.number && !ball.pocketed).map(ball => ball.number), calledBall: plan?.pocket == null ? null : plan.ball, calledPocket: plan?.pocket ?? null };
    this.rules.ballInHand = false;
    this.rules.behindHeadString = false;
    this.rules.lastFoul = null;
    white.vx = Math.cos(angle) * power;
    white.vz = Math.sin(angle) * power;
    this.shots++;
    this.events.push({ kind: "strike", x: white.x, z: white.z });
    return true;
  }

  step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const elapsed = Math.min(0.1, dt);
    const steps = Math.ceil(elapsed * 180);
    const h = elapsed / steps;
    for (let step = 0; step < steps; step++) {
      for (const ball of this.balls) {
        if (ball.pocketed) { ball.sink = Math.min(1, ball.sink + h * 3.2); continue; }
        ball.x += ball.vx * h;
        ball.z += ball.vz * h;
        const pocket = POCKETS.find(hole => Math.hypot(ball.x - hole.x, ball.z - hole.z) < 0.089);
        if (pocket) {
          this.shot?.pocketed.push({ number: ball.number, pocket: POCKETS.indexOf(pocket) });
          Object.assign(ball, { x: pocket.x, z: pocket.z, vx: 0, vz: 0, pocketed: true, sink: 0 });
          this.events.push({ kind: "pocket", x: pocket.x, z: pocket.z });
          continue;
        }
        let cushion = false;
        if (Math.abs(ball.x) > 0.948) { ball.x = Math.sign(ball.x) * 0.948; if (ball.vx * ball.x > 0) { ball.vx *= -0.82; cushion = true; } }
        if (Math.abs(ball.z) > 0.448) { ball.z = Math.sign(ball.z) * 0.448; if (ball.vz * ball.z > 0) { ball.vz *= -0.82; cushion = true; } }
        if (cushion) {
          if (this.shot?.firstContact != null) this.shot.railAfterContact = true;
          if (this.shot && ball.number && !this.shot.objectRails.includes(ball.number)) this.shot.objectRails.push(ball.number);
          if (Math.hypot(ball.vx, ball.vz) > 0.2) this.events.push({ kind: "cushion", x: ball.x, z: ball.z });
        }
        const drag = Math.exp(-1.35 * h);
        ball.vx *= drag; ball.vz *= drag;
        if (Math.hypot(ball.vx, ball.vz) < 0.025) { ball.vx = 0; ball.vz = 0; }
      }
      for (let i = 0; i < this.balls.length; i++) for (let j = i + 1; j < this.balls.length; j++) {
        const a = this.balls[i], b = this.balls[j];
        if (a.pocketed || b.pocketed) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const distance = Math.hypot(dx, dz);
        if (distance >= BILLIARD_RADIUS * 2) continue;
        const nx = distance > 1e-6 ? dx / distance : 1, nz = distance > 1e-6 ? dz / distance : 0;
        const correction = (BILLIARD_RADIUS * 2 - distance) / 2 + 0.00001;
        a.x -= nx * correction; a.z -= nz * correction;
        b.x += nx * correction; b.z += nz * correction;
        const approaching = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
        if (approaching <= 0) continue;
        if (this.shot && this.shot.firstContact === null && (a.number === 0 || b.number === 0)) this.shot.firstContact = a.number === 0 ? b.number : a.number;
        const impulse = approaching * 0.96;
        a.vx -= impulse * nx; a.vz -= impulse * nz;
        b.vx += impulse * nx; b.vz += impulse * nz;
        if (approaching > 0.25) this.events.push({ kind: "collision", x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
      }
    }
    if (this.shot && !this.moving) {
      const result = this.rules.resolveShot(this.shot);
      this.shot = null;
      if (result.rerack) {
        const player = this.rules.currentPlayer;
        this.rack();
        this.rules.currentPlayer = player;
      } else if (result.respotEight) {
        const eight = this.balls.find(ball => ball.number === 8)!;
        for (let x = 0.15; x <= 0.9; x += 0.11) {
          if (this.balls.some(ball => ball !== eight && !ball.pocketed && Math.hypot(ball.x - x, ball.z) < BILLIARD_RADIUS * 2.1)) continue;
          Object.assign(eight, { x, z: 0, vx: 0, vz: 0, pocketed: false, sink: 0 });
          break;
        }
      }
    }
    if (this.events.length > 48) this.events.splice(0, this.events.length - 48);
  }
}

interface BilliardsTable {
  root: THREE.Object3D;
  physics: BilliardsPhysics;
  balls: THREE.Mesh[];
  shadows: THREE.Mesh[];
  aim: THREE.Line;
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  effects: { mesh: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; life: number; pocket: boolean }[];
  trail: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  history: THREE.Vector3[];
  turn: string;
  struck: boolean;
  activeAt: number;
  phase: number;
  score: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  scoreCanvas: HTMLCanvasElement;
  lastScore: string;
  cueAim: NonNullable<LoungeCue["poolAim"]> | null;
  attached: boolean;
  plan: ReturnType<BilliardsPhysics["plan"]>;
}

const billiardsTables: BilliardsTable[] = [];
const billiardGeo = new THREE.SphereGeometry(BILLIARD_RADIUS, 20, 14);
const billiardMaterials = new Map<number, THREE.MeshStandardMaterial>();
const billiardColors = ["#f7f2df", "#f3c72c", "#205ccc", "#dc3338", "#7b43b6", "#ee7927", "#29864d", "#9e2737", "#151a24"];

function billiardsAttached(root: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = root; node; node = node.parent) if ((node as THREE.Scene).isScene) return true;
  return false;
}

function disposeBilliards(table: BilliardsTable): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  table.root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry && mesh.geometry !== billiardGeo) geometries.add(mesh.geometry);
    if (mesh.material && !Array.isArray(mesh.material) && ![...billiardMaterials.values()].includes(mesh.material as THREE.MeshStandardMaterial)) materials.add(mesh.material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  table.score.material.map?.dispose();
}

function billiardMaterial(number: number): THREE.MeshStandardMaterial {
  const cached = billiardMaterials.get(number);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const color = billiardColors[number > 8 ? number - 8 : number];
  context.fillStyle = number > 8 ? "#fff9e9" : color;
  context.fillRect(0, 0, 256, 128);
  if (number > 8) { context.fillStyle = color; context.fillRect(0, 38, 256, 52); }
  if (number) for (const x of [64, 192]) {
    context.fillStyle = "#fffdf4";
    context.beginPath(); context.arc(x, 64, 22, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#121826"; context.font = "bold 29px Arial"; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(String(number), x, 65);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.22, metalness: 0.06 });
  billiardMaterials.set(number, material);
  return material;
}

export function createBilliards(parent: THREE.Object3D): void {
  const root = new THREE.Group(); root.name = "billiards-game"; parent.add(root);
  const physics = new BilliardsPhysics();
  const verticalScale = root.getWorldScale(new THREE.Vector3()).y;
  const ballY = BALL_Y - BILLIARD_RADIUS + BILLIARD_RADIUS / verticalScale;
  const shadowMaterial = new THREE.MeshBasicMaterial({ color: 0x071c10, transparent: true, opacity: 0.3, depthWrite: false });
  const balls = physics.balls.map(ball => {
    const mesh = new THREE.Mesh(billiardGeo, billiardMaterial(ball.number));
    mesh.name = `billiard-ball-${ball.number}`;
    mesh.position.set(ball.x, ballY, ball.z);
    mesh.scale.y = 1 / verticalScale;
    mesh.rotation.x = Math.PI / 3;
    mesh.castShadow = true;
    root.add(mesh);
    return mesh;
  });
  const shadows = balls.map(() => {
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(BILLIARD_RADIUS * 1.1, 16), shadowMaterial);
    mesh.rotation.x = -Math.PI / 2; root.add(mesh); return mesh;
  });
  const aim = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xe8f9db, transparent: true, opacity: 0.48, dashSize: 0.045, gapSize: 0.04, depthWrite: false }));
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.071, 0.08, 32), new THREE.MeshBasicMaterial({ color: 0xa4edb2, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
  halo.rotation.x = -Math.PI / 2;
  const effects = Array.from({ length: 12 }, () => {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.05, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI / 2; mesh.visible = false; root.add(mesh);
    return { mesh, life: 0, pocket: false };
  });
  const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 10 }, () => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: 0xe8f8f1, transparent: true, opacity: 0.22, depthWrite: false }));
  const scoreCanvas = document.createElement("canvas"); scoreCanvas.width = 512; scoreCanvas.height = 112;
  const texture = new THREE.CanvasTexture(scoreCanvas); texture.colorSpace = THREE.SRGBColorSpace;
  const score = new THREE.Mesh(new THREE.PlaneGeometry(0.77, 0.17), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  score.position.set(0, 0.67, 0.611);
  root.add(aim, halo, trail, score);
  root.traverse(object => { object.userData.keep = true; });
  billiardsTables.push({ root, physics, balls, shadows, aim, halo, effects, trail, history: [], turn: "", struck: false, activeAt: -Infinity, phase: 0, score, scoreCanvas, lastScore: "", cueAim: null, attached: false, plan: null });
  tickBilliards(0, 0);
}

function poolApproach(root: THREE.Object3D, from: { x: number; z: number }, to: { x: number; z: number }): { x: number; z: number }[] {
  const start = root.worldToLocal(new THREE.Vector3(from.x, 0, from.z));
  const end = root.worldToLocal(new THREE.Vector3(to.x, 0, to.z));
  const width = 1.55, depth = 1.1, perimeter = 4 * (width + depth);
  const station = (point: THREE.Vector3): number => {
    if (Math.abs(point.x) / width > Math.abs(point.z) / depth) return point.x > 0 ? 2 * width + THREE.MathUtils.clamp(point.z, -depth, depth) + depth : 4 * width + 3 * depth - THREE.MathUtils.clamp(point.z, -depth, depth);
    return point.z < 0 ? THREE.MathUtils.clamp(point.x, -width, width) + width : 3 * width + 2 * depth - THREE.MathUtils.clamp(point.x, -width, width);
  };
  const pointAt = (offset: number): THREE.Vector3 => {
    const s = ((offset % perimeter) + perimeter) % perimeter;
    if (s < 2 * width) return new THREE.Vector3(s - width, 0, -depth);
    if (s < 2 * width + 2 * depth) return new THREE.Vector3(width, 0, s - 2 * width - depth);
    if (s < 4 * width + 2 * depth) return new THREE.Vector3(3 * width + 2 * depth - s, 0, depth);
    return new THREE.Vector3(-width, 0, 4 * width + 3 * depth - s);
  };
  const first = station(start), last = station(end);
  const clockwise = (last - first + perimeter) % perimeter;
  const sign = clockwise <= perimeter / 2 ? 1 : -1;
  const distance = sign > 0 ? clockwise : perimeter - clockwise;
  const corners = [0, 2 * width, 2 * width + 2 * depth, 4 * width + 2 * depth]
    .map(s => ({ s, along: ((s - first) * sign + perimeter) % perimeter }))
    .filter(corner => corner.along > 0.001 && corner.along < distance - 0.001)
    .sort((a, b) => a.along - b.along);
  return [start, pointAt(first), ...corners.map(corner => pointAt(corner.s)), pointAt(last), end].map(point => {
    root.localToWorld(point);
    return { x: point.x, z: point.z };
  });
}

function billiardTurn(speaker: LoungeMember, since: number, phase: number, t: number): NonNullable<LoungeCue["poolAim"]> | null {
  const point = new THREE.Vector3();
  const table = billiardsTables.find(entry => {
    if (!billiardsAttached(entry.root)) return false;
    entry.root.getWorldPosition(point);
    return Math.hypot(point.x - speaker.x, point.z - speaker.z) < 2.8;
  });
  if (!table) return null;
  table.activeAt = t;
  table.phase = phase;
  const key = `${speaker.id}:${since}`;
  if (table.turn !== key) {
    table.turn = key; table.struck = false; table.cueAim = null; table.physics.prepare();
    table.plan = table.physics.plan();
    table.history.length = 0;
  }
  if (table.physics.moving && !table.struck) return null;
  if (phase < POOL_STRIKE_PHASE && !table.struck) table.physics.prepare();
  if (!reducedMotion() && phase >= POOL_STRIKE_PHASE && !table.struck && table.cueAim) {
    table.root.updateWorldMatrix(true, false);
    const direction = new THREE.Vector3(table.cueAim.dx, 0, table.cueAim.dz).transformDirection(table.root.matrixWorld.clone().invert());
    table.struck = table.physics.strike({ x: direction.x, z: direction.z }, table.plan);
  }
  if (table.cueAim) return table.cueAim;
  const white = table.physics.balls[0];
  const verticalScale = table.root.getWorldScale(new THREE.Vector3()).y;
  point.set(white.x, BALL_Y - BILLIARD_RADIUS + BILLIARD_RADIUS / verticalScale, white.z);
  table.root.localToWorld(point);
  if (!table.plan) return null;
  const localDirection = new THREE.Vector3(table.plan.x, 0, table.plan.z).normalize();
  const direction = localDirection.clone().transformDirection(table.root.matrixWorld);
  const bodyX = white.x - localDirection.z * POOL_SIDE_CLEARANCE;
  const bodyZ = white.z + localDirection.x * POOL_SIDE_CLEARANCE;
  const exitX = Math.abs(localDirection.x) < 1e-6 ? Infinity : (bodyX + Math.sign(localDirection.x) * 1.22) / localDirection.x;
  const exitZ = Math.abs(localDirection.z) < 1e-6 ? Infinity : (bodyZ + Math.sign(localDirection.z) * 0.74) / localDirection.z;
  const distance = Math.max(0.95, Math.min(exitX, exitZ));
  const edgeX = Math.abs(localDirection.x) < 1e-6 ? Infinity : (white.x + Math.sign(localDirection.x) * 1.02) / localDirection.x;
  const edgeZ = Math.abs(localDirection.z) < 1e-6 ? Infinity : (white.z + Math.sign(localDirection.z) * 0.52) / localDirection.z;
  const bridgeDistance = Math.max(0.055, Math.min(distance - 0.55, edgeX - 0.04, edgeZ - 0.04));
  const bridgeX = white.x - localDirection.x * bridgeDistance;
  const bridgeZ = white.z - localDirection.z * bridgeDistance;
  const supportY = Math.abs(bridgeX) > 0.98 || Math.abs(bridgeZ) > 0.48 ? 0.935 : 0.889;
  const bridgeY = table.root.localToWorld(new THREE.Vector3(bridgeX, supportY, bridgeZ)).y;
  table.cueAim = {
    x: point.x, y: point.y, z: point.z, dx: direction.x, dz: direction.z, bridgeDistance, bridgeY,
    gripDistance: distance + 0.08,
    stance: { x: point.x - direction.x * distance - direction.z * POOL_SIDE_CLEARANCE, z: point.z - direction.z * distance + direction.x * POOL_SIDE_CLEARANCE },
  };
  table.cueAim.approach = poolApproach(table.root, speaker, table.cueAim.stance!);
  return table.cueAim;
}

export function tickBilliards(t: number, dt: number): void {
  const still = reducedMotion();
  for (let index = billiardsTables.length - 1; index >= 0; index--) {
    const table = billiardsTables[index];
    const attached = billiardsAttached(table.root);
    if (!attached && table.attached) { disposeBilliards(table); billiardsTables.splice(index, 1); continue; }
    if (attached) table.attached = true;
    const active = t - table.activeAt < 0.25;
    const verticalScale = table.root.getWorldScale(new THREE.Vector3()).y;
    const ballY = BALL_Y - BILLIARD_RADIUS + BILLIARD_RADIUS / verticalScale;
    if (!still) table.physics.step(dt);
    const white = table.physics.balls[0], target = table.physics.target();
    const potted = table.physics.balls.filter(ball => ball.number > 0 && ball.pocketed).length;
    const rules = table.physics.rules;
    const group = rules.groups[rules.currentPlayer];
    const label = group === "solid" ? "TRƠN" : group === "stripe" ? "SỌC" : "BÀN MỞ";
    const call = table.plan?.pocket == null ? "AN TOÀN" : `BI ${table.plan.ball} → LỖ ${table.plan.pocket + 1}`;
    const foulNames = { scratch: "BI TRẮNG VÀO LỖ", "no-contact": "KHÔNG CHẠM BI", "wrong-first-ball": "CHẠM SAI BI", "no-rail": "KHÔNG CHẠM BĂNG", "illegal-break": "PHÁ BI LỖI", "early-eight": "BI 8 QUÁ SỚM", "wrong-eight-pocket": "BI 8 SAI LỖ" };
    const headline = rules.winner !== null ? `NGƯỜI ${rules.winner + 1} THẮNG` : `LƯỢT ${rules.currentPlayer + 1} · ${label}`;
    const detail = rules.lastFoul ? `LỖI: ${foulNames[rules.lastFoul]}` : table.physics.shots === 0 ? "PHÁ BI" : call;
    const status = `${headline}|${detail}`;
    if (status !== table.lastScore) {
      const context = table.scoreCanvas.getContext("2d")!;
      context.clearRect(0, 0, 512, 112); context.fillStyle = "#151c1d"; context.fillRect(0, 0, 512, 112);
      context.fillStyle = "#f5df9d"; context.font = "600 32px Arial"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(headline, 256, 35);
      context.fillStyle = "#fff8e8"; context.font = "24px Arial"; context.fillText(detail, 256, 82);
      table.score.material.map!.needsUpdate = true; table.lastScore = status;
    }
    table.physics.balls.forEach((ball, index) => {
      const mesh = table.balls[index];
      if (ball.pocketed && ball.sink >= 1) {
        mesh.visible = ball.number !== 0;
        mesh.scale.set(0.55, 0.55 / verticalScale, 0.55);
        mesh.position.set(-0.43 + (ball.number - 1) * 0.062, 0.4775 + BILLIARD_RADIUS * 0.55 / verticalScale, 0.625);
      } else {
        const size = ball.pocketed ? 1 - ball.sink * 0.7 : 1;
        mesh.visible = true; mesh.scale.set(size, size / verticalScale, size);
        mesh.position.set(ball.x, ballY - (ball.pocketed ? ball.sink * 0.25 : 0), ball.z);
        if (!still) { mesh.rotateZ(-ball.vx * dt / BILLIARD_RADIUS); mesh.rotateX(ball.vz * dt / BILLIARD_RADIUS); }
      }
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeScale(mesh.scale.x, mesh.scale.y, mesh.scale.z).multiply(new THREE.Matrix4().makeRotationFromQuaternion(mesh.quaternion)).setPosition(mesh.position);
      mesh.matrixWorldNeedsUpdate = true;
      const shadow = table.shadows[index]; shadow.visible = !ball.pocketed; shadow.position.set(ball.x, 0.873, ball.z);
    });
    table.aim.visible = active && !white.pocketed && !table.physics.moving && table.phase < POOL_STRIKE_PHASE && Boolean(target);
    table.halo.visible = table.aim.visible;
    if (table.aim.visible && target) {
      table.root.updateWorldMatrix(true, false);
      const direction = new THREE.Vector3(table.cueAim?.dx ?? 1, 0, table.cueAim?.dz ?? 0).transformDirection(table.root.matrixWorld.clone().invert());
      const aimed = table.physics.balls.find(ball => ball.number === table.plan?.ball) ?? target;
      const distance = Math.min(Math.hypot(aimed.x - white.x, aimed.z - white.z), Math.abs((Math.sign(direction.x) * 0.94 - white.x) / (direction.x || 1e-8)), Math.abs((Math.sign(direction.z) * 0.44 - white.z) / (direction.z || 1e-8)));
      const positions = table.aim.geometry.getAttribute("position") as THREE.BufferAttribute;
      positions.setXYZ(0, white.x, 0.88, white.z); positions.setXYZ(1, white.x + direction.x * distance, 0.88, white.z + direction.z * distance); positions.needsUpdate = true;
      table.aim.geometry.computeBoundingSphere(); table.aim.computeLineDistances();
      table.halo.position.set(aimed.x, 0.88, aimed.z);
      table.halo.scale.setScalar(still ? 1 : 1 + Math.sin(t * 4) * 0.09);
    }
    for (const event of table.physics.events.splice(0)) {
      if (still) continue;
      const effect = table.effects.find(entry => entry.life <= 0);
      if (!effect) continue;
      effect.life = event.kind === "pocket" || event.kind === "rack" ? 1 : 0.45;
      effect.pocket = event.kind === "pocket" || event.kind === "rack";
      effect.mesh.position.set(event.x, 0.887, event.z);
      effect.mesh.material.color.setHex(event.kind === "pocket" ? 0xffd568 : event.kind === "rack" ? 0x8ee8b6 : 0xfffbdf);
    }
    for (const effect of table.effects) {
      if (still) effect.life = 0;
      effect.life = Math.max(0, effect.life - dt);
      effect.mesh.visible = effect.life > 0;
      effect.mesh.material.opacity = effect.life * 0.65;
      effect.mesh.scale.setScalar(1 + (1 - effect.life) * (effect.pocket ? 4.5 : 2));
    }
    table.trail.visible = !still && !white.pocketed && Math.hypot(white.vx, white.vz) > 0.35;
    if (table.trail.visible) {
      table.history.unshift(new THREE.Vector3(white.x, 0.88, white.z));
      table.history.length = Math.min(table.history.length, 10);
      const positions = table.trail.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let i = 0; i < 10; i++) { const point = table.history[Math.min(i, table.history.length - 1)]; positions.setXYZ(i, point.x, point.y, point.z); }
      positions.needsUpdate = true; table.trail.geometry.computeBoundingSphere();
    } else table.history.length = 0;
    table.root.userData.billiards = { balls: 16, shots: table.physics.shots, pocketed: potted, moving: table.physics.moving, active, player: rules.currentPlayer, groups: [...rules.groups], winner: rules.winner, foul: rules.lastFoul, calledShot: table.physics.calledShot };
  }
}
