import { L } from "../../shared/i18n.ts";
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { ROLES } from "../../shared/roles.ts";
import {
  CEO_DESK, GENERAL_DESKS, MACHINE_ROOMS, OFFICE_DESK_Z, RACK_FRONT, RACK_WIDTH, ROUND_CHAIR_ANGLES, SERVER_RIGHT_MARGIN, SERVER_ROWS_Z, STORAGE_SCREEN_DX, TRAINING_CHAIR_DZ, TRAINING_DESK_DX, TRAINING_ROWS_Z, serverGapX, serverRackSlots, ROUND_CHAIR_R, ROUND_TABLE_X, ROUND_TABLE_Z, SX, TECH_DESK_Z, ZONES, ZONE_BY_ID, deskX, meetingLayout, serverNook,
  type Zone, type ZoneId,
} from "./layout.ts";
import {
  MAT, SCREEN_TILT, armchair, bookshelf, box, coffeeTable, conferenceTable, counter, crate, credenza, cyl, deskLamp, ergonomicChair, executiveDesk, floorLamp, gate, group,
  massageChair, officeChair, plant, poolTable, rug, seatedPerson, serverRack, sofa, wallScreen, workstation,
} from "./props.ts";
import { CanvasPanel, canvasPlate, htmlLabel } from "./labels.ts";
import { CeoAnimator } from "./ceo.ts";
import { CoffeeStation } from "./coffee.ts";
import { DOOR_W } from "./layout.ts";
import { createDrinkBar } from "./drink-bar.ts";
import { createDrinkFridge } from "./drink-fridge.ts";
import { createLoungeGames } from "./lounge-games.ts";
import { registerAmbientRotor } from "./ambient.ts";

const WALL_H = 1.5;
const GLASS_H = 1.3;

type FloorFinish = "wood" | "carpet" | "stone" | "service";

const floorTextures = new Map<FloorFinish, THREE.CanvasTexture>();
const floorMaterials = new Map<string, THREE.MeshStandardMaterial>();
const wallStone = new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 0.78 });
const wallTrim = new THREE.MeshStandardMaterial({ color: 0x8b8170, roughness: 0.42, metalness: 0.35 });
const glassMark = new THREE.MeshStandardMaterial({ color: 0xa9b8b9, roughness: 0.4 });

function floorTexture(finish: FloorFinish): THREE.CanvasTexture {
  const cached = floorTextures.get(finish);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const grain = (x: number, y: number) => (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
  ctx.fillStyle = "#e8e6e2";
  ctx.fillRect(0, 0, 256, 256);
  if (finish === "wood") {
    for (let row = 0; row < 4; row++) {
      const shade = 210 + row * 8;
      ctx.fillStyle = `rgb(${shade},${shade - 3},${shade - 7})`;
      ctx.fillRect(0, row * 64, 256, 64);
      for (let line = 0; line < 35; line++) {
        const y = row * 64 + line * 1.8;
        ctx.strokeStyle = `rgba(62,39,20,${0.025 + Math.abs(grain(row, line)) * 0.09})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(0, y);
        for (let x = 0; x <= 256; x += 8) ctx.lineTo(x, y + Math.sin(x / 42 + line) * 1.2);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(40,29,20,0.25)";
      ctx.fillRect(0, row * 64, 256, 1.2);
      ctx.fillRect((row % 2) * 128 + 35, row * 64, 1, 64);
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(0, row * 64 + 1.3, 256, 0.8);
    }
  } else {
    const tile = finish === "carpet" ? 64 : 128;
    for (let y = 0; y < 256; y += tile) {
      for (let x = 0; x < 256; x += tile) {
        const alternating = (x / tile + y / tile) % 2;
        const shade = finish === "carpet" ? 224 + alternating * 7 : 231 + alternating * 5;
        ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
        ctx.fillRect(x, y, tile, tile);
        if (finish === "carpet") {
          ctx.strokeStyle = "rgba(65,65,65,0.075)";
          ctx.lineWidth = 1;
          for (let i = 0; i < tile; i += 3) {
            ctx.beginPath();
            ctx.moveTo(x + (alternating ? i : 0), y + (alternating ? 0 : i));
            ctx.lineTo(x + (alternating ? i : tile), y + (alternating ? tile : i));
            ctx.stroke();
          }
        } else {
          ctx.strokeStyle = finish === "service" ? "rgba(30,40,50,0.3)" : "rgba(90,86,80,0.16)";
          ctx.lineWidth = finish === "service" ? 1.4 : 0.9;
          ctx.strokeRect(x + 0.7, y + 0.7, tile - 1.4, tile - 1.4);
          if (finish === "service") {
            ctx.fillStyle = "rgba(20,30,40,0.4)";
            for (const dx of [5, tile - 5]) for (const dy of [5, tile - 5]) ctx.fillRect(x + dx, y + dy, 1.5, 1.5);
          }
        }
      }
    }
    for (let i = 0; i < 3400; i++) {
      const x = Math.abs(grain(i, 7)) * 256;
      const y = Math.abs(grain(i, 19)) * 256;
      ctx.fillStyle = i % 2 ? "rgba(255,255,255,0.14)" : "rgba(60,57,52,0.05)";
      ctx.fillRect(x, y, 1, 1);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  floorTextures.set(finish, texture);
  return texture;
}

function finishedFloor(root: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, color: number, finish: FloorFinish): THREE.Mesh {
  const key = `${finish}:${color}`;
  let material = floorMaterials.get(key);
  if (!material) {
    material = new THREE.MeshStandardMaterial({ color, map: floorTexture(finish), roughness: finish === "carpet" ? 0.96 : finish === "wood" ? 0.62 : 0.48, metalness: finish === "service" ? 0.1 : 0 });
    floorMaterials.set(key, material);
  }
  const floor = box(root, w, h, d, x, y, z, material);
  floor.geometry = floor.geometry.clone();
  const positions = floor.geometry.getAttribute("position");
  const uv = floor.geometry.getAttribute("uv");
  for (let i = 0; i < positions.count; i++) uv.setXY(i, (positions.getX(i) + x) / (finish === "wood" ? 5.2 : 3.2), (positions.getZ(i) + z) / (finish === "wood" ? 2.8 : 3.2));
  floor.castShadow = false;
  return floor;
}

export interface Panels {
  led: CanvasPanel;
  serverWall: CanvasPanel;
  reception: CanvasPanel;
  meeting: CanvasPanel;
  training: CanvasPanel;
  storage: CanvasPanel;
  machines: CanvasPanel[];
}

function zoneFloor(root: THREE.Object3D, z: Zone): void {
  const w = z.x1 - z.x0;
  const d = z.z1 - z.z0;
  const finish: FloorFinish = ["ceo", "reception", "meeting", "common"].includes(z.id) ? "wood" : z.id === "lobby" ? "stone" : ["server", "storage"].includes(z.id) ? "service" : "carpet";
  finishedFloor(root, w, 0.1, d, (z.x0 + z.x1) / 2, 0.05, (z.z0 + z.z1) / 2, z.floor, finish);
}

function glassRun(root: THREE.Object3D, x0: number, x1: number, z: number, gapX: number | null): void {
  const segs: [number, number][] = gapX === null ? [[x0, x1]] : [[x0, gapX - DOOR_W / 2], [gapX + DOOR_W / 2, x1]];
  for (const [a, b] of segs) {
    if (b - a < 0.1) continue;
    const g = box(root, b - a, GLASS_H, 0.06, (a + b) / 2, GLASS_H / 2 + 0.1, z, MAT.glass);
    g.castShadow = false;
    box(root, b - a, 0.05, 0.1, (a + b) / 2, GLASS_H + 0.1, z, MAT.frame);
    box(root, b - a, 0.05, 0.1, (a + b) / 2, 0.12, z, MAT.frame);
    const count = Math.ceil((b - a) / 3.2);
    for (let i = 1; i < count; i++) box(root, 0.025, GLASS_H, 0.065, a + (b - a) * i / count, GLASS_H / 2 + 0.1, z, wallTrim);
    box(root, b - a, 0.025, 0.062, (a + b) / 2, 0.82, z, glassMark);
  }
}

function zoneWalls(root: THREE.Object3D, z: Zone): void {
  const w = z.x1 - z.x0;
  const cz = (z.z0 + z.z1) / 2;
  const d = z.z1 - z.z0;
  const backDoor = z.door.side === "back";
  if (z.id !== "ceo" && !backDoor) box(root, w, WALL_H, 0.22, (z.x0 + z.x1) / 2, WALL_H / 2, z.z0, MAT.charcoal);
  if (backDoor) {
    const left = z.door.x - DOOR_W / 2;
    const right = z.door.x + DOOR_W / 2;
    box(root, left - z.x0, WALL_H, 0.22, (z.x0 + left) / 2, WALL_H / 2, z.z0, MAT.charcoal);
    box(root, z.x1 - right, WALL_H, 0.22, (right + z.x1) / 2, WALL_H / 2, z.z0, MAT.charcoal);
  }
  box(root, 0.18, WALL_H, d, z.x0, WALL_H / 2, cz, MAT.charcoal);
  box(root, 0.18, WALL_H, d, z.x1, WALL_H / 2, cz, MAT.charcoal);
  for (const x of [z.x0, z.x1]) {
    box(root, 0.175, 0.045, d, x, WALL_H + 0.012, cz, wallStone);
    for (const side of [-1, 1]) box(root, 0.012, 0.16, d, x + side * 0.084, 0.18, cz, wallTrim);
  }
  const backRuns: [number, number][] = backDoor ? [[z.x0, z.door.x - DOOR_W / 2], [z.door.x + DOOR_W / 2, z.x1]] : z.id === "ceo" ? [] : [[z.x0, z.x1]];
  for (const [a, b] of backRuns) {
    box(root, b - a, 0.045, 0.215, (a + b) / 2, WALL_H + 0.012, z.z0, wallStone);
    box(root, b - a, 0.16, 0.012, (a + b) / 2, 0.18, z.z0 + 0.105, wallTrim);
  }
  const frontGap = z.door.side === "front" ? z.door.x : null;
  if (z.id !== "ceo" && z.id !== "lobby" && !backDoor) glassRun(root, z.x0, z.x1, z.z1, frontGap);
  if (backDoor && z.id !== "server" && z.id !== "lobby") glassRun(root, z.x0, z.x1, z.z1, z.id === "general" ? 0 : null);
  box(root, w, 0.03, 0.04, (z.x0 + z.x1) / 2, WALL_H + 0.02, z.z0 + 0.12, MAT.ledWarm);
}

function deskPlate(root: THREE.Object3D, text: string, x: number, z: number): void {
  const plate = canvasPlate(text, 0.78, 0.16, { size: 0.6 });
  plate.position.set(x, 0.65, z);
  plate.rotation.x = -0.2;
  root.add(plate);
}

function serverUtility(root: THREE.Object3D, x: number, z: number, width: number, height: number, depth: number, cooling: boolean): void {
  const unit = group(root, x, z);
  unit.name = cooling ? "server-cooling-unit" : "server-ups-unit";
  box(unit, width, height, depth, 0, height / 2, 0, cooling ? MAT.white : MAT.charcoal);
  const front = depth / 2 + 0.012;
  box(unit, width * 0.88, height * 0.8, 0.018, 0, height * 0.48, front, MAT.black);
  for (const side of [-1, 1]) {
    box(unit, width * 0.065, height * 0.84, 0.028, side * width * 0.43, height * 0.48, front + 0.015, MAT.metal);
    box(unit, 0.04, 0.06, depth * 0.78, side * width * 0.36, 0.035, 0, MAT.black);
  }
  box(unit, width * 0.3, 0.1, 0.025, -width * 0.17, height * 0.86, front + 0.02, MAT.screenAlt);
  for (let i = 0; i < 4; i++) box(unit, 0.014, 0.028 + i * 0.007, 0.004, -width * 0.27 + i * width * 0.06, height * 0.855, front + 0.035, MAT.ledGreen);
  for (let i = 0; i < 3; i++) cyl(unit, 0.015, 0.015, 0.016, width * 0.16 + i * 0.055, height * 0.86, front + 0.03, i === 2 ? MAT.ledWarm : MAT.ledGreen, 8).rotation.x = Math.PI / 2;
  for (let row = 0; row < (cooling ? 11 : 7); row++) box(unit, width * 0.68, 0.018, 0.026, 0, 0.2 + row * (height * 0.55 / (cooling ? 11 : 7)), front + 0.02, MAT.metal);
  if (cooling) {
    const fan = new THREE.Group();
    fan.position.set(0, height * 0.36, front + 0.036);
    fan.name = "server-cooling-rotor";
    unit.add(fan);
    const grille = new THREE.Mesh(new THREE.TorusGeometry(width * 0.25, 0.012, 6, 24), MAT.charcoal);
    grille.position.copy(fan.position); grille.position.z += 0.035; unit.add(grille);
    for (let blade = 0; blade < 5; blade++) box(fan, width * 0.16, 0.035, 0.014, Math.sin(blade * Math.PI * 2 / 5) * width * 0.1, Math.cos(blade * Math.PI * 2 / 5) * width * 0.1, 0, MAT.charcoal).rotation.z = -blade * Math.PI * 2 / 5 + 0.5;
    fan.traverse(part => { part.userData.keep = true; });
    registerAmbientRotor(fan);
  } else {
    for (const py of [height * 0.22, height * 0.46]) for (const side of [-1, 1]) box(unit, 0.05, 0.1, 0.04, side * width * 0.28, py, front + 0.035, MAT.white);
    for (const side of [-1, 1]) box(unit, width * 0.15, 0.035, 0.025, side * width * 0.28, height * 0.7, front + 0.035, MAT.metal);
  }
}

function buildServerNook(root: THREE.Object3D, zone: Zone, def: (typeof MACHINE_ROOMS)[number], index: number, accent: THREE.Material): void {
  const n = serverNook(zone);
  const w = n.x1 - n.x0;
  const d = n.z1 - n.z0;
  finishedFloor(root, w, 0.02, d, (n.x0 + n.x1) / 2, 0.11, (n.z0 + n.z1) / 2, 0x354454, "service");
  box(root, w, WALL_H, 0.16, (n.x0 + n.x1) / 2, WALL_H / 2, n.z0, MAT.charcoal);
  box(root, w - 0.2, 0.04, 0.04, (n.x0 + n.x1) / 2, WALL_H + 0.03, n.z0 + 0.1, accent);
  const doorZ = n.z1 - 0.9;
  const sideLen = doorZ - 0.6 - n.z0;
  const side = box(root, 0.06, GLASS_H, sideLen, n.x1, GLASS_H / 2 + 0.1, n.z0 + sideLen / 2, MAT.glass);
  side.castShadow = false;
  box(root, 0.1, 0.05, sideLen, n.x1, GLASS_H + 0.1, n.z0 + sideLen / 2, MAT.frame);
  box(root, 0.12, GLASS_H + 0.1, 0.12, n.x1, (GLASS_H + 0.1) / 2, doorZ - 0.6, MAT.frame);
  for (let i = 0; i < 3; i++) serverRack(root, n.x0 + 0.6, n.z0 + 0.62 + i * 1.04, Math.PI / 2);
  box(root, 0.4, 0.06, d - 0.4, n.x0 + 0.6, 2.45, (n.z0 + n.z1) / 2, MAT.metal);
  box(root, w - 1.4, 0.06, 0.3, (n.x0 + n.x1) / 2 + 0.5, 2.0, n.z0 + 0.3, MAT.metal);
  serverUtility(root, n.x1 - 0.55, n.z0 + 0.5, 0.7, 1.3, 0.6, true);
  serverUtility(root, n.x1 - 0.65, n.z1 - 0.5, 0.8, 0.7, 0.55, false);
  const light = new THREE.PointLight(def.accent, 3.5, 5, 1.8);
  light.position.set((n.x0 + n.x1) / 2, 1.8, n.z0 + 1.6);
  root.add(light);
  for (let i = 0; i < 2; i++) {
    const g = group(root, (n.x0 + n.x1) / 2 - 0.2 + i * 0.85, n.z0 + 0.62);
    g.scale.set(1, 0.72, 1);
    serverRack(g, 0, 0, 0);
  }
  const hit = new THREE.Mesh(new THREE.BoxGeometry(w, 2.6, d), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
  hit.position.set((n.x0 + n.x1) / 2, 1.3, (n.z0 + n.z1) / 2);
  hit.userData = { keep: true, hoverMachine: index };
  root.add(hit);
}

function buildMachineRoom(root: THREE.Object3D, def: (typeof MACHINE_ROOMS)[number], index: number): void {
  const zone = ZONE_BY_ID.get(def.zone)!;
  for (const row of ["office", "tech"] as const) {
    const roles = ROLES.filter((r) => r.row === row);
    const deskZ = row === "office" ? OFFICE_DESK_Z : TECH_DESK_Z;
    roles.forEach((role, i) => {
      const x = deskX(zone, i);
      workstation(root, x, deskZ);
      deskPlate(root, role.label, x, deskZ + 0.47);
    });
  }
  for (const px of [zone.x0 + 0.5, zone.x1 - 0.5]) plant(root, px, zone.z0 + 0.6, 1.1, true);
  plant(root, zone.x1 - 0.6, zone.z1 - 0.6, 0.9);
  plant(root, (zone.x0 + zone.x1) / 2 - 3, (OFFICE_DESK_Z + TECH_DESK_Z) / 2 + 0.4, 0.75);
  plant(root, (zone.x0 + zone.x1) / 2 + 3, (OFFICE_DESK_Z + TECH_DESK_Z) / 2 + 0.4, 0.75);
  const accentMat = new THREE.MeshStandardMaterial({ color: def.accent, emissive: def.accent, emissiveIntensity: 1.5 });
  box(root, zone.x1 - zone.x0 - 0.2, 0.05, 0.05, (zone.x0 + zone.x1) / 2, WALL_H + 0.06, zone.z0 + 0.14, accentMat);
  buildServerNook(root, zone, def, index, accentMat);
  htmlLabel(
    root,
    `<div class="room-sign" style="--accent:${def.accentCss}"><b>${def.machine}</b></div>`,
    "anchor",
    (zone.x0 + zone.x1) / 2,
    2.6,
    zone.z0 + 0.4,
  );
}

const LED_HEIGHT = 9;
const LED_TILT = -0.78;
const LED_BOTTOM = new THREE.Vector3(0, 1.55, -19.68);
const LED_BEZEL = 0.16;

function buildCeo(root: THREE.Group, panels: Panels): CeoAnimator {
  const back = group(root, 0, -23.6);
  const ceo = ZONE_BY_ID.get("ceo")!;
  const ledH = LED_HEIGHT * Math.min(SX, 1.05);
  const ledW = Math.min(ceo.x1 - ceo.x0 - 0.8, (ledH * 16) / 9);
  box(back, ceo.x1 - ceo.x0, 4.6, 0.3, 0, 2.3, 0, MAT.charcoal);
  const up = new THREE.Vector3(0, Math.cos(LED_TILT), Math.sin(LED_TILT));
  const normal = new THREE.Vector3(0, -Math.sin(LED_TILT), Math.cos(LED_TILT));
  const center = LED_BOTTOM.clone().addScaledVector(up, ledH / 2);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(ledW, ledH), panels.led.material);
  screen.position.copy(center);
  screen.rotation.x = LED_TILT;
  screen.userData = { keep: true, panel: "led" };
  root.add(screen);
  const bezel = box(root, ledW + LED_BEZEL * 2, ledH + LED_BEZEL * 2, 0.12, 0, 0, 0, MAT.frame);
  bezel.position.copy(center).addScaledVector(normal, -0.07);
  bezel.rotation.x = LED_TILT;
  for (const side of [-1, 1]) {
    const post = box(root, 0.22, LED_BOTTOM.y, 0.22, side * ledW * 0.3, LED_BOTTOM.y / 2, LED_BOTTOM.z - 0.25, MAT.frame);
    post.userData.keep = true;
  }
  const stage = cyl(root, 6.2, 6.2, 0.06, CEO_DESK.x, 0.13, CEO_DESK.z + 0.4, MAT.wood, 48);
  stage.scale.set(1.15 * Math.min(SX, 1.2), 1, 0.55);
  executiveDesk(root, CEO_DESK.x, CEO_DESK.z);
  const chair = ergonomicChair(root, CEO_DESK.x, CEO_DESK.z - 0.9);
  chair.traverse((part) => { if ((part as THREE.Mesh).isMesh) part.userData.keep = true; });
  const person = seatedPerson(root, CEO_DESK.x, CEO_DESK.z - 0.72);
  const massage = massageChair(root, CEO_DESK.x - 4.35, CEO_DESK.z - 0.9);
  deskLamp(root, CEO_DESK.x + 2.65, 0.82, CEO_DESK.z + 0.38, -0.4);
  credenza(root, CEO_DESK.x, CEO_DESK.z - 2.55, 3.2);
  const plate = canvasPlate("CEO", 2.0, 0.5, { size: 0.5, sub: L("GIÁM ĐỐC") });
  plate.position.set(CEO_DESK.x, 0.49, CEO_DESK.z + 0.88);
  plate.rotation.x = -0.08;
  root.add(plate);
  for (const side of [-1, 1]) {
    const gx = side * 5.8 * Math.min(SX, 1.2);
    armchair(root, gx, -17.2, side * 0.9);
    cyl(root, 0.22, 0.22, 0.5, gx + side * 0.75, 0.25, -17.75, MAT.marble, 16);
    bookshelf(root, side * (12.5 * SX - 0.4), -19.6, 2.0, -side * Math.PI / 2);
    floorLamp(root, side * 10.7 * SX, -15.9);
    coffeeTable(root, side * 7.2 * SX, -14.7, 1.0, 0.6);
    rug(root, side * 8.2 * SX, -15.15, 4.5 * Math.min(SX, 1.3), 2.6);
    const cabinet = group(root, side * (12.5 * SX - 0.45), -17.65, -side * Math.PI / 2);
    credenza(cabinet, 0, 0, 1.0);
    const planterX = side * (8.2 * SX);
    displayPlinth(root, planterX, -17.8, 2.2, 0.65);
  }
  for (const px of [-8.6 * SX, 8.6 * SX]) {
    sofa(root, px, -15.4, 0, 2, MAT.fabricLight);
    plant(root, px * 0.68, -21.5, 1.15, true);
    plant(root, px * 1.3, -22.6, 1.0, true);
    plant(root, px * 0.85, -14.2, 0.85);
  }
  return new CeoAnimator(person, chair, root, massage);
}

function displayPlinth(root: THREE.Object3D, x: number, z: number, w: number, d: number): void {
  box(root, w, 0.24, d, x, 0.23, z, MAT.woodDark);
  box(root, w + 0.03, 0.035, d + 0.03, x, 0.365, z, MAT.marble);
  for (const side of [-1, 1]) {
    const vase = group(root, x + side * w * 0.32, z);
    vase.position.y = 0.385;
    plant(vase, 0, 0, 0.5);
  }
  box(root, w * 0.28, 0.025, d * 0.55, x, 0.4, z, MAT.fabric);
  box(root, w * 0.25, 0.012, d * 0.5, x + 0.03, 0.42, z, MAT.white);
}

function wallArt(root: THREE.Object3D, x: number, z: number, w: number, h: number): void {
  const art = group(root, x, z);
  art.position.y = 1.45;
  art.rotation.x = -0.35;
  box(art, w, h, 0.055, 0, 0, 0, MAT.woodDark);
  box(art, w - 0.08, h - 0.08, 0.015, 0, 0, 0.034, MAT.white);
  box(art, w * 0.26, h * 0.66, 0.012, -w * 0.22, -h * 0.08, 0.048, MAT.fabric);
  box(art, w * 0.31, h * 0.28, 0.014, w * 0.16, -h * 0.26, 0.049, MAT.wood);
  const sun = cyl(art, h * 0.15, h * 0.15, 0.014, w * 0.18, h * 0.17, 0.05, MAT.gold, 20);
  sun.rotation.x = Math.PI / 2;
}

function buildReception(root: THREE.Object3D, panels: Panels): void {
  const z = ZONE_BY_ID.get("reception")!;
  const cx = (z.x0 + z.x1) / 2;
  rug(root, cx, -18.8, 9.3, 5.7);
  sofa(root, cx, -20.4, 0, 3);
  sofa(root, cx - 3.3, -18.3, Math.PI / 2, 2);
  sofa(root, cx + 3.3, -18.3, -Math.PI / 2, 2);
  coffeeTable(root, cx, -18.3, 2.4, 1.1);
  bookshelf(root, z.x0 + 0.55, -18.0, 2.6, Math.PI / 2);
  counter(root, z.x1 - 0.55, -18.1, 2.4, -Math.PI / 2);
  const tray = group(root, z.x1 - 0.55, -18.1, -Math.PI / 2);
  box(tray, 0.75, 0.035, 0.4, 0, 0.97, 0, MAT.woodDark);
  for (const dx of [-0.22, 0, 0.22]) cyl(tray, 0.06, 0.045, 0.11, dx, 1.04, 0, MAT.white, 10);
  rug(root, cx - 5.0, -15.05, 2.6, 1.7);
  armchair(root, cx - 5.0, -15.2, -0.45, MAT.fabric);
  coffeeTable(root, cx - 6.0, -15.3, 0.55, 0.5);
  floorLamp(root, cx - 5.9, -14.6);
  for (const side of [-1, 1]) {
    const edgeX = side < 0 ? z.x0 + 2.2 : z.x1 - 2.2;
    if (Math.abs(edgeX - cx) > RECEPTION_BOARD_W / 2 + 1.2) {
      wallArt(root, edgeX, z.z0 + 0.2, 2.4, 1.2);
      displayPlinth(root, edgeX, -21.3, 2.8, 0.7);
    }
  }
  const boardH = RECEPTION_BOARD_W / RECEPTION_BOARD_ASPECT;
  mountScreen(root, "reception", "reception", panels.reception.material, { x: cx, y: BOARD_BOTTOM_Y + boardH / 2, z: huggedZ(z.z0, boardH), w: RECEPTION_BOARD_W, h: boardH });
  for (const [px, pz] of [[z.x0 + 0.7, -23.2], [z.x1 - 0.7, -23.2], [z.x0 + 0.7, -14], [z.x1 - 2.2, -14.2]] as const) plant(root, px, pz, 1.1, true);
  const lampX = z.x0 + 1.5;
  cyl(root, 0.05, 0.05, 1.6, lampX, 0.8, -20.6, MAT.black, 8);
  cyl(root, 0.3, 0.2, 0.3, lampX, 1.65, -20.6, MAT.ledWarm, 12);
}

function buildMeeting(root: THREE.Object3D, panels: Panels): THREE.Group {
  const z = ZONE_BY_ID.get("meeting")!;
  const room = meetingLayout();
  const cx = room.cx;
  conferenceTable(root, cx, room.tableZ, room.len);
  const head = ergonomicChair(root, room.head.x, room.head.z, room.head.facing);
  head.traverse((part) => { if ((part as THREE.Mesh).isMesh) part.userData.keep = true; });
  const plate = canvasPlate(L("CHỦ TRÌ"), 0.62, 0.17, { size: 0.6 });
  plate.position.set(room.head.x - 0.78, 0.9, room.tableZ + 0.6);
  root.add(plate);
  mountScreen(root, "meeting", "meeting", panels.meeting.material, { x: cx, y: 1.1, z: -22.9, w: 6.2, h: 2.1 });
  bookshelf(root, z.x0 + 1.2, -23.4, 1.8);
  bookshelf(root, z.x1 - 1.2, -23.4, 1.8);
  for (const [px, pz] of [[z.x0 + 0.6, -14.2], [z.x1 - 0.6, -14.2], [z.x1 - 0.6, -20.5], [z.x0 + 0.6, -20.5]] as const) plant(root, px, pz, 1.05, true);
  return head;
}

const SCREEN_LABEL_GAP = 0.12;
const WALL_HUG = 0.17;
const screenTops = new Map<ZoneId, { x: number; y: number; z: number }>();
const BOARD_DOOR_GAP = 0.25;
const TRAINING_BOARD_W = 5.0;
const TRAINING_BOARD_H = 1.7;
const BOARD_BOTTOM_Y = 0.7;
const SERVER_BOARD_ASPECT = 1472 / 416;
const RECEPTION_BOARD_ASPECT = 1440 / 420;
const RECEPTION_BOARD_W = 12;
const TRAY_CABLES = [0xf2c230, 0x3d8bff, 0x3ccf6e].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.6 }));

function mountScreen(root: THREE.Object3D, zone: ZoneId, panel: string, mat: THREE.Material, at: { x: number; y: number; z: number; w: number; h: number }): void {
  const screen = wallScreen(root, at.x, at.y, at.z, at.w, at.h, mat, 0, SCREEN_TILT);
  screen.userData = { keep: true, panel };
  const reach = at.h / 2 + 0.06 + SCREEN_LABEL_GAP;
  screenTops.set(zone, { x: at.x, y: at.y + reach * Math.cos(SCREEN_TILT), z: at.z + reach * Math.sin(SCREEN_TILT) });
}

function huggedZ(wallZ: number, h: number): number {
  return wallZ + WALL_HUG + (h / 2 + 0.06) * Math.sin(-SCREEN_TILT);
}

function cableTray(root: THREE.Object3D, x0: number, x1: number, z: number, seed: number): void {
  const len = x1 - x0;
  const cx = (x0 + x1) / 2;
  for (const dz of [-0.18, 0.18]) box(root, len, 0.04, 0.03, cx, 2.48, z + dz, MAT.metal);
  for (let x = x0 + 0.1; x < x1; x += 0.35) box(root, 0.03, 0.02, 0.36, x, 2.47, z, MAT.metal);
  box(root, len - 0.1, 0.05, 0.12, cx, 2.52, z - 0.06, TRAY_CABLES[Math.abs(seed) % TRAY_CABLES.length]);
  for (let x = x0 + RACK_WIDTH / 2; x < x1; x += RACK_WIDTH) box(root, 0.05, 0.28, 0.05, x, 2.34, z - 0.12, MAT.black);
  for (const px of [x0 + 0.1, x1 - 0.1]) box(root, 0.03, 0.4, 0.03, px, 2.7, z, MAT.metal);
}

function buildServer(root: THREE.Object3D, panels: Panels): void {
  const z = ZONE_BY_ID.get("server")!;
  const boardLeft = z.door.x + DOOR_W / 2 + BOARD_DOOR_GAP;
  const boardW = Math.min(z.x1 - SERVER_RIGHT_MARGIN - boardLeft, 8.4 * Math.min(SX, 1.3));
  const boardH = boardW / SERVER_BOARD_ASPECT;
  mountScreen(root, "server", "server", panels.serverWall.material, { x: boardLeft + boardW / 2, y: BOARD_BOTTOM_Y + boardH / 2, z: huggedZ(z.z0, boardH), w: boardW, h: boardH });
  const tileA = new THREE.MeshStandardMaterial({ color: 0x5b6b7d, roughness: 0.55 });
  const tileB = new THREE.MeshStandardMaterial({ color: 0x4a5869, roughness: 0.55 });
  const slots = serverRackSlots();
  for (const slot of slots) {
    serverRack(root, slot.x, slot.z, 0);
    const tile = box(root, RACK_WIDTH - 0.04, 0.02, 1.1, slot.x, 0.11, slot.z + RACK_FRONT + 0.6, slot.index % 2 ? tileA : tileB);
    tile.castShadow = false;
  }
  SERVER_ROWS_Z.forEach((rowZ, row) => {
    for (const side of [-1, 1]) {
      const xs = slots.filter((s) => s.row === row && s.side === side).map((s) => s.x);
      cableTray(root, Math.min(...xs) - RACK_WIDTH / 2, Math.max(...xs) + RACK_WIDTH / 2, rowZ, row + side);
    }
  });
  for (const ux of [z.x1 - 0.7, z.x1 - 1.6]) {
    serverUtility(root, ux, 16.2, 0.8, 1.6, 0.8, true);
  }
  serverUtility(root, z.x0 + 3.2, 16.3, 1.2, 1.0, 0.6, false);
  const light = new THREE.PointLight(0x4da3ff, 6, 9, 1.6);
  light.position.set(serverGapX(), 2.6, 12.0);
  root.add(light);
  glassRun(root, z.x0, z.x1, z.z1, null);
}

function buildTraining(root: THREE.Object3D, panels: Panels): void {
  const z = ZONE_BY_ID.get("training")!;
  const cx = (z.x0 + z.x1) / 2 + TRAINING_DESK_DX;
  const boardLeft = z.door.x + DOOR_W / 2 + BOARD_DOOR_GAP;
  const boardRight = z.x1 - SERVER_RIGHT_MARGIN;
  const boardW = Math.min(TRAINING_BOARD_W, boardRight - boardLeft);
  const boardX = Math.min(Math.max(cx, boardLeft + boardW / 2), boardRight - boardW / 2);
  mountScreen(root, "training", "training", panels.training.material, { x: boardX, y: 1.15, z: huggedZ(z.z0, TRAINING_BOARD_H), w: boardW, h: TRAINING_BOARD_H });
  for (const dz of TRAINING_ROWS_Z) {
    for (const dx of [-2.2, 0, 2.2]) {
      box(root, 1.7, 0.06, 0.6, cx + dx, 0.74, dz, MAT.white);
      box(root, 1.5, 0.7, 0.04, cx + dx, 0.38, dz - 0.25, MAT.charcoal);
      officeChair(root, cx + dx - 0.4, dz + TRAINING_CHAIR_DZ, Math.PI);
      officeChair(root, cx + dx + 0.4, dz + TRAINING_CHAIR_DZ, Math.PI);
    }
  }
  plant(root, z.x0 + 0.6, 16.3, 1.0, true);
  plant(root, z.x1 - 0.6, 16.3, 1.0, true);
}

function buildGeneral(root: THREE.Object3D): void {
  for (const d of GENERAL_DESKS) {
    workstation(root, d.x, d.z);
  }
  cyl(root, 1.5, 1.6, 0.6, 0, 0.3, 11.2, MAT.charcoal, 24);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    plant(root, Math.cos(a) * 0.8, 11.2 + Math.sin(a) * 0.8, 1.15, true);
  }
  plant(root, 0, 11.2, 1.5, true);
  for (const tx of ROUND_TABLE_X) {
    cyl(root, 0.55, 0.55, 0.05, tx, 0.75, ROUND_TABLE_Z, MAT.white, 20);
    cyl(root, 0.05, 0.05, 0.7, tx, 0.38, ROUND_TABLE_Z, MAT.black, 8);
    for (const a of ROUND_CHAIR_ANGLES) officeChair(root, tx + Math.cos(a) * ROUND_CHAIR_R, ROUND_TABLE_Z + Math.sin(a) * ROUND_CHAIR_R, -a - Math.PI / 2);
  }
  const gz = ZONE_BY_ID.get("general")!;
  for (const px of [gz.x0 + 0.6, gz.x1 - 0.6]) {
    plant(root, px, 6.7, 1.1, true);
    plant(root, px, 16.3, 1.1, true);
  }
  htmlLabel(root, L("<div class=\"general-sign\"><b>VĂN PHÒNG CHUNG</b><span>KHÔNG GIAN LÀM VIỆC CHUNG TOÀN CÔNG TY</span></div>"), "anchor", 0, 2.6, 6.5);
}

function buildCommon(root: THREE.Object3D) {
  const z = ZONE_BY_ID.get("common")!;
  rug(root, z.x0 + 2.65, 20.25, 5.0, 4.5);
  const gameFloor = box(root, 3.4, 0.012, 4.2, z.x1 - 2.0, 0.114, 11.0, MAT.fabric);
  gameFloor.castShadow = false;
  counter(root, z.x0 + 2.6, 6.75, 4.2);
  const drinksFridge = createDrinkFridge(root, z.x0 + 5.3, 6.8);
  const drinks = createDrinkBar(root, (z.x0 + z.x1) / 2, 15.2);
  const games = createLoungeGames(root, { x: z.x0 + 2.2, z: 11 }, { x: z.x1 - 2, z: 21.1 });
  const coffee = new CoffeeStation(root, z.x0 + 1.6, 6.7);
  wallArt(root, z.x0 + 2.6, 6.18, 3.8, 0.95);
  const herb = group(root, z.x0 + 4.25, 6.7);
  herb.position.y = 0.95;
  plant(herb, 0, 0, 0.35);
  const cafeX = z.x1 - 1.7;
  rug(root, cafeX, 7.4, 3.2, 2.1);
  cyl(root, 0.62, 0.62, 0.055, cafeX, 0.76, 7.3, MAT.marble, 24);
  cyl(root, 0.08, 0.12, 0.63, cafeX, 0.42, 7.3, MAT.metal, 12);
  cyl(root, 0.34, 0.36, 0.035, cafeX, 0.12, 7.3, MAT.charcoal, 16);
  for (const side of [-1, 1]) {
    armchair(root, cafeX + side * 0.95, 7.3, -side * Math.PI / 2, MAT.fabricLight);
    cyl(root, 0.055, 0.045, 0.1, cafeX + side * 0.3, 0.84, 7.3, MAT.white, 10);
  }
  sofa(root, z.x0 + 2.9, 21.6, Math.PI, 3);
  coffeeTable(root, z.x0 + 2.9, 20.2, 1.4, 0.7);
  sofa(root, z.x0 + 1.0, 19.4, Math.PI / 2, 1);
  poolTable(root, z.x1 - 2.0, 11.0, Math.PI / 2);
  displayPlinth(root, (z.x0 + z.x1) / 2, 22.8, 3.0, 0.6);
  const rack = group(root, z.x1 - 0.22, 14.2, -Math.PI / 2);
  box(rack, 1.6, 0.08, 0.22, 0, 0.2, 0, MAT.woodDark);
  box(rack, 1.6, 0.08, 0.22, 0, 1.35, 0, MAT.woodDark);
  for (let i = 0; i < 5; i++) cyl(rack, 0.012, 0.022, 1.3, -0.6 + i * 0.3, 0.8, 0, MAT.wood, 6);
  plant(root, z.x1 - 0.6, 22.8, 1.05, true);
  plant(root, z.x0 + 0.6, 22.8, 0.9);
  return { coffee, amenities: { tick(t: number, dt: number) { drinks.tick(t, dt); drinksFridge.tick(t, dt); games.tick(t, dt); }, dispose() { drinks.dispose(); drinksFridge.dispose(); games.dispose(); } } };
}

function buildStorage(root: THREE.Object3D, panels: Panels): void {
  const z = ZONE_BY_ID.get("storage")!;
  mountScreen(root, "storage", "storage", panels.storage.material, { x: z.x0 + STORAGE_SCREEN_DX, y: 1.05, z: huggedZ(z.z0, 1.4), w: 2.6, h: 1.4 });
  for (const dx of [1.6, 6.8]) bookshelf(root, z.x0 + dx, 6.55, 2.2, 0, true);
  bookshelf(root, z.x1 - 0.5, 11.0, 2.4, -Math.PI / 2, true);
  bookshelf(root, z.x0 + 0.55, 10.5, 2.6, Math.PI / 2, true);
  bookshelf(root, z.x1 - 0.5, 14.5, 2.4, -Math.PI / 2, true);
  for (const [x, zz, w, d] of [[z.x0 + 2.4, 13.4, 3.0, 1.5], [z.x0 + 6.1, 12.6, 2.2, 2.0], [z.x0 + 6.2, 15.6, 2.5, 1.5]] as const) {
    const pad = box(root, w, 0.008, d, x, 0.105, zz, MAT.charcoal);
    pad.castShadow = false;
    for (const side of [-1, 1]) {
      box(root, w, 0.006, 0.045, x, 0.113, zz + side * d / 2, MAT.gold).castShadow = false;
      box(root, 0.045, 0.006, d, x + side * w / 2, 0.113, zz, MAT.gold).castShadow = false;
    }
  }
  box(root, 2.4, 0.08, 1.0, z.x0 + 2.4, 0.86, 13.4, MAT.woodDark);
  box(root, 2.2, 0.82, 0.9, z.x0 + 2.4, 0.41, 13.4, MAT.charcoal);
  box(root, 0.5, 0.3, 0.4, z.x0 + 1.8, 1.05, 13.4, MAT.metal);
  box(root, 2.1, 0.75, 0.045, z.x0 + 2.4, 1.32, 12.95, MAT.wood);
  for (let i = 0; i < 5; i++) {
    box(root, 0.055, 0.3, 0.06, z.x0 + 1.6 + i * 0.36, 1.34, 12.99, MAT.metal);
    box(root, 0.12, 0.08, 0.065, z.x0 + 1.6 + i * 0.36, 1.49, 13.0, MAT.charcoal);
  }
  box(root, 0.36, 0.2, 0.28, z.x0 + 3.1, 1.0, 13.35, MAT.fabric);
  box(root, 0.45, 0.025, 0.32, z.x0 + 2.5, 0.92, 13.65, MAT.white);
  const spareWidth = z.x1 - z.x0 - 9.6;
  if (spareWidth > 2.5) {
    bookshelf(root, z.x1 - 2.6, 6.55, Math.min(3.5, spareWidth), 0, true);
    for (const dz of [9.0, 15.8]) {
      const x = z.x1 - 3.0;
      box(root, 1.5, 0.13, 1.1, x, 0.165, dz, MAT.woodDark);
      const pallet = group(root, x, dz);
      pallet.position.y = 0.23;
      for (const dx of [-0.4, 0.4]) crate(pallet, dx, 0, 0.55, 2);
    }
  }
  for (const [cx, cz, st] of [[z.x0 + 5.5, 12.2, 3], [z.x0 + 6.3, 12.2, 2], [z.x0 + 5.9, 13.2, 1], [z.x0 + 6.8, 15.6, 2], [z.x0 + 5.6, 15.6, 3]] as const) crate(root, cx, cz, 0.6, st);
  for (const rx of [z.x0 + 3.6, z.x0 + 4.4]) serverRack(root, rx, 15.6, Math.PI);
  plant(root, z.x0 + 0.6, 16.3, 1.0, true);
}

function buildLobby(root: THREE.Object3D): void {
  const z = ZONE_BY_ID.get("lobby")!;
  for (const gx of [-2.1, 2.1]) gate(root, gx, 18.4);
  box(root, 0.12, 1.1, 2.4, -3.4, 0.55, 19.4, MAT.glass).castShadow = false;
  box(root, 0.12, 1.1, 2.4, 3.4, 0.55, 19.4, MAT.glass).castShadow = false;
  const logo = canvasPlate("◭  AI AGENT", 4.6, 1.5, { size: 0.42, bg: "#2a2e35", sub: "COMPANY" });
  logo.position.set(0, 0.13, 21.6);
  logo.rotation.x = -Math.PI / 2;
  root.add(logo);
  for (const px of [z.x0 + 0.8, z.x1 - 0.8]) {
    plant(root, px, 18.4, 1.1, true);
    plant(root, px, 22.8, 1.0, true);
  }
}

function labelZones(root: THREE.Object3D): void {
  for (const z of ZONES) {
    if (!z.label || z.id.startsWith("room") || z.id === "general") continue;
    const top = screenTops.get(z.id);
    if (top) htmlLabel(root, z.label, "room-label", top.x, top.y, top.z, [0.5, 1]);
    else htmlLabel(root, z.label, "room-label", (z.x0 + z.x1) / 2, 2.2, z.z0 + 0.4);
  }
}

function mergeStatic(root: THREE.Group): void {
  root.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const remove: THREE.Mesh[] = [];
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || mesh.userData.keep || Array.isArray(mesh.material)) return;
    const mat = mesh.material as THREE.Material;
    if ((mat as THREE.MeshPhysicalMaterial).transparent) return;
    const geo = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(geo.attributes)) if (!["position", "normal", "uv"].includes(name)) geo.deleteAttribute(name);
    const list = buckets.get(mat) ?? [];
    list.push(geo);
    buckets.set(mat, list);
    remove.push(mesh);
  });
  for (const mesh of remove) mesh.parent?.remove(mesh);
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    for (const geo of geos) geo.dispose();
    if (!merged) continue;
    const indexed = mergeVertices(merged);
    merged.dispose();
    const mesh = new THREE.Mesh(indexed, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
}

export function buildOffice(scene: THREE.Scene) {
  const root = new THREE.Group();
  scene.add(root);
  const panels: Panels = {
    led: new CanvasPanel(2400, 1350),
    serverWall: new CanvasPanel(1472, 416),
    reception: new CanvasPanel(1440, 420),
    meeting: new CanvasPanel(1240, 420),
    training: new CanvasPanel(1000, 340),
    storage: new CanvasPanel(820, 340),
    machines: [0, 1, 2].map(() => new CanvasPanel(960, 600)),
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xc4beb3, roughness: 0.6 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.62;
  ground.receiveShadow = true;
  ground.userData.keep = true;
  root.add(ground);
  const base = box(root, 64 * SX, 0.6, 50, 0, -0.3, -0.25, new THREE.MeshStandardMaterial({ color: 0xcfc9bf, roughness: 0.5 }));
  base.castShadow = false;
  for (const z of ZONES) {
    zoneFloor(root, z);
    zoneWalls(root, z);
  }
  MACHINE_ROOMS.forEach((def, i) => buildMachineRoom(root, def, i));
  const ceo = buildCeo(root, panels);
  buildReception(root, panels);
  ceo.attachMeeting(buildMeeting(root, panels), meetingLayout());
  buildServer(root, panels);
  buildTraining(root, panels);
  buildGeneral(root);
  const { coffee, amenities } = buildCommon(root);
  buildStorage(root, panels);
  buildLobby(root);
  labelZones(root);
  const screens: THREE.Mesh[] = [];
  const hoverTargets: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.panel) screens.push(o as THREE.Mesh);
    if ((o as THREE.Mesh).isMesh && o.userData.hoverMachine !== undefined) hoverTargets.push(o as THREE.Mesh);
  });
  mergeStatic(root);
  return { root, panels, screens, hoverTargets, ceo, coffee, amenities };
}

export type { ZoneId };
