import * as THREE from "three";
import type { AgentApp } from "../../shared/types.ts";

export interface Mascot {
  root: THREE.Group;
  body: THREE.Group;
  arms: THREE.Object3D[];
  legs: THREE.Object3D[];
  height: number;
}

interface ArmRest {
  mesh: THREE.Mesh;
  y: number;
  height: number;
  lowerLength: number;
  forearm: THREE.Group;
  wrist: THREE.Group;
  shoulderZ: number;
}

const armRest = new WeakMap<THREE.Object3D, ArmRest>();
const forearmGeometries = new Map<string, THREE.BoxGeometry>();
const legRigs = new WeakMap<THREE.Object3D, { knee: THREE.Group; length: number; shin: number; foot: THREE.Object3D | null; footRest: THREE.Vector3 | null }>();
const gripPoint = new THREE.Vector3();
const gripDown = new THREE.Vector3(0, -1, 0);

export function mascotDeskPosture(mascot: Mascot, scale = mascot.root.scale.x): { seatHeight: number; seatZ: number; shoulderZ: number } {
  const compact = mascotArmReach(mascot, 0) < 0.35;
  const broad = Math.abs(mascot.arms[0].position.x) > 0.4;
  const hip = Math.min(...mascot.legs.map(leg => leg.position.y));
  return {
    seatHeight: Math.max(0.48, 0.76 - (mascot.arms[0].position.y - hip) * scale) + (compact ? 0.12 * scale : 0),
    seatZ: compact ? 0.33 + 0.42 * scale : 0.58 - (1 - scale) * 0.28,
    shoulderZ: compact ? broad ? 0.27 : 0.18 : 0,
  };
}

export function poseMascotSeated(mascot: Mascot, amount: number, desk = false): void {
  const seated = THREE.MathUtils.clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  const shoulderZ = desk ? mascotDeskPosture(mascot).shoulderZ : 0;
  for (const arm of mascot.arms) arm.position.z = armRest.get(arm)!.shoulderZ + shoulderZ * seated;
  for (const leg of mascot.legs) {
    const rig = legRigs.get(leg)!;
    leg.rotation.x = -Math.PI / 2 * seated;
    rig.knee.rotation.x = Math.PI / 2 * seated;
    rig.knee.visible = seated > 0.001;
    if (rig.foot && rig.footRest) {
      const foot = new THREE.Vector3(0, -rig.length, 0).add(new THREE.Vector3(0, -rig.shin - 0.025, 0.025).applyAxisAngle(new THREE.Vector3(1, 0, 0), rig.knee.rotation.x));
      rig.foot.position.copy(rig.footRest).lerp(foot, seated);
      rig.foot.rotation.x = rig.knee.rotation.x;
    }
  }
  mascot.root.userData.seated = seated;
}

export function resetMascotHands(mascot: Mascot): void {
  for (const arm of mascot.arms) {
    const rest = armRest.get(arm)!;
    rest.mesh.position.y = rest.y;
    rest.mesh.scale.y = 1;
    rest.forearm.visible = false;
  }
}

export function mascotArmReach(mascot: Mascot, index: number): number {
  const rest = armRest.get(mascot.arms[index])!;
  return rest.height + rest.lowerLength;
}

export function mascotHandPosition(mascot: Mascot, index: number, anchor: THREE.Object3D): THREE.Vector3 {
  const rest = armRest.get(mascot.arms[index])!;
  const point = rest.forearm.visible ? rest.wrist.getWorldPosition(new THREE.Vector3()) : rest.mesh.localToWorld(new THREE.Vector3(0, -rest.height / 2, 0));
  return anchor.worldToLocal(point);
}

export function reachMascotHand(mascot: Mascot, index: number, anchor: THREE.Object3D, x: number, y: number, z: number): THREE.Vector3 {
  const arm = mascot.arms[index];
  const rest = armRest.get(arm)!;
  anchor.updateWorldMatrix(true, false);
  mascot.body.updateWorldMatrix(true, false);
  gripPoint.set(x, y, z);
  anchor.localToWorld(gripPoint);
  mascot.body.worldToLocal(gripPoint);
  gripPoint.sub(arm.position);
  const requested = gripPoint.length();
  if (!Number.isFinite(requested) || requested < 0.001) return mascotHandPosition(mascot, index, anchor);
  const length = THREE.MathUtils.clamp(requested, Math.abs(rest.height - rest.lowerLength) + 0.001, rest.height + rest.lowerLength - 0.001);
  const direction = gripPoint.clone().normalize();
  const along = (rest.height ** 2 - rest.lowerLength ** 2 + length ** 2) / (2 * length);
  const bend = new THREE.Vector3(index ? 0.18 : -0.18, -1, 0);
  bend.addScaledVector(direction, -bend.dot(direction));
  if (bend.lengthSq() < 0.000001) bend.set(0, 0, 1).addScaledVector(direction, -direction.z);
  bend.normalize();
  const elbow = direction.clone().multiplyScalar(along).addScaledVector(bend, Math.sqrt(Math.max(0, rest.height ** 2 - along ** 2)));
  const foreDirection = direction.multiplyScalar(length).sub(elbow).normalize();
  arm.quaternion.setFromUnitVectors(gripDown, elbow.normalize());
  rest.forearm.quaternion.copy(arm.quaternion).invert().multiply(new THREE.Quaternion().setFromUnitVectors(gripDown, foreDirection));
  rest.forearm.visible = true;
  rest.mesh.position.y = -rest.height / 2;
  rest.mesh.scale.y = 1;
  arm.updateWorldMatrix(false, true);
  return mascotHandPosition(mascot, index, anchor);
}

const matCache = new Map<number, THREE.MeshStandardMaterial>();

function mat(color: number, emissive = 0): THREE.MeshStandardMaterial {
  const key = color * 7 + emissive;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, emissive: emissive ? color : 0x000000, emissiveIntensity: emissive });
    matCache.set(key, m);
  }
  return m;
}

function voxel(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, color: number, emissive = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, emissive));
  m.position.set(x, y, z);
  m.castShadow = true;
  parent.add(m);
  return m;
}

function limb(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, color: number): THREE.Group {
  const pivot = new THREE.Group();
  pivot.position.set(x, y, z);
  voxel(pivot, w, h, d, 0, -h / 2, 0, color);
  parent.add(pivot);
  return pivot;
}

const CLAUDE = 0xd97757;
const CLAUDE_DARK = 0xb85f42;

function buildClaude(body: THREE.Group): Pick<Mascot, "arms" | "legs" | "height"> {
  const legY = 0.22;
  voxel(body, 0.9, 0.46, 0.46, 0, legY + 0.23, 0, CLAUDE);
  voxel(body, 0.7, 0.1, 0.46, 0, legY + 0.51, 0, CLAUDE);
  voxel(body, 0.09, 0.15, 0.03, -0.2, legY + 0.32, 0.24, 0x1d1b1a);
  voxel(body, 0.09, 0.15, 0.03, 0.2, legY + 0.32, 0.24, 0x1d1b1a);
  const arms = [
    limb(body, 0.16, 0.14, 0.2, -0.53, legY + 0.3, 0, CLAUDE_DARK),
    limb(body, 0.16, 0.14, 0.2, 0.53, legY + 0.3, 0, CLAUDE_DARK),
  ];
  for (const a of arms) a.children[0].position.y = 0;
  const legs = [-0.33, -0.15, 0.15, 0.33].map((x) => limb(body, 0.1, legY, 0.13, x, legY, 0, CLAUDE_DARK));
  return { arms, legs, height: legY + 0.56 };
}

const CODEX_BLUE = 0x4a72f0;
const CODEX_LIGHT = 0x6a8dff;
const CODEX_SHADE = 0x3858d4;
const CODEX_FACE = 0x0e1a3a;
const CODEX_GLYPH = 0x7fe8ff;

function codexPrompt(parent: THREE.Object3D, x: number, y: number, z: number, s: number): void {
  voxel(parent, s, s, 0.02, x - s, y + s, z, CODEX_GLYPH, 0.8);
  voxel(parent, s, s, 0.02, x, y, z, CODEX_GLYPH, 0.8);
  voxel(parent, s, s, 0.02, x - s, y - s, z, CODEX_GLYPH, 0.8);
  voxel(parent, s * 2.4, s * 0.9, 0.02, x + s * 2.6, y - s * 1.05, z, CODEX_GLYPH, 0.8);
}

function buildCodex(body: THREE.Group): Pick<Mascot, "arms" | "legs" | "height"> {
  const legY = 0.14;
  const torsoY = legY + 0.16;
  voxel(body, 0.34, 0.28, 0.28, 0, torsoY, 0, CODEX_BLUE);
  voxel(body, 0.2, 0.14, 0.02, 0, torsoY + 0.01, 0.15, CODEX_SHADE);
  codexPrompt(body, -0.03, torsoY + 0.01, 0.162, 0.028);
  const headY = torsoY + 0.36;
  voxel(body, 0.66, 0.42, 0.5, 0, headY, 0, CODEX_BLUE);
  voxel(body, 0.5, 0.12, 0.42, 0, headY + 0.25, 0, CODEX_LIGHT);
  for (const [x, y, w, h] of [[-0.2, 0.3, 0.2, 0.12], [0.02, 0.33, 0.24, 0.12], [0.22, 0.29, 0.18, 0.1], [-0.36, 0.08, 0.1, 0.26], [0.36, 0.06, 0.1, 0.28], [-0.3, -0.18, 0.14, 0.1], [0.3, -0.18, 0.14, 0.1]] as const) {
    voxel(body, w, h, 0.44, x, headY + y, 0, y > 0.2 ? CODEX_LIGHT : CODEX_BLUE);
  }
  voxel(body, 0.46, 0.27, 0.02, 0, headY - 0.01, 0.26, CODEX_FACE);
  codexPrompt(body, -0.1, headY - 0.01, 0.272, 0.04);
  const arms = [
    limb(body, 0.09, 0.16, 0.1, -0.22, torsoY + 0.1, 0, CODEX_SHADE),
    limb(body, 0.09, 0.16, 0.1, 0.22, torsoY + 0.1, 0, CODEX_SHADE),
  ];
  const legs = [-0.09, 0.09].map((x) => limb(body, 0.11, legY, 0.13, x, legY, 0, CODEX_SHADE));
  return { arms, legs, height: headY + 0.42 };
}

const G_BLUE = 0x4285f4;
const G_RED = 0xea4335;
const G_YELLOW = 0xfbbc05;
const G_GREEN = 0x34a853;

const astronautGeometry = {
  round: new THREE.SphereGeometry(1, 10, 6),
  box: new THREE.BoxGeometry(1, 1, 1),
  arm: new THREE.BoxGeometry(0.11, 0.24, 0.14),
  leg: new THREE.BoxGeometry(0.11, 0.15, 0.13),
};
const astronautMaterial = {
  shell: new THREE.MeshStandardMaterial({ color: 0xe9eef2, roughness: 0.4, metalness: 0.12 }),
  navy: new THREE.MeshStandardMaterial({ color: 0x192b42, roughness: 0.5, metalness: 0.15 }),
  visor: new THREE.MeshStandardMaterial({ color: 0x081725, roughness: 0.24, metalness: 0.3 }),
  eyes: new THREE.MeshStandardMaterial({ color: 0xc6f4ff, emissive: 0x70c5ed, emissiveIntensity: 0.65, roughness: 0.3 }),
};

function astronautPart(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function buildAntigravity(body: THREE.Group): Pick<Mascot, "arms" | "legs" | "height"> {
  const { round, box, arm, leg } = astronautGeometry;
  const { shell, navy, visor, eyes } = astronautMaterial;
  astronautPart(body, round, shell, 0, 0.4, 0, 0.23, 0.22, 0.17);
  astronautPart(body, box, navy, 0, 0.4, -0.17, 0.27, 0.28, 0.1);
  astronautPart(body, round, shell, 0, 0.75, 0, 0.3, 0.23, 0.23);
  astronautPart(body, round, visor, 0, 0.76, 0.2, 0.25, 0.145, 0.065);
  for (const x of [-0.09, 0.09]) astronautPart(body, box, eyes, x, 0.78, 0.26, 0.055, 0.035, 0.018);
  astronautPart(body, box, navy, 0, 0.4, 0.158, 0.25, 0.2, 0.035);
  for (const side of [-1, 1]) astronautPart(body, box, mat(side < 0 ? G_BLUE : G_RED), side * 0.041, 0.402, 0.182, 0.035, 0.13, 0.012).rotation.z = side * 0.32;
  astronautPart(body, box, mat(G_GREEN), 0, 0.38, 0.19, 0.105, 0.025, 0.012);
  astronautPart(body, box, mat(G_YELLOW), 0, 0.478, 0.182, 0.04, 0.025, 0.012);
  const arms = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.265, 0.53, 0);
    body.add(pivot);
    astronautPart(pivot, arm, shell, 0, -0.12, 0);
    astronautPart(pivot, round, mat(side < 0 ? G_BLUE : G_RED), 0, 0, 0, 0.075, 0.07, 0.08);
    return pivot;
  });
  const legs = [-1, 1].map((side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.115, 0.21, 0);
    body.add(pivot);
    astronautPart(pivot, leg, navy, 0, -0.075, 0);
    astronautPart(pivot, box, shell, 0, -0.16, 0.025, 0.15, 0.1, 0.2);
    return pivot;
  });
  return { arms, legs, height: 0.98 };
}

const BUILDERS: Record<AgentApp, (body: THREE.Group) => Pick<Mascot, "arms" | "legs" | "height">> = {
  claude: buildClaude,
  codex: buildCodex,
  antigravity: buildAntigravity,
};

export const APP_COLORS: Record<AgentApp, string> = {
  claude: "#d97757",
  codex: "#4a72f0",
  antigravity: "#4285f4",
};

export const APP_NAMES: Record<AgentApp, string> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

export function createMascot(app: AgentApp, small: boolean): Mascot {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const parts = BUILDERS[app](body);
  for (const [index, leg] of parts.legs.entries()) {
    leg.name = `mascot-hip-${index}`;
    const upper = leg.children[0] as THREE.Mesh<THREE.BoxGeometry>;
    const length = upper.geometry.parameters.height;
    const shin = length * 0.9;
    const knee = new THREE.Group();
    knee.name = `mascot-knee-${index}`;
    knee.position.y = -length;
    const lower = new THREE.Mesh(upper.geometry, upper.material);
    lower.scale.set(0.85, 0.9, 0.85);
    lower.position.y = -shin / 2;
    lower.castShadow = true;
    knee.add(lower);
    const ankle = new THREE.Group();
    ankle.name = `mascot-ankle-${index}`;
    ankle.position.y = -shin;
    knee.add(ankle);
    const foot = app === "antigravity" ? leg.children[1] : null;
    legRigs.set(leg, { knee, length, shin, foot, footRest: foot?.position.clone() ?? null });
    knee.visible = false;
    leg.add(knee);
  }
  for (const [index, arm] of parts.arms.entries()) {
    arm.name = `mascot-arm-${index}`;
    const mesh = arm.children[0] as THREE.Mesh;
    const height = (mesh.geometry as THREE.BoxGeometry).parameters.height;
    const lowerLength = height * 0.9;
    const forearm = new THREE.Group();
    forearm.name = `mascot-forearm-${index}`;
    forearm.position.y = -height;
    const dimensions = (mesh.geometry as THREE.BoxGeometry).parameters;
    const geometryKey = `${dimensions.width}:${height}:${dimensions.depth}`;
    let lowerGeometry = forearmGeometries.get(geometryKey);
    if (!lowerGeometry) {
      lowerGeometry = new THREE.BoxGeometry(dimensions.width * 0.85, lowerLength, dimensions.depth * 0.85);
      forearmGeometries.set(geometryKey, lowerGeometry);
    }
    const lowerMesh = new THREE.Mesh(lowerGeometry, mesh.material);
    lowerMesh.position.y = -lowerLength / 2;
    lowerMesh.castShadow = true;
    forearm.add(lowerMesh);
    const wrist = new THREE.Group();
    wrist.name = `mascot-hand-${index}`;
    wrist.position.y = -lowerLength;
    forearm.add(wrist);
    forearm.visible = false;
    arm.add(forearm);
    armRest.set(arm, { mesh, y: mesh.position.y, height, lowerLength, forearm, wrist, shoulderZ: arm.position.z });
  }
  root.scale.setScalar(small ? 0.75 : 1);
  return { root, body, ...parts };
}
