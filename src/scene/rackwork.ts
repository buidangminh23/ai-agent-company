import * as THREE from "three";
import { mascotHandPosition, type Mascot } from "./mascots.ts";
import { damp, reducedMotion } from "../motion.ts";

export type RackStep = "pull" | "cable" | "console" | "scan";

export const RACK_REACH = 0.62;
const STEP_S = 7.5;
const ORDER: RackStep[] = ["pull", "cable", "console", "scan"];
const SLAB_Y = 0.92;
const SLAB_DEPTH = 0.55;
const SLAB_TRAVEL = 0.42;
const CART_SIDE = 0.66;
const CART_FORWARD = 0.22;
const CART_YAW = Math.atan2(CART_SIDE, CART_FORWARD);
const SCAN_END = 0.7;

const chassisMat = new THREE.MeshStandardMaterial({ color: 0x3a414c, roughness: 0.4, metalness: 0.6 });
const boardMat = new THREE.MeshStandardMaterial({ color: 0x1f6b3a, roughness: 0.6 });
const fanMat = new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.5 });
const ramMat = new THREE.MeshStandardMaterial({ color: 0x2c2f6b, roughness: 0.5 });
const caddyMat = new THREE.MeshStandardMaterial({ color: 0xc23b3b, roughness: 0.5 });
const ledMat = new THREE.MeshStandardMaterial({ color: 0x6dffa0, emissive: 0x22d36b, emissiveIntensity: 2 });
const cableMat = new THREE.MeshStandardMaterial({ color: 0xf2c230, roughness: 0.5 });
const plugMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.3 });
const cartMat = new THREE.MeshStandardMaterial({ color: 0x5d6673, roughness: 0.45, metalness: 0.5 });
const laptopMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.4 });
const terminalMat = new THREE.MeshStandardMaterial({ color: 0x0c2a1a, emissive: 0x2ee07a, emissiveIntensity: 0.9, roughness: 0.3 });
const torchMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.4 });
const beamMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.32, depthWrite: false });
const amberMat = new THREE.MeshStandardMaterial({ color: 0xe9af42, emissive: 0xc57517, emissiveIntensity: 0.5 });
const geometryCache = new Map<string, THREE.BufferGeometry>();

export interface RackPose {
  arms: [number, number];
  lean: number;
  yaw: number;
  lift: number;
}

export interface RackProps {
  mascot: Mascot;
  slab: THREE.Group;
  caddy: THREE.Group;
  cable: THREE.Group;
  cart: THREE.Group;
  terminal: THREE.Mesh;
  torch: THREE.Group;
  beam: THREE.Mesh;
  out: number;
  cartLevel: number;
  caddyLevel: number;
  cableLevel: number;
  torchLevel: number;
  pullGrips: THREE.Group[];
  consoleGrips: THREE.Group[];
  gripLinks: THREE.Mesh[];
  caddyDock: THREE.Group;
  caddyLatch: THREE.Group;
  fanRotors: THREE.Group[];
  consoleKeys: THREE.Mesh[];
  terminalRows: THREE.Mesh[];
  cableSegments: THREE.Mesh[];
  cablePort: THREE.Group;
  torchMarker: THREE.Mesh;
  cableGrip: THREE.Group;
}

export function rackStep(t: number, phase: number): { step: RackStep; k: number } {
  const cycle = (Number.isFinite(t) ? Math.max(0, t) : 0) / STEP_S + (Number.isFinite(phase) ? phase : 0) * 1.7;
  const index = Math.floor(cycle);
  return { step: ORDER[((index % ORDER.length) + ORDER.length) % ORDER.length], k: cycle - index };
}

function ramp(k: number, a: number, b: number): number {
  const x = Math.min(1, Math.max(0, (k - a) / (b - a)));
  return x * x * (3 - 2 * x);
}

function slabOut(k: number): number {
  return ramp(k, 0.12, 0.3) * (1 - ramp(k, 0.74, 0.9));
}

function pullPose(k: number, t: number, phase: number): RackPose {
  const out = slabOut(k);
  const working = k > 0.32 && k < 0.72;
  const swap = ramp(k, 0.44, 0.5) * (1 - ramp(k, 0.58, 0.64));
  if (!working) {
    const tug = out > 0 && out < 1 ? 0.08 : 0;
    return { arms: [-1.45, -1.45], lean: 0.2 - tug, yaw: 0, lift: 0 };
  }
  const left = -1.15 + Math.sin(t * 6.5 + phase) * 0.12;
  const right = -1.15 + Math.sin(t * 6.5 + phase + 2) * 0.12 - swap * 0.75;
  return { arms: [left, right], lean: 0.32, yaw: Math.sin(t * 0.9 + phase) * 0.12, lift: 0 };
}

function cablePose(k: number, t: number, phase: number): RackPose {
  const plug = Math.sin(k * Math.PI * 6) > 0.4 ? 0.12 : 0;
  return { arms: [-2.25 + Math.sin(t * 1.8 + phase) * 0.05, -2.05 - plug + Math.sin(t * 11 + phase) * 0.04], lean: -0.1, yaw: Math.sin(t * 0.6 + phase) * 0.15, lift: 0.03 };
}

function consolePose(k: number, t: number, phase: number): RackPose {
  const glance = ramp(k, 0.45, 0.51) * (1 - ramp(k, 0.57, 0.63));
  const yaw = CART_YAW - glance * 0.18;
  return { arms: [-1.0 + Math.sin(t * 15 + phase) * 0.14, -1.0 + Math.sin(t * 15 + phase + Math.PI) * 0.14], lean: 0.14, yaw, lift: 0 };
}

function scanPose(k: number, t: number, phase: number): RackPose {
  if (k < SCAN_END) {
    const sweep = Math.sin((k / SCAN_END) * Math.PI * 2 - Math.PI / 2);
    return { arms: [-0.85, -1.65 - sweep * 0.5], lean: 0.08 - sweep * 0.06, yaw: Math.sin(t * 0.7 + phase) * 0.1, lift: 0 };
  }
  return { arms: [-0.95, -0.95 + Math.sin(t * 13 + phase) * 0.07], lean: 0.22, yaw: 0, lift: 0 };
}

export function rackPose(t: number, phase: number): RackPose {
  if (!Number.isFinite(t) || reducedMotion()) t = 0;
  const { step, k } = rackStep(t, phase);
  if (step === "pull") return pullPose(k, t, phase);
  if (step === "cable") return cablePose(k, t, phase);
  if (step === "console") return consolePose(k, t, phase);
  return scanPose(k, t, phase);
}

export function rackShowsBoard(t: number, phase: number): boolean {
  const { step } = rackStep(t, phase);
  return step === "scan";
}

function part(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, name = ""): THREE.Mesh {
  const key = `box:${w}:${h}:${d}`;
  let geometry = geometryCache.get(key);
  if (!geometry) { geometry = new THREE.BoxGeometry(w, h, d); geometryCache.set(key, geometry); }
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinder(parent: THREE.Object3D, radius: number, height: number, x: number, y: number, z: number, mat: THREE.Material, name = ""): THREE.Mesh {
  const key = `cylinder:${radius}:${height}`;
  let geometry = geometryCache.get(key);
  if (!geometry) { geometry = new THREE.CylinderGeometry(radius, radius, height, 12); geometryCache.set(key, geometry); }
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function segment(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3): void {
  const direction = end.clone().sub(start);
  const length = direction.length();
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.scale.y = length;
  if (length > 0.000001) mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.divideScalar(length));
}

function handTip(arm: THREE.Object3D): number {
  const mesh = arm.children[0] as THREE.Mesh;
  const height = (mesh.geometry as THREE.BoxGeometry).parameters?.height ?? 0.15;
  return mesh.position.y - height / 2;
}

function buildSlab(): { slab: THREE.Group; caddy: THREE.Group; caddyDock: THREE.Group; caddyLatch: THREE.Group; fanRotors: THREE.Group[] } {
  const slab = new THREE.Group();
  slab.name = "rack-service-server";
  part(slab, 0.54, 0.06, SLAB_DEPTH, 0, 0, 0, chassisMat);
  part(slab, 0.5, 0.012, SLAB_DEPTH - 0.06, 0, 0.036, 0.01, boardMat);
  for (const x of [-0.18, -0.06, 0.06, 0.18]) part(slab, 0.09, 0.05, 0.05, x, 0.06, 0.2, fanMat);
  const fanRotors = [-0.18, -0.06, 0.06, 0.18].map(x => {
    const rotor = new THREE.Group(); rotor.position.set(x, 0.089, 0.2); rotor.name = "server-fan-rotor"; slab.add(rotor);
    for (let blade = 0; blade < 4; blade++) part(rotor, 0.008, 0.004, 0.065, 0, 0, 0, plugMat).rotation.y = blade * Math.PI / 4;
    cylinder(rotor, 0.008, 0.006, 0, 0, 0, fanMat);
    return rotor;
  });
  for (const x of [-0.14, -0.1, 0.1, 0.14]) part(slab, 0.018, 0.035, 0.2, x, 0.058, -0.03, ramMat);
  part(slab, 0.12, 0.04, 0.12, 0, 0.06, -0.04, fanMat);
  for (let fin = 0; fin < 8; fin++) part(slab, 0.008, 0.027, 0.1, -0.045 + fin * 0.013, 0.094, -0.04, plugMat);
  for (const side of [-1, 1]) {
    part(slab, 0.02, 0.045, 0.53, side * 0.265, -0.005, 0, plugMat, "server-slide-rail");
    part(slab, 0.012, 0.015, 0.22, side * 0.275, -0.01, 0.05, cartMat);
    for (const z of [-0.22, 0.22]) cylinder(slab, 0.008, 0.005, side * 0.235, 0.036, z, plugMat);
  }
  part(slab, 0.54, 0.07, 0.02, 0, 0, -SLAB_DEPTH / 2, chassisMat);
  for (const x of [-0.2, -0.16]) part(slab, 0.025, 0.018, 0.01, x, 0.01, -SLAB_DEPTH / 2 - 0.012, ledMat);
  for (let bay = 0; bay < 3; bay++) {
    part(slab, 0.105, 0.045, 0.035, -0.05 + bay * 0.12, 0.008, -0.28, laptopMat);
    for (let vent = 0; vent < 4; vent++) part(slab, 0.012, 0.026, 0.004, -0.08 + bay * 0.12 + vent * 0.02, 0.008, -0.3, plugMat);
  }
  const caddyDock = new THREE.Group(); caddyDock.name = "server-drive-dock"; caddyDock.position.set(0.07, 0.04, -0.19); slab.add(caddyDock);
  part(caddyDock, 0.095, 0.025, 0.14, 0, 0, 0, caddyMat);
  const caddyLatch = new THREE.Group(); caddyLatch.name = "server-drive-latch"; caddyLatch.position.z = -0.075; caddyDock.add(caddyLatch);
  part(caddyLatch, 0.09, 0.014, 0.014, 0, 0, 0, plugMat);
  const caddy = new THREE.Group();
  caddy.name = "rack-service-drive-caddy";
  part(caddy, 0.1, 0.03, 0.15, 0, 0, 0, caddyMat);
  part(caddy, 0.1, 0.02, 0.02, 0, 0.005, -0.08, plugMat);
  part(caddy, 0.075, 0.006, 0.11, 0, 0.018, 0.005, chassisMat);
  part(caddy, 0.055, 0.002, 0.045, 0, 0.022, 0.005, plugMat);
  part(caddy, 0.065, 0.01, 0.006, 0, 0, 0.079, amberMat);
  for (const x of [-0.035, 0.035]) for (const z of [-0.05, 0.05]) cylinder(caddy, 0.004, 0.003, x, 0.023, z, fanMat);
  return { slab, caddy, caddyDock, caddyLatch, fanRotors };
}

function buildCable(): THREE.Group {
  const cable = new THREE.Group();
  cable.name = "rack-patch-cable-plug";
  part(cable, 0.035, 0.028, 0.055, 0, 0, 0, plugMat);
  part(cable, 0.02, 0.012, 0.035, 0, 0.014, 0.004, chassisMat);
  part(cable, 0.028, 0.023, 0.04, 0, 0, -0.044, cableMat);
  for (let rib = 0; rib < 4; rib++) part(cable, 0.032, 0.027, 0.004, 0, 0, -0.03 - rib * 0.008, cableMat);
  for (let pin = 0; pin < 8; pin++) part(cable, 0.002, 0.003, 0.015, -0.012 + pin * 0.0034, 0.012, 0.025, amberMat);
  return cable;
}

function buildCart(): { cart: THREE.Group; terminal: THREE.Mesh; consoleKeys: THREE.Mesh[]; terminalRows: THREE.Mesh[] } {
  const cart = new THREE.Group();
  cart.name = "server-crash-cart";
  for (const [x, z] of [[-0.18, -0.14], [0.18, -0.14], [-0.18, 0.14], [0.18, 0.14]]) {
    part(cart, 0.03, 0.82, 0.03, x, 0.45, z, cartMat);
    part(cart, 0.025, 0.045, 0.065, x, 0.055, z, cartMat);
    const wheel = cylinder(cart, 0.032, 0.023, x, 0.032, z, fanMat, "crash-cart-caster"); wheel.rotation.z = Math.PI / 2;
    part(cart, 0.012, 0.009, 0.035, x + 0.022, 0.065, z + 0.025, caddyMat);
  }
  part(cart, 0.44, 0.03, 0.36, 0, 0.84, 0, cartMat);
  part(cart, 0.44, 0.03, 0.36, 0, 0.3, 0, cartMat);
  for (const x of [-0.22, 0.22]) part(cart, 0.015, 0.035, 0.36, x, 0.87, 0, plugMat);
  for (const z of [-0.18, 0.18]) part(cart, 0.44, 0.035, 0.015, 0, 0.87, z, plugMat);
  for (const x of [-0.16, 0.16]) cylinder(cart, 0.012, 0.15, x, 0.91, -0.19, cartMat);
  const handle = cylinder(cart, 0.018, 0.32, 0, 0.985, -0.19, fanMat); handle.rotation.z = Math.PI / 2;
  part(cart, 0.3, 0.02, 0.22, 0, 0.865, 0.03, laptopMat);
  const lid = new THREE.Group();
  lid.position.set(0, 0.875, -0.08);
  lid.rotation.x = -0.18;
  part(lid, 0.3, 0.2, 0.015, 0, 0.1, 0, laptopMat);
  const terminal = part(lid, 0.27, 0.17, 0.004, 0, 0.1, 0.01, terminalMat.clone());
  const terminalRows = Array.from({ length: 7 }, (_, index) => part(lid, 0.095 + index % 3 * 0.035, 0.006, 0.002, -0.03, 0.165 - index * 0.019, 0.014, index === 0 ? amberMat : ledMat));
  const consoleKeys = Array.from({ length: 4 }, (_, row) => Array.from({ length: 9 }, (_, column) => part(cart, 0.022, 0.004, 0.023, -0.112 + column * 0.028, 0.878, -0.025 + row * 0.027, plugMat))).flat();
  part(cart, 0.075, 0.003, 0.025, 0, 0.878, 0.11, chassisMat);
  cylinder(lid, 0.004, 0.003, 0, 0.187, 0.014, fanMat).rotation.x = Math.PI / 2;
  cart.add(lid);
  part(cart, 0.2, 0.1, 0.16, 0, 0.36, 0, chassisMat);
  for (let port = 0; port < 4; port++) part(cart, 0.025, 0.018, 0.006, -0.06 + port * 0.04, 0.36, 0.085, port % 2 ? ledMat : plugMat);
  part(cart, 0.16, 0.025, 0.12, 0, 0.44, 0.015, caddyMat);
  return { cart, terminal, consoleKeys, terminalRows };
}

function buildTorch(): { torch: THREE.Group; beam: THREE.Mesh } {
  const torch = new THREE.Group();
  torch.name = "rack-inspection-torch";
  torch.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 0.14, 8), torchMat));
  cylinder(torch, 0.038, 0.025, 0, -0.075, 0, plugMat);
  cylinder(torch, 0.03, 0.005, 0, -0.09, 0, amberMat);
  for (let ring = 0; ring < 4; ring++) cylinder(torch, 0.031, 0.008, 0, 0.025 + ring * 0.012, 0, chassisMat);
  part(torch, 0.018, 0.014, 0.025, 0, 0.04, 0.027, caddyMat);
  const beam = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.6, 12, 1, true), beamMat.clone());
  beam.position.y = -0.37;
  torch.add(beam);
  return { torch, beam };
}

export function createRackProps(mascot: Mascot): RackProps {
  const { slab, caddy, caddyDock, caddyLatch, fanRotors } = buildSlab();
  slab.position.set(0, SLAB_Y, RACK_REACH + SLAB_DEPTH / 2);
  mascot.root.add(slab);
  const right = mascot.arms[mascot.arms.length - 1];
  caddy.position.set(0, handTip(right) - 0.03, 0.06);
  right.add(caddy);
  const cable = buildCable();
  cable.position.set(0, handTip(right) - 0.02, 0.04);
  right.add(cable);
  const { cart, terminal, consoleKeys, terminalRows } = buildCart();
  cart.position.set(CART_SIDE, 0, CART_FORWARD);
  cart.rotation.y = CART_YAW - Math.PI;
  mascot.root.add(cart);
  const { torch, beam } = buildTorch();
  torch.position.set(0, handTip(right) - 0.04, 0.05);
  right.add(torch);
  const pullGrips = mascot.arms.map((_, index) => {
    const grip = new THREE.Group(); grip.name = `rack-pull-grip-${index}`; mascot.root.add(grip);
    part(grip, 0.04, 0.1, 0.035, 0, 0, 0, plugMat);
    return grip;
  });
  const consoleGrips = mascot.arms.map((_, index) => {
    const grip = new THREE.Group(); grip.name = `rack-console-grip-${index}`; mascot.root.add(grip);
    part(grip, 0.14, 0.025, 0.13, 0, -0.0125, 0, laptopMat);
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) part(grip, 0.026, 0.003, 0.022, (column - 1) * 0.035, 0.0015, (row - 1) * 0.032, plugMat);
    return grip;
  });
  const gripLinks = Array.from({ length: 4 }, () => {
    const link = part(mascot.root, 0.018, 1, 0.018, 0, 0, 0, cartMat);
    link.name = "rack-articulated-control-link";
    return link;
  });
  const cableGrip = new THREE.Group(); cableGrip.name = "rack-cable-grip"; mascot.root.add(cableGrip);
  const cablePort = new THREE.Group(); cablePort.name = "rack-service-patch-port"; mascot.root.add(cablePort);
  part(cablePort, 0.065, 0.055, 0.04, 0, 0, 0, chassisMat);
  part(cablePort, 0.038, 0.031, 0.005, 0, 0, -0.023, fanMat);
  part(cablePort, 0.008, 0.008, 0.005, 0.023, 0.017, -0.024, ledMat);
  const cableSegments = Array.from({ length: 10 }, () => part(mascot.root, 0.012, 1, 0.012, 0, 0, 0, cableMat, "rack-flexible-patch-lead"));
  const torchMarker = part(mascot.root, 0.08, 0.08, 0.003, 0, 0.9, RACK_REACH, amberMat, "rack-inspection-highlight");
  for (const prop of [slab, caddy, cable, cart, torch]) prop.visible = false;
  return { mascot, slab, caddy, cable, cart, terminal, torch, beam, out: 0, cartLevel: 0, caddyLevel: 0, cableLevel: 0, torchLevel: 0, pullGrips, consoleGrips, gripLinks, caddyDock, caddyLatch, fanRotors, consoleKeys, terminalRows, cableSegments, cablePort, torchMarker, cableGrip };
}

function reveal(prop: THREE.Object3D, level: number): void {
  prop.visible = level > 0.02;
  prop.scale.setScalar(0.4 + 0.6 * level);
}

function keepLevel(prop: THREE.Object3D): void {
  const arm = prop.parent!;
  prop.rotation.x = -arm.rotation.x;
}

export function animateRackProps(props: RackProps, active: boolean, t: number, dt: number, phase: number): void {
  if (!Number.isFinite(t) || reducedMotion()) t = 0;
  if (!Number.isFinite(dt)) dt = 0;
  const { step, k } = rackStep(t, phase);
  const on = (s: RackStep) => active && step === s;
  props.out = damp(props.out, on("pull") ? slabOut(k) : 0, 12, dt);
  props.slab.visible = props.out > 0.02;
  props.slab.position.z = RACK_REACH + SLAB_DEPTH / 2 - props.out * SLAB_TRAVEL;
  props.caddyDock.position.z = -0.19 - ramp(k, 0.35, 0.47) * (1 - ramp(k, 0.64, 0.73)) * 0.1;
  props.caddyLatch.rotation.y = ramp(k, 0.33, 0.4) * (1 - ramp(k, 0.66, 0.73)) * 0.8;
  props.caddyLevel = damp(props.caddyLevel, on("pull") && k > 0.46 && k < 0.62 ? 1 : 0, 14, dt);
  props.cableLevel = damp(props.cableLevel, on("cable") ? 1 : 0, 10, dt);
  props.cartLevel = damp(props.cartLevel, active ? 1 : 0, 6, dt);
  props.torchLevel = damp(props.torchLevel, on("scan") && k < SCAN_END ? 1 : 0, 12, dt);
  reveal(props.caddy, props.caddyLevel);
  reveal(props.cable, props.cableLevel);
  reveal(props.cart, props.cartLevel);
  reveal(props.torch, props.torchLevel);
  props.caddyDock.visible = !props.caddy.visible;
  props.fanRotors.forEach((fan, index) => { fan.rotation.y = reducedMotion() ? 0 : t * (12 + index); });
  for (const prop of [props.caddy, props.cable]) keepLevel(prop);
  props.beam.visible = props.torchLevel > 0.6;
  (props.beam.material as THREE.MeshBasicMaterial).opacity = 0.22 + Math.sin(t * 20 + phase) * 0.03;
  const typing = on("console");
  props.consoleKeys.forEach((key, index) => { key.position.y = 0.878 - (typing && !reducedMotion() ? Math.max(0, Math.sin(t * 10 + index * 1.7)) * 0.003 : 0); });
  props.terminalRows.forEach((row, index) => { row.visible = !typing || index <= Math.floor(t * 2) % 8; });
  (props.terminal.material as THREE.MeshStandardMaterial).emissiveIntensity = typing ? 0.9 + Math.sin(t * 9) * 0.25 : 0.55;
  props.mascot.root.updateWorldMatrix(true, true);
  const right = props.mascot.arms[1];
  const insertion = ramp(k, 0.35, 0.48) * (1 - ramp(k, 0.7, 0.85));
  const plugPosition = props.mascot.body.localToWorld(new THREE.Vector3(right.position.x, right.position.y + 0.05, 0.13 + insertion * 0.05));
  props.cableGrip.position.copy(props.mascot.root.worldToLocal(plugPosition));
  props.cableGrip.quaternion.copy(props.mascot.body.quaternion);
  props.cablePort.position.copy(props.cableGrip.position).add(new THREE.Vector3(0, 0, 0.035).applyQuaternion(props.mascot.body.quaternion));
  props.cablePort.quaternion.copy(props.mascot.body.quaternion);
  props.cablePort.visible = on("cable");
  props.torchMarker.visible = on("scan") && k < SCAN_END;
  props.torchMarker.position.set(Math.sin(t * 0.7 + phase) * 0.15, 0.78 + Math.sin(k / SCAN_END * Math.PI) * 0.35, RACK_REACH);
  for (const [index, arm] of props.mascot.arms.entries()) {
    for (const [kind, controls] of [props.pullGrips, props.consoleGrips].entries()) {
      const grip = controls[index];
      grip.visible = kind === 0 ? props.slab.visible : typing;
      const target = props.mascot.body.localToWorld(new THREE.Vector3(arm.position.x, arm.position.y - 0.025, 0.18));
      grip.position.copy(props.mascot.root.worldToLocal(target));
      grip.quaternion.copy(props.mascot.body.quaternion);
      const link = props.gripLinks[kind * 2 + index];
      link.visible = grip.visible;
      const source = kind === 0 ? props.slab.localToWorld(new THREE.Vector3(index ? 0.2 : -0.2, 0.015, -0.28)) : props.cart.localToWorld(new THREE.Vector3(index ? 0.12 : -0.12, 0.84, 0));
      props.mascot.root.worldToLocal(source);
      const direction = grip.position.clone().sub(source);
      link.position.copy(source).add(grip.position).multiplyScalar(0.5);
      link.scale.y = direction.length();
      link.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    }
  }
}

export function finalizeRackProps(props: RackProps, t: number, phase: number): void {
  const { step, k } = rackStep(reducedMotion() ? 0 : t, phase);
  const root = props.mascot.root;
  root.updateWorldMatrix(true, true);
  if (props.cable.visible) {
    const localRotation = new THREE.Quaternion().copy(props.mascot.body.quaternion);
    props.cable.parent!.getWorldQuaternion(props.cable.quaternion).invert();
    root.getWorldQuaternion(localRotation).multiply(props.mascot.body.quaternion);
    props.cable.quaternion.multiply(localRotation);
  }
  const start = props.cable.visible ? root.worldToLocal(props.cable.localToWorld(new THREE.Vector3(0, 0, -0.06))) : mascotHandPosition(props.mascot, 1, root);
  const end = new THREE.Vector3(0.18, 0.83, RACK_REACH + 0.025);
  const control = start.clone().add(end).multiplyScalar(0.5); control.y -= 0.2;
  const point = (x: number) => start.clone().multiplyScalar((1 - x) ** 2).addScaledVector(control, 2 * x * (1 - x)).addScaledVector(end, x ** 2);
  props.cableSegments.forEach((link, index) => {
    link.visible = props.cable.visible;
    if (link.visible) segment(link, point(index / props.cableSegments.length), point((index + 1) / props.cableSegments.length));
  });
  if (props.torch.visible) {
    const wrist = mascotHandPosition(props.mascot, 1, root);
    const direction = props.torchMarker.position.clone().sub(wrist).normalize();
    const worldRotation = root.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), direction));
    props.torch.parent!.getWorldQuaternion(props.torch.quaternion).invert().multiply(worldRotation);
    props.torch.updateWorldMatrix(true, true);
    const distance = props.torchMarker.position.distanceTo(wrist);
    props.beam.scale.set(0.65 + k * 0.3, Math.max(0.1, distance - 0.09) / 0.6, 0.65 + k * 0.3);
    props.beam.position.y = -0.09 - Math.max(0.1, distance - 0.09) / 2;
  }
  root.userData.rackService = { step, progress: k, cartFacingOperator: true, drive: props.caddy.visible ? "hand" : "bay", patchConnected: step === "cable" && k > 0.48 && k < 0.7 };
}
