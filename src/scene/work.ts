import * as THREE from "three";
import { mascotArmReach, mascotDeskPosture, mascotHandPosition, reachMascotHand, type Mascot } from "./mascots.ts";
import { damp, shortestAngle } from "../motion.ts";
import type { TrainingCue } from "../../shared/training.ts";
import type { AgentState } from "../../shared/types.ts";

export type WorkTask = "type" | "present" | "inspect" | "carry" | "water" | "rack" | "teach" | "learn";

export type DeskAction = "type" | "mouse" | "read" | "sip" | "think" | "stretch" | "recline" | "settle";

export interface DeskSample {
  action: DeskAction;
  progress: number;
  weight: number;
  lean: number;
  yaw: number;
  recline: number;
}

export interface WorkstationRig {
  keyboard: THREE.Group;
  mouse: THREE.Group;
  mug: THREE.Group;
  notebook: THREE.Group;
  pen?: THREE.Group;
  chair: THREE.Group;
  chairSeat: THREE.Group;
  chairBack: THREE.Group;
  chairLift?: THREE.Mesh;
  keyboardTray: THREE.Group;
  mouseTray: THREE.Group;
  cupTray?: THREE.Group;
  keys: THREE.InstancedMesh;
  keyRest: THREE.Matrix4[];
  fans: THREE.Object3D[];
  seatHeight?: number;
  footrest?: THREE.Group;
}

const DESK_SEQUENCES: Record<AgentState, readonly (readonly [DeskAction, number])[]> = {
  working: [["type", 16], ["mouse", 7], ["read", 6], ["type", 9], ["sip", 8], ["stretch", 5], ["settle", 5]],
  thinking: [["think", 9], ["read", 6], ["mouse", 5], ["stretch", 4], ["settle", 4]],
  waiting: [["read", 6], ["think", 6], ["sip", 8], ["settle", 5]],
  idle: [["read", 7], ["sip", 8], ["stretch", 6], ["recline", 9], ["settle", 5]],
};

const deskSmooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };
const deskPhase = (value: number, from: number, to: number) => deskSmooth((value - from) / (to - from));

export function sampleDeskAction(state: AgentState, t: number, phase = 0, quiet = false): DeskSample {
  if (quiet) return { action: "settle", progress: 0, weight: 0, lean: 0, yaw: 0, recline: 0 };
  const sequence = DESK_SEQUENCES[state];
  const duration = sequence.reduce((sum, [, seconds]) => sum + seconds, 0);
  let remaining = ((Number.isFinite(t) ? Math.max(0, t) : 0) + (Number.isFinite(phase) ? Math.max(0, phase) : 0)) % duration;
  let action: DeskAction = "settle";
  let progress = 0;
  for (const [name, seconds] of sequence) {
    if (remaining < seconds) { action = name; progress = remaining / seconds; break; }
    remaining -= seconds;
  }
  const weight = deskPhase(progress, 0, 0.16) * (1 - deskPhase(progress, 0.84, 1));
  const recline = action === "recline" ? weight * 0.12 : action === "stretch" ? weight * 0.055 : 0;
  const lean = (action === "read" ? 0.055 : action === "type" || action === "mouse" ? 0.035 : action === "think" ? -0.018 : 0) * weight - recline;
  const yaw = (action === "read" ? 0.1 : action === "mouse" ? -0.055 : action === "think" ? 0.085 : 0) * weight;
  return { action, progress, weight, lean, yaw, recline };
}

interface DeskHome {
  positions: Map<THREE.Object3D, THREE.Vector3>;
  rotations: Map<THREE.Object3D, THREE.Euler>;
  pressedKeys: number[];
}

export function sampleDeskKeystroke(t: number, broad: boolean, right = false): { index: number; previous: number; travel: number; lift: number; depth: number } {
  const sequence = right ? broad ? [55, 41, 54, 40, 53, 55, 40, 54] : [55, 41, 54, 53, 55, 54, 41, 53] : broad ? [42, 28, 43, 29, 44, 42, 29, 43] : [44, 30, 45, 31, 46, 43, 32, 45];
  const clock = Math.max(0, Number.isFinite(t) ? t : 0) * 2.8 + (right ? 0.5 : 0);
  const step = Math.floor(clock);
  const phase = clock - step;
  const travel = deskPhase(phase, 0, 0.38);
  return {
    index: sequence[step % sequence.length],
    previous: sequence[(step + sequence.length - 1) % sequence.length],
    travel,
    lift: Math.sin(travel * Math.PI) * 0.025,
    depth: Math.sin(deskPhase(phase, 0.45, 0.82) * Math.PI) ** 2 * 0.003,
  };
}

const deskHomes = new WeakMap<THREE.Object3D, DeskHome>();

function workstationHome(root: THREE.Object3D, rig: WorkstationRig): DeskHome {
  let home = deskHomes.get(root);
  if (!home) {
    const objects = [rig.keyboard, rig.mouse, rig.mug, rig.notebook, rig.chair, rig.chairSeat, rig.chairBack, rig.keyboardTray, rig.mouseTray, ...(rig.cupTray ? [rig.cupTray] : []), ...(rig.pen ? [rig.pen] : []), ...(rig.footrest ? [rig.footrest] : [])];
    home = { positions: new Map(objects.map(object => [object, object.position.clone()])), rotations: new Map(objects.map(object => [object, object.rotation.clone()])), pressedKeys: [] };
    deskHomes.set(root, home);
  }
  return home;
}

function updateTraySupport(root: THREE.Object3D, tray: THREE.Group): void {
  tray.updateWorldMatrix(true, false);
  for (const link of (tray.userData.supportLinks ?? []) as THREE.Mesh[]) {
    const anchor = link.userData.supportAnchor as THREE.Object3D | undefined;
    const from = anchor ? root.worldToLocal(anchor.localToWorld((link.userData.anchorOffset as THREE.Vector3).clone())) : link.userData.from as THREE.Vector3;
    const offset = link.userData.offset as THREE.Vector3;
    const to = root.worldToLocal(tray.localToWorld(offset.clone()));
    const direction = to.sub(from);
    link.position.copy(from).addScaledVector(direction, 0.5);
    link.scale.y = direction.length();
    if (direction.lengthSq() > 0.000001) link.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  }
}

export function resetWorkstation(root: THREE.Object3D, t: number, quiet = false): void {
  const rig = root.userData.workstation as WorkstationRig | undefined;
  if (!rig) return;
  const home = workstationHome(root, rig);
  for (const [object, position] of home.positions) object.position.copy(position);
  for (const [object, rotation] of home.rotations) object.rotation.copy(rotation);
  rig.mug.visible = true;
  rig.keyboard.scale.set(1, 1, 1);
  rig.mouseTray.scale.set(1, 1, 1);
  if (rig.chairLift) { rig.chairLift.position.y = 0.36; rig.chairLift.scale.y = 0.04; }
  if (home.pressedKeys.length) {
    for (const index of home.pressedKeys) rig.keys.setMatrixAt(index, rig.keyRest[index]);
    rig.keys.instanceMatrix.needsUpdate = true;
    home.pressedKeys.length = 0;
  }
  rig.fans.forEach((fan, index) => { fan.rotation.z = quiet ? 0 : t * (3.8 + index * 0.3); });
  root.userData.deskAction = "vacant";
  root.userData.deskOccupant = null;
  for (const tray of [rig.keyboardTray, rig.mouseTray, ...(rig.cupTray ? [rig.cupTray] : []), ...(rig.footrest ? [rig.footrest] : [])]) updateTraySupport(root, tray);
}

export function animateWorkstation(root: THREE.Object3D, mascot: Mascot, sample: DeskSample, t: number, occupant: string): void {
  const rig = root.userData.workstation as WorkstationRig | undefined;
  if (!rig) return;
  const home = workstationHome(root, rig);
  root.userData.deskAction = sample.action;
  root.userData.deskOccupant = occupant;
  rig.chairSeat.rotation.y += sample.yaw * 0.5;
  rig.chairBack.rotation.x += sample.recline;
  mascot.body.updateWorldMatrix(true, true);
  const toDesk = (point: THREE.Vector3) => root.worldToLocal(mascot.body.localToWorld(point));
  const toBody = (object: THREE.Object3D, point = new THREE.Vector3()) => mascot.body.worldToLocal(object.localToWorld(point));
  const broad = Math.abs(mascot.arms[0].position.x) > 0.4;
  const reach = Math.min(...mascot.arms.map((_, index) => mascotArmReach(mascot, index)));
  const forward = reach * 0.55;
  const posture = mascotDeskPosture(mascot);
  const hipY = Math.min(...mascot.legs.map(leg => leg.position.y));
  const heightLift = Math.max(0, toDesk(new THREE.Vector3(0, hipY, 0)).y - (rig.seatHeight ?? 0.48));
  rig.chairSeat.position.y += heightLift;
  if (rig.chairLift) {
    const underside = rig.chairSeat.position.y - 0.06;
    rig.chairLift.position.y = (0.34 + underside) / 2;
    rig.chairLift.scale.y = Math.max(0.04, underside - 0.34);
  }
  if (rig.footrest) {
    const ankles = mascot.legs.map((leg, index) => {
      const ankle = leg.getObjectByName(`mascot-ankle-${index}`);
      return root.worldToLocal(ankle ? ankle.getWorldPosition(new THREE.Vector3()) : leg.getWorldPosition(new THREE.Vector3()));
    });
    rig.footrest.position.set(ankles.reduce((sum, point) => sum + point.x, 0) / ankles.length, Math.max(0.06, Math.min(...ankles.map(point => point.y)) - 0.0225), ankles.reduce((sum, point) => sum + point.z, 0) / ankles.length);
  }
  rig.keyboard.scale.x = (broad ? 2.2 : 1) * mascot.root.scale.x;
  rig.keyboardTray.position.x = (broad ? 0 : -0.1) * mascot.root.scale.x;
  rig.keyboardTray.position.z = 0.29;
  rig.mouseTray.position.x = (broad ? 0.72 : 0.36) * mascot.root.scale.x;
  rig.mouseTray.position.z = 0.35;
  rig.mouseTray.scale.set(mascot.root.scale.x * (broad ? 0.75 : 1), 1, mascot.root.scale.x);
  rig.chair.position.z = 0.58 + (posture.seatZ - 0.58) * (mascot.root.userData.seated ?? 1);
  for (const button of rig.mouse.children.filter(part => part.name.startsWith("workstation-mouse-button-"))) {
    const click = sample.action === "mouse" ? Math.max(0, Math.sin(t * 8)) ** 8 * sample.weight : 0;
    button.position.y = 0.019 - click * 0.003;
    button.rotation.x = click * 0.05;
  }
  const wheel = rig.mouse.getObjectByName("workstation-mouse-wheel");
  if (wheel) wheel.rotation.x = sample.action === "mouse" ? Math.sin(t * 3) * 0.7 * sample.weight : 0;
  const rest = (index: number) => {
    const arm = mascot.arms[index];
    const mesh = arm.children[0] as THREE.Mesh<THREE.BoxGeometry>;
    return new THREE.Vector3(arm.position.x, arm.position.y - mesh.geometry.parameters.height, arm.position.z);
  };
  const applyHand = (index: number, target: THREE.Vector3, weight = sample.weight) => {
    const point = rest(index).lerp(target, weight);
    return reachMascotHand(mascot, index, mascot.body, point.x, point.y, point.z);
  };
  const rightHand = mascot.arms.findIndex(arm => arm.position.x < 0);
  const leftHand = mascot.arms.findIndex(arm => arm.position.x > 0);
  if (sample.action === "type" || sample.action === "mouse") {
    const typing = sample.action === "type";
    const keyTarget = (right: boolean) => {
      const stroke = sampleDeskKeystroke(t, broad, right);
      const index = Math.min(rig.keyRest.length - 1, typing ? stroke.index : broad ? 28 : 30);
      const previous = Math.min(rig.keyRest.length - 1, stroke.previous);
      const point = new THREE.Vector3().setFromMatrixPosition(rig.keyRest[index]);
      if (typing) {
        point.lerpVectors(new THREE.Vector3().setFromMatrixPosition(rig.keyRest[previous]), point.clone(), stroke.travel);
        const matrix = rig.keyRest[index].clone();
        matrix.elements[13] -= stroke.depth * sample.weight;
        rig.keys.setMatrixAt(index, matrix);
        rig.keys.instanceMatrix.needsUpdate = true;
        home.pressedKeys.push(index);
      }
      point.y += 0.006 + (typing ? stroke.lift - stroke.depth * sample.weight : 0);
      return toBody(rig.keyboard, point);
    };
    const left = keyTarget(false);
    const mouseMove = sample.action === "mouse" ? Math.sin(t * 2.7) * (broad ? 0.012 : 0.02) * sample.weight : 0;
    rig.mouse.position.x += mouseMove;
    const right = !typing ? toBody(rig.mouse, new THREE.Vector3(0, 0.024, -0.015)) : keyTarget(true);
    applyHand(leftHand, left);
    applyHand(rightHand, right);
  } else if (sample.action === "read") {
    const noteTarget = toDesk(new THREE.Vector3(mascot.arms[1].position.x * 0.9, mascot.arms[1].position.y - 0.04, mascot.arms[1].position.z + forward));
    rig.notebook.position.lerp(noteTarget, sample.weight);
    const note = toBody(rig.notebook, new THREE.Vector3(0, 0.025, 0));
    applyHand(1, note);
    applyHand(0, new THREE.Vector3(mascot.arms[0].position.x, mascot.arms[0].position.y - 0.03, mascot.arms[0].position.z + forward * 0.6));
  } else if (sample.action === "think") {
    applyHand(0, new THREE.Vector3(mascot.arms[0].position.x * 0.9, mascot.arms[0].position.y + 0.08, mascot.arms[0].position.z + reach * 0.35));
    applyHand(1, new THREE.Vector3(mascot.arms[1].position.x, mascot.arms[1].position.y - 0.09, mascot.arms[1].position.z + forward * 0.4));
  } else if (sample.action === "stretch") {
    for (let index = 0; index < 2; index++) {
      const shoulder = mascot.arms[index].position;
      applyHand(index, new THREE.Vector3(shoulder.x * 1.15, shoulder.y + reach * 0.65, shoulder.z + reach * 0.14));
    }
  } else if (sample.action === "sip" && rig.cupTray) {
    const progress = sample.progress;
    const delivered = deskPhase(progress, 0, 0.2) * (1 - deskPhase(progress, 0.82, 1));
    const trayHome = home.positions.get(rig.cupTray)!;
    const restingGrip = new THREE.Vector3(mascot.arms[0].position.x, mascot.arms[0].position.y - 0.04, mascot.arms[0].position.z + forward * 0.85);
    const trayTarget = toDesk(restingGrip.clone()).sub(new THREE.Vector3(0.055, 0.05, 0));
    rig.cupTray.position.copy(trayHome).lerp(trayTarget, delivered);
    const pickup = toBody(rig.mug, new THREE.Vector3(0.055, 0.05, 0));
    const lift = deskPhase(progress, 0.28, 0.4) * (1 - deskPhase(progress, 0.6, 0.72));
    const sip = Math.sin(deskPhase(progress, 0.4, 0.6) * Math.PI * 2) ** 2 * lift;
    const drinking = new THREE.Vector3(mascot.arms[0].position.x * 0.78, mascot.arms[0].position.y + 0.08 + sip * 0.025, mascot.arms[0].position.z + forward * 0.7);
    const target = pickup.lerp(drinking, lift);
    const grip = applyHand(0, target, deskPhase(progress, 0.18, 0.28) * (1 - deskPhase(progress, 0.72, 0.82)));
    if (progress >= 0.28 && progress <= 0.72) {
      rig.mug.rotation.z = -sip * 0.22;
      const worldGrip = mascot.body.localToWorld(grip);
      const offset = new THREE.Vector3(0.055, 0.05, 0).applyEuler(rig.mug.rotation);
      rig.mug.position.copy(rig.cupTray.worldToLocal(worldGrip)).sub(offset);
    }
    applyHand(1, new THREE.Vector3(mascot.arms[1].position.x, mascot.arms[1].position.y - 0.08, mascot.arms[1].position.z + forward * 0.4));
  } else {
    for (let index = 0; index < 2; index++) applyHand(index, new THREE.Vector3(mascot.arms[index].position.x, mascot.arms[index].position.y - 0.08, mascot.arms[index].position.z + forward * 0.3));
  }
  for (const tray of [rig.keyboardTray, rig.mouseTray, ...(rig.cupTray ? [rig.cupTray] : []), ...(rig.footrest ? [rig.footrest] : [])]) updateTraySupport(root, tray);
}

const crateMat = new THREE.MeshStandardMaterial({ color: 0xb58a55, roughness: 0.7 });
const crateBandMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.7 });
const boardMat = new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 0.6 });
const paperMat = new THREE.MeshStandardMaterial({ color: 0xf7f4ec, roughness: 0.8 });
const inkMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, roughness: 0.8 });
const canMat = new THREE.MeshStandardMaterial({ color: 0x3f9e5a, roughness: 0.45 });
const waterMat = new THREE.MeshStandardMaterial({ color: 0x8fd3ff, emissive: 0x4aa8ff, emissiveIntensity: 0.4, roughness: 0.3 });
const DROPS = 4;

export interface WorkProps {
  crate: THREE.Group;
  board: THREE.Group;
  can: THREE.Group;
  drops: THREE.Mesh[];
  crateLevel: number;
  boardLevel: number;
  canLevel: number;
  clipboardPen: THREE.Group;
}

function handTip(arm: THREE.Object3D): number {
  const mesh = arm.children[0] as THREE.Mesh;
  const height = (mesh.geometry as THREE.BoxGeometry).parameters?.height ?? 0.15;
  return mesh.position.y - height / 2;
}

function buildCrate(): THREE.Group {
  const crate = new THREE.Group();
  crate.add(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.28), crateMat));
  for (const y of [-0.08, 0.08]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.03, 0.29), crateBandMat);
    band.position.y = y;
    crate.add(band);
  }
  return crate;
}

function buildBoard(): THREE.Group {
  const board = new THREE.Group();
  board.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.26, 0.02), boardMat));
  const paper = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.21, 0.01), paperMat);
  paper.position.set(0, -0.01, 0.012);
  board.add(paper);
  for (let i = 0; i < 3; i++) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 0.004), inkMat);
    line.position.set(0, 0.05 - i * 0.05, 0.019);
    board.add(line);
  }
  return board;
}

function buildCan(): { can: THREE.Group; drops: THREE.Mesh[] } {
  const can = new THREE.Group();
  can.add(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.2), canMat));
  const spout = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.18), canMat);
  spout.position.set(0, 0.04, 0.17);
  spout.rotation.x = -0.5;
  can.add(spout);
  const drops = Array.from({ length: DROPS }, () => new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.04, 0.025), waterMat));
  can.add(...drops);
  return { can, drops };
}

export function createWorkProps(mascot: Mascot): WorkProps {
  const crate = buildCrate();
  crate.position.set(0, mascot.arms[0].position.y - 0.06, 0.38);
  crate.userData.widthScale = Math.max(1, Math.abs(mascot.arms[0].position.x) / 0.19);
  mascot.body.add(crate);
  const board = buildBoard();
  const left = mascot.arms[0];
  board.position.set(0, handTip(left) - 0.02, 0.1);
  left.add(board);
  const { can, drops } = buildCan();
  const right = mascot.arms[mascot.arms.length - 1];
  can.position.set(0, handTip(right) - 0.05, 0.08);
  right.add(can);
  const clipboardPen = new THREE.Group();
  clipboardPen.name = "work-clipboard-pen";
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.16, 0.012), inkMat);
  clipboardPen.add(shaft);
  mascot.body.add(clipboardPen);
  for (const prop of [crate, board, can, clipboardPen]) prop.visible = false;
  return { crate, board, can, drops, crateLevel: 0, boardLevel: 0, canLevel: 0, clipboardPen };
}

export function animateClipboard(props: WorkProps, mascot: Mascot, t: number, quiet = false): void {
  props.clipboardPen.visible = props.board.visible;
  if (!props.board.visible) return;
  const left = mascot.arms[0];
  const reach = mascotArmReach(mascot, 0);
  const target = new THREE.Vector3(left.position.x * 0.9, left.position.y + 0.02, reach * 0.65);
  const wrist = reachMascotHand(mascot, 0, mascot.body, target.x, target.y, target.z);
  const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI * 0.7, 0, 0));
  const grip = new THREE.Vector3(-0.085, -0.055, 0.012).multiply(props.board.scale).applyQuaternion(rotation);
  const centre = wrist.clone().sub(grip);
  const worldRotation = mascot.body.getWorldQuaternion(new THREE.Quaternion()).multiply(rotation);
  const parentRotation = props.board.parent!.getWorldQuaternion(new THREE.Quaternion()).invert();
  props.board.quaternion.copy(parentRotation.multiply(worldRotation));
  props.board.position.copy(props.board.parent!.worldToLocal(mascot.body.localToWorld(centre)));
  const right = mascot.arms[1];
  const annotation = props.board.localToWorld(new THREE.Vector3(0.02 + (quiet ? 0 : Math.sin(t * 4) * 0.02), 0.01, 0.02));
  mascot.body.worldToLocal(annotation);
  const writing = annotation.distanceTo(right.position) < mascotArmReach(mascot, 1) * 0.95;
  const penTarget = writing ? annotation.clone().add(new THREE.Vector3(0, 0.065, 0)) : new THREE.Vector3(right.position.x, right.position.y + 0.04, mascotArmReach(mascot, 1) * 0.3);
  const penGrip = reachMascotHand(mascot, 1, mascot.body, penTarget.x, penTarget.y, penTarget.z);
  props.clipboardPen.position.copy(penGrip);
  props.clipboardPen.rotation.set(writing ? -0.35 : -0.12, 0, writing ? -0.15 : 0.12);
}

function reveal(prop: THREE.Object3D, level: number): void {
  prop.visible = level > 0.02;
  const scale = 0.5 + 0.5 * level;
  prop.scale.set(scale * (prop.userData.widthScale ?? 1), scale, scale);
}

export function animateWorkProps(props: WorkProps, show: { crate: boolean; board: boolean; can: boolean; pouring: boolean }, t: number, dt: number): void {
  props.crateLevel = damp(props.crateLevel, show.crate ? 1 : 0, 9, dt);
  props.boardLevel = damp(props.boardLevel, show.board ? 1 : 0, 9, dt);
  props.canLevel = damp(props.canLevel, show.can ? 1 : 0, 9, dt);
  reveal(props.crate, props.crateLevel);
  reveal(props.board, props.boardLevel);
  reveal(props.can, props.canLevel);
  const leftArm = props.board.parent!;
  props.board.rotation.x = -leftArm.rotation.x - 0.6;
  const rightArm = props.can.parent!;
  props.can.rotation.x = -rightArm.rotation.x + (show.pouring ? 0.55 : 0);
  props.drops.forEach((drop, i) => {
    const k = (t * 1.4 + i / DROPS) % 1;
    drop.visible = show.pouring;
    drop.position.set(0, 0.0 - k * 0.38, 0.3 + k * 0.04);
  });
}

export interface TrainingPose {
  arms: [number, number];
  spread: [number, number];
  reach: number;
  lean: number;
  yaw: number;
}

export function trainingPose(cue: TrainingCue, facing: number, position: { x: number; z: number }, t: number, phase: number, quiet = false): TrainingPose {
  const pose: TrainingPose = { arms: [-0.55, -0.55], spread: [0, 0], reach: 0, lean: 0.025, yaw: 0 };
  if (quiet) return pose;
  const pulse = Math.sin(t * 2.6 + phase);
  const writing = Math.sin(t * 13 + phase);
  if (cue.lookAt) {
    const angle = Math.atan2(cue.lookAt.x - position.x, cue.lookAt.z - position.z);
    pose.yaw = Math.max(-0.55, Math.min(0.55, shortestAngle(facing, angle)));
  }
  if (cue.action === "explain" || cue.action === "answer" || cue.action === "invite") {
    pose.arms = [-1.2 + pulse * 0.17, -1.65 + Math.sin(t * 3.3 + phase) * 0.22];
    pose.spread = [-0.28, 0.35];
    pose.lean = 0.025 + pulse * 0.025;
  } else if (cue.action === "point") {
    pose.arms = [-0.5, -2.15 + pulse * 0.09];
    pose.spread = [-0.12, 0.34];
    pose.yaw = Math.PI - 0.2;
  } else if (cue.action === "observe") {
    pose.arms = [-0.8, -0.45];
    pose.lean = 0.06;
  } else if (cue.action === "write") {
    pose.arms = [-1.15 + writing * 0.08, -0.92];
    pose.spread = [-0.06 + Math.sin(t * 7 + phase) * 0.04, 0.08];
    pose.lean = 0.17;
    pose.yaw = -0.1;
  } else if (cue.action === "type") {
    const pause = (t + phase) % 4.7 > 3.9 ? 0 : 1;
    pose.arms = [-1.08 + writing * 0.12 * pause, -1.08 - writing * 0.12 * pause];
    pose.spread = [0.12, -0.08];
    pose.lean = 0.13;
    pose.yaw = 0.12;
  } else if (cue.action === "read") {
    pose.arms = [-1.02, -0.78];
    pose.lean = 0.12;
    pose.yaw = -0.15;
  } else if (cue.action === "raise" || cue.action === "ask") {
    pose.arms = [-0.65, cue.action === "raise" ? -2.95 : -2.4 + pulse * 0.1];
    pose.spread = [0, 0.5];
    pose.lean = -0.035;
  } else if (cue.action === "nod") {
    const nod = Math.max(0, Math.sin(t * 3 + phase));
    pose.lean = 0.035 + nod * 0.1;
  }
  return pose;
}

const studyGeometry = new THREE.BoxGeometry(1, 1, 1);
const studyMat = {
  cover: new THREE.MeshStandardMaterial({ color: 0x378c8b, roughness: 0.8 }),
  laptop: new THREE.MeshStandardMaterial({ color: 0x344353, metalness: 0.35, roughness: 0.45 }),
  screen: new THREE.MeshStandardMaterial({ color: 0x0b2439, emissive: 0x153954, emissiveIntensity: 0.5 }),
  code: new THREE.MeshBasicMaterial({ color: 0x70cfcc }),
  pencil: new THREE.MeshStandardMaterial({ color: 0xefb24e, roughness: 0.5 }),
  pointer: new THREE.MeshStandardMaterial({ color: 0xe2d0a9, roughness: 0.45 }),
};

function studyPart(parent: THREE.Object3D, material: THREE.Material, size: [number, number, number], position: [number, number, number]): THREE.Mesh {
  const mesh = new THREE.Mesh(studyGeometry, material);
  mesh.scale.set(...size);
  mesh.position.set(...position);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

export interface TrainingProps {
  desk: THREE.Group;
  page: THREE.Group;
  ink: THREE.Mesh[];
  code: THREE.Mesh[];
  pencil: THREE.Group;
  pointer: THREE.Group;
  pageTurn: number;
  hands: { mesh: THREE.Mesh; y: number; height: number; length: number }[];
  columnScale: number;
}

export function createTrainingProps(mascot: Mascot): TrainingProps {
  const desk = new THREE.Group();
  desk.name = "training-desk-tools";
  mascot.root.add(desk);
  studyPart(desk, studyMat.cover, [0.31, 0.025, 0.28], [-0.19, 0, -0.12]);
  studyPart(desk, paperMat, [0.28, 0.014, 0.25], [-0.19, 0.017, -0.12]);
  studyPart(desk, studyMat.cover, [0.012, 0.008, 0.24], [-0.19, 0.029, -0.12]);
  const ink = Array.from({ length: 5 }, (_, i) => studyPart(desk, inkMat, [0.18, 0.003, 0.008], [-0.18, 0.027, -0.2 + i * 0.04]));
  const page = new THREE.Group();
  page.position.set(-0.19, 0.03, -0.12);
  studyPart(page, paperMat, [0.13, 0.003, 0.24], [0.065, 0, 0]);
  desk.add(page);
  studyPart(desk, studyMat.laptop, [0.35, 0.025, 0.25], [0.18, 0, 0.015]);
  for (let row = 0; row < 3; row++) studyPart(desk, paperMat, [0.25, 0.004, 0.014], [0.18, 0.015, -0.015 + row * 0.034]);
  studyPart(desk, inkMat, [0.09, 0.004, 0.04], [0.18, 0.015, -0.075]);
  const lid = new THREE.Group();
  lid.position.set(0.18, 0.012, 0.14);
  lid.rotation.x = 0.18;
  desk.add(lid);
  studyPart(lid, studyMat.laptop, [0.35, 0.23, 0.018], [0, 0.115, 0]);
  studyPart(lid, studyMat.screen, [0.31, 0.19, 0.004], [0, 0.12, -0.012]);
  const code = Array.from({ length: 5 }, (_, i) => studyPart(lid, studyMat.code, [0.13 + i % 3 * 0.025, 0.009, 0.003], [-0.03, 0.18 - i * 0.027, -0.016]));
  const pencil = new THREE.Group();
  pencil.name = "training-pencil";
  studyPart(pencil, studyMat.pencil, [0.026, 0.22, 0.026], [0, 0, 0]);
  studyPart(pencil, inkMat, [0.014, 0.035, 0.014], [0, -0.125, 0]);
  const left = mascot.arms[0];
  pencil.position.set(0, handTip(left), 0.09);
  left.add(pencil);
  const pointer = new THREE.Group();
  pointer.name = "training-pointer";
  studyPart(pointer, studyMat.pointer, [0.023, 0.76, 0.023], [0, -0.33, 0]);
  studyPart(pointer, studyMat.pencil, [0.05, 0.07, 0.05], [0, -0.72, 0]);
  const right = mascot.arms[mascot.arms.length - 1];
  pointer.position.set(0, handTip(right), 0.025);
  right.add(pointer);
  for (const prop of [desk, pencil, pointer]) prop.visible = false;
  const hands = mascot.arms.map((arm) => {
    const mesh = arm.children[0] as THREE.Mesh;
    const height = (mesh.geometry as THREE.BoxGeometry).parameters.height;
    return { mesh, y: mesh.position.y, height, length: height };
  });
  const columnScale = Math.max(0.8, Math.abs(mascot.arms[0].position.x) * mascot.root.scale.x / 0.2);
  desk.children.forEach(child => { child.position.x *= columnScale; });
  const trayWidth = Math.max(0.8, columnScale * 0.4 + 0.4);
  studyPart(desk, studyMat.laptop, [trayWidth, 0.025, 0.55], [0, -0.02, 0]);
  for (const side of [-1, 1]) studyPart(desk, studyMat.laptop, [0.025, 0.03, 0.45], [side * trayWidth * 0.35, -0.045, 0.2]);
  return { desk, page, ink, code, pencil, pointer, pageTurn: 0, hands, columnScale };
}

const handTarget = new THREE.Vector3();
const pencilRotation = new THREE.Quaternion();

function alignStudyHands(props: TrainingProps, mascot: Mascot, cue: TrainingCue | null, t: number, phase: number, quiet: boolean): void {
  const writing = cue?.action === "write";
  const typing = cue?.action === "type";
  mascot.root.updateMatrixWorld(true);
  mascot.arms.forEach((arm, i) => {
    const rig = props.hands[i];
    const reaching = !quiet && !cue?.teacher && (writing || typing);
    if (!reaching) {
      rig.length = rig.height;
      rig.mesh.position.y = rig.y;
      rig.mesh.scale.y = 1;
      return;
    }
    const stroke = Math.sin(t * 10 + phase);
    handTarget.set((i === 0 ? -0.19 + (writing ? stroke * 0.045 : 0) : 0.18 + (typing ? stroke * 0.025 : 0)) * props.columnScale, i === 0 && writing ? 0.06 : 0.03 + (typing && i === 1 ? Math.max(0, Math.sin(t * 13 + phase)) * 0.025 : 0), i === 0 ? -0.12 + Math.sin(t * 6 + phase) * 0.025 : 0.02);
    reachMascotHand(mascot, i, props.desk, handTarget.x, handTarget.y, handTarget.z);
    rig.length = mascotArmReach(mascot, i);
  });
  if (writing && !quiet) {
    const arm = mascot.arms[0];
    props.pencil.position.copy(mascotHandPosition(mascot, 0, arm));
    arm.updateWorldMatrix(true, false);
    arm.getWorldQuaternion(pencilRotation).invert();
    props.pencil.quaternion.copy(pencilRotation);
    props.pencil.position.add(new THREE.Vector3(0, 0.09, 0).applyQuaternion(pencilRotation));
  }
}

export function animateTrainingProps(props: TrainingProps, mascot: Mascot, cue: TrainingCue | null, t: number, dt: number, phase: number, quiet: boolean): void {
  props.desk.visible = cue !== null && !cue.teacher;
  props.pencil.visible = cue?.action === "write" && !quiet;
  props.pointer.visible = cue?.teacher === true && cue.action === "point" && !quiet;
  if (!cue) {
    alignStudyHands(props, mascot, null, t, phase, quiet);
    return;
  }
  const scale = mascot.root.scale.x;
  props.desk.scale.setScalar(1 / scale);
  const reach = Math.min(...mascot.arms.map((_, index) => mascotArmReach(mascot, index)));
  props.desk.position.set(0, (0.795 - mascot.root.position.y) / mascot.root.scale.y, Math.min(0.32 / scale, reach * 0.72));
  const flipping = !quiet && cue.action === "read";
  const turn = flipping ? Math.min(1, ((t + phase) % 3) / 1.4) : 0;
  props.pageTurn = quiet ? 0 : damp(props.pageTurn, turn, 9, dt);
  props.page.visible = flipping || props.pageTurn > 0.01;
  props.page.rotation.z = Math.PI * props.pageTurn;
  const writing = cue.action === "write" && !quiet;
  props.ink.forEach((line, i) => {
    line.scale.x = 0.18 * (writing ? Math.min(1, Math.max(0.06, ((t + phase) % 5) - i * 0.7)) : 1);
  });
  props.code.forEach((line, i) => {
    line.visible = quiet || cue.action !== "type" || i <= Math.floor((t * 1.5 + phase) % 6);
  });
  props.pencil.rotation.x = -mascot.arms[0].rotation.x + 0.25;
  props.pencil.rotation.z = -0.18;
  alignStudyHands(props, mascot, cue, t, phase, quiet);
}
