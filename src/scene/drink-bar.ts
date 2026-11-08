import * as THREE from "three";
import { createMascot, poseMascotSeated, reachMascotHand, resetMascotHands, type Mascot } from "./mascots.ts";
import { reducedMotion } from "../motion.ts";
import { DRINK_BAR_SEATS } from "./layout.ts";

export const DRINK_BAR_STAGES = [
  ["approach", 6], ["order", 4], ["prepare", 4], ["brew", 6], ["serve", 4],
  ["carry", 7], ["drink", 14], ["return", 7], ["drop", 3], ["leave", 7],
] as const;
export type DrinkBarStage = typeof DRINK_BAR_STAGES[number][0];
export const DRINK_BAR_CYCLE = DRINK_BAR_STAGES.reduce((sum, entry) => sum + entry[1], 0);
export const DRINK_BAR_FOOTPRINT = { x0: -2.2, x1: 2.2, z0: -1.5, z1: 2.55 };
export const DRINK_BAR_MENU = [
  { id: "espresso", label: "Espresso", family: "coffee", brewSeconds: 6, color: 0x6b4124 },
  { id: "orange", label: "Nước cam", family: "cold", brewSeconds: 12, color: 0xf4a62a },
  { id: "matcha-latte", label: "Matcha latte", family: "matcha", brewSeconds: 36, color: 0x91b755 },
  { id: "latte", label: "Caffè latte", family: "coffee", brewSeconds: 10, color: 0xc99a6d },
  { id: "cappuccino", label: "Cappuccino", family: "coffee", brewSeconds: 10, color: 0xb3855d },
  { id: "americano", label: "Americano", family: "coffee", brewSeconds: 8, color: 0x593b29 },
  { id: "lemon-tea", label: "Trà chanh", family: "cold", brewSeconds: 12, color: 0xc58b32 },
] as const;
export type DrinkRecipe = typeof DRINK_BAR_MENU[number]["id"];
export const MATCHA_LATTE_METHOD = { matchaGrams: 3, waterMl: 100, waterCelsius: 80, whiskSeconds: 15, milkMl: 100 } as const;

export interface DrinkBarSample {
  stage: DrinkBarStage;
  progress: number;
  guest: number;
  recipe: DrinkRecipe;
  brewSeconds: number;
  brewElapsed: number;
  recipeStep: string;
  cupOwner: "counter" | "bartender" | "guest" | "return";
  fill: number;
}

export function sampleDrinkBar(t: number): DrinkBarSample {
  const time = Number.isFinite(t) ? Math.max(0, t) : 0;
  const menuDuration = DRINK_BAR_MENU.reduce((sum, recipe) => sum + DRINK_BAR_CYCLE - 6 + recipe.brewSeconds, 0);
  let remaining = time % menuDuration;
  let recipeIndex = 0;
  while (recipeIndex < DRINK_BAR_MENU.length - 1 && remaining >= DRINK_BAR_CYCLE - 6 + DRINK_BAR_MENU[recipeIndex].brewSeconds) {
    remaining -= DRINK_BAR_CYCLE - 6 + DRINK_BAR_MENU[recipeIndex].brewSeconds;
    recipeIndex++;
  }
  const recipe = DRINK_BAR_MENU[recipeIndex];
  const cycle = Math.floor(time / menuDuration) * DRINK_BAR_MENU.length + recipeIndex;
  let stage: DrinkBarStage = "approach";
  let progress = 0;
  for (const [name, baseDuration] of DRINK_BAR_STAGES) {
    const duration = name === "brew" ? recipe.brewSeconds : baseDuration;
    if (remaining < duration) { stage = name; progress = remaining / duration; break; }
    remaining -= duration;
  }
  const cupOwner = (stage === "prepare" && progress >= 0.08 && progress < 0.85) || (stage === "serve" && progress >= 0.08 && progress < 0.86) || (stage === "leave" && progress >= 0.12 && progress < 0.7) ? "bartender" : stage === "carry" || stage === "return" || stage === "drink" || (stage === "drop" && progress < 0.6) ? "guest" : stage === "drop" ? "return" : "counter";
  const brewElapsed = stage === "brew" ? progress * recipe.brewSeconds : 0;
  const recipeStep = stage !== "brew" ? stage : recipe.family === "matcha" ? brewElapsed < 4 ? "sift" : brewElapsed < 7 ? "water" : brewElapsed < 8 ? "whisk-setup" : brewElapsed < 23 ? "whisk" : brewElapsed < 24 ? "whisk-rest" : brewElapsed < 29 ? "transfer" : brewElapsed < 34 ? "milk" : "finish" : recipe.family === "cold" ? brewElapsed < 5 ? recipe.id === "orange" ? "juice" : "steep" : brewElapsed < 9 ? "shake" : "pour" : recipe.id === "americano" && progress > 0.6 ? "water" : (recipe.id === "latte" || recipe.id === "cappuccino") && progress > 0.6 ? "milk" : "extract";
  const fill = stage === "brew" ? recipe.family === "matcha" ? phase(brewElapsed, 26, 28) * 0.5 + phase(brewElapsed, 30.5, 32.7) * 0.5 : recipe.family === "cold" ? phase(brewElapsed, 9.5, 11) : progress : stage === "serve" || stage === "carry" ? 1 : stage === "drink" ? Math.max(0, 1 - progress / 0.88) : 0;
  return { stage, progress, guest: cycle % 2, recipe: recipe.id, brewSeconds: recipe.brewSeconds, brewElapsed, recipeStep, cupOwner, fill };
}

const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };
const phase = (value: number, start: number, end: number) => smooth((value - start) / (end - start));
const pulse = (value: number, start: number, rise: number, fall: number, end: number) => phase(value, start, rise) * (1 - phase(value, fall, end));
type Point = { x: number; z: number };

function along(path: Point[], progress: number): Point & { yaw: number } {
  const lengths = path.slice(1).map((point, i) => Math.hypot(point.x - path[i].x, point.z - path[i].z));
  let distance = lengths.reduce((sum, length) => sum + length, 0) * smooth(progress);
  for (let i = 0; i < lengths.length; i++) {
    if (distance <= lengths[i] || i === lengths.length - 1) {
      const k = lengths[i] ? distance / lengths[i] : 1;
      const facing = (index: number) => Math.atan2(path[index + 1].x - path[index].x, path[index + 1].z - path[index].z);
      let yaw = facing(i);
      if (i > 0 && k < 0.2) {
        const previous = facing(i - 1);
        yaw = previous + Math.atan2(Math.sin(yaw - previous), Math.cos(yaw - previous)) * (0.5 + smooth(k / 0.2) * 0.5);
      } else if (i < lengths.length - 1 && k > 0.8) yaw += Math.atan2(Math.sin(facing(i + 1) - yaw), Math.cos(facing(i + 1) - yaw)) * smooth((k - 0.8) / 0.2) * 0.5;
      return { x: THREE.MathUtils.lerp(path[i].x, path[i + 1].x, k), z: THREE.MathUtils.lerp(path[i].z, path[i + 1].z, k), yaw };
    }
    distance -= lengths[i];
  }
  return { ...path[0], yaw: 0 };
}

export function drinkGuestPosition(sample: DrinkBarSample): Point & { yaw: number; seated: boolean; seatAmount: number; walking: boolean } {
  const side = sample.guest ? 1 : -1;
  const home = DRINK_BAR_SEATS[sample.guest];
  const order = { x: 0, z: 1.45 };
  const path = [home, ...[2, 1].map(step => ({ x: Math.sin(side * step * Math.PI / 9) * 1.85, z: Math.cos(step * Math.PI / 9) * 1.85 })), { x: side * 0.5, z: 2.25 }, { x: 0, z: 2.25 }, order];
  if (sample.stage === "approach" || sample.stage === "return") {
    const seatAmount = 1 - smooth(sample.progress / 0.18);
    const position = along(path, Math.max(0, (sample.progress - 0.18) / 0.82));
    position.yaw = home.yaw + Math.atan2(Math.sin(position.yaw - home.yaw), Math.cos(position.yaw - home.yaw)) * smooth(sample.progress / 0.18);
    position.yaw += Math.atan2(Math.sin(Math.PI - position.yaw), Math.cos(Math.PI - position.yaw)) * smooth((sample.progress - 0.9) / 0.1);
    return { ...position, seated: seatAmount > 0, seatAmount, walking: sample.progress > 0.18 };
  }
  if (sample.stage === "carry" || sample.stage === "leave") {
    const seatAmount = smooth((sample.progress - 0.82) / 0.18);
    const position = along([...path].reverse(), Math.max(0, Math.min(1, (sample.progress - 0.18) / 0.64)));
    position.yaw += Math.atan2(Math.sin(Math.PI - position.yaw), Math.cos(Math.PI - position.yaw)) * (1 - smooth(sample.progress / 0.18));
    position.yaw += Math.atan2(Math.sin(home.yaw - position.yaw), Math.cos(home.yaw - position.yaw)) * seatAmount;
    return { ...position, seated: seatAmount > 0, seatAmount, walking: sample.progress > 0.18 && sample.progress < 0.82 };
  }
  if (sample.stage === "drink") return { ...home, seated: true, seatAmount: 1, walking: false };
  return { ...order, yaw: Math.PI, seated: false, seatAmount: 0, walking: false };
}

export function createDrinkBar(parent: THREE.Object3D, centerX: number, centerZ: number): { root: THREE.Group; tick(t: number, dt: number): void; dispose(): void } {
  const root = new THREE.Group();
  root.name = "circular-drinks-bar";
  root.position.set(centerX, 0, centerZ);
  parent.add(root);
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const material = (color: number, roughness = 0.5, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const wood = material(0x725039), stone = material(0xf2e8d7, 0.28), metal = material(0xb4bbc0, 0.3, 0.7), dark = material(0x173737), porcelain = material(0xfffaf0), brass = material(0xcfab68, 0.3, 0.65);
  const mesh = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
    geometries.add(geometry); materials.add(mat);
    const item = new THREE.Mesh(geometry, mat); item.position.set(x, y, z); item.castShadow = true; item.receiveShadow = true; parent.add(item); return item;
  };
  const box = (parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat = wood) => mesh(parent, new THREE.BoxGeometry(w, h, d), mat, x, y, z);
  const cylinder = (parent: THREE.Object3D, radius: number, height: number, x: number, y: number, z: number, mat = metal) => mesh(parent, new THREE.CylinderGeometry(radius, radius, height, 32), mat, x, y, z);
  const ring = (inner: number, outer: number, height: number, mat: THREE.Material, y: number) => {
    const shape = new THREE.Shape();
    shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
    const hole = new THREE.Path(); hole.absarc(0, 0, inner, 0, Math.PI * 2, true); shape.holes.push(hole);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 48 });
    geometry.rotateX(-Math.PI / 2);
    return mesh(root, geometry, mat, 0, y, 0);
  };
  cylinder(root, 1.45, 0.025, 0, 0.115, 0, dark);
  ring(0.78, 1.27, 0.75, wood, 0.13);
  ring(0.72, 1.35, 0.095, stone, 0.88);
  ring(1.27, 1.3, 0.035, brass, 0.24);
  for (let index = 0; index < 42; index++) {
    const angle = index / 42 * Math.PI * 2;
    const slat = box(root, 0.035, 0.62, 0.045, Math.sin(angle) * 1.28, 0.53, Math.cos(angle) * 1.28, brass);
    slat.rotation.y = angle;
  }
  box(root, 0.72, 0.45, 0.35, 0, 1.2, -1.0, dark);
  box(root, 0.76, 0.045, 0.4, 0, 1.445, -1.0, metal);
  box(root, 0.55, 0.025, 0.26, 0, 0.995, -0.82, metal);
  for (let i = 0; i < 9; i++) box(root, 0.012, 0.01, 0.22, -0.24 + i * 0.06, 1.015, -0.82, dark);
  cylinder(root, 0.028, 0.16, -0.13, 1.21, -0.8, metal);
  cylinder(root, 0.028, 0.16, 0.13, 1.21, -0.8, metal);
  cylinder(root, 0.08, 0.045, 0, 1.21, -0.81, metal);
  box(root, 0.045, 0.035, 0.21, 0, 1.19, -0.68, dark);
  const pressureGauge = cylinder(root, 0.065, 0.02, -0.2, 1.34, -0.81, porcelain); pressureGauge.rotation.x = Math.PI / 2;
  const gaugeNeedle = box(root, 0.006, 0.045, 0.008, -0.2, 1.355, -0.792, dark); gaugeNeedle.rotation.z = -0.55;
  const steamWand = cylinder(root, 0.012, 0.22, 0.3, 1.16, -0.77, metal); steamWand.rotation.z = -0.3;
  const grinder = new THREE.Group(); grinder.name = "bar-coffee-grinder"; grinder.position.set(-0.8, 0.98, -0.76); root.add(grinder);
  cylinder(grinder, 0.11, 0.25, 0, 0.13, 0, dark);
  cylinder(grinder, 0.13, 0.16, 0, 0.34, 0, new THREE.MeshPhysicalMaterial({ color: 0xa58865, transparent: true, opacity: 0.65, roughness: 0.1 }));
  cylinder(grinder, 0.14, 0.025, 0, 0.43, 0, dark);
  for (let i = 0; i < 15; i++) mesh(grinder, new THREE.SphereGeometry(0.023, 6, 5), wood, Math.sin(i * 2.4) * 0.08, 0.29 + (i % 3) * 0.026, Math.cos(i * 2.4) * 0.08);
  box(grinder, 0.07, 0.05, 0.11, 0, 0.2, 0.1, metal);
  const pitcher = new THREE.Group(); pitcher.name = "drink-milk-pitcher"; pitcher.position.set(0.39, 0.985, -0.78); root.add(pitcher);
  mesh(pitcher, new THREE.CylinderGeometry(0.065, 0.045, 0.14, 20, 1, true), metal, 0, 0.07, 0);
  const pitcherHandle = mesh(pitcher, new THREE.TorusGeometry(0.037, 0.009, 8, 16), metal, 0.068, 0.08, 0); pitcherHandle.rotation.y = Math.PI / 2;
  box(pitcher, 0.04, 0.018, 0.04, -0.06, 0.139, 0, metal).rotation.z = -0.2;
  const machineLight = material(0x74d2a0); machineLight.emissive.setHex(0x2a965f);
  box(root, 0.16, 0.035, 0.02, 0.2, 1.33, -0.81, machineLight);
  for (let i = 0; i < 4; i++) {
    const angle = (25 + i * 10) * Math.PI / 180;
    const bottle = cylinder(root, 0.055, 0.23, Math.sin(angle) * 1.12, 1.085, -Math.cos(angle) * 1.12, material([0xd99b32, 0x76893e, 0xae5c3a, 0xd1ae73][i]));
    cylinder(bottle, 0.024, 0.075, 0, 0.15, 0, brass);
    box(bottle, 0.09, 0.018, 0.025, 0.022, 0.19, 0, dark);
    box(bottle, 0.08, 0.09, 0.005, 0, 0, 0.056, porcelain);
  }
  const bamboo = material(0xd4b67b), matchaGreen = material(0x63923e), orangeSkin = material(0xf0a22d), lemonSkin = material(0xe7cf49);
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xd8e9e7, transparent: true, opacity: 0.45, roughness: 0.12, metalness: 0.05 });
  const equipment = (name: string, x: number, z: number, y = 0.975) => {
    const item = new THREE.Group(); item.name = name; item.position.set(x, y, z); root.add(item); return item;
  };
  const beanJar = equipment("bar-bean-jar", -1.04, -0.64);
  cylinder(beanJar, 0.08, 0.23, 0, 0.12, 0, glass);
  cylinder(beanJar, 0.085, 0.025, 0, 0.25, 0, wood);
  for (let i = 0; i < 20; i++) mesh(beanJar, new THREE.SphereGeometry(0.017, 6, 5), wood, Math.sin(i * 2.4) * 0.05, 0.035 + (i % 6) * 0.024, Math.cos(i * 2.4) * 0.05);
  const cupRack = equipment("bar-cup-rack", 0, -1, 1.47);
  box(cupRack, 0.66, 0.025, 0.24, 0, 0, 0, metal);
  for (const x of [-0.22, 0, 0.22]) {
    for (let layer = 0; layer < 2; layer++) mesh(cupRack, new THREE.CylinderGeometry(0.055, 0.04, 0.07, 16, 1, true), porcelain, x, 0.05 + layer * 0.06, 0);
    mesh(cupRack, new THREE.TorusGeometry(0.024, 0.007, 6, 12), porcelain, x + 0.06, 0.1, 0).rotation.y = Math.PI / 2;
  }
  const paperCups = equipment("bar-paper-cups", -0.56, -1.03);
  for (let i = 0; i < 4; i++) mesh(paperCups, new THREE.CylinderGeometry(0.055, 0.038, 0.1, 16, 1, true), porcelain, 0, 0.06 + i * 0.035, 0);
  const knockBox = equipment("bar-knock-box", 1.1, -0.48);
  box(knockBox, 0.18, 0.09, 0.18, 0, 0.045, 0, metal);
  box(knockBox, 0.145, 0.012, 0.145, 0, 0.094, 0, dark);
  const knockBar = cylinder(knockBox, 0.016, 0.19, 0, 0.11, 0, dark); knockBar.rotation.z = Math.PI / 2;
  const tampMat = equipment("bar-tamping-station", 1.05, -0.12);
  box(tampMat, 0.23, 0.014, 0.2, 0, 0.007, 0, dark);
  cylinder(tampMat, 0.035, 0.018, 0.055, 0.025, -0.045, metal);
  cylinder(tampMat, 0.022, 0.06, 0.055, 0.06, -0.045, wood);
  const portafilter = cylinder(tampMat, 0.04, 0.025, -0.04, 0.03, 0.055, metal);
  box(portafilter, 0.1, 0.025, 0.025, 0.08, 0, 0, dark);
  const scale = box(tampMat, 0.085, 0.02, 0.085, -0.06, 0.025, -0.05, metal); scale.name = "bar-digital-scale";
  box(scale, 0.06, 0.003, 0.02, 0, 0.012, 0.025, material(0x7fccc2));
  const iceBin = equipment("bar-ice-bin", 1.14, -0.28);
  box(iceBin, 0.2, 0.1, 0.19, 0, 0.05, 0, metal);
  box(iceBin, 0.17, 0.008, 0.16, 0, 0.105, 0, dark);
  for (let i = 0; i < 8; i++) box(iceBin, 0.045, 0.035, 0.04, Math.sin(i * 2.4) * 0.055, 0.12 + i % 2 * 0.018, Math.cos(i * 2.4) * 0.05, glass).rotation.y = i;
  for (const side of [-1, 1]) box(iceBin, 0.013, 0.018, 0.15, side * 0.015, 0.16, 0, metal).rotation.y = side * 0.12;
  const juicer = equipment("bar-citrus-juicer", 1.08, 0.17);
  cylinder(juicer, 0.085, 0.035, 0, 0.02, 0, porcelain);
  mesh(juicer, new THREE.ConeGeometry(0.055, 0.085, 12), porcelain, 0, 0.07, 0);
  const citrusPress = mesh(juicer, new THREE.SphereGeometry(0.06, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), orangeSkin, 0, 0.12, 0);
  citrusPress.name = "bar-orange-half";
  const cuttingBoard = equipment("bar-cutting-board", 1.04, 0.36);
  box(cuttingBoard, 0.22, 0.018, 0.13, 0, 0.009, 0, bamboo);
  mesh(cuttingBoard, new THREE.SphereGeometry(0.043, 12, 8), lemonSkin, -0.05, 0.055, 0);
  const orangeSlice = cylinder(cuttingBoard, 0.038, 0.012, 0.04, 0.028, 0, orangeSkin);
  cylinder(orangeSlice, 0.03, 0.014, 0, 0.002, 0, material(0xffd588));
  box(cuttingBoard, 0.1, 0.008, 0.025, 0.025, 0.025, 0.04, metal);
  box(cuttingBoard, 0.045, 0.013, 0.028, -0.05, 0.025, 0.04, dark);
  const jigger = equipment("bar-jigger", 0.75, 0.52);
  mesh(jigger, new THREE.CylinderGeometry(0.034, 0.017, 0.06, 16, 1, true), metal, 0, 0.09, 0);
  mesh(jigger, new THREE.CylinderGeometry(0.017, 0.03, 0.055, 16, 1, true), metal, 0, 0.032, 0);
  const stirrers = equipment("bar-stirrer-holder", 0.67, 0.62);
  cylinder(stirrers, 0.035, 0.08, 0, 0.04, 0, dark);
  for (let i = 0; i < 5; i++) { const spoon = cylinder(stirrers, 0.004, 0.18, (i - 2) * 0.01, 0.12, 0, i % 2 ? bamboo : metal); spoon.rotation.z = (i - 2) * 0.08; }
  const napkins = equipment("bar-napkin-holder", -0.83, 0.8);
  box(napkins, 0.16, 0.045, 0.12, 0, 0.023, 0, dark);
  for (let i = 0; i < 4; i++) box(napkins, 0.13, 0.004, 0.1, 0, 0.05 + i * 0.006, 0, porcelain);
  const matchaTin = equipment("bar-matcha-tin", -1.08, 0.34);
  cylinder(matchaTin, 0.065, 0.12, 0, 0.06, 0, dark);
  cylinder(matchaTin, 0.06, 0.008, 0, 0.123, 0, matchaGreen);
  cylinder(matchaTin, 0.068, 0.012, -0.11, 0.01, 0, brass);
  const bowl = equipment("bar-matcha-bowl", -0.98, 0);
  mesh(bowl, new THREE.CylinderGeometry(0.16, 0.09, 0.12, 32, 1, true), porcelain, 0, 0.065, 0);
  cylinder(bowl, 0.095, 0.016, 0, 0.015, 0, porcelain);
  const bowlLiquid = cylinder(bowl, 0.13, 0.006, 0, 0.04, 0, matchaGreen);
  const bowlFoam = cylinder(bowl, 0.128, 0.003, 0, 0.07, 0, material(0xa8bf72));
  const sieve = equipment("bar-matcha-sieve", -0.83, -0.25, 0.99);
  mesh(sieve, new THREE.TorusGeometry(0.068, 0.007, 6, 24), metal, 0, 0.03, 0).rotation.x = Math.PI / 2;
  cylinder(sieve, 0.064, 0.004, 0, 0.025, 0, material(0xaab2ac));
  box(sieve, 0.017, 0.012, 0.11, 0, 0.03, 0.115, metal);
  const scoop = equipment("bar-matcha-scoop", -1.08, 0.34, 1.13);
  box(scoop, 0.018, 0.009, 0.2, 0, 0, 0.06, bamboo);
  mesh(scoop, new THREE.SphereGeometry(0.024, 10, 6), bamboo, 0, 0.005, -0.055).scale.y = 0.25;
  const powder = cylinder(scoop, 0.017, 0.008, 0, 0.015, -0.055, matchaGreen);
  const whisk = equipment("bar-matcha-whisk", -1.07, -0.25);
  cylinder(whisk, 0.021, 0.13, 0, 0.225, 0, bamboo);
  cylinder(whisk, 0.028, 0.03, 0, 0.15, 0, dark);
  for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12;
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(Math.sin(angle) * 0.02, 0.15, Math.cos(angle) * 0.02), new THREE.Vector3(Math.sin(angle) * 0.055, 0.065, Math.cos(angle) * 0.055), new THREE.Vector3(Math.sin(angle) * 0.04, 0.012, Math.cos(angle) * 0.04)]);
    mesh(whisk, new THREE.TubeGeometry(curve, 8, 0.0025, 4, false), bamboo, 0, 0, 0);
  }
  const kettle = equipment("bar-temperature-kettle", -0.98, -0.42);
  mesh(kettle, new THREE.SphereGeometry(0.1, 20, 12), metal, 0, 0.1, 0).scale.y = 0.85;
  cylinder(kettle, 0.055, 0.025, 0, 0.19, 0, dark);
  const kettleSpout = mesh(kettle, new THREE.CylinderGeometry(0.012, 0.02, 0.15, 12), metal, 0, 0.14, 0.13); kettleSpout.rotation.x = 0.85;
  mesh(kettle, new THREE.TorusGeometry(0.065, 0.011, 8, 20), dark, 0, 0.11, -0.1);
  const teaTin = equipment("bar-tea-tin", 0.58, -1.12);
  cylinder(teaTin, 0.05, 0.15, 0, 0.075, 0, material(0x9d7541));
  cylinder(teaTin, 0.055, 0.015, 0, 0.155, 0, brass);
  const teaPot = equipment("bar-tea-pot", 0.82, -0.1);
  mesh(teaPot, new THREE.SphereGeometry(0.085, 20, 12), material(0x9d7541), 0, 0.09, 0);
  cylinder(teaPot, 0.045, 0.018, 0, 0.18, 0, dark);
  const teaSpout = cylinder(teaPot, 0.014, 0.1, 0, 0.09, -0.1, metal); teaSpout.rotation.x = -0.9;
  const matchaMilk = equipment("bar-matcha-milk-pitcher", -0.72, 0.48);
  mesh(matchaMilk, new THREE.CylinderGeometry(0.065, 0.045, 0.14, 20, 1, true), metal, 0, 0.07, 0);
  mesh(matchaMilk, new THREE.TorusGeometry(0.037, 0.009, 8, 16), metal, 0.068, 0.08, 0).rotation.y = Math.PI / 2;
  box(matchaMilk, 0.04, 0.018, 0.04, -0.06, 0.139, 0, metal).rotation.z = -0.2;
  const frother = equipment("bar-milk-frother", -0.72, 0.48);
  cylinder(frother, 0.085, 0.025, 0, 0.012, 0, dark);
  const frotherLight = box(frother, 0.035, 0.008, 0.015, 0, 0.027, 0.06, machineLight);
  const siftPowder = Array.from({ length: 16 }, () => mesh(root, new THREE.SphereGeometry(0.005, 4, 4), matchaGreen, 0, 0, 0));
  const terminal = box(root, 0.28, 0.05, 0.32, -0.55, 1.02, 0.99, dark);
  terminal.rotation.x = -0.45;
  box(terminal, 0.23, 0.005, 0.22, 0, 0.028, 0, material(0x7fccc2));
  const receipt = box(root, 0.09, 0.008, 0.2, -0.3, 0.985, 1.1, porcelain);
  receipt.name = "drink-order-receipt";
  const tray = cylinder(root, 0.2, 0.02, -0.1, 0.987, 1.12, dark);
  tray.name = "drink-pickup-tray";
  cylinder(root, 0.18, 0.035, 0.62, 0.988, 0.9, metal).name = "drink-return-tray";
  const serviceSteps = new THREE.Group(); serviceSteps.name = "drink-service-steps"; root.add(serviceSteps);
  for (let step = 0; step < 3; step++) {
    const depth = 0.75 - step * 0.25;
    const height = 0.2 * (step + 1);
    box(serviceSteps, 0.62, height, depth, 0, 0.1 + height / 2, 1.375 + depth / 2, dark);
    box(serviceSteps, 0.58, 0.008, 0.025, 0, 0.105 + height, 1.375 + depth - 0.025, brass);
  }
  for (const [index, seat] of DRINK_BAR_SEATS.entries()) {
    const stool = new THREE.Group();
    stool.name = `drink-bar-stool-${index + 1}`;
    stool.position.set(seat.x, 0, seat.z);
    stool.rotation.y = seat.yaw;
    root.add(stool);
    cylinder(stool, 0.24, 0.08, 0, 0.61, 0, dark);
    cylinder(stool, 0.04, 0.46, 0, 0.36, 0, brass);
    cylinder(stool, 0.2, 0.035, 0, 0.115, 0, dark);
    const footrest = mesh(stool, new THREE.TorusGeometry(0.15, 0.014, 8, 24), brass, 0, 0.3, 0);
    footrest.rotation.x = Math.PI / 2;
    box(stool, 0.42, 0.22, 0.07, 0, 0.77, -0.19, dark).rotation.x = 0.12;
  }
  cylinder(root, 0.7, 0.42, 0, 0.34, 0, wood);
  const bartender = createMascot("claude", false);
  bartender.root.name = "drink-bar-bartender"; root.add(bartender.root);
  const armLength = 0.44;
  const armDown = new THREE.Vector3(0, -1, 0);
  const sleeveMaterial = material(0xb85f42);
  const bartenderHands = bartender.arms.map((upper, index) => {
    upper.name = `drink-bartender-shoulder-${index}`;
    (upper.children[0] as THREE.Mesh).visible = false;
    const upperMesh = box(upper, 0.16, armLength, 0.2, 0, -armLength / 2, 0, sleeveMaterial);
    const forearm = new THREE.Group();
    forearm.name = `drink-bartender-elbow-${index}`;
    bartender.body.add(forearm);
    box(forearm, 0.13, armLength, 0.15, 0, -armLength / 2, 0, sleeveMaterial);
    const wrist = new THREE.Group();
    wrist.name = `drink-bartender-wrist-${index}`;
    bartender.body.add(wrist);
    box(wrist, 0.15, 0.1, 0.17, 0, 0, 0, sleeveMaterial);
    return { upper, upperMesh, forearm, wrist, target: new THREE.Vector3(), weight: 0 };
  });
  const poseBartenderHand = (index: number) => {
    const hand = bartenderHands[index];
    const shoulder = hand.upper.position;
    const target = new THREE.Vector3(shoulder.x * 0.88, 0.48, 0.3);
    if (hand.weight > 0) {
      const grip = root.localToWorld(hand.target.clone());
      bartender.body.worldToLocal(grip);
      target.lerp(grip, hand.weight);
    }
    const direction = target.clone().sub(shoulder);
    const distance = THREE.MathUtils.clamp(direction.length(), 0.04, armLength * 2 - 0.001);
    direction.normalize();
    target.copy(shoulder).addScaledVector(direction, distance);
    const bend = new THREE.Vector3(index ? 0.1 : -0.1, -1, 0);
    bend.addScaledVector(direction, -bend.dot(direction)).normalize();
    const elbow = shoulder.clone().addScaledVector(direction, distance / 2).addScaledVector(bend, Math.sqrt(armLength ** 2 - distance ** 2 / 4));
    hand.upper.quaternion.setFromUnitVectors(armDown, elbow.clone().sub(shoulder).normalize());
    hand.forearm.position.copy(elbow);
    hand.forearm.quaternion.setFromUnitVectors(armDown, target.clone().sub(elbow).normalize());
    hand.wrist.position.copy(target);
    hand.wrist.quaternion.copy(hand.forearm.quaternion);
  };
  const apron = box(bartender.body, 0.5, 0.32, 0.025, 0, 0.38, 0.25, dark); apron.rotation.x = 0.04;
  box(bartender.body, 0.19, 0.07, 0.03, 0, 0.41, 0.27, brass);
  const guests = [createMascot("codex", true), createMascot("antigravity", true)];
  guests.forEach((guest, index) => { guest.root.name = `drink-bar-guest-${index + 1}`; root.add(guest.root); });
  const cup = new THREE.Group(); cup.name = "drink-service-cup"; root.add(cup);
  const cupShell = mesh(cup, new THREE.CylinderGeometry(0.065, 0.052, 0.13, 24, 1, true), porcelain, 0, 0.065, 0);
  const coldGlass = mesh(cup, new THREE.CylinderGeometry(0.07, 0.055, 0.22, 24, 1, true), glass, 0, 0.11, 0);
  cylinder(cup, 0.052, 0.008, 0, 0.004, 0, porcelain);
  const rim = mesh(cup, new THREE.TorusGeometry(0.064, 0.006, 8, 24), brass, 0, 0.132, 0); rim.rotation.x = Math.PI / 2;
  const handle = mesh(cup, new THREE.TorusGeometry(0.035, 0.009, 8, 18), porcelain, 0.069, 0.065, 0); handle.rotation.y = Math.PI / 2;
  const sleeve = cylinder(cup, 0.066, 0.05, 0, 0.058, 0, wood);
  const lid = cylinder(cup, 0.071, 0.018, 0, 0.145, 0, porcelain); lid.visible = false;
  box(lid, 0.025, 0.008, 0.009, 0, 0.011, 0.045, dark);
  const liquid = cylinder(cup, 0.057, 0.008, 0, 0.12, 0, material(0x6b4124));
  const coldVolume = cylinder(cup, 0.055, 0.16, 0, 0.09, 0, material(0xf4a62a));
  const foam = cylinder(cup, 0.057, 0.007, 0, 0.125, 0, material(0xffefd9));
  const latteArt = new THREE.Group(); cup.add(latteArt);
  for (let i = 0; i < 3; i++) {
    const leaf = mesh(latteArt, new THREE.TorusGeometry(0.012 + i * 0.007, 0.0025, 4, 18, Math.PI * 1.55), porcelain, 0, 0, (i - 1) * 0.012);
    leaf.rotation.x = -Math.PI / 2;
    leaf.scale.z = 0.6;
  }
  const cupIce = Array.from({ length: 4 }, (_, index) => box(cup, 0.035, 0.035, 0.035, Math.sin(index * 2.4) * 0.03, 0.17, Math.cos(index * 2.4) * 0.03, glass));
  const straw = cylinder(cup, 0.004, 0.3, 0.035, 0.2, -0.015, bamboo); straw.rotation.z = -0.12;
  const lemonGarnish = cylinder(cup, 0.034, 0.01, -0.05, 0.2, 0, lemonSkin); lemonGarnish.rotation.z = Math.PI / 2;
  const matchaBaseColor = new THREE.Color(0x4d7b2e);
  const matchaMilkColor = new THREE.Color(0x91b755);
  const stream = cylinder(root, 0.01, 0.07, 0, 1.185, -0.8, material(0x764927));
  stream.name = "drink-pour-stream";
  const shaker = new THREE.Group(); shaker.name = "drink-shaker"; root.add(shaker);
  cylinder(shaker, 0.065, 0.2, 0, 0.1, 0, metal); cylinder(shaker, 0.044, 0.05, 0, 0.225, 0, brass);
  const steam = Array.from({ length: 5 }, () => mesh(root, new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false }), 0, 0, 0));
  let statusTexture: THREE.CanvasTexture | null = null;
  let statusCanvas: HTMLCanvasElement | null = null;
  let lastStatus = "";
  if (typeof document !== "undefined") {
    statusCanvas = document.createElement("canvas"); statusCanvas.width = 512; statusCanvas.height = 128;
    statusTexture = new THREE.CanvasTexture(statusCanvas); statusTexture.colorSpace = THREE.SRGBColorSpace;
    const sign = mesh(root, new THREE.PlaneGeometry(0.95, 0.24), new THREE.MeshBasicMaterial({ map: statusTexture, side: THREE.DoubleSide }), 0, 1.65, -1.05);
    sign.rotation.x = -0.35;
    box(root, 0.025, 0.23, 0.025, -0.4, 1.49, -1.05, brass); box(root, 0.025, 0.23, 0.025, 0.4, 1.49, -1.05, brass);
  }
  const cupPoint = new THREE.Vector3();
  const storagePoint = new THREE.Vector3(0.3, 0.99, 0.9);
  const brewPoint = new THREE.Vector3(0, 1.02, -0.8);
  const pickupPoint = new THREE.Vector3(0, 0.999, 1.0);
  const guestPickupPoint = new THREE.Vector3(-0.21, 0.999, 1.24);
  const returnPoint = new THREE.Vector3(0.62, 1.01, 0.9);
  const guestRestHand = (guest: Mascot, index: number) => {
    const arm = guest.arms[index];
    const length = ((arm.children[0] as THREE.Mesh).geometry as THREE.BoxGeometry).parameters.height;
    return new THREE.Vector3(arm.position.x, arm.position.y - length, 0);
  };
  const clearPose = (actor: Mascot) => { resetMascotHands(actor); actor.body.rotation.set(0, 0, 0); for (const limb of [...actor.arms, ...actor.legs]) limb.rotation.set(0, 0, 0); };
  const tick = (t: number, _dt: number) => {
    if (reducedMotion() || !Number.isFinite(t)) t = 0;
    const sample = sampleDrinkBar(t);
    const recipe = DRINK_BAR_MENU.find(recipe => recipe.id === sample.recipe)!;
    const isMatcha = recipe.family === "matcha";
    const isCold = recipe.family === "cold";
    const milkCoffee = sample.recipe === "latte" || sample.recipe === "cappuccino";
    const workYaw = isMatcha ? -Math.PI / 2 : isCold ? Math.PI / 2 : -Math.PI;
    if (isMatcha) brewPoint.set(-0.94, 1.02, 0.3);
    else if (isCold) brewPoint.set(0.94, 1.02, -0.22);
    else brewPoint.set(0, 1.02, -0.8);
    const progress = sample.progress;
    const position = drinkGuestPosition(sample);
    for (const [index, guest] of guests.entries()) {
      clearPose(guest);
      const active = index === sample.guest;
      const seatAmount = !active ? 1 : position.seatAmount;
      const seat = DRINK_BAR_SEATS[index];
      const stepHeight = active ? 0.2 * (phase(2.25 - position.z, 0, 0.125) + phase(2.0 - position.z, 0, 0.125) + phase(1.75 - position.z, 0, 0.125)) * (1 - phase(Math.abs(position.x), 0.1, 0.35)) : 0;
      const hip = Math.min(...guest.legs.map(leg => leg.position.y)) * guest.root.scale.y;
      guest.root.position.set(active ? position.x : seat.x, 0.1 + seatAmount * (0.65 - hip - 0.1) + stepHeight, active ? position.z : seat.z);
      guest.root.rotation.y = active ? position.yaw : seat.yaw;
      poseMascotSeated(guest, seatAmount);
      if (active && position.walking) {
        const stride = Math.sin(Math.PI * Math.max(0, Math.min(1, (sample.progress - 0.18) / (sample.stage === "carry" || sample.stage === "leave" ? 0.64 : 0.82))));
        guest.legs.forEach((leg, i) => { leg.rotation.x = Math.sin(t * 7 + i * Math.PI) * 0.35 * stride; });
        guest.arms.forEach((arm, i) => { arm.rotation.x = Math.sin(t * 7 + i * Math.PI) * 0.25 * stride; });
        guest.root.position.y += Math.abs(Math.sin(t * 7)) * 0.025 * stride;
      }
    }
    clearPose(bartender);
    const toWork = sample.stage === "prepare" ? phase(progress, 0.2, 0.65) : sample.stage === "brew" ? 1 : sample.stage === "serve" ? 1 - phase(progress, 0.18, 0.65) : 0;
    const yaw = workYaw * toWork;
    bartender.root.position.set(Math.sin(yaw) * 0.3, 0.55, Math.cos(yaw) * 0.3);
    bartender.root.rotation.y = yaw;
    bartenderHands.forEach(hand => { hand.weight = 0; });
    const setHand = (index: number, point: THREE.Vector3, weight = 1) => {
      bartenderHands[index].target.copy(point);
      bartenderHands[index].weight = weight;
    };
    const objectGrip = (object: THREE.Object3D, x: number, y: number, z: number) => root.worldToLocal(object.localToWorld(new THREE.Vector3(x, y, z)));
    const holdCup = (weight = 1) => setHand(1, objectGrip(cup, 0.069, 0.065, 0), weight);
    const carryPoint = root.worldToLocal(bartender.body.localToWorld(new THREE.Vector3(0.3, 0.55, 0.46)));
    const workCarryPoint = new THREE.Vector3(Math.cos(workYaw) * 0.3 + Math.sin(workYaw) * 0.76, 1.1, -Math.sin(workYaw) * 0.3 + Math.cos(workYaw) * 0.76);
    const frontCarryPoint = new THREE.Vector3(0.3, 1.1, 0.76);
    cup.rotation.set(0, 0, 0);
    cup.position.copy(storagePoint);
    if (sample.stage === "prepare") {
      if (progress < 0.2) cup.position.lerpVectors(storagePoint, frontCarryPoint, phase(progress, 0.08, 0.2));
      else if (progress < 0.65) cup.position.copy(carryPoint);
      else cup.position.lerpVectors(workCarryPoint, brewPoint, phase(progress, 0.65, 0.85));
      holdCup(pulse(progress, 0, 0.08, 0.85, 1));
    }
    if (sample.stage === "brew") cup.position.copy(brewPoint);
    if (sample.stage === "serve") {
      if (progress < 0.18) cup.position.lerpVectors(brewPoint, workCarryPoint, phase(progress, 0.08, 0.18));
      else if (progress < 0.65) cup.position.copy(carryPoint);
      else if (progress < 0.86) cup.position.lerpVectors(frontCarryPoint, pickupPoint, phase(progress, 0.65, 0.86));
      else cup.position.lerpVectors(pickupPoint, guestPickupPoint, phase(progress, 0.86, 1));
      holdCup(pulse(progress, 0, 0.08, 0.86, 1));
      if (progress > 0.94) {
        const guest = guests[sample.guest];
        const reach = phase(progress, 0.94, 1);
        const rest = root.worldToLocal(guest.body.localToWorld(guestRestHand(guest, 1)));
        rest.lerp(cup.position.clone().add(new THREE.Vector3(0.069, 0.065, 0)), reach);
        reachMascotHand(guest, 1, root, rest.x, rest.y, rest.z);
      }
    }
    if (["carry", "drink", "return", "drop"].includes(sample.stage)) {
      const guest = guests[sample.guest];
      const sip = sample.stage === "drink" && sample.progress > 0.18 && sample.progress < 0.82 ? Math.pow(Math.sin((sample.progress - 0.18) / 0.64 * Math.PI * 3), 2) : 0;
      cupPoint.set(0.16, guest.arms[1].position.y + 0.1 + sip * 0.12, 0.16 - sip * 0.08);
      guest.body.localToWorld(cupPoint); root.worldToLocal(cupPoint);
      const gripOffset = new THREE.Vector3(0.069, 0.065, 0).applyAxisAngle(new THREE.Vector3(0, 0, 1), sip * 0.3);
      cupPoint.sub(gripOffset);
      cup.position.copy(cupPoint); cup.rotation.z = sip * 0.3;
      if (sample.stage === "carry") cup.position.lerpVectors(guestPickupPoint, cupPoint, smooth(sample.progress / 0.18));
      if (sample.stage === "drop") cup.position.lerpVectors(cupPoint, guestPickupPoint, smooth(sample.progress / 0.6));
      const grip = cup.position.clone().add(gripOffset);
      if (sample.stage === "drop") {
        const rest = root.worldToLocal(guest.body.localToWorld(guestRestHand(guest, 1)));
        grip.lerp(rest, phase(progress, 0.6, 1));
      }
      const hand = reachMascotHand(guest, 1, root, grip.x, grip.y, grip.z);
      if (sample.cupOwner === "guest") cup.position.copy(hand).sub(gripOffset);
    }
    if (sample.stage === "leave") {
      if (progress < 0.12) cup.position.lerpVectors(guestPickupPoint, pickupPoint, phase(progress, 0, 0.12));
      else if (progress < 0.3) cup.position.lerpVectors(pickupPoint, frontCarryPoint, phase(progress, 0.12, 0.3));
      else if (progress < 0.5) cup.position.lerpVectors(frontCarryPoint, returnPoint, phase(progress, 0.3, 0.5));
      else cup.position.lerpVectors(returnPoint, storagePoint, phase(progress, 0.5, 0.7));
      if (progress < 0.12) setHand(1, pickupPoint.clone().add(new THREE.Vector3(0.069, 0.065, 0)));
      else holdCup(1 - phase(progress, 0.7, 0.9));
    }
    if (sample.stage === "order") {
      const guest = guests[sample.guest];
      const wave = Math.sin(progress * Math.PI) ** 2;
      const rest = guestRestHand(guest, 0);
      reachMascotHand(guest, 0, guest.body, rest.x, rest.y + wave * 0.12, wave * 0.12);
      setHand(0, new THREE.Vector3(-0.48, 1.1 + Math.sin(progress * Math.PI * 4) * 0.035, 0.7), wave);
    }
    if (sample.stage === "drop") {
      setHand(1, pickupPoint.clone().add(new THREE.Vector3(0.069, 0.065, 0)), phase(progress, 0.6, 0.85));
    }
    liquid.visible = sample.fill > 0.01;
    cupShell.visible = !isCold;
    coldGlass.visible = isCold;
    handle.visible = !isCold;
    rim.visible = !isCold;
    sleeve.visible = false;
    lid.visible = false;
    liquid.position.y = 0.025 + sample.fill * (isCold ? 0.165 : 0.095);
    (liquid.material as THREE.MeshStandardMaterial).color.setHex(recipe.color);
    coldVolume.visible = isCold && sample.fill > 0.01;
    coldVolume.scale.y = sample.fill;
    coldVolume.position.y = 0.01 + sample.fill * 0.08;
    (coldVolume.material as THREE.MeshStandardMaterial).color.setHex(recipe.color);
    const milkAdded = sample.stage === "brew" ? isMatcha ? phase(sample.brewElapsed, 30.5, 32.7) : milkCoffee ? phase(progress, 0.7, 0.9) : 0 : sample.fill > 0 ? 1 : 0;
    if (isMatcha) (liquid.material as THREE.MeshStandardMaterial).color.lerpColors(matchaBaseColor, matchaMilkColor, milkAdded);
    foam.visible = (isMatcha || milkCoffee) && milkAdded > 0.01 && sample.fill > 0.1;
    foam.position.y = liquid.position.y + 0.005;
    foam.scale.y = sample.recipe === "cappuccino" ? 2.5 : 1;
    (foam.material as THREE.MeshStandardMaterial).color.setHex(isMatcha ? 0xb9cf8b : 0xffefd9);
    latteArt.visible = foam.visible && milkAdded > 0.8 && sample.recipe !== "cappuccino";
    latteArt.position.y = foam.position.y + 0.007;
    cupIce.forEach(ice => { ice.visible = isCold && sample.fill > 0.8; });
    straw.visible = isCold && sample.fill > 0.95;
    lemonGarnish.visible = sample.recipe === "lemon-tea" && sample.fill > 0.95;
    stream.visible = false;
    stream.position.set(0, 1.185, -0.8);
    stream.rotation.set(0, 0, 0);
    stream.scale.set(1, 1, 1);
    let streamColor: number = recipe.color;
    const pourStream = (spout: THREE.Vector3, end = brewPoint.clone().add(new THREE.Vector3(0, 0.13, 0))) => {
      stream.position.copy(spout).add(end).multiplyScalar(0.5);
      stream.scale.y = spout.distanceTo(end) / 0.07;
      stream.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.sub(spout).normalize());
    };
    shaker.position.set(0.75, 0.98, -0.42);
    shaker.rotation.set(0, 0, 0);
    pitcher.position.set(0.39, 0.985, -0.78);
    pitcher.rotation.set(0, 0, 0);
    bowl.position.set(-0.98, 0.975, 0);
    bowl.rotation.set(0, 0, 0);
    bowlLiquid.visible = false;
    bowlFoam.visible = false;
    sieve.position.set(-0.83, 0.99, -0.25);
    sieve.rotation.set(0, Math.PI, 0);
    scoop.position.set(-1.08, 1.13, 0.34);
    scoop.rotation.set(0, 0, 0);
    powder.visible = false;
    whisk.position.set(-1.07, 0.975, -0.25);
    whisk.rotation.set(0, 0, 0);
    kettle.position.set(-0.98, 0.975, -0.42);
    kettle.rotation.set(0, 0, 0);
    matchaMilk.position.set(-0.72, 1.0, 0.48);
    matchaMilk.rotation.set(0, 0, 0);
    frotherLight.visible = isMatcha && sample.stage === "brew" && sample.brewElapsed > 6.5 && sample.brewElapsed < 29;
    teaPot.position.set(0.82, 0.975, -0.1);
    teaPot.rotation.set(0, 0, 0);
    citrusPress.position.y = 0.12;
    citrusPress.rotation.set(0, 0, 0);
    siftPowder.forEach(particle => { particle.visible = false; });
    if (sample.stage === "brew" && recipe.family === "coffee") {
      const button = pulse(progress, 0.02, 0.1, 0.36, 0.48);
      const grip = milkCoffee ? pulse(progress, 0.5, 0.6, 0.96, 1) : 0;
      const lift = milkCoffee ? pulse(progress, 0.6, 0.7, 0.86, 0.96) : 0;
      const pouring = milkCoffee ? pulse(progress, 0.7, 0.78, 0.84, 0.9) : 0;
      pitcher.position.set(0.39 - pouring * 0.28, 0.985 + lift * 0.22, -0.78);
      pitcher.rotation.z = pouring * 0.7;
      setHand(0, new THREE.Vector3(0.2, 1.33, -0.81), button);
      if (grip > 0) setHand(0, objectGrip(pitcher, 0.068, 0.08, 0), grip);
      stream.visible = progress > 0.12 && progress < 0.56;
      if (pouring > 0.7) {
        stream.visible = true;
        streamColor = 0xfff5dc;
        pourStream(objectGrip(pitcher, -0.06, 0.139, 0));
      }
      if (sample.recipe === "americano" && progress > 0.6 && progress < 0.9) { stream.visible = true; streamColor = 0xcadadd; }
    }
    if (sample.stage === "brew" && isCold) {
      const elapsed = sample.brewElapsed;
      if (sample.recipe === "orange") {
        const press = pulse(elapsed, 0.5, 1, 4, 4.5);
        citrusPress.position.y -= (0.5 + Math.sin(elapsed * 5) * 0.5) * 0.025 * press;
        citrusPress.rotation.y = Math.sin(elapsed * 5) * 0.7 * press;
        setHand(0, objectGrip(citrusPress, 0, 0.035, 0), pulse(elapsed, 0, 0.5, 4.5, 5));
      } else {
        const liftTea = pulse(elapsed, 0.5, 1, 4, 4.5);
        const pourTea = pulse(elapsed, 1, 1.5, 3.5, 4);
        teaPot.position.lerp(new THREE.Vector3(0.76, 1.3, -0.2), liftTea);
        teaPot.rotation.x = -pourTea * 0.6;
        setHand(1, objectGrip(teaPot, 0, 0.1, 0.05), pulse(elapsed, 0, 0.5, 4.5, 5));
        if (pourTea > 0.8) { stream.visible = true; pourStream(objectGrip(teaPot, 0, 0.15, -0.15), new THREE.Vector3(0.75, 1.23, -0.42)); }
      }
      const lift = pulse(elapsed, 5.5, 6.2, 10.9, 11.6);
      const shake = pulse(elapsed, 6.5, 7, 8.4, 9);
      const pouring = pulse(elapsed, 9, 9.7, 10.5, 11);
      const beat = elapsed * 14;
      const target = new THREE.Vector3(0.85 + Math.sin(beat) * 0.04 * shake + pouring * 0.09, 1.15 + Math.cos(beat) * 0.03 * shake + pouring * 0.06, 0.08 - pouring * 0.1);
      shaker.position.lerp(target, lift);
      shaker.rotation.x = (Math.sin(beat) * 0.16 * shake - pouring * 0.9) * lift;
      if (elapsed >= 5) setHand(1, objectGrip(shaker, 0, 0.1, -0.055), pulse(elapsed, 5, 5.5, 11.6, 12));
      if (elapsed >= 5) setHand(0, objectGrip(shaker, 0, 0.18, 0.055), pulse(elapsed, 6.2, 6.6, 8.6, 9.2));
      if (pouring > 0.8) { stream.visible = true; pourStream(objectGrip(shaker, 0, 0.25, 0)); }
    }
    if (sample.stage === "brew" && isMatcha) {
      const elapsed = sample.brewElapsed;
      const siftLift = pulse(elapsed, 0.65, 1, 3, 3.35);
      sieve.position.lerp(new THREE.Vector3(-0.98, 1.16, 0), siftLift);
      sieve.position.x += Math.sin(elapsed * 22) * 0.008 * pulse(elapsed, 1.6, 2, 2.8, 3);
      const scoopLift = pulse(elapsed, 0.55, 1.4, 3, 3.5);
      scoop.position.lerp(new THREE.Vector3(-0.98, 1.23, 0.05), scoopLift);
      scoop.rotation.x = pulse(elapsed, 1.5, 2, 2.7, 3) * 0.45;
      powder.visible = elapsed < 2;
      setHand(0, objectGrip(sieve, 0, 0.03, 0.13), pulse(elapsed, 0, 0.65, 3.35, 4));
      setHand(1, objectGrip(scoop, 0, 0, 0.13), pulse(elapsed, 0, 0.55, 3.5, 4));
      siftPowder.forEach((particle, index) => {
        particle.visible = elapsed > 1.8 && elapsed < 3.1;
        const fall = (elapsed * 3 + index / siftPowder.length) % 1;
        particle.position.set(-0.98 + Math.sin(index * 2.4) * 0.045, 1.18 - fall * 0.16, Math.cos(index * 2.4) * 0.045);
      });
      bowlLiquid.visible = elapsed > 2 && elapsed < 28;
      bowlLiquid.position.y = 0.025 + phase(elapsed, 4.8, 6.2) * 0.04;
      bowlLiquid.scale.setScalar(1 - phase(elapsed, 26, 28));
      bowlFoam.visible = elapsed > 8 && elapsed < 28;
      bowlFoam.position.y = bowlLiquid.position.y + 0.004;
      bowlFoam.scale.setScalar(phase(elapsed, 8, 20) * (1 - phase(elapsed, 26, 28)));
      if (elapsed >= 4 && elapsed < 7) {
        const liftWater = pulse(elapsed, 4.4, 4.8, 6.2, 6.6);
        const pourWater = pulse(elapsed, 4.8, 5.1, 5.9, 6.2);
        kettle.position.lerp(new THREE.Vector3(-0.98, 1.17, -0.28), liftWater);
        kettle.rotation.x = pourWater * 0.55;
        setHand(0, objectGrip(kettle, 0, 0.11, -0.1), pulse(elapsed, 4, 4.4, 6.6, 7));
        if (pourWater > 0.8) { stream.visible = true; streamColor = 0xd6e5df; pourStream(objectGrip(kettle, 0, 0.19, 0.18), new THREE.Vector3(-0.98, 1.04, 0)); }
        setHand(1, new THREE.Vector3(-0.72, 1.03, 0.48), pulse(elapsed, 6.2, 6.4, 6.7, 7));
      }
      if (elapsed >= 7 && elapsed < 24) {
        const whiskLift = pulse(elapsed, 7.35, 8, 23, 23.65);
        const stroke = (elapsed - 8) * 3.5;
        const sweep = 1 - Math.abs(((stroke % 1 + 1) % 1) * 2 - 1);
        const vertices = [-0.018, 0.018, -0.006, 0.018, -0.018];
        const segment = Math.min(3, Math.floor(sweep * 4));
        const z = THREE.MathUtils.lerp(vertices[segment], vertices[segment + 1], sweep * 4 - segment);
        const motion = pulse(elapsed, 7.9, 8, 23, 23.1);
        whisk.position.lerp(new THREE.Vector3(-0.94 + (sweep - 0.5) * 0.07 * motion, 1.005, z * motion), whiskLift);
        setHand(0, objectGrip(whisk, 0, 0.23, 0), pulse(elapsed, 7, 7.35, 23.65, 24));
        setHand(1, new THREE.Vector3(-0.94, 1.04, 0.1), pulse(elapsed, 7.7, 8, 23, 23.3));
      }
      if (elapsed >= 24 && elapsed < 29) {
        const liftBowl = pulse(elapsed, 24.5, 25.3, 27.5, 28.5);
        const pourBowl = pulse(elapsed, 25.3, 26, 27.4, 28);
        bowl.position.lerp(new THREE.Vector3(-0.82, 1.16, 0.12), liftBowl);
        bowl.rotation.set(pourBowl * 0.3, 0, pourBowl * 0.6);
        setHand(0, objectGrip(bowl, 0, 0.065, -0.1), pulse(elapsed, 24, 24.5, 28.5, 29));
        if (pourBowl > 0.8) { stream.visible = true; streamColor = 0x63923e; pourStream(objectGrip(bowl, -0.12, 0.1, 0.08)); }
      }
      if (elapsed >= 29 && elapsed < 34) {
        const liftMilk = pulse(elapsed, 29.5, 30.3, 32.7, 33.5);
        const pourMilk = pulse(elapsed, 30.3, 30.9, 32.1, 32.7);
        matchaMilk.position.lerp(new THREE.Vector3(-0.78, 1.16, 0.3), liftMilk);
        matchaMilk.rotation.z = pourMilk * 0.65;
        setHand(1, objectGrip(matchaMilk, 0.068, 0.08, 0), pulse(elapsed, 29, 29.5, 33.5, 34));
        if (pourMilk > 0.7) { stream.visible = true; streamColor = 0xfff5dc; pourStream(objectGrip(matchaMilk, -0.06, 0.139, 0)); }
      }
    }
    machineLight.emissiveIntensity = sample.stage === "brew" && recipe.family === "coffee" && stream.visible ? 0.7 + Math.sin(t * 9) * 0.2 : 0.15;
    bartenderHands.forEach((_, index) => poseBartenderHand(index));
    root.userData.bartenderHands = bartenderHands.map(hand => ({ weight: hand.weight, target: hand.target.toArray() }));
    (stream.material as THREE.MeshStandardMaterial).color.setHex(streamColor);
    for (const [index, puff] of steam.entries()) {
      const phase = (t * 0.55 + index / steam.length) % 1;
      const warmingMilk = isMatcha && sample.stage === "brew" && sample.brewElapsed > 8 && sample.brewElapsed < 29;
      puff.visible = warmingMilk || !isCold && sample.fill > 0.15;
      puff.position.set((warmingMilk ? matchaMilk.position.x : cup.position.x) + Math.sin(t + index) * 0.02, (warmingMilk ? matchaMilk.position.y + 0.14 : cup.position.y + 0.15) + phase * 0.23, warmingMilk ? matchaMilk.position.z : cup.position.z);
      puff.scale.setScalar(0.5 + phase * 1.8);
      (puff.material as THREE.MeshBasicMaterial).opacity = (1 - phase) * 0.23;
    }
    receipt.visible = ["order", "prepare", "brew", "serve"].includes(sample.stage);
    root.userData.drinkBar = sample;
    const labels: Record<DrinkBarStage, string> = { approach: "MỜI GỌI MÓN", order: "NHẬN ORDER", prepare: "CHUẨN BỊ", brew: "ĐANG PHA", serve: "MỜI NHẬN ĐỒ", carry: "CHÚC NGON MIỆNG", drink: "THƯỞNG THỨC", return: "TRẢ LY", drop: "CẢM ƠN", leave: "DỌN LY" };
    const recipeLabels: Record<string, string> = { sift: "RÂY MATCHA 3G", water: isMatcha ? "THÊM NƯỚC 80°C" : "THÊM NƯỚC", "whisk-setup": "LẤY CHỔI TRE", whisk: "ĐÁNH MATCHA", "whisk-rest": "ĐẶT CHỔI", transfer: "RÓT MATCHA", milk: "RÓT SỮA", finish: "HOÀN THIỆN", juice: "VẮT CAM", steep: "Ủ TRÀ", shake: "LẮC ĐỀU", pour: "RÓT RA LY", extract: "CHIẾT XUẤT" };
    const status = `${sample.stage === "brew" ? recipeLabels[sample.recipeStep] ?? labels.brew : labels[sample.stage]} · ${recipe.label.toLocaleUpperCase("vi")}`;
    if (statusCanvas && statusTexture && status !== lastStatus) {
      const context = statusCanvas.getContext("2d")!;
      context.fillStyle = "#173737"; context.fillRect(0, 0, 512, 128);
      context.fillStyle = "#e6c68e"; context.font = "600 28px Arial"; context.textAlign = "center"; context.fillText("AGENT CAFE", 256, 45);
      context.fillStyle = "#f8f1e5"; context.font = "22px Arial"; context.fillText(status, 256, 92);
      statusTexture.needsUpdate = true; lastStatus = status;
    }
  };
  root.traverse(object => { object.userData.keep = true; });
  tick(0, 0);
  const dispose = () => {
    root.removeFromParent();
    for (const geometry of geometries) geometry.dispose();
    for (const mat of materials) mat.dispose();
    statusTexture?.dispose();
  };
  return { root, tick, dispose };
}
