import * as THREE from "three";
import { createMascot, reachMascotHand, resetMascotHands } from "./mascots.ts";
import { reducedMotion } from "../motion.ts";

export const DRINK_FRIDGE_STAGES = [
  ["approach", 4], ["handle", 2], ["open", 3], ["select", 5], ["take", 5],
  ["close", 3], ["carry", 4], ["drink", 8], ["lower", 2], ["deposit", 3],
  ["refill", 5], ["retrieve", 4], ["return", 4], ["reopen", 3], ["restock", 6],
  ["reclose", 7], ["leave", 4], ["idle", 8],
] as const;
export type DrinkFridgeStage = typeof DRINK_FRIDGE_STAGES[number][0];
export const DRINK_FRIDGE_CYCLE = DRINK_FRIDGE_STAGES.reduce((sum, entry) => sum + entry[1], 0);
export const DRINK_FRIDGE_FOOTPRINT = { x0: -0.9, x1: 1.0, z0: -0.4, z1: 1.8 };

type Position = { x: number; y: number; z: number };
export interface DrinkFridgeSample {
  stage: DrinkFridgeStage;
  progress: number;
  door: number;
  light: number;
  bottleOwner: "shelf" | "hand" | "tray";
  bottle: Position;
  bottleTilt: number;
  cap: number;
  fill: number;
  stream: boolean;
  actor: { x: number; y: number; z: number; yaw: number; walking: number };
  handleReach: number;
  bottleReach: number;
}

const SHELF = { x: -0.12, y: 0.66, z: 0.18 };
const TRAY = { x: -0.66, y: 0.67, z: 0.55 };
const HOME = { x: -0.48, y: 0.1, z: 1.48, yaw: Math.PI, walking: 0 };
const SHELF_STANCE = { x: 0.045, y: 0.32, z: 0.34, yaw: Math.PI, walking: 0 };
const TRAY_STANCE = { x: -0.495, y: 0.32, z: 0.69, yaw: Math.PI, walking: 0 };
const AWAY_HOLD = { x: -0.645, y: 0.36, z: 1.32 };
const MOUTH = { x: -0.48, y: 0.5, z: 1.52 };
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const smooth = (p: number) => { const x = Math.max(0, Math.min(1, p)); return x * x * (3 - 2 * x); };
const position = (a: Position, b: Position, p: number): Position => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), z: lerp(a.z, b.z, p) });
const phase = (value: number, start: number, end: number) => smooth((value - start) / (end - start));
type ActorPose = DrinkFridgeSample["actor"];

function handleStance(door: number): ActorPose {
  const angle = door * 1.72;
  return { x: 0.38 - 0.835 * Math.cos(angle) + 0.23 * Math.sin(angle), y: 0.32, z: 0.37 + 0.835 * Math.sin(angle) + 0.23 * Math.cos(angle), yaw: Math.PI + angle, walking: 0 };
}

function moveActor(from: ActorPose, to: ActorPose, amount: number): ActorPose {
  const point = position(from, to, amount);
  point.y = 0.1 + 0.22 * smooth((1.48 - point.z) / 0.12);
  return { ...point, yaw: lerp(from.yaw, to.yaw, amount), walking: Math.sin(amount * Math.PI) };
}

function shelfWalk(amount: number): ActorPose {
  const points = [handleStance(1), { ...SHELF_STANCE, x: 0.75, z: 1.36 }, { ...SHELF_STANCE, z: 1.36 }, SHELF_STANCE];
  const lengths = points.slice(1).map((point, index) => Math.hypot(point.x - points[index].x, point.z - points[index].z));
  let distance = amount * lengths.reduce((sum, length) => sum + length, 0);
  for (let index = 0; index < lengths.length; index++) {
    if (distance <= lengths[index] || index === lengths.length - 1) return moveActor(points[index], points[index + 1], distance / lengths[index]);
    distance -= lengths[index];
  }
  return { ...SHELF_STANCE };
}

function carriedBottle(actor: ActorPose): Position {
  return { x: actor.x + Math.cos(actor.yaw) * 0.165 + Math.sin(actor.yaw) * 0.16, y: actor.y + 0.26, z: actor.z - Math.sin(actor.yaw) * 0.165 + Math.cos(actor.yaw) * 0.16 };
}

export function sampleDrinkFridge(t: number, quiet = false): DrinkFridgeSample {
  const time = quiet || !Number.isFinite(t) ? 0 : Math.max(0, t);
  let elapsed = time % DRINK_FRIDGE_CYCLE;
  let stage: DrinkFridgeStage = "approach";
  let progress = 0;
  for (const [name, duration] of DRINK_FRIDGE_STAGES) {
    if (elapsed < duration) { stage = name; progress = elapsed / duration; break; }
    elapsed -= duration;
  }
  const p = smooth(progress);
  const index = DRINK_FRIDGE_STAGES.findIndex(entry => entry[0] === stage);
  const door = stage === "open" || stage === "reopen" ? p : stage === "close" ? 1 - p : stage === "reclose" ? 1 - phase(progress, 0.4, 1) : ["select", "take", "restock"].includes(stage) ? 1 : 0;
  const sample: DrinkFridgeSample = {
    stage, progress, door, light: smooth(door / 0.12), bottleOwner: "shelf", bottle: { ...SHELF }, bottleTilt: 0, cap: 0, fill: 1, stream: false,
    actor: handleStance(door), handleReach: 0, bottleReach: 0,
  };
  const movement = stage === "approach" || stage === "return" ? p : stage === "carry" || stage === "leave" ? 1 - p : null;
  if (movement !== null) {
    sample.actor = moveActor(HOME, handleStance(0), movement);
  } else if (index >= 7 && index <= 11 || stage === "idle") Object.assign(sample.actor, HOME);
  if (stage === "handle") sample.handleReach = p;
  if (["open", "reopen"].includes(stage)) sample.handleReach = 1;
  if (stage === "close") sample.handleReach = phase(progress, 0, 0.1) * (1 - phase(progress, 0.8, 1));
  if (stage === "select") {
    sample.actor = shelfWalk(phase(progress, 0.15, 0.75));
    sample.handleReach = 1 - phase(progress, 0, 0.15);
    sample.bottleReach = phase(progress, 0.75, 1);
  }
  if (stage === "take") sample.actor = shelfWalk(1 - phase(progress, 0.2, 1));
  if (index >= 4 && index <= 14) {
    sample.bottleOwner = "hand";
    sample.bottle = carriedBottle(sample.actor);
    sample.bottleReach = 1;
  }
  if (stage === "take") sample.bottle = position(SHELF, carriedBottle(sample.actor), phase(progress, 0, 0.2));
  if (stage === "drink") {
    const sip = smooth(progress / 0.16) * (1 - smooth((progress - 0.82) / 0.18));
    sample.bottle = position(AWAY_HOLD, MOUTH, sip);
    sample.bottleTilt = -1.2 * sip;
    sample.cap = smooth(progress / 0.08);
    sample.fill = 1 - 0.9 * smooth((progress - 0.15) / 0.65);
  }
  if (stage === "lower") { sample.bottle = { ...AWAY_HOLD }; sample.fill = 0.1; sample.cap = 1 - p; }
  if (stage === "deposit") { sample.actor = moveActor(HOME, TRAY_STANCE, phase(progress, 0, 0.65)); sample.bottle = position(carriedBottle(sample.actor), TRAY, phase(progress, 0.65, 1)); sample.fill = 0.1; sample.cap = p; }
  if (stage === "refill") {
    sample.actor = { ...TRAY_STANCE };
    sample.bottleOwner = "tray";
    sample.bottle = { ...TRAY };
    sample.bottleReach = 1 - smooth(progress / 0.2);
    sample.fill = lerp(0.1, 1, smooth((progress - 0.15) / 0.7));
    sample.stream = progress > 0.15 && progress < 0.85;
    sample.cap = 1;
  }
  if (stage === "retrieve") {
    sample.actor = moveActor(TRAY_STANCE, HOME, phase(progress, 0.45, 1));
    sample.bottleOwner = progress < 0.25 ? "tray" : "hand";
    sample.bottle = position(TRAY, carriedBottle(sample.actor), phase(progress, 0.25, 0.45));
    sample.bottleReach = smooth(progress / 0.25);
    sample.cap = 1 - p;
  }
  if (stage === "return") sample.handleReach = phase(progress, 0.75, 1);
  if (stage === "restock") { sample.actor = shelfWalk(phase(progress, 0.15, 0.65)); sample.bottle = position(carriedBottle(sample.actor), SHELF, phase(progress, 0.65, 1)); sample.handleReach = 1 - phase(progress, 0, 0.15); }
  if (stage === "reclose") { sample.actor = progress < 0.4 ? shelfWalk(1 - phase(progress, 0, 0.35)) : handleStance(door); sample.bottleReach = 1 - phase(progress, 0, 0.15); sample.handleReach = phase(progress, 0.35, 0.4) * (1 - phase(progress, 0.9, 1)); }
  if (quiet) { sample.stage = "idle"; Object.assign(sample.actor, HOME); }
  return sample;
}

export interface DrinkFridge {
  root: THREE.Group;
  tick(t: number, dt: number): void;
  dispose(): void;
}

export function createDrinkFridge(parent: THREE.Object3D, x: number, z: number): DrinkFridge {
  const root = new THREE.Group();
  root.name = "drink-fridge";
  root.position.set(x, 0, z);
  parent.add(root);
  const steel = new THREE.MeshStandardMaterial({ color: 0xb7c3ca, metalness: 0.65, roughness: 0.28 });
  const white = new THREE.MeshStandardMaterial({ color: 0xe9f0ed, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x253337, roughness: 0.7 });
  const seal = new THREE.MeshStandardMaterial({ color: 0x707b7c, roughness: 0.9 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x8ec7d3, transparent: true, opacity: 0.28, roughness: 0.16 });
  const water = new THREE.MeshStandardMaterial({ color: 0x3cafd6, transparent: true, opacity: 0.65, roughness: 0.2 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x3e7caa, roughness: 0.4 });
  const green = new THREE.MeshStandardMaterial({ color: 0x558b6b, roughness: 0.5 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xecab57, roughness: 0.5 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xf3fff5, emissive: 0xc3efff, emissiveIntensity: 0 });
  const ownedMaterials = [steel, white, dark, seal, glass, water, blue, green, orange, glow];
  const ownedGeometries = new Set<THREE.BufferGeometry>();
  let disposed = false;
  const mesh = (name: string, owner: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, px: number, py: number, pz: number): THREE.Mesh => {
    const object = new THREE.Mesh(geometry, material); object.name = name; object.position.set(px, py, pz); object.castShadow = true; owner.add(object); return object;
  };
  const box = (name: string, owner: THREE.Object3D, w: number, h: number, d: number, px: number, py: number, pz: number, material: THREE.Material = steel) => mesh(name, owner, new THREE.BoxGeometry(w, h, d), material, px, py, pz);
  const cyl = (name: string, owner: THREE.Object3D, rt: number, rb: number, h: number, px: number, py: number, pz: number, material: THREE.Material = steel) => mesh(name, owner, new THREE.CylinderGeometry(rt, rb, h, 16), material, px, py, pz);
  box("back", root, 0.8, 1.85, 0.07, 0, 1.025, -0.34);
  for (const side of [-1, 1]) {
    box("side", root, 0.06, 1.85, 0.7, side * 0.38, 1.025, 0);
    box("liner", root, 0.012, 1.68, 0.59, side * 0.343, 1.03, 0, white);
    for (const depth of [-0.25, 0.25]) cyl("foot", root, 0.042, 0.05, 0.08, side * 0.29, 0.13, depth, dark);
  }
  box("top", root, 0.8, 0.07, 0.7, 0, 1.94, 0);
  box("bottom", root, 0.8, 0.09, 0.7, 0, 0.2, 0);
  box("back-liner", root, 0.68, 1.66, 0.02, 0, 1.04, -0.295, white);
  for (const y of [0.36, 0.65, 1.02, 1.36]) {
    box("shelf", root, 0.66, 0.018, 0.57, 0, y, 0.01, glass);
    box("shelf-edge", root, 0.66, 0.035, 0.025, 0, y, 0.29, white);
    for (const side of [-1, 1]) box("shelf-support", root, 0.025, 0.035, 0.52, side * 0.32, y - 0.02, 0, white);
  }
  box("freezer", root, 0.65, 0.33, 0.53, 0, 1.63, -0.015, white);
  box("freezer-flap", root, 0.59, 0.27, 0.025, 0, 1.63, 0.265, glass);
  box("freezer-handle", root, 0.18, 0.025, 0.04, 0, 1.61, 0.29, steel);
  for (const px of [-0.16, 0, 0.16]) box("ice-tray", root, 0.1, 0.04, 0.13, px, 1.54, 0.1, blue);
  for (let i = 0; i < 7; i++) box("vent", root, 0.44, 0.012, 0.025, 0, 0.225 + i * 0.018, 0.358, dark);
  const bottle = (name: string, px: number, py: number, pz: number, color: THREE.Material): { root: THREE.Group; fill: THREE.Mesh; lid: THREE.Group } => {
    const item = new THREE.Group(); item.name = name; item.position.set(px, py, pz); root.add(item);
    cyl("bottle-shell", item, 0.045, 0.046, 0.19, 0, 0.095, 0, glass);
    cyl("bottle-shoulder", item, 0.023, 0.045, 0.045, 0, 0.213, 0, glass);
    cyl("bottle-neck", item, 0.022, 0.022, 0.045, 0, 0.25, 0, glass);
    const fill = cyl("bottle-water", item, 0.037, 0.038, 0.16, 0, 0.087, 0, color);
    cyl("bottle-label", item, 0.047, 0.047, 0.065, 0, 0.09, 0, white);
    box("bottle-label-mark", item, 0.04, 0.027, 0.003, 0, 0.09, 0.049, blue);
    const lid = new THREE.Group(); lid.name = "bottle-lid"; lid.position.set(0, 0.271, -0.022); item.add(lid);
    cyl("bottle-cap", lid, 0.026, 0.026, 0.018, 0, 0, 0.022, blue);
    return { root: item, fill, lid };
  };
  for (const [px, pz] of [[0.13, -0.1], [0.25, 0.13], [-0.12, -0.12]]) bottle("stock-water", px, 0.66, pz, water);
  for (const px of [-0.23, 0, 0.23]) {
    box("milk-carton", root, 0.13, 0.22, 0.13, px, 1.14, 0.02, white);
    const fold = box("milk-roof", root, 0.13, 0.06, 0.095, px, 1.28, 0.02, blue); fold.rotation.x = Math.PI / 4;
    box("milk-label", root, 0.09, 0.065, 0.006, px, 1.13, 0.09, blue);
    cyl("milk-cap", root, 0.018, 0.018, 0.018, px + 0.03, 1.32, 0.02, white);
  }
  box("produce-bin", root, 0.59, 0.18, 0.45, 0, 0.47, 0.02, glass);
  for (let i = 0; i < 6; i++) mesh("fruit", root, new THREE.SphereGeometry(0.055, 10, 8), i % 2 ? orange : green, -0.2 + i % 3 * 0.19, 0.46, -0.07 + Math.floor(i / 3) * 0.17);
  const lamp = box("inside-lamp", root, 0.34, 0.025, 0.08, 0, 1.84, 0.18, glow);
  lamp.castShadow = false;
  const light = new THREE.PointLight(0xd8f5ff, 0, 2.3, 2); light.name = "fridge-light"; light.position.set(0, 1.55, 0.14); root.add(light);
  const door = new THREE.Group(); door.name = "fridge-door"; door.position.set(0.38, 0, 0.37); root.add(door);
  box("door-panel", door, 0.76, 1.78, 0.07, -0.38, 1.04, 0);
  box("door-inner", door, 0.65, 1.66, 0.015, -0.38, 1.04, -0.043, white);
  for (const px of [-0.724, -0.036]) box("door-seal", door, 0.018, 1.7, 0.025, px, 1.04, -0.05, seal);
  for (const py of [0.19, 1.89]) box("door-seal", door, 0.69, 0.018, 0.025, -0.38, py, -0.05, seal);
  for (const py of [0.4, 0.92]) {
    box("door-bin", door, 0.51, 0.045, 0.1, -0.38, py, -0.1, white);
    box("door-bin-rail", door, 0.51, 0.08, 0.015, -0.38, py + 0.07, -0.15, glass);
  }
  const handle = box("door-handle", door, 0.028, 0.6, 0.035, -0.67, 0.8, 0.09, dark);
  for (const py of [0.53, 1.07]) box("handle-mount", door, 0.034, 0.035, 0.07, -0.67, py, 0.06, steel);
  box("control-display", door, 0.19, 0.1, 0.008, -0.43, 1.56, 0.042, dark);
  for (const [px, py, w, h] of [[-0.47, 1.58, 0.006, 0.035], [-0.43, 1.58, 0.006, 0.035], [-0.45, 1.56, 0.045, 0.006], [-0.43, 1.54, 0.006, 0.035]]) box("display-digit", door, w, h, 0.003, px, py, 0.048, blue);
  cyl("return-stand", root, 0.09, 0.14, 0.49, TRAY.x, 0.395, TRAY.z, steel);
  box("return-tray", root, 0.25, 0.035, 0.25, TRAY.x, TRAY.y - 0.022, TRAY.z, dark);
  for (let i = 0; i < 6; i++) box("tray-drain", root, 0.18, 0.006, 0.012, TRAY.x, TRAY.y, TRAY.z - 0.08 + i * 0.032, steel);
  cyl("refill-pipe", root, 0.018, 0.018, 0.46, TRAY.x, 0.85, TRAY.z - 0.15, steel);
  box("refill-spout", root, 0.04, 0.04, 0.19, TRAY.x, 1.06, TRAY.z - 0.07, steel);
  const stream = cyl("refill-water", root, 0.007, 0.007, 0.11, TRAY.x, 0.996, TRAY.z, water);
  const drink = bottle("reusable-water-bottle", SHELF.x, SHELF.y, SHELF.z, water);
  box("access-platform", root, 1.7, 0.22, 1.08, 0.1, 0.21, 0.82, dark);
  for (let index = 0; index < 6; index++) {
    const depth = 1.47 - index * 0.02;
    const height = 0.22 * smooth((1.48 - depth) / 0.12);
    box("access-step", root, 1.7, height, 0.02, 0.1, 0.1 + height / 2, depth, seal);
  }
  const actor = createMascot("codex", true); actor.root.name = "fridge-guest"; root.add(actor.root);
  root.traverse(object => { if ((object as THREE.Mesh).isMesh) ownedGeometries.add((object as THREE.Mesh).geometry); });
  const handlePoint = new THREE.Vector3();
  const handPoint = new THREE.Vector3();
  const restPoint = new THREE.Vector3();
  const tick = (t: number, _dt: number): void => {
    if (disposed) return;
    const state = sampleDrinkFridge(t, reducedMotion());
    root.userData.fridge = state;
    door.rotation.y = state.door * 1.72;
    light.intensity = state.light * 1.8;
    glow.emissiveIntensity = state.light * 1.2;
    stream.visible = state.stream;
    actor.root.position.set(state.actor.x, state.actor.y, state.actor.z);
    actor.root.rotation.y = state.actor.yaw;
    resetMascotHands(actor);
    actor.body.rotation.set(0, 0, 0);
    for (const [index, leg] of actor.legs.entries()) leg.rotation.x = Math.sin((Number.isFinite(t) ? t : 0) * 8 + index * Math.PI) * state.actor.walking * 0.34;
    for (const arm of actor.arms) arm.rotation.set(0, 0, 0);
    drink.root.position.set(state.bottle.x, state.bottle.y, state.bottle.z);
    drink.root.rotation.x = state.bottleTilt;
    drink.root.userData.owner = state.bottleOwner;
    drink.lid.rotation.x = state.cap * -2.1;
    drink.fill.scale.y = state.fill;
    drink.fill.position.y = 0.007 + 0.08 * state.fill;
    root.updateWorldMatrix(true, true);
    handle.localToWorld(handlePoint.set(0, -0.25, 0)); root.worldToLocal(handlePoint);
    drink.root.localToWorld(handPoint.set(0, 0.11, 0)); root.worldToLocal(handPoint);
    for (const [index, target, amount] of [[0, handlePoint, state.handleReach], [1, handPoint, state.bottleReach]] as const) {
      actor.body.localToWorld(restPoint.set(index ? 0.22 : -0.22, 0.23, 0.05)); root.worldToLocal(restPoint);
      restPoint.lerp(target, amount);
      reachMascotHand(actor, index, root, restPoint.x, restPoint.y, restPoint.z);
    }
  };
  root.traverse(object => { object.userData.keep = true; });
  tick(0, 0);
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    root.removeFromParent();
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    ownedGeometries.clear();
    light.dispose();
  };
  return { root, tick, dispose };
}
