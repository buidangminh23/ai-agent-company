import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { createBilliards } from "./lounge.ts";

function surface(kind: "wood" | "fabric" | "stone" | "screen" | "rug"): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = kind === "screen" ? "#10243a" : "#ded8ce";
  ctx.fillRect(0, 0, 256, 256);
  if (kind === "wood") {
    for (let i = 0; i < 128; i++) {
      ctx.strokeStyle = `rgba(77,45,23,${0.04 + (Math.sin(i * 17.3) + 1) * 0.035})`;
      ctx.beginPath();
      ctx.moveTo(0, i * 2);
      ctx.bezierCurveTo(72, i * 2 + Math.sin(i) * 6, 180, i * 2 - 4, 256, i * 2);
      ctx.stroke();
    }
  } else if (kind === "fabric" || kind === "rug") {
    for (let i = 0; i < 256; i += 2) {
      ctx.fillStyle = i % 4 ? "#bcb7af" : "#eee9e1";
      ctx.fillRect(i, 0, 1, 256);
      ctx.fillStyle = "rgba(65,60,52,0.12)";
      ctx.fillRect(0, i, 256, 1);
    }
    if (kind === "rug") {
      ctx.strokeStyle = "#777e7e";
      ctx.lineWidth = 3;
      ctx.strokeRect(12, 12, 232, 232);
      ctx.strokeRect(19, 19, 218, 218);
      ctx.lineWidth = 1;
      for (let i = 38; i < 225; i += 24) {
        ctx.beginPath(); ctx.moveTo(i, 28); ctx.lineTo(i, 228); ctx.stroke();
      }
    }
  } else if (kind === "stone") {
    for (let i = 0; i < 7; i++) {
      ctx.strokeStyle = `rgba(96,103,106,${0.05 + i * 0.012})`;
      ctx.lineWidth = 0.5 + i % 2;
      ctx.beginPath(); ctx.moveTo(i * 43 - 80, 0);
      ctx.bezierCurveTo(i * 43 + 50, 90, i * 43 - 40, 130, i * 43 + 80, 256); ctx.stroke();
    }
  } else {
    ctx.fillStyle = "#203e56"; ctx.fillRect(0, 0, 256, 28); ctx.fillRect(12, 40, 45, 203);
    for (let i = 0; i < 13; i++) {
      ctx.fillStyle = ["#63b6c3", "#9faec4", "#d5b286"][i % 3];
      ctx.fillRect(70 + (i % 3) * 8, 45 + i * 14, 48 + (i * 37) % 100, 3);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const woodMap = surface("wood");
const weaveMap = surface("fabric");
const stoneMap = surface("stone");
const screenMap = surface("screen");

export const MAT = {
  wood: new THREE.MeshStandardMaterial({ color: 0xc59a70, map: woodMap, roughness: 0.48 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x76523a, map: woodMap, roughness: 0.44 }),
  black: new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.45, metalness: 0.2 }),
  charcoal: new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.6 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.35, metalness: 0.7 }),
  white: new THREE.MeshStandardMaterial({ color: 0xeeeae3, roughness: 0.5 }),
  fabric: new THREE.MeshStandardMaterial({ color: 0x41575a, map: weaveMap, roughness: 0.95 }),
  fabricLight: new THREE.MeshStandardMaterial({ color: 0xb9b4a9, map: weaveMap, roughness: 0.95 }),
  rug: new THREE.MeshStandardMaterial({ color: 0xd1c3ac, map: surface("rug"), roughness: 1 }),
  pot: new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x3f8f45, roughness: 0.8 }),
  leafDark: new THREE.MeshStandardMaterial({ color: 0x2d6e36, roughness: 0.8 }),
  screen: new THREE.MeshStandardMaterial({ color: 0xffffff, map: screenMap, emissiveMap: screenMap, emissive: 0xb7d9ff, emissiveIntensity: 0.55, roughness: 0.35 }),
  screenAlt: new THREE.MeshStandardMaterial({ color: 0xb5d5e5, map: screenMap, emissiveMap: screenMap, emissive: 0xc4e4e9, emissiveIntensity: 0.5, roughness: 0.35 }),
  ledWarm: new THREE.MeshStandardMaterial({ color: 0xffd28a, emissive: 0xffb347, emissiveIntensity: 1.6 }),
  ledBlue: new THREE.MeshStandardMaterial({ color: 0x5fb0ff, emissive: 0x2f8bff, emissiveIntensity: 1.8 }),
  ledGreen: new THREE.MeshStandardMaterial({ color: 0x6dffa0, emissive: 0x22d36b, emissiveIntensity: 1.8 }),
  ledRed: new THREE.MeshStandardMaterial({ color: 0xff7b7b, emissive: 0xff3030, emissiveIntensity: 1.8 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0xbfd9ee, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0, depthWrite: false }),
  frame: new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.4, metalness: 0.4 }),
  felt: new THREE.MeshStandardMaterial({ color: 0x1f7a3d, roughness: 0.95 }),
  cardboard: new THREE.MeshStandardMaterial({ color: 0xb08d5f, roughness: 0.9 }),
  rack: new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.35, metalness: 0.5 }),
  rackFace: new THREE.MeshStandardMaterial({ color: 0x0f2033, emissive: 0x1d4f8a, emissiveIntensity: 0.5, roughness: 0.4 }),
  marble: new THREE.MeshStandardMaterial({ color: 0xfffcf4, map: stoneMap, roughness: 0.3, metalness: 0.05 }),
  suit: new THREE.MeshStandardMaterial({ color: 0x16181d, roughness: 0.6 }),
  trousers: new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.7 }),
  shirt: new THREE.MeshStandardMaterial({ color: 0xf3f1ec, roughness: 0.6 }),
  tie: new THREE.MeshStandardMaterial({ color: 0xc8202a, roughness: 0.45 }),
  skin: new THREE.MeshStandardMaterial({ color: 0xf0c6a0, roughness: 0.7 }),
  hair: new THREE.MeshStandardMaterial({ color: 0x15120f, roughness: 0.8 }),
  leather: new THREE.MeshStandardMaterial({ color: 0x2a1d16, roughness: 0.5 }),
  gold: new THREE.MeshStandardMaterial({ color: 0xd8a640, roughness: 0.3, metalness: 0.8 }),
};

const geoCache = new Map<string, THREE.BoxGeometry>();
const roundedCache = new Map<string, THREE.BufferGeometry>();
const cylinderCache = new Map<string, THREE.CylinderGeometry>();
const upholstery = new THREE.MeshStandardMaterial({ color: 0x303a42, map: weaveMap, roughness: 0.86 });
const brass = new THREE.MeshStandardMaterial({ color: 0xb99b65, metalness: 0.65, roughness: 0.38 });
const shade = new THREE.MeshStandardMaterial({ color: 0xe9dcc2, map: weaveMap, emissive: 0xffd698, emissiveIntensity: 0.22, roughness: 0.8 });

function rounded(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, radius = 0.045): THREE.Mesh {
  const r = Math.min(radius, Math.min(w, h, d) * 0.45);
  const key = `${w}|${h}|${d}|${r}`;
  let geometry = roundedCache.get(key);
  if (!geometry) {
    const half = [w / 2, h / 2, d / 2];
    const points: THREE.Vector3[] = [];
    for (let axis = 0; axis < 3; axis++) {
      for (const side of [-1, 1]) for (const a of [-1, 1]) for (const b of [-1, 1]) {
        const point = new THREE.Vector3();
        point.setComponent(axis, side * half[axis]);
        point.setComponent((axis + 1) % 3, a * (half[(axis + 1) % 3] - r));
        point.setComponent((axis + 2) % 3, b * (half[(axis + 2) % 3] - r));
        points.push(point);
      }
    }
    geometry = new ConvexGeometry(points);
    const positions = geometry.getAttribute("position");
    const normals = geometry.getAttribute("normal");
    const uv = new Float32Array(positions.count * 2);
    for (let i = 0; i < positions.count; i++) {
      const nx = Math.abs(normals.getX(i));
      const ny = Math.abs(normals.getY(i));
      const nz = Math.abs(normals.getZ(i));
      uv[i * 2] = nx > ny && nx > nz ? positions.getZ(i) / d + 0.5 : positions.getX(i) / w + 0.5;
      uv[i * 2 + 1] = ny >= nx && ny >= nz ? positions.getZ(i) / d + 0.5 : positions.getY(i) / h + 0.5;
    }
    geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    roundedCache.set(key, geometry);
  }
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function boxGeo(w: number, h: number, d: number): THREE.BoxGeometry {
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.BoxGeometry(w, h, d);
    geoCache.set(key, g);
  }
  return g;
}

export function box(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(boxGeo(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

export function cyl(parent: THREE.Object3D, rTop: number, rBot: number, h: number, x: number, y: number, z: number, mat: THREE.Material, seg = 14): THREE.Mesh {
  const key = `${rTop}|${rBot}|${h}|${seg}`;
  let geometry = cylinderCache.get(key);
  if (!geometry) {
    geometry = new THREE.CylinderGeometry(rTop, rBot, h, seg);
    cylinderCache.set(key, geometry);
  }
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

export function group(parent: THREE.Object3D, x = 0, z = 0, rotY = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  parent.add(g);
  return g;
}

export function officeChair(parent: THREE.Object3D, x: number, z: number, rotY = 0): THREE.Group {
  const g = group(parent, x, z, rotY);
  cyl(g, 0.03, 0.03, 0.32, 0, 0.24, 0, MAT.metal, 6);
  for (let i = 0; i < 5; i++) {
    const a = i * Math.PI * 2 / 5;
    box(g, 0.035, 0.025, 0.22, Math.sin(a) * 0.11, 0.08, Math.cos(a) * 0.11, MAT.metal).rotation.y = a;
    box(g, 0.055, 0.055, 0.055, Math.sin(a) * 0.2, 0.04, Math.cos(a) * 0.2, MAT.black);
  }
  rounded(g, 0.48, 0.08, 0.46, 0, 0.42, 0, upholstery, 0.035);
  rounded(g, 0.46, 0.5, 0.07, 0, 0.72, -0.22, upholstery, 0.03);
  box(g, 0.3, 0.035, 0.025, 0, 0.6, -0.17, MAT.charcoal);
  for (const side of [-1, 1]) {
    box(g, 0.025, 0.16, 0.025, side * 0.21, 0.53, 0.03, MAT.metal);
    box(g, 0.055, 0.035, 0.24, side * 0.21, 0.62, 0.015, MAT.black);
  }
  return g;
}

const ergonomicMesh = (() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.35;
  for (let i = 0; i <= 128; i += 4) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 128);
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ color: 0x53616b, map: texture, alphaTest: 0.25, side: THREE.DoubleSide, roughness: 0.78 });
})();
const massageCream = new THREE.MeshStandardMaterial({ color: 0xd9d1bd, roughness: 0.64 });

export function ergonomicChair(parent: THREE.Object3D, x: number, z: number, rotY = 0): THREE.Group {
  const g = group(parent, x, z, rotY);
  cyl(g, 0.035, 0.045, 0.18, 0, 0.3, 0, MAT.metal, 10);
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5;
    rounded(g, 0.04, 0.04, 0.29, Math.sin(angle) * 0.145, 0.22, Math.cos(angle) * 0.145, MAT.metal, 0.014).rotation.y = angle;
    rounded(g, 0.065, 0.07, 0.065, Math.sin(angle) * 0.28, 0.195, Math.cos(angle) * 0.28, MAT.black, 0.02);
  }
  rounded(g, 0.54, 0.1, 0.5, 0, 0.43, 0.025, upholstery, 0.04);
  box(g, 0.07, 0.47, 0.065, 0, 0.635, -0.235, MAT.black);
  for (const side of [-1, 1]) {
    rounded(g, 0.035, 0.59, 0.065, side * 0.238, 0.855, -0.235, MAT.charcoal, 0.014);
    box(g, 0.035, 0.2, 0.035, side * 0.27, 0.55, 0.015, MAT.metal);
    rounded(g, 0.08, 0.045, 0.28, side * 0.27, 0.66, 0.045, MAT.black, 0.018);
  }
  for (const y of [0.565, 1.145]) rounded(g, 0.51, 0.04, 0.065, 0, y, -0.235, MAT.charcoal, 0.017);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.54), ergonomicMesh);
  mesh.position.set(0, 0.855, -0.23);
  mesh.castShadow = mesh.receiveShadow = true;
  g.add(mesh);
  rounded(g, 0.37, 0.115, 0.09, 0, 0.7, -0.18, upholstery, 0.035);
  box(g, 0.065, 0.15, 0.04, 0, 1.19, -0.255, MAT.metal);
  rounded(g, 0.33, 0.15, 0.12, 0, 1.285, -0.24, upholstery, 0.045).rotation.x = -0.12;
  return g;
}

const massageGeometryCache = new Map<string, THREE.BufferGeometry>();
const massageShell = new THREE.MeshStandardMaterial({ color: 0x303c42, roughness: 0.32, metalness: 0.22 });
const massageInset = new THREE.MeshStandardMaterial({ color: 0x8c8372, roughness: 0.85 });

function massageGeometry(kind: "flank" | "spine" | "base" | "boot" | "cushion"): THREE.BufferGeometry {
  const cached = massageGeometryCache.get(kind);
  if (cached) return cached;
  let geometry: THREE.BufferGeometry;
  if (kind === "cushion") geometry = new THREE.SphereGeometry(1, 12, 8);
  else {
    const shape = new THREE.Shape();
    if (kind === "flank") {
      shape.moveTo(0.43, -0.1);
      shape.bezierCurveTo(0.51, 0.1, 0.24, 0.28, 0.18, 0.48);
      shape.bezierCurveTo(0.13, 0.77, 0.12, 1.07, -0.12, 1.12);
      shape.bezierCurveTo(-0.36, 1.16, -0.48, 0.92, -0.47, 0.67);
      shape.bezierCurveTo(-0.5, 0.39, -0.4, -0.02, -0.26, -0.12);
      shape.bezierCurveTo(-0.1, -0.23, 0.29, -0.24, 0.43, -0.1);
    } else if (kind === "spine") {
      shape.moveTo(-0.17, -0.08);
      shape.bezierCurveTo(-0.4, 0.26, -0.45, 0.85, -0.26, 1.09);
      shape.bezierCurveTo(-0.18, 1.16, -0.08, 1.15, 0.015, 1.08);
      shape.lineTo(0.035, 1.0);
      shape.bezierCurveTo(-0.16, 1.08, -0.25, 0.88, -0.24, 0.63);
      shape.bezierCurveTo(-0.26, 0.36, -0.17, 0.12, -0.05, -0.04);
      shape.closePath();
    } else if (kind === "base") {
      shape.absellipse(0, 0, 0.52, 0.55, 0, Math.PI * 2, false, 0);
    } else {
      shape.moveTo(-0.16, -0.1);
      shape.quadraticCurveTo(-0.16, -0.18, -0.08, -0.18);
      shape.lineTo(0.08, -0.18);
      shape.quadraticCurveTo(0.16, -0.18, 0.16, -0.1);
      shape.lineTo(0.16, 0.12);
      shape.quadraticCurveTo(0.16, 0.2, 0.08, 0.2);
      shape.lineTo(-0.08, 0.2);
      shape.quadraticCurveTo(-0.16, 0.2, -0.16, 0.12);
      shape.closePath();
      const opening = new THREE.Path();
      opening.moveTo(-0.115, -0.09);
      opening.quadraticCurveTo(-0.115, -0.135, -0.07, -0.135);
      opening.lineTo(0.07, -0.135);
      opening.quadraticCurveTo(0.115, -0.135, 0.115, -0.09);
      opening.lineTo(0.115, 0.105);
      opening.quadraticCurveTo(0.115, 0.155, 0.065, 0.155);
      opening.lineTo(-0.065, 0.155);
      opening.quadraticCurveTo(-0.115, 0.155, -0.115, 0.105);
      opening.closePath();
      shape.holes.push(opening);
    }
    const depth = kind === "flank" ? 0.16 : kind === "spine" ? 1.02 : kind === "base" ? 0.11 : 0.075;
    geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, curveSegments: 6, bevelEnabled: true, bevelSegments: 2, bevelSize: 0.012, bevelThickness: 0.012 });
    if (kind === "flank" || kind === "spine") {
      geometry.rotateY(-Math.PI / 2);
      geometry.translate(depth / 2, 0, 0);
    } else geometry.rotateX(-Math.PI / 2);
  }
  massageGeometryCache.set(kind, geometry);
  return geometry;
}

function massagePart(parent: THREE.Object3D, kind: "flank" | "spine" | "base" | "boot" | "cushion", x: number, y: number, z: number, material: THREE.Material, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(massageGeometry(kind), material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.keep = true;
  mesh.userData.massageAirbag = kind === "cushion" && material === massageCream;
  parent.add(mesh);
  return mesh;
}

export function massageChair(parent: THREE.Object3D, x: number, z: number, rotY = 0): { root: THREE.Group; back: THREE.Group; legRest: THREE.Group } {
  const root = group(parent, x, z, rotY);
  massagePart(root, "base", 0, 0.172, -0.05, massageShell);
  massagePart(root, "base", 0, 0.285, -0.05, MAT.metal, 0.95, 0.12, 0.96);
  rounded(root, 0.85, 0.18, 0.77, 0, 0.38, 0, massageShell, 0.07);
  rounded(root, 0.73, 0.12, 0.65, 0, 0.42, 0.045, massageCream, 0.055);
  const back = group(root);
  back.position.set(0, 0.48, -0.2);
  massagePart(back, "spine", 0, 0, 0, massageShell);
  massagePart(back, "cushion", 0, 0.52, -0.125, massageCream, 0.4, 0.5, 0.15);
  massagePart(back, "cushion", 0, 0.89, -0.035, massageCream, 0.24, 0.19, 0.105);
  massagePart(back, "cushion", 0, 0.18, 0.065, massageCream, 0.34, 0.16, 0.09);
  for (const side of [-1, 1]) {
    massagePart(back, "flank", side * 0.57, 0, 0, massageShell);
    massagePart(back, "flank", side * 0.496, 0.025, 0.015, massageCream, 0.36, 0.95, 0.9);
    massagePart(back, "cushion", side * 0.365, 0.72, 0.1, massageCream, 0.115, 0.24, 0.19).rotation.z = side * -0.18;
    massagePart(back, "cushion", side * 0.32, 0.99, 0.025, massageCream, 0.105, 0.15, 0.16);
    massagePart(root, "cushion", side * 0.465, 0.59, 0.13, massageShell, 0.19, 0.21, 0.46);
    massagePart(root, "cushion", side * 0.46, 0.732, 0.13, massageInset, 0.12, 0.04, 0.32);
    for (const edge of [-1, 1]) massagePart(root, "cushion", side * 0.46 + edge * 0.085, 0.755, 0.12, massageCream, 0.055, 0.075, 0.32);
    massagePart(root, "cushion", side * 0.46, 0.74, 0.4, massageCream, 0.13, 0.07, 0.065);
  }
  const legRest = group(root);
  legRest.position.set(0, 0.46, 0.35);
  rounded(legRest, 0.71, 0.24, 0.16, 0, -0.1, -0.015, massageShell, 0.06);
  for (const side of [-1, 1]) {
    const px = side * 0.175;
    massagePart(legRest, "cushion", px, -0.085, 0.025, massageInset, 0.135, 0.19, 0.105);
    for (const edge of [-1, 1]) massagePart(legRest, "cushion", px + edge * 0.117, -0.08, 0.085, massageCream, 0.047, 0.18, 0.115);
    massagePart(legRest, "boot", px, -0.285, 0.16, massageShell);
    rounded(legRest, 0.27, 0.035, 0.22, px, -0.22, 0.16, massageCream, 0.015);
  }
  const controller = group(root);
  controller.position.set(0.49, 0.83, 0.28);
  controller.rotation.x = -0.4;
  rounded(controller, 0.15, 0.025, 0.21, 0, 0, 0, massageShell, 0.012);
  rounded(controller, 0.122, 0.006, 0.16, 0, 0.016, -0.008, MAT.screenAlt, 0.006);
  for (const offset of [-0.032, 0.032]) cyl(controller, 0.012, 0.012, 0.005, offset, 0.018, 0.079, MAT.metal, 8);
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) object.userData.keep = true;
  });
  return { root, back, legRest };
}

export function monitor(parent: THREE.Object3D, x: number, y: number, z: number, rotY = 0, wide = false, alt = false): void {
  const g = group(parent, x, z, rotY);
  g.position.y = y;
  const w = wide ? 0.78 : 0.56;
  box(g, 0.05, 0.16, 0.05, 0, 0.08, 0.02, MAT.black);
  box(g, 0.2, 0.02, 0.14, 0, 0.01, 0.02, MAT.black);
  box(g, w + 0.04, 0.36, 0.035, 0, 0.32, 0, MAT.frame);
  box(g, w, 0.32, 0.01, 0, 0.32, -0.02, alt ? MAT.screenAlt : MAT.screen);
}

export function portraitMonitor(parent: THREE.Object3D, x: number, y: number, z: number, rotY = 0, alt = false): void {
  const g = group(parent, x, z, rotY);
  g.position.y = y;
  box(g, 0.05, 0.14, 0.05, 0, 0.07, 0.02, MAT.black);
  box(g, 0.18, 0.02, 0.14, 0, 0.01, 0.02, MAT.black);
  box(g, 0.34, 0.6, 0.035, 0, 0.44, 0, MAT.frame);
  box(g, 0.3, 0.56, 0.01, 0, 0.44, -0.02, alt ? MAT.screenAlt : MAT.screen);
}

export function monitorTrio(parent: THREE.Object3D, y: number, z: number, faceY: number, spacing = 1): void {
  portraitMonitor(parent, -0.62 * spacing, y, z, faceY, false);
  monitor(parent, -0.1 * spacing, y, z, faceY, false, true);
  monitor(parent, 0.52 * spacing, y, z, faceY, false, false);
}

const workstationGeometry = new Map<string, THREE.BufferGeometry>();

function batchWorkstation(root: THREE.Group, name: string, exclude: Set<THREE.Object3D> = new Set()): void {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const buckets = new Map<THREE.Material, THREE.Mesh[]>();
  const visit = (object: THREE.Object3D) => {
    if (exclude.has(object)) return;
    if ((object as THREE.Mesh).isMesh && !Array.isArray((object as THREE.Mesh).material) && !(object as THREE.InstancedMesh).isInstancedMesh) {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.Material;
      const list = buckets.get(material) ?? [];
      list.push(mesh); buckets.set(material, list);
    }
    for (const child of object.children) visit(child);
  };
  for (const child of root.children) visit(child);
  for (const [material, meshes] of buckets) {
    const key = `${name}:${material.uuid}`;
    let geometry = workstationGeometry.get(key);
    if (!geometry) {
      const parts = meshes.map(mesh => {
        const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
        return geometry.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));
      });
      geometry = mergeGeometries(parts, false)!;
      parts.forEach(part => part.dispose());
      workstationGeometry.set(key, geometry);
    }
    meshes.forEach(mesh => mesh.removeFromParent());
    const merged = new THREE.Mesh(geometry, material);
    merged.castShadow = merged.receiveShadow = true;
    root.add(merged);
  }
}

function workstationRod(parent: THREE.Object3D, from: number[], to: number[], radius: number, material: THREE.Material): THREE.Mesh {
  const a = new THREE.Vector3().fromArray(from), b = new THREE.Vector3().fromArray(to);
  const middle = a.clone().add(b).multiplyScalar(0.5);
  const rod = cyl(parent, radius, radius, a.distanceTo(b), middle.x, middle.y, middle.z, material, 8);
  rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
  return rod;
}

function workstationChair(parent: THREE.Object3D): { chair: THREE.Group; chairSeat: THREE.Group; chairBack: THREE.Group; chairLift: THREE.Mesh } {
  const chair = group(parent, 0, 0.58, Math.PI); chair.name = "workstation-ergonomic-chair";
  cyl(chair, 0.035, 0.05, 0.22, 0, 0.28, 0, MAT.metal, 12);
  cyl(chair, 0.075, 0.075, 0.04, 0, 0.17, 0, MAT.black, 12);
  const chairLift = cyl(chair, 0.027, 0.027, 1, 0, 0.36, 0, MAT.metal, 12);
  chairLift.name = "workstation-chair-lift"; chairLift.scale.y = 0.04;
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5;
    const px = Math.sin(angle) * 0.28, pz = Math.cos(angle) * 0.28;
    workstationRod(chair, [0, 0.18, 0], [px, 0.1, pz], 0.022, MAT.metal);
    box(chair, 0.06, 0.045, 0.05, px, 0.09, pz, MAT.charcoal);
    for (const side of [-1, 1]) {
      const wheel = cyl(chair, 0.038, 0.038, 0.02, px + Math.cos(angle) * side * 0.026, 0.058, pz - Math.sin(angle) * side * 0.026, MAT.black, 10);
      wheel.rotation.z = Math.PI / 2; wheel.rotation.y = angle;
    }
  }
  const chairSeat = group(chair); chairSeat.name = "workstation-chair-seat"; chairSeat.position.y = 0.44;
  rounded(chairSeat, 0.58, 0.08, 0.52, 0, 0, 0.015, upholstery, 0.035);
  box(chairSeat, 0.32, 0.035, 0.24, 0, -0.065, 0, MAT.black);
  workstationRod(chairSeat, [0.13, -0.065, 0], [0.3, -0.065, 0.06], 0.012, MAT.metal);
  rounded(chairSeat, 0.065, 0.018, 0.035, 0.3, -0.06, 0.075, MAT.black, 0.008);
  for (const side of [-1, 1]) {
    box(chairSeat, 0.028, 0.2, 0.035, side * 0.29, 0.085, 0.04, MAT.metal);
    rounded(chairSeat, 0.075, 0.035, 0.26, side * 0.29, 0.2, 0.055, MAT.black, 0.012);
    box(chairSeat, 0.045, 0.02, 0.035, side * 0.29, 0.155, 0.15, MAT.charcoal);
  }
  const chairBack = group(chairSeat); chairBack.name = "workstation-chair-back"; chairBack.position.set(0, 0.09, -0.21);
  for (const side of [-1, 1]) {
    rounded(chairBack, 0.035, 0.57, 0.055, side * 0.245, 0.3, -0.025, MAT.charcoal, 0.012);
    workstationRod(chairBack, [side * 0.15, -0.09, 0], [side * 0.21, 0.28, -0.04], 0.016, MAT.black);
  }
  for (const y of [0.02, 0.57]) rounded(chairBack, 0.5, 0.035, 0.055, 0, y, -0.025, MAT.charcoal, 0.012);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.52), ergonomicMesh); mesh.position.set(0, 0.295, -0.02); chairBack.add(mesh);
  rounded(chairBack, 0.4, 0.105, 0.085, 0, 0.16, 0.025, upholstery, 0.03);
  box(chairBack, 0.045, 0.1, 0.035, 0, 0.62, -0.045, MAT.metal);
  rounded(chairBack, 0.34, 0.13, 0.105, 0, 0.7, -0.02, upholstery, 0.04).rotation.x = -0.12;
  batchWorkstation(chair, "chair-base", new Set([chairSeat, chairLift]));
  batchWorkstation(chairSeat, "chair-seat", new Set([chairBack]));
  batchWorkstation(chairBack, "chair-back");
  return { chair, chairSeat, chairBack, chairLift };
}

export function workstation(parent: THREE.Object3D, x: number, z: number): THREE.Group {
  const g = group(parent, x, z);
  g.name = "agent-workstation";
  rounded(g, 1.78, 0.06, 0.82, 0, 0.74, 0, MAT.wood, 0.024);
  box(g, 0.05, 0.72, 0.72, -0.84, 0.36, 0, MAT.black);
  box(g, 0.05, 0.72, 0.72, 0.84, 0.36, 0, MAT.black);
  box(g, 1.6, 0.36, 0.03, 0, 0.52, -0.32, MAT.black);
  box(g, 1.72, 0.012, 0.02, 0, 0.72, 0.405, brass);
  rounded(g, 0.96, 0.008, 0.34, 0.08, 0.775, 0.2, upholstery, 0.003);
  box(g, 0.84, 0.08, 0.12, 0, 0.64, -0.26, MAT.charcoal);
  box(g, 0.018, 0.5, 0.018, 0.79, 0.37, -0.27, MAT.charcoal);
  monitorTrio(g, 0.77, -0.14, Math.PI);
  const gear = (name: string, px: number, py: number, pz: number, parent: THREE.Object3D = g) => {
    const root = group(parent, px, pz); root.position.y = py; root.name = `workstation-${name}`; return root;
  };
  const keyboardTray = gear("keyboard-tray", -0.1, 0.76, 0.29);
  box(keyboardTray, 0.59, 0.018, 0.24, 0, 0, 0, MAT.charcoal);
  const keyboard = gear("keyboard", 0, 0.034, 0, keyboardTray);
  rounded(keyboard, 0.52, 0.025, 0.18, 0, 0, 0, MAT.black, 0.012);
  box(keyboard, 0.49, 0.004, 0.158, 0, 0.013, 0, MAT.ledBlue);
  const keys = new THREE.InstancedMesh(boxGeo(0.028, 0.012, 0.025), MAT.white, 56);
  keys.name = "workstation-keycaps"; keys.castShadow = true;
  const keyRest: THREE.Matrix4[] = [];
  for (let row = 0; row < 4; row++) for (let column = 0; column < 14; column++) {
    const matrix = new THREE.Matrix4().makeTranslation((column - 6.5) * 0.034, 0.023, (row - 1.5) * 0.034);
    keys.setMatrixAt(row * 14 + column, matrix); keyRest.push(matrix);
  }
  keyboard.add(keys);
  rounded(keyboard, 0.19, 0.012, 0.025, -0.025, 0.023, 0.078, MAT.charcoal, 0.004);
  const mouseTray = gear("mouse-tray", 0.36, 0.76, 0.35);
  rounded(mouseTray, 0.22, 0.015, 0.12, 0, 0, 0, upholstery, 0.006);
  const mouse = gear("mouse", 0, 0.035, 0, mouseTray);
  rounded(mouse, 0.085, 0.032, 0.12, 0, 0, 0, MAT.white, 0.016);
  for (const side of [-1, 1]) rounded(mouse, 0.034, 0.007, 0.05, side * 0.021, 0.019, -0.025, MAT.charcoal, 0.004).name = `workstation-mouse-button-${side}`;
  const wheel = cyl(mouse, 0.009, 0.009, 0.014, 0, 0.023, -0.02, MAT.black, 8); wheel.rotation.z = Math.PI / 2; wheel.name = "workstation-mouse-wheel";
  const notebook = gear("notebook", -0.69, 0.775, 0.18);
  rounded(notebook, 0.22, 0.025, 0.28, 0, 0.012, 0, MAT.fabric, 0.008);
  box(notebook, 0.19, 0.015, 0.25, 0.007, 0.021, 0, MAT.white);
  for (let line = 0; line < 5; line++) box(notebook, 0.13, 0.002, 0.003, 0.01, 0.03, -0.08 + line * 0.035, MAT.metal);
  const pen = gear("pen", -0.07, 0.042, 0.01, notebook);
  box(pen, 0.012, 0.012, 0.2, 0, 0, 0, brass);
  const cupTray = gear("cup-tray", 0.73, 0.775, 0.2);
  cyl(cupTray, 0.075, 0.075, 0.012, 0, -0.009, 0, MAT.charcoal, 16);
  const mug = gear("mug", 0, 0, 0, cupTray);
  cyl(mug, 0.055, 0.045, 0.09, 0, 0.045, 0, MAT.white, 16);
  cyl(mug, 0.043, 0.043, 0.003, 0, 0.092, 0, MAT.woodDark, 16);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.029, 0.008, 6, 14), MAT.white); handle.position.set(0.055, 0.05, 0); mug.add(handle);
  for (const side of [-1, 1]) {
    const speaker = gear(`speaker-${side}`, side * 0.8, 0.775, -0.29);
    rounded(speaker, 0.12, 0.18, 0.115, 0, 0.09, 0, MAT.black, 0.012);
    for (const height of [0.052, 0.13]) { const driver = cyl(speaker, 0.027, 0.027, 0.008, 0, height, 0.061, MAT.metal, 12); driver.rotation.x = Math.PI / 2; }
    box(speaker, 0.012, 0.008, 0.003, 0.035, 0.025, 0.065, MAT.ledGreen);
  }
  for (const px of [-0.62, -0.1, 0.52]) {
    workstationRod(g, [px, 0.82, -0.12], [px * 0.6, 1.02, -0.3], 0.014, MAT.metal);
    box(g, 0.08, 0.06, 0.055, px * 0.6, 1.02, -0.3, MAT.black);
  }
  const webcam = gear("webcam", -0.1, 1.29, -0.14);
  rounded(webcam, 0.1, 0.035, 0.035, 0, 0, 0, MAT.black, 0.008);
  const lens = cyl(webcam, 0.012, 0.012, 0.006, 0, 0, 0.02, MAT.metal, 12); lens.rotation.x = Math.PI / 2;
  const lightbar = gear("monitor-lightbar", 0.52, 1.29, -0.12);
  box(lightbar, 0.36, 0.022, 0.035, 0, 0, 0, MAT.black); box(lightbar, 0.32, 0.005, 0.02, 0, -0.013, 0.01, MAT.ledWarm);
  const mic = gear("microphone", 0.77, 0.78, -0.015);
  cyl(mic, 0.045, 0.045, 0.018, 0, 0, 0, MAT.black, 12);
  workstationRod(mic, [0, 0.015, 0], [0, 0.22, 0], 0.012, MAT.metal);
  workstationRod(mic, [0, 0.22, 0], [-0.15, 0.28, 0.06], 0.012, MAT.black);
  rounded(mic, 0.055, 0.11, 0.055, -0.15, 0.235, 0.06, MAT.charcoal, 0.018).rotation.z = -0.35;
  const headset = gear("headset", -0.78, 0.775, -0.015);
  cyl(headset, 0.055, 0.065, 0.018, 0, 0.009, 0, MAT.black, 12);
  box(headset, 0.015, 0.21, 0.018, 0, 0.12, 0, MAT.metal);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.009, 6, 18, Math.PI), MAT.black); band.position.y = 0.22; headset.add(band);
  for (const side of [-1, 1]) rounded(headset, 0.03, 0.07, 0.055, side * 0.075, 0.19, 0, upholstery, 0.012);
  const phone = gear("phone", 0.62, 0.79, -0.03); phone.rotation.x = -0.48;
  rounded(phone, 0.065, 0.12, 0.012, 0, 0.04, 0, MAT.black, 0.008);
  box(phone, 0.055, 0.09, 0.004, 0, 0.045, 0.009, MAT.screenAlt);
  workstationRod(g, [0.62, 0.78, -0.02], [0.62, 0.86, -0.06], 0.01, MAT.metal);
  const dock = gear("dock", 0.6, 0.785, 0.05);
  rounded(dock, 0.11, 0.025, 0.06, 0, 0, 0, MAT.metal, 0.005);
  for (let port = 0; port < 3; port++) box(dock, 0.018, 0.009, 0.003, -0.034 + port * 0.034, 0, 0.032, MAT.black);
  const lamp = gear("lamp", -0.39, 0.775, -0.34);
  cyl(lamp, 0.055, 0.06, 0.018, 0, 0.009, 0, MAT.black, 12);
  workstationRod(lamp, [0, 0.01, 0], [0, 0.43, 0], 0.011, MAT.metal);
  workstationRod(lamp, [0, 0.43, 0], [0.15, 0.45, 0.06], 0.011, MAT.metal);
  rounded(lamp, 0.22, 0.025, 0.06, 0.15, 0.45, 0.06, MAT.black, 0.01);
  box(lamp, 0.18, 0.005, 0.045, 0.15, 0.434, 0.06, MAT.ledWarm);
  const tower = gear("pc", 0.62, 0.1, -0.04);
  rounded(tower, 0.25, 0.48, 0.4, 0, 0.24, 0, MAT.black, 0.018);
  box(tower, 0.004, 0.37, 0.29, -0.127, 0.25, 0, MAT.glass);
  box(tower, 0.18, 0.01, 0.01, 0, 0.46, 0.203, MAT.ledBlue);
  const fans: THREE.Group[] = [];
  for (const py of [0.14, 0.34]) {
    const fan = gear("pc-fan", 0, py, 0.208, tower); fans.push(fan);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.069, 0.006, 6, 18), MAT.ledBlue); fan.add(ring);
    cyl(fan, 0.018, 0.018, 0.016, 0, 0, 0, MAT.metal, 10).rotation.x = Math.PI / 2;
    const blades = new THREE.InstancedMesh(boxGeo(0.025, 0.07, 0.006), MAT.charcoal, 7);
    for (let i = 0; i < 7; i++) { const angle = i * Math.PI * 2 / 7; const matrix = new THREE.Matrix4().makeRotationZ(-angle + 0.3); matrix.setPosition(Math.sin(angle) * 0.036, Math.cos(angle) * 0.036, 0); blades.setMatrixAt(i, matrix); } fan.add(blades);
  }
  const cableTray = gear("cable-tray", 0, 0.6, -0.28);
  box(cableTray, 1.24, 0.03, 0.14, 0, 0, 0, MAT.black);
  for (const px of [-0.4, 0, 0.4]) workstationRod(g, [px, 0.77, -0.29], [px, 0.61, -0.29], 0.008, MAT.charcoal);
  const { chair, chairSeat, chairBack, chairLift } = workstationChair(g);
  const footrest = gear("footrest", 0, 0.27, 0.68);
  rounded(footrest, 0.84, 0.035, 0.28, 0, 0, 0, MAT.charcoal, 0.012);
  for (let strip = 0; strip < 5; strip++) box(footrest, 0.78, 0.005, 0.008, 0, 0.02, -0.1 + strip * 0.05, MAT.black);
  const supportLinks: THREE.Mesh[] = [];
  for (const tray of [keyboardTray, mouseTray, cupTray]) {
    const links: THREE.Mesh[] = [];
    for (const offset of tray === keyboardTray ? [-0.22, 0.22] : [0]) {
      const from = new THREE.Vector3(tray.position.x + offset, 0.72, 0.06);
      const localEnd = new THREE.Vector3(offset, -0.025, -0.04);
      const to = tray.position.clone().add(localEnd);
      const middle = from.clone().add(to).multiplyScalar(0.5);
      const link = box(g, 0.018, 1, 0.018, middle.x, middle.y, middle.z, MAT.metal);
      link.scale.y = from.distanceTo(to);
      link.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.sub(from).normalize());
      link.userData.from = from; link.userData.offset = localEnd;
      links.push(link); supportLinks.push(link);
    }
    tray.userData.supportLinks = links;
  }
  const footMount = cyl(g, 0.012, 0.012, 1, 0, 0.28, 0.63, MAT.metal, 10);
  footMount.name = "workstation-footrest-mount"; footMount.scale.y = 0.1;
  footMount.userData.supportAnchor = chair;
  footMount.userData.anchorOffset = new THREE.Vector3(0, 0.3, 0);
  footMount.userData.offset = new THREE.Vector3(0, -0.02, 0);
  supportLinks.push(footMount);
  footrest.userData.supportLinks = [footMount];
  const excluded = new Set<THREE.Object3D>([keyboardTray, mouseTray, notebook, cupTray, chair, footrest, ...fans, ...supportLinks]);
  batchWorkstation(g, "workstation-fixed", excluded);
  batchWorkstation(keyboardTray, "keyboard-tray", new Set([keyboard]));
  batchWorkstation(keyboard, "keyboard", new Set([keys]));
  batchWorkstation(mouseTray, "mouse-tray", new Set([mouse])); batchWorkstation(mouse, "mouse", new Set(mouse.children.filter(part => part.name.startsWith("workstation-mouse-"))));
  batchWorkstation(notebook, "notebook", new Set([pen])); batchWorkstation(pen, "pen"); batchWorkstation(mug, "mug");
  batchWorkstation(footrest, "footrest");
  for (const part of excluded) part.traverse(object => { if ((object as THREE.Mesh).isMesh) object.userData.keep = true; });
  g.userData.workstation = { keyboard, mouse, mug, notebook, pen, chair, chairSeat, chairBack, chairLift, keys, keyRest, fans, keyboardTray, mouseTray, cupTray, footrest, headset, mic, lamp, phone, seatHeight: 0.48 };
  return g;
}

const leafGeo = new THREE.SphereGeometry(1, 6, 4);

const appleSilver = new THREE.MeshStandardMaterial({ color: 0xcbd0d6, roughness: 0.29, metalness: 0.68 });
const appleInk = new THREE.MeshStandardMaterial({ color: 0x262d35, roughness: 0.38, metalness: 0.25 });
const appleWhite = new THREE.MeshStandardMaterial({ color: 0xf5f6f6, roughness: 0.32 });
const appleLogoGeometry = (() => {
  const fruit = new THREE.Shape();
  fruit.moveTo(0.03, 0.29);
  fruit.bezierCurveTo(0.2, 0.43, 0.4, 0.37, 0.45, 0.23);
  fruit.bezierCurveTo(0.23, 0.17, 0.24, -0.06, 0.44, -0.13);
  fruit.bezierCurveTo(0.36, -0.36, 0.26, -0.47, 0.13, -0.43);
  fruit.bezierCurveTo(0.02, -0.38, -0.03, -0.38, -0.15, -0.44);
  fruit.bezierCurveTo(-0.3, -0.5, -0.46, -0.22, -0.47, 0.03);
  fruit.bezierCurveTo(-0.48, 0.3, -0.25, 0.43, -0.1, 0.34);
  fruit.bezierCurveTo(-0.04, 0.3, 0, 0.29, 0.03, 0.29);
  const leaf = new THREE.Shape();
  leaf.moveTo(-0.015, 0.37);
  leaf.bezierCurveTo(-0.02, 0.53, 0.12, 0.63, 0.22, 0.62);
  leaf.bezierCurveTo(0.22, 0.48, 0.1, 0.38, -0.015, 0.37);
  return new THREE.ShapeGeometry([fruit, leaf], 8);
})();

function appleLogo(parent: THREE.Object3D, x: number, y: number, z: number, size: number): void {
  const logo = new THREE.Mesh(appleLogoGeometry, appleInk);
  logo.position.set(x, y, z);
  logo.scale.setScalar(size);
  parent.add(logo);
}

function executiveDevices(parent: THREE.Object3D): void {
  for (const x of [-0.95, 0, 0.95]) {
    const display = group(parent, x, 0.34 - Math.abs(x) * 0.08, x * 0.2);
    rounded(display, 0.3, 0.025, 0.25, 0, 0.835, 0.04, appleSilver, 0.01);
    box(display, 0.095, 0.22, 0.045, 0, 0.95, 0.065, appleSilver);
    rounded(display, 0.89, 0.48, 0.035, 0, 1.12, 0, appleSilver, 0.015);
    box(display, 0.855, 0.445, 0.005, 0, 1.12, -0.02, MAT.black);
    box(display, 0.825, 0.41, 0.004, 0, 1.12, -0.024, MAT.screenAlt);
    appleLogo(display, 0, 1.13, 0.019, 0.12);
    cyl(display, 0.007, 0.007, 0.004, 0, 1.344, -0.024, appleInk, 8).rotation.x = Math.PI / 2;
  }
  rounded(parent, 1.8, 0.008, 0.58, 0, 0.824, -0.05, upholstery, 0.003);
  rounded(parent, 0.64, 0.02, 0.22, 0, 0.842, -0.18, appleSilver, 0.008);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 11; col++) box(parent, 0.044, 0.004, 0.033, -0.265 + col * 0.053, 0.854, -0.25 + row * 0.045, appleWhite);
  }
  rounded(parent, 0.25, 0.017, 0.23, 0.55, 0.843, -0.18, appleWhite, 0.007);
  const mac = group(parent, -2.0, -0.04, -0.15);
  rounded(mac, 0.7, 0.025, 0.45, 0, 0.835, 0, appleSilver, 0.01);
  box(mac, 0.58, 0.005, 0.17, 0, 0.851, 0.065, appleInk);
  rounded(mac, 0.21, 0.003, 0.105, 0, 0.851, -0.125, MAT.metal, 0.001);
  for (let row = 0; row < 3; row++) box(mac, 0.54, 0.002, 0.008, 0, 0.855, 0.01 + row * 0.05, MAT.metal);
  const lid = group(mac, 0, 0.245);
  lid.position.y = 1.056;
  lid.rotation.x = 0.18;
  rounded(lid, 0.7, 0.42, 0.018, 0, 0, 0, appleSilver, 0.007);
  box(lid, 0.66, 0.38, 0.004, 0, 0, -0.011, appleInk);
  box(lid, 0.625, 0.35, 0.003, 0, 0, -0.014, MAT.screen);
  appleLogo(lid, 0, 0, 0.01, 0.13);
  const tablet = group(parent, 2.0, 0.205, 0.15);
  rounded(tablet, 0.35, 0.02, 0.24, 0, 0.835, 0.04, appleSilver, 0.008);
  box(tablet, 0.05, 0.18, 0.05, 0, 0.92, 0.08, appleSilver);
  const pad = group(tablet);
  pad.position.y = 1.08;
  pad.rotation.x = 0.28;
  rounded(pad, 0.62, 0.4, 0.018, 0, 0, 0, appleSilver, 0.008);
  rounded(pad, 0.59, 0.37, 0.005, 0, 0, -0.011, appleInk, 0.002);
  box(pad, 0.56, 0.34, 0.003, 0, 0, -0.015, MAT.screenAlt);
  appleLogo(pad, 0, 0, 0.01, 0.075);
  rounded(pad, 0.055, 0.055, 0.009, -0.25, 0.14, 0.013, appleInk, 0.004);
  cyl(pad, 0.014, 0.014, 0.004, -0.25, 0.14, 0.02, MAT.black, 10).rotation.x = Math.PI / 2;
  rounded(parent, 0.19, 0.065, 0.135, -0.55, 0.853, -0.18, appleWhite, 0.027);
  box(parent, 0.14, 0.002, 0.001, -0.55, 0.868, -0.248, MAT.metal);
  cyl(parent, 0.003, 0.003, 0.001, -0.55, 0.845, -0.248, MAT.ledGreen, 6).rotation.x = Math.PI / 2;
}

export function executiveDesk(parent: THREE.Object3D, x: number, z: number): void {
  const g = group(parent, x, z);
  const w = 2.9;
  const d = 0.675;
  const r = 0.22;
  const outline = new THREE.Shape();
  outline.moveTo(-w + r, -d);
  outline.lineTo(w - r, -d);
  outline.quadraticCurveTo(w, -d, w, -d + r);
  outline.lineTo(w, d - r);
  outline.quadraticCurveTo(w, d, w - r, d);
  outline.lineTo(-w + r, d);
  outline.quadraticCurveTo(-w, d, -w, d - r);
  outline.lineTo(-w, -d + r);
  outline.quadraticCurveTo(-w, -d, -w + r, -d);
  const geometry = new THREE.ExtrudeGeometry(outline, { depth: 0.06, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.012, bevelThickness: 0.01, curveSegments: 6 });
  geometry.rotateX(-Math.PI / 2);
  const top = new THREE.Mesh(geometry, MAT.woodDark);
  top.position.set(0, 0.75, 0.05);
  top.castShadow = top.receiveShadow = true;
  g.add(top);
  rounded(g, 5.55, 0.04, 1.12, 0, 0.73, 0.05, MAT.charcoal, 0.015);
  for (const side of [-1, 1]) {
    for (const dz of [-0.42, 0.48]) box(g, 0.07, 0.6, 0.07, side * 2.5, 0.42, dz, MAT.metal);
    rounded(g, 0.13, 0.045, 1.02, side * 2.5, 0.125, 0.03, MAT.charcoal, 0.018);
  }
  rounded(g, 3.9, 0.44, 0.045, 0, 0.5, 0.55, MAT.charcoal, 0.015);
  box(g, 3.7, 0.012, 0.012, 0, 0.68, 0.579, brass);
  for (const side of [-1, 1]) {
    rounded(g, 0.72, 0.53, 0.96, side * 2.22, 0.42, 0.03, MAT.white, 0.035);
    for (const y of [0.29, 0.47, 0.63]) {
      box(g, 0.62, 0.012, 0.012, side * 2.22, y, 0.515, MAT.charcoal);
      box(g, 0.16, 0.012, 0.02, side * 2.22, y - 0.05, 0.515, MAT.metal);
    }
  }
  executiveDevices(g);
  box(g, 1.3, 0.09, 0.12, 0, 0.65, -0.4, MAT.charcoal);
}

export function plant(parent: THREE.Object3D, x: number, z: number, scale = 1, tall = false): void {
  const g = group(parent, x, z);
  g.scale.setScalar(scale);
  cyl(g, 0.24, 0.18, 0.42, 0, 0.21, 0, MAT.pot, 18);
  cyl(g, 0.241, 0.24, 0.018, 0, 0.395, 0, brass, 18);
  cyl(g, 0.215, 0.215, 0.012, 0, 0.418, 0, MAT.woodDark, 14);
  cyl(g, 0.018, 0.03, tall ? 0.95 : 0.4, 0, tall ? 0.89 : 0.62, 0, MAT.woodDark, 6);
  const n = tall ? 11 : 8;
  for (let i = 0; i < n; i++) {
    const a = i * 2.4;
    const r = 0.16 + (i % 3) * 0.035;
    const leaf = new THREE.Mesh(leafGeo, i % 2 ? MAT.leaf : MAT.leafDark);
    leaf.position.set(Math.cos(a) * r, 0.58 + (tall ? i * 0.085 : (i % 3) * 0.09), Math.sin(a) * r);
    leaf.scale.set(0.19, tall ? 0.33 : 0.26, 0.085);
    leaf.rotation.set(0.35, -a, Math.sin(a) * 0.8);
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    g.add(leaf);
  }
}

export function sofa(parent: THREE.Object3D, x: number, z: number, rotY: number, seats = 3, mat: THREE.Material = MAT.fabric): void {
  const g = group(parent, x, z, rotY);
  const w = seats * 0.75 + 0.3;
  rounded(g, w, 0.32, 0.85, 0, 0.26, 0, mat, 0.07);
  rounded(g, w, 0.55, 0.22, 0, 0.55, -0.32, mat, 0.08);
  rounded(g, 0.18, 0.44, 0.85, -w / 2 + 0.09, 0.4, 0, mat, 0.07);
  rounded(g, 0.18, 0.44, 0.85, w / 2 - 0.09, 0.4, 0, mat, 0.07);
  for (let i = 0; i < seats; i++) {
    const px = -w / 2 + 0.6 + i * 0.75;
    rounded(g, 0.68, 0.1, 0.6, px, 0.47, 0.05, MAT.fabricLight, 0.04);
    rounded(g, 0.65, 0.28, 0.09, px, 0.66, -0.19, mat, 0.04);
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(g, 0.025, 0.02, 0.1, sx * (w / 2 - 0.12), 0.05, sz * 0.3, brass, 6);
}

export function coffeeTable(parent: THREE.Object3D, x: number, z: number, w = 1.2, d = 0.7): void {
  const g = group(parent, x, z);
  rounded(g, w, 0.06, d, 0, 0.38, 0, MAT.marble, 0.025);
  for (const sx of [-1, 1]) box(g, 0.055, 0.32, d - 0.16, sx * (w / 2 - 0.12), 0.18, 0, brass);
  box(g, w - 0.2, 0.025, d - 0.18, 0, 0.12, 0, MAT.woodDark);
  box(g, 0.28, 0.018, 0.22, -w * 0.2, 0.42, 0, MAT.fabric);
  box(g, 0.26, 0.008, 0.2, -w * 0.2, 0.433, 0, MAT.white);
  cyl(g, 0.09, 0.09, 0.018, w * 0.24, 0.42, 0, brass, 12);
  cyl(g, 0.045, 0.04, 0.05, w * 0.24, 0.455, 0, MAT.white, 10);
}

export function rug(parent: THREE.Object3D, x: number, z: number, w: number, d: number): void {
  const m = box(parent, w, 0.02, d, x, 0.11, z, MAT.rug);
  m.castShadow = false;
}

export const SCREEN_TILT = -0.8;

export function wallScreen(parent: THREE.Object3D, x: number, y: number, z: number, w: number, h: number, mat: THREE.Material, rotY = 0, tilt = 0): THREE.Mesh {
  const g = group(parent, x, z, rotY);
  const face = new THREE.Group();
  face.position.y = y;
  face.rotation.x = tilt;
  g.add(face);
  box(face, w + 0.12, h + 0.12, 0.08, 0, 0, 0, MAT.frame);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  screen.position.set(0, 0, 0.045);
  face.add(screen);
  return screen;
}

export function conferenceTable(parent: THREE.Object3D, x: number, z: number, len: number): void {
  const g = group(parent, x, z);
  rounded(g, len, 0.08, 1.6, 0, 0.76, 0, MAT.woodDark, 0.035);
  box(g, len - 0.6, 0.7, 0.5, 0, 0.36, 0, MAT.black);
  rounded(g, len * 0.6, 0.012, 0.2, 0, 0.809, 0, MAT.charcoal, 0.005);
  cyl(g, 0.17, 0.2, 0.035, 0, 0.83, 0, MAT.metal, 16);
  const n = Math.floor(len / 0.9);
  for (let i = 0; i < n; i++) {
    const cx = -len / 2 + 0.45 + i * (len / n);
    officeChair(g, cx, -1.15, 0);
    officeChair(g, cx, 1.15, Math.PI);
    for (const side of [-1, 1]) {
      box(g, 0.24, 0.012, 0.3, cx, 0.808, side * 0.52, MAT.fabric);
      box(g, 0.19, 0.003, 0.25, cx, 0.816, side * 0.52, MAT.white);
    }
  }
}

const BLINK_VARIANTS = 4;
const blinkPools = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial[]>();

export interface BlinkInfo {
  base: number;
  phase: number;
  rate: number;
}

export const BLINK_MATERIALS: THREE.MeshStandardMaterial[] = [];

function blinkingLed(base: THREE.MeshStandardMaterial, seed: number): THREE.MeshStandardMaterial {
  let pool = blinkPools.get(base);
  if (!pool) {
    pool = Array.from({ length: BLINK_VARIANTS }, (_, i) => {
      const m = base.clone();
      m.userData.blink = { base: base.emissiveIntensity, phase: i * 1.7 + base.emissive.getHex() % 7, rate: 0.9 + i * 0.55 } satisfies BlinkInfo;
      BLINK_MATERIALS.push(m);
      return m;
    });
    blinkPools.set(base, pool);
  }
  return pool[Math.abs(Math.round(seed)) % BLINK_VARIANTS];
}

const RACK_H = 2.2;
const RACK_U = 0.086;
const PLATE_Z = 0.44;
const FACE_Z = 0.47;
const DEVICE_W = 0.5;
const PORTS = 12;

const RM = {
  shell: new THREE.MeshStandardMaterial({ color: 0x1b1f26, roughness: 0.45, metalness: 0.5 }),
  post: new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.4, metalness: 0.6 }),
  top: new THREE.MeshStandardMaterial({ color: 0x262b33, roughness: 0.5, metalness: 0.5 }),
  vent: new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.7 }),
  fan: new THREE.MeshStandardMaterial({ color: 0x3c434d, roughness: 0.4, metalness: 0.6 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9aa3ae, roughness: 0.35, metalness: 0.6 }),
  steelDark: new THREE.MeshStandardMaterial({ color: 0x6f7883, roughness: 0.4, metalness: 0.6 }),
  blank: new THREE.MeshStandardMaterial({ color: 0x15181c, roughness: 0.5 }),
  bay: new THREE.MeshStandardMaterial({ color: 0x2c323b, roughness: 0.5 }),
  latch: new THREE.MeshStandardMaterial({ color: 0xe08a2e, roughness: 0.5 }),
  port: new THREE.MeshStandardMaterial({ color: 0x050607, roughness: 0.6 }),
  patch: new THREE.MeshStandardMaterial({ color: 0x353b44, roughness: 0.5 }),
  label: new THREE.MeshStandardMaterial({ color: 0xe8ecf1, roughness: 0.6 }),
  lcd: new THREE.MeshStandardMaterial({ color: 0x0f3b3a, emissive: 0x2fd6c4, emissiveIntensity: 1.1, roughness: 0.3 }),
  cables: [0xf2c230, 0x3d8bff, 0x3ccf6e, 0xe04848].map((color) => new THREE.MeshStandardMaterial({ color, roughness: 0.55 })),
};

type RackDevice = "patch" | "switch" | "u1" | "u2" | "storage" | "ups" | "blank";
type RackLayout = [RackDevice, number][];

const RACK_LAYOUTS: RackLayout[] = [
  [["patch", 1], ["switch", 1], ["patch", 1], ["switch", 1], ["blank", 1], ["u1", 1], ["u1", 1], ["u1", 1], ["u1", 1], ["u1", 1], ["u1", 1], ["blank", 1], ["u2", 2], ["u2", 2], ["blank", 2], ["ups", 3]],
  [["patch", 1], ["switch", 1], ["blank", 1], ["u2", 2], ["u2", 2], ["u2", 2], ["u2", 2], ["u2", 2], ["u2", 2], ["blank", 3], ["ups", 3]],
  [["switch", 1], ["blank", 1], ["storage", 4], ["storage", 4], ["storage", 4], ["u2", 2], ["u2", 2], ["ups", 3]],
];

function rackPorts(g: THREE.Object3D, y: number, h: number, seed: number, plate: THREE.Material, plugged: number): void {
  box(g, DEVICE_W, h - 0.008, 0.05, 0, y, PLATE_Z, plate);
  const pitch = 0.32 / PORTS;
  const cable = RM.cables[seed % RM.cables.length];
  for (const row of [0.018, -0.018]) {
    for (let i = 0; i < PORTS; i++) {
      const px = -0.21 + i * pitch;
      box(g, 0.02, 0.018, 0.01, px, y + row, FACE_Z, RM.port);
      box(g, 0.014, 0.003, 0.002, px, y + row - 0.005, FACE_Z + 0.006, brass);
      if ((i * 7 + seed + (row > 0 ? 3 : 0)) % 10 < plugged) box(g, 0.016, 0.014, 0.04, px, y + row, FACE_Z + 0.02, cable);
    }
  }
  box(g, 0.3, 0.012, 0.02, -0.04, y - h / 2 + 0.004, FACE_Z + 0.04, cable);
  for (let i = 0; i < 4; i++) box(g, 0.012, 0.012, 0.01, 0.15 + i * 0.022, y, FACE_Z, blinkingLed(MAT.ledGreen, seed + i));
  for (const side of [-1, 1]) {
    const key = `rack-patch-lead:${side}`;
    let geometry = workstationGeometry.get(key);
    if (!geometry) {
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(side * 0.19, 0, 0), new THREE.Vector3(side * 0.225, -0.025, 0.025), new THREE.Vector3(side * 0.27, -0.07, 0.018)]);
      geometry = new THREE.TubeGeometry(curve, 8, 0.004, 4, false); workstationGeometry.set(key, geometry);
    }
    const patchLead = new THREE.Mesh(geometry, cable); patchLead.position.set(0, y, FACE_Z + 0.025); g.add(patchLead);
  }
}

function rackServer(g: THREE.Object3D, y: number, h: number, seed: number, bays: number, plate: THREE.Material): void {
  box(g, DEVICE_W, h - 0.008, 0.05, 0, y, PLATE_Z, plate);
  const bayW = 0.3 / bays;
  for (let i = 0; i < bays; i++) {
    const bx = -0.21 + bayW / 2 + i * bayW;
    box(g, bayW - 0.008, h * 0.62, 0.012, bx, y, FACE_Z, RM.bay);
    box(g, bayW - 0.014, 0.006, 0.008, bx, y - h * 0.17, FACE_Z + 0.012, RM.steelDark);
    for (let vent = 0; vent < 3; vent++) box(g, Math.max(0.006, bayW - 0.02), 0.003, 0.002, bx, y - h * 0.04 + vent * 0.012, FACE_Z + 0.008, RM.port);
    box(g, 0.01, 0.01, 0.01, bx - bayW / 2 + 0.012, y + h * 0.22, FACE_Z + 0.008, blinkingLed((i + seed) % 7 === 0 ? MAT.ledRed : MAT.ledGreen, seed + i));
  }
  box(g, 0.06, 0.016, 0.01, 0.17, y, FACE_Z, RM.label);
  box(g, 0.016, 0.016, 0.012, 0.225, y, FACE_Z, blinkingLed(MAT.ledBlue, seed));
  for (const sx of [-0.235, 0.235]) box(g, 0.02, h * 0.7, 0.03, sx, y, FACE_Z + 0.01, RM.steelDark);
}

function rackStorage(g: THREE.Object3D, y: number, h: number, seed: number): void {
  box(g, DEVICE_W, h - 0.008, 0.05, 0, y, PLATE_Z, RM.blank);
  const rowH = (h - 0.03) / 3;
  for (let r = 0; r < 3; r++) {
    const ry = y + h / 2 - 0.015 - rowH / 2 - r * rowH;
    for (let c = 0; c < 4; c++) {
      const cx = -0.165 + c * 0.11;
      box(g, 0.1, rowH - 0.012, 0.014, cx, ry, FACE_Z, RM.bay);
      box(g, 0.1, 0.012, 0.016, cx, ry - rowH / 2 + 0.012, FACE_Z + 0.002, RM.latch);
      box(g, 0.012, 0.012, 0.01, cx + 0.035, ry + rowH / 2 - 0.016, FACE_Z + 0.009, blinkingLed(MAT.ledGreen, seed + r * 4 + c));
    }
  }
}

function rackUps(g: THREE.Object3D, y: number, h: number, seed: number): void {
  box(g, DEVICE_W, h - 0.008, 0.05, 0, y, PLATE_Z, MAT.black);
  box(g, 0.13, 0.06, 0.01, -0.13, y + 0.04, FACE_Z, RM.lcd);
  for (let i = 0; i < 5; i++) box(g, 0.22, 0.012, 0.01, 0.09, y + 0.07 - i * 0.035, FACE_Z, RM.vent);
  box(g, 0.016, 0.016, 0.01, -0.19, y - 0.05, FACE_Z, blinkingLed(MAT.ledGreen, seed));
  box(g, 0.016, 0.016, 0.01, -0.16, y - 0.05, FACE_Z, MAT.ledWarm);
}

function rackDevice(g: THREE.Object3D, kind: RackDevice, y: number, h: number, seed: number): void {
  if (kind === "patch") rackPorts(g, y, h, seed, RM.patch, 9);
  else if (kind === "switch") rackPorts(g, y, h, seed + 1, MAT.black, 6);
  else if (kind === "u1") rackServer(g, y, h, seed, 4, RM.steel);
  else if (kind === "u2") rackServer(g, y, h, seed, 8, RM.steelDark);
  else if (kind === "storage") rackStorage(g, y, h, seed);
  else if (kind === "ups") rackUps(g, y, h, seed);
  else box(g, DEVICE_W, h - 0.008, 0.04, 0, y, PLATE_Z - 0.01, RM.blank);
  for (const side of [-1, 1]) for (const vertical of [-1, 1]) {
    const screw = cyl(g, 0.006, 0.006, 0.004, side * 0.241, y + vertical * Math.max(0.016, h / 2 - 0.014), FACE_Z + 0.018, RM.steel, 8);
    screw.rotation.x = Math.PI / 2;
    box(g, 0.007, 0.0015, 0.002, side * 0.241, screw.position.y, FACE_Z + 0.021, RM.post);
  }
}

function rackShell(g: THREE.Object3D): void {
  box(g, 0.7, 0.08, 1.0, 0, 0.04, 0, RM.post);
  box(g, 0.7, RACK_H, 0.04, 0, RACK_H / 2, -0.48, RM.shell);
  for (const sx of [-0.335, 0.335]) box(g, 0.03, RACK_H, 1.0, sx, RACK_H / 2, 0, RM.shell);
  for (const sx of [-0.3, 0.3]) box(g, 0.06, RACK_H - 0.04, 0.05, sx, RACK_H / 2, 0.475, RM.post);
  box(g, 0.66, 0.06, 0.05, 0, RACK_H - 0.05, 0.475, RM.post);
  box(g, 0.7, 0.04, 1.0, 0, RACK_H, 0, RM.top);
  for (let i = 0; i < 7; i++) box(g, 0.44, 0.008, 0.035, -0.08, RACK_H + 0.022, -0.4 + i * 0.075, RM.vent);
  for (const fz of [0.2, 0.38]) {
    cyl(g, 0.075, 0.075, 0.012, 0.2, RACK_H + 0.024, fz, RM.vent, 12);
    cyl(g, 0.025, 0.025, 0.016, 0.2, RACK_H + 0.03, fz, RM.fan, 8);
  }
  for (const sx of [-0.268, 0.268]) box(g, 0.03, RACK_H - 0.25, 0.05, sx, RACK_H / 2, 0.45, RM.vent);
  for (const sx of [-0.335, 0.335]) {
    box(g, 0.018, RACK_H - 0.08, 0.018, sx, RACK_H / 2, 0.48, RM.steelDark);
    for (let i = 0; i < 9; i++) box(g, 0.032, 0.026, 0.58, sx, 0.25 + i * 0.09, -0.03, RM.vent);
  }
  box(g, 0.22, 0.025, 0.07, 0, RACK_H + 0.025, 0.38, RM.label);
  box(g, 0.17, 0.003, 0.035, 0, RACK_H + 0.039, 0.38, RM.post);
}

export function serverRack(parent: THREE.Object3D, x: number, z: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  g.name = "server-rack";
  const seed = Math.abs(Math.round(x * 7 + z * 13));
  rackShell(g);
  const layout = RACK_LAYOUTS[seed % RACK_LAYOUTS.length];
  let top = RACK_H - 0.1;
  layout.forEach(([kind, units], i) => {
    const h = units * RACK_U;
    rackDevice(g, kind, top - h / 2, h, seed + i * 5);
    top -= h + 0.004;
  });
  const cable = RM.cables[seed % RM.cables.length];
  for (const sx of [-0.268, 0.268]) box(g, 0.014, RACK_H - 0.3, 0.014, sx, RACK_H / 2, 0.48, cable);
  for (const sx of [-0.29, 0.29]) for (const sz of [-0.37, 0.37]) {
    box(g, 0.07, 0.06, 0.065, sx, 0.04, sz, RM.post);
    const caster = cyl(g, 0.035, 0.035, 0.045, sx, 0.035, sz, RM.vent, 10); caster.rotation.z = Math.PI / 2;
  }
  for (let rackUnit = 0; rackUnit < 22; rackUnit++) {
    const py = 0.19 + rackUnit * RACK_U;
    box(g, 0.016, 0.006, 0.002, -0.294, py, 0.504, RM.label);
  }
  box(g, 0.058, 0.15, 0.028, 0.295, 1.05, 0.51, RM.steelDark);
  cyl(g, 0.009, 0.009, 0.01, 0.295, 1.08, 0.53, RM.post, 8).rotation.x = Math.PI / 2;
  batchWorkstation(g, `server-rack-${seed % 420}`);
  g.userData.rack = { front: FACE_Z, height: RACK_H, layout: seed % RACK_LAYOUTS.length };
}

export function bookshelf(parent: THREE.Object3D, x: number, z: number, w: number, rotY = 0, withBoxes = false): void {
  const g = group(parent, x, z, rotY);
  box(g, w, 2.0, 0.045, 0, 1.0, -0.2025, MAT.woodDark);
  for (const sx of [-1, 1]) box(g, 0.06, 2.0, 0.45, sx * (w / 2 - 0.03), 1.0, 0, MAT.woodDark);
  rounded(g, w, 0.05, 0.45, 0, 1.975, 0, MAT.wood, 0.02);
  box(g, w, 0.1, 0.45, 0, 0.05, 0, MAT.woodDark);
  for (let i = 0; i < 4; i++) {
    box(g, w - 0.08, 0.04, 0.42, 0, 0.35 + i * 0.48, 0.02, MAT.wood);
    const n = Math.floor(w / 0.38);
    for (let j = 0; j < n; j++) {
      const mat = withBoxes ? (j % 3 ? MAT.cardboard : MAT.black) : [MAT.charcoal, MAT.white, MAT.wood, MAT.metal][(i + j) % 4];
      const px = -w / 2 + 0.25 + j * 0.38;
      const py = 0.55 + i * 0.48;
      box(g, 0.28, withBoxes ? 0.3 : 0.27 + ((i + j) % 3) * 0.035, 0.32, px, py, 0.04, mat);
      box(g, withBoxes ? 0.12 : 0.22, 0.025, 0.006, px, py + 0.06, 0.203, withBoxes ? MAT.white : brass);
      if (!withBoxes) box(g, 0.012, 0.24, 0.009, px - 0.09, py, 0.204, MAT.woodDark);
    }
  }
}

export function counter(parent: THREE.Object3D, x: number, z: number, w: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  box(g, w, 0.9, 0.62, 0, 0.45, 0, MAT.charcoal);
  rounded(g, w + 0.04, 0.05, 0.66, 0, 0.92, 0, MAT.marble, 0.018);
  const doors = Math.max(2, Math.floor(w / 0.65));
  for (let i = 0; i < doors; i++) {
    const dx = -w / 2 + (i + 0.5) * w / doors;
    box(g, w / doors - 0.025, 0.74, 0.012, dx, 0.48, 0.312, MAT.woodDark);
    box(g, 0.16, 0.015, 0.02, dx, 0.75, 0.31, brass);
  }
}

export function fridge(parent: THREE.Object3D, x: number, z: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  rounded(g, 0.75, 1.9, 0.7, 0, 0.95, 0, MAT.metal, 0.035);
  box(g, 0.68, 0.018, 0.012, 0, 1.23, 0.35, MAT.charcoal);
  box(g, 0.14, 0.1, 0.008, -0.15, 1.53, 0.354, MAT.screenAlt);
  box(g, 0.03, 0.5, 0.03, 0.3, 1.3, 0.36, MAT.black);
}

export function poolTable(parent: THREE.Object3D, x: number, z: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  g.scale.y = 0.72;
  rounded(g, 2.2, 0.14, 1.2, 0, 0.78, 0, MAT.woodDark, 0.05);
  box(g, 2.0, 0.02, 1.0, 0, 0.86, 0, MAT.felt);
  for (const sx of [-0.95, 0.95]) for (const sz of [-0.48, 0.48]) box(g, 0.14, 0.72, 0.14, sx, 0.36, sz, MAT.woodDark);
  for (const sz of [-0.55, 0.55]) {
    rounded(g, 2.05, 0.045, 0.08, 0, 0.875, sz, MAT.wood, 0.018);
    for (const sx of [-0.97, 0, 0.97]) cyl(g, 0.079, 0.079, 0.01, sx, 0.882, Math.sign(sz) * 0.49, MAT.black, 20);
    for (const sx of [-0.65, -0.32, 0.32, 0.65]) box(g, 0.018, 0.003, 0.018, sx, 0.9, sz, brass);
  }
  for (const sx of [-1.045, 1.045]) rounded(g, 0.07, 0.07, 0.94, sx, 0.89, 0, MAT.wood, 0.016);
  box(g, 0.96, 0.045, 0.11, 0, 0.455, 0.625, MAT.black);
  createBilliards(g);
}

export function crate(parent: THREE.Object3D, x: number, z: number, s = 0.5, stack = 1): void {
  for (let i = 0; i < stack; i++) {
    const y = s * 0.4 + i * s * 0.8;
    rounded(parent, s, s * 0.8, s, x, y, z, MAT.cardboard, 0.012);
    box(parent, s * 0.14, 0.003, s * 0.98, x, y + s * 0.4, z, MAT.wood);
    box(parent, s * 0.14, s * 0.78, 0.003, x, y, z + s / 2, MAT.wood);
    box(parent, s * 0.3, s * 0.18, 0.004, x - s * 0.25, y + s * 0.08, z + s / 2, MAT.white);
  }
}

export function cabinet(parent: THREE.Object3D, x: number, z: number, w: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  box(g, w, 1.0, 0.45, 0, 0.5, 0, MAT.woodDark);
  box(g, w - 0.1, 0.02, 0.02, 0, 0.75, 0.23, MAT.ledWarm);
  rounded(g, w, 0.045, 0.45, 0, 0.98, 0, MAT.marble, 0.016);
  for (const sx of [-1, 1]) box(g, w / 2 - 0.04, 0.6, 0.012, sx * w / 4, 0.4, 0.22, MAT.wood);
}

export function gate(parent: THREE.Object3D, x: number, z: number): void {
  const g = group(parent, x, z);
  rounded(g, 0.25, 1.0, 0.6, 0, 0.5, 0, MAT.metal, 0.04);
  rounded(g, 0.2, 0.04, 0.5, 0, 1.02, 0, MAT.black, 0.016);
  box(g, 0.12, 0.003, 0.12, 0, 1.042, 0.1, MAT.screenAlt);
  box(g, 0.14, 0.008, 0.03, 0, 1.045, -0.15, MAT.ledGreen);
}

const personSkin = new THREE.MeshStandardMaterial({ color: 0xd8a989, roughness: 0.72 });
const personJacket = new THREE.MeshStandardMaterial({ color: 0x24354b, roughness: 0.82 });
const personLapel = new THREE.MeshStandardMaterial({ color: 0x30435b, roughness: 0.77 });
const personLips = new THREE.MeshStandardMaterial({ color: 0x926b60, roughness: 0.8 });
const personHair = new THREE.MeshStandardMaterial({ color: 0x27211e, roughness: 0.85 });
const personSphere = new THREE.SphereGeometry(1, 16, 12);

function tailoredGeometry(rings: [number, number, number, number][]): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const segments = 20;
  rings.forEach(([y, rx, rz, offset], row) => {
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      positions.push(Math.cos(angle) * rx, y, Math.sin(angle) * rz + offset);
      uvs.push(i / segments, row / (rings.length - 1));
      if (row && i < segments) {
        const a = row * (segments + 1) + i;
        const b = a - segments - 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

const personTorso = tailoredGeometry([[0.64, 0, 0, -0.02], [0.67, 0.16, 0.11, -0.02], [0.78, 0.19, 0.13, -0.025], [0.96, 0.225, 0.145, -0.025], [1.09, 0.265, 0.13, -0.025], [1.15, 0.22, 0.105, -0.025], [1.2, 0.075, 0.07, -0.025], [1.205, 0, 0, -0.025]]);
const personHead = tailoredGeometry([[-0.17, 0, 0, 0.005], [-0.15, 0.065, 0.065, 0.005], [-0.115, 0.095, 0.082, 0], [-0.055, 0.12, 0.105, -0.008], [0.025, 0.129, 0.119, -0.018], [0.1, 0.122, 0.114, -0.026], [0.15, 0.091, 0.08, -0.029], [0.177, 0.02, 0.025, -0.025], [0.179, 0, 0, -0.025]]);
const personHairCap = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.57);
const personUpperArm = tailoredGeometry([[-0.272, 0, 0, 0], [-0.25, 0.06, 0.06, 0], [-0.12, 0.07, 0.067, 0], [0, 0.076, 0.073, 0], [0.028, 0, 0, 0]]);
const personForearm = tailoredGeometry([[-0.28, 0.047, 0.045, 0], [-0.25, 0.05, 0.048, 0], [-0.1, 0.058, 0.055, 0], [0, 0.061, 0.059, 0], [0.025, 0, 0, 0]]);
const personThigh = tailoredGeometry([[-0.384, 0, 0, 0], [-0.36, 0.07, 0.073, 0], [-0.15, 0.082, 0.085, 0], [0, 0.086, 0.09, 0], [0.03, 0, 0, 0]]);
const personShin = tailoredGeometry([[-0.36, 0.048, 0.05, 0], [-0.28, 0.052, 0.053, 0], [-0.12, 0.069, 0.071, 0], [0, 0.069, 0.07, 0], [0.025, 0, 0, 0]]);

export interface PersonRig {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  arms: [{ upper: THREE.Group; forearm: THREE.Group; hand: THREE.Group }, { upper: THREE.Group; forearm: THREE.Group; hand: THREE.Group }];
  legs: [{ upper: THREE.Group; lower: THREE.Group; foot: THREE.Group }, { upper: THREE.Group; lower: THREE.Group; foot: THREE.Group }];
}

function clothPanel(parent: THREE.Object3D, points: [number, number][], z: number, material: THREE.Material): void {
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => i ? shape.lineTo(x, y) : shape.moveTo(x, y));
  shape.closePath();
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  mesh.position.z = z;
  parent.add(mesh);
}

export function seatedPerson(parent: THREE.Object3D, x: number, z: number, rotY = 0): PersonRig {
  const root = group(parent, x, z, rotY);
  const body = group(root);
  body.position.y = 0.62;
  const g = group(body);
  g.position.y = -0.62;
  const form = (owner: THREE.Object3D, sx: number, sy: number, sz: number, px: number, py: number, pz: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(personSphere, material);
    mesh.scale.set(sx, sy, sz);
    mesh.position.set(px, py, pz);
    mesh.castShadow = mesh.receiveShadow = true;
    owner.add(mesh);
    return mesh;
  };
  const segment = (owner: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = mesh.receiveShadow = true;
    owner.add(mesh);
  };
  const torso = new THREE.Mesh(personTorso, personJacket);
  torso.castShadow = torso.receiveShadow = true;
  g.add(torso);
  form(g, 0.19, 0.115, 0.16, 0, 0.61, 0.01, MAT.trousers);
  clothPanel(g, [[-0.075, 1.18], [-0.055, 0.83], [0.055, 0.83], [0.075, 1.18]], 0.148, MAT.shirt);
  clothPanel(g, [[-0.038, 1.195], [0, 1.125], [0.038, 1.195]], 0.153, personSkin);
  for (const side of [-1, 1]) {
    const points = [[0.08, 1.185], [0.18, 1.105], [0.055, 0.895], [0.035, 1.09]] as [number, number][];
    clothPanel(g, points.map(([px, py]) => [px * side, py]), 0.156, personLapel);
    clothPanel(g, [[side * 0.038, 1.18], [side * 0.072, 1.155], [side * 0.05, 1.115]], 0.16, MAT.shirt);
  }
  const arms = [-1, 1].map((side) => {
    const upper = group(body);
    upper.position.set(side * 0.23, 0.485, -0.025);
    segment(upper, personUpperArm, personJacket);
    const forearm = group(upper);
    forearm.position.y = -0.25;
    forearm.rotation.x = -Math.PI / 2;
    segment(forearm, personForearm, personJacket);
    form(forearm, 0.051, 0.019, 0.047, 0, -0.273, 0, MAT.shirt);
    const hand = group(forearm);
    hand.position.y = -0.28;
    form(hand, 0.048, 0.072, 0.027, 0, -0.065, 0, personSkin);
    form(hand, 0.018, 0.039, 0.019, -side * 0.043, -0.055, 0.009, personSkin);
    return { upper, forearm, hand };
  }) as PersonRig["arms"];
  const legs = [-1, 1].map((side) => {
    const upper = group(body);
    upper.position.set(side * 0.12, 0, 0);
    upper.rotation.x = -Math.PI / 2;
    segment(upper, personThigh, MAT.trousers);
    const lower = group(upper);
    lower.position.y = -0.36;
    lower.rotation.x = Math.PI / 2;
    segment(lower, personShin, MAT.trousers);
    const foot = group(lower);
    foot.position.y = -0.36;
    rounded(foot, 0.15, 0.1, 0.27, 0, -0.05, 0.07, MAT.black, 0.035);
    return { upper, lower, foot };
  }) as PersonRig["legs"];
  form(g, 0.059, 0.09, 0.06, 0, 1.255, -0.018, personSkin);
  const headJoint = group(body);
  headJoint.position.y = 0.835;
  const head = group(headJoint);
  head.rotation.x = -0.14;
  const face = new THREE.Mesh(personHead, personSkin);
  face.castShadow = face.receiveShadow = true;
  head.add(face);
  const hair = new THREE.Mesh(personHairCap, personHair);
  hair.scale.set(0.135, 0.092, 0.124);
  hair.position.set(0, 0.115, -0.029);
  hair.castShadow = true;
  head.add(hair);
  form(head, 0.13, 0.105, 0.05, 0, 0.035, -0.12, personHair);
  form(head, 0.106, 0.039, 0.099, -0.022, 0.155, 0.011, personHair).rotation.z = -0.13;
  form(head, 0.027, 0.037, 0.073, 0.1, 0.13, -0.004, personHair);
  for (const side of [-1, 1]) {
    form(head, 0.019, 0.035, 0.023, side * 0.128, -0.005, -0.012, personSkin);
    form(head, 0.02, 0.0055, 0.004, side * 0.05, 0.025, 0.098, personHair);
    box(head, 0.064, 0.0035, 0.004, side * 0.052, 0.047, 0.105, MAT.charcoal);
    box(head, 0.064, 0.003, 0.004, side * 0.052, 0.01, 0.105, MAT.charcoal);
    for (const edge of [-1, 1]) box(head, 0.003, 0.037, 0.004, side * 0.052 + edge * 0.032, 0.0285, 0.105, MAT.charcoal);
    box(head, 0.035, 0.003, 0.075, side * 0.105, 0.044, 0.063, MAT.charcoal);
  }
  box(head, 0.04, 0.003, 0.004, 0, 0.039, 0.109, MAT.charcoal);
  form(head, 0.016, 0.034, 0.027, 0, -0.013, 0.107, personSkin);
  form(head, 0.022, 0.01, 0.017, 0, -0.041, 0.122, personSkin);
  form(head, 0.03, 0.004, 0.004, 0, -0.087, 0.089, personLips);
  for (const py of [0.87, 0.96]) form(g, 0.005, 0.005, 0.003, 0.012, py, 0.153, MAT.metal);
  root.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) object.userData.keep = true;
  });
  return { root, body, head: headJoint, arms, legs };
}

export function armchair(parent: THREE.Object3D, x: number, z: number, rotY = 0, mat: THREE.Material = MAT.leather): void {
  const g = group(parent, x, z, rotY);
  rounded(g, 0.86, 0.3, 0.8, 0, 0.27, 0, mat, 0.07);
  rounded(g, 0.86, 0.5, 0.18, 0, 0.6, -0.31, mat, 0.06);
  rounded(g, 0.14, 0.32, 0.8, -0.36, 0.5, 0, mat, 0.05);
  rounded(g, 0.14, 0.32, 0.8, 0.36, 0.5, 0, mat, 0.05);
  rounded(g, 0.58, 0.08, 0.56, 0, 0.45, 0.06, MAT.fabricLight, 0.03);
  for (const [lx, lz] of [[-0.36, -0.32], [0.36, -0.32], [-0.36, 0.32], [0.36, 0.32]] as const) box(g, 0.05, 0.12, 0.05, lx, 0.06, lz, MAT.metal);
}

export function floorLamp(parent: THREE.Object3D, x: number, z: number): void {
  const g = group(parent, x, z);
  cyl(g, 0.18, 0.18, 0.04, 0, 0.12, 0, MAT.metal, 12);
  cyl(g, 0.025, 0.025, 1.6, 0, 0.92, 0, MAT.metal, 6);
  cyl(g, 0.16, 0.26, 0.3, 0, 1.78, 0, shade, 20);
  cyl(g, 0.26, 0.26, 0.012, 0, 1.635, 0, brass, 20);
}

export function credenza(parent: THREE.Object3D, x: number, z: number, w: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  box(g, w, 0.56, 0.5, 0, 0.38, 0, MAT.woodDark);
  rounded(g, w + 0.04, 0.04, 0.54, 0, 0.68, 0, MAT.marble, 0.016);
  for (let i = 0; i < 3; i++) box(g, w / 3 - 0.08, 0.42, 0.02, -w / 3 + (i * w) / 3, 0.38, 0.26, MAT.wood);
  box(g, 0.08, 0.32, 0.08, -w * 0.32, 0.86, 0, MAT.gold);
  box(g, 0.2, 0.06, 0.14, -w * 0.32, 0.73, 0, MAT.black);
  for (let i = 0; i < 4; i++) box(g, 0.06, 0.26, 0.2, -0.1 + i * 0.07, 0.83, 0, [MAT.charcoal, MAT.white, MAT.tie, MAT.wood][i]);
  box(g, 0.5, 0.36, 0.03, w * 0.3, 0.9, -0.08, MAT.frame);
  box(g, 0.44, 0.3, 0.01, w * 0.3, 0.9, -0.06, MAT.screenAlt);
}

export function deskLamp(parent: THREE.Object3D, x: number, y: number, z: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  box(g, 0.14, 0.03, 0.14, 0, y + 0.015, 0, MAT.black);
  box(g, 0.025, 0.36, 0.025, 0, y + 0.2, 0, MAT.metal);
  rounded(g, 0.2, 0.05, 0.08, 0.07, y + 0.38, 0, brass, 0.018);
  box(g, 0.16, 0.006, 0.055, 0.07, y + 0.355, 0, MAT.ledWarm);
}

export function laptop(parent: THREE.Object3D, x: number, y: number, z: number, rotY = 0): void {
  const g = group(parent, x, z, rotY);
  rounded(g, 0.4, 0.02, 0.28, 0, y + 0.01, 0, MAT.metal, 0.008);
  box(g, 0.32, 0.002, 0.1, 0, y + 0.022, -0.055, MAT.charcoal);
  box(g, 0.11, 0.002, 0.065, 0, y + 0.022, 0.06, MAT.fabricLight);
  const lid = box(g, 0.4, 0.26, 0.015, 0, y + 0.14, -0.15, MAT.frame);
  lid.rotation.x = -0.2;
  box(g, 0.36, 0.21, 0.005, 0, y + 0.14, -0.14, MAT.screen).rotation.x = -0.2;
}
