import * as THREE from "three";
import { MAT, box, cyl, sofa } from "./props.ts";
import { createMascot, poseMascotSeated, reachMascotHand, resetMascotHands } from "./mascots.ts";
import { reducedMotion } from "../motion.ts";

export const FOOSBALL_RODS = [
  { x: -0.86, team: 0, count: 1 }, { x: -0.63, team: 0, count: 2 },
  { x: -0.39, team: 1, count: 3 }, { x: -0.13, team: 0, count: 5 },
  { x: 0.13, team: 1, count: 5 }, { x: 0.39, team: 0, count: 3 },
  { x: 0.63, team: 1, count: 2 }, { x: 0.86, team: 1, count: 1 },
] as const;

const FIELD_X = 0.985;
const FIELD_Z = 0.455;
const GOAL_HALF = 0.17;
const BALL_RADIUS = 0.025;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const figureZ = (count: number, index: number) => (index - (count - 1) / 2) * (count === 5 ? 0.17 : count === 3 ? 0.28 : 0.4);

export class FoosballGame {
  readonly ball = { x: -0.13, z: 0, vx: 0, vz: 0 };
  readonly score = [0, 0];
  readonly rods = FOOSBALL_RODS.map(() => ({ offset: 0, angle: 0, cooldown: 0 }));
  phase: "ready" | "play" | "goal" | "match" = "ready";
  server = 0;
  winner: number | null = null;
  lastScorer: number | null = null;
  phaseTime = 0;
  elapsed = 0;
  rallies = 0;
  readonly activeRods: number[][] = [[3, 5], [2, 4]];
  readonly gripTransition = [0, 0];
  private idleFor = 0;

  step(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    const total = Math.min(dt, 0.1);
    const count = Math.ceil(total * 240);
    for (let i = 0; i < count; i++) this.advance(total / count);
  }

  private advance(dt: number): void {
    this.elapsed += dt;
    this.phaseTime += dt;
    this.rods.forEach((rod) => {
      rod.cooldown = Math.max(0, rod.cooldown - dt);
      rod.angle *= Math.exp(-10 * dt);
    });
    for (const team of [0, 1]) this.gripTransition[team] = Math.max(0, this.gripTransition[team] - dt);
    if (this.phase === "goal" || this.phase === "match") {
      if (this.phaseTime < (this.phase === "match" ? 5 : 2.8)) return;
      if (this.phase === "match") { this.score.fill(0); this.winner = null; }
      this.phase = "ready";
      this.phaseTime = 0;
      this.idleFor = 0;
      return;
    }
    if (this.phase === "ready") {
      const rodIndex = this.server === 0 ? 3 : 4;
      this.activeRods[this.server] = this.server === 0 ? [3, 5] : [2, 4];
      const direction = this.server === 0 ? 1 : -1;
      const lateral = this.phaseTime < 0.8 ? -0.17 : this.phaseTime < 1.6 ? 0 : 0.17;
      this.ball.x = FOOSBALL_RODS[rodIndex].x + direction * 0.04;
      this.ball.z += clamp(lateral - this.ball.z, -dt * 0.6, dt * 0.6);
      this.ball.vx = this.ball.vz = 0;
      this.rods[rodIndex].angle = direction * Math.sin(this.phaseTime * Math.PI * 2.5) * 0.12;
      if (this.phaseTime >= 2.4) {
        this.phase = "play"; this.phaseTime = 0; this.rallies++;
        this.ball.vx = direction * 1.45;
        this.ball.vz = (this.rallies % 2 ? -1 : 1) * 0.42;
        this.rods[rodIndex].angle = direction * 0.9;
        this.rods[rodIndex].cooldown = 0.45;
      }
      return;
    }
    for (const team of [0, 1]) {
      if (this.gripTransition[team] > 0) continue;
      const next = FOOSBALL_RODS.map((spec, index) => ({ ...spec, index }))
        .filter(spec => spec.team === team).sort((a, b) => Math.abs(a.x - this.ball.x) - Math.abs(b.x - this.ball.x)).slice(0, 2).map(spec => spec.index).sort((a, b) => a - b);
      if (next.some((index, hand) => index !== this.activeRods[team][hand])) {
        this.activeRods[team] = next;
        this.gripTransition[team] = 0.24;
      }
    }
    for (const [index, spec] of FOOSBALL_RODS.entries()) {
      const rod = this.rods[index];
      const held = this.activeRods[spec.team].includes(index) && this.gripTransition[spec.team] <= 0;
      const positions = Array.from({ length: spec.count }, (_, i) => figureZ(spec.count, i));
      const nearest = positions.reduce((a, b) => Math.abs(a + rod.offset - this.ball.z) < Math.abs(b + rod.offset - this.ball.z) ? a : b);
      const limit = 0.43 - Math.abs(positions[0]);
      const wanted = clamp(this.ball.z - nearest + Math.sin(this.elapsed * 2 + index) * 0.07, -limit, limit);
      if (held) rod.offset += clamp(wanted - rod.offset, -dt * 0.3, dt * 0.3);
      if (rod.cooldown > 0 || Math.abs(this.ball.x - spec.x) > 0.065) continue;
      if (!positions.some(z => Math.abs(z + rod.offset - this.ball.z) < 0.045)) continue;
      if (!held) {
        const side = this.ball.x < spec.x ? -1 : 1;
        if (this.ball.vx * side < 0) {
          this.ball.x = spec.x + side * 0.068;
          this.ball.vx *= -0.72;
        }
        continue;
      }
      const direction = spec.team === 0 ? 1 : -1;
      rod.angle = direction * 0.95;
      rod.cooldown = 0.34;
      this.ball.x = spec.x + direction * 0.068;
      this.ball.vx = direction * (2.2 + (index % 3) * 0.32);
      this.ball.vz = clamp(-this.ball.z * 2.6 + Math.sin(this.elapsed * 3.1 + index) * 1.3, -1.4, 1.4);
    }
    this.ball.x += this.ball.vx * dt;
    this.ball.z += this.ball.vz * dt;
    if (Math.abs(this.ball.z) > FIELD_Z - BALL_RADIUS) {
      this.ball.z = Math.sign(this.ball.z) * (FIELD_Z - BALL_RADIUS);
      this.ball.vz *= -0.88;
    }
    if (Math.abs(this.ball.x) > FIELD_X - BALL_RADIUS) {
      if (Math.abs(this.ball.z) < GOAL_HALF - BALL_RADIUS && Math.abs(this.ball.x) >= FIELD_X + BALL_RADIUS) {
        const scorer = this.ball.x > 0 ? 0 : 1;
        this.score[scorer]++;
        this.lastScorer = scorer;
        this.server = 1 - scorer;
        this.winner = this.score[scorer] >= 5 ? scorer : null;
        this.phase = this.winner === null ? "goal" : "match";
        this.phaseTime = 0;
        this.ball.vx = this.ball.vz = 0;
        return;
      }
      if (Math.abs(this.ball.z) >= GOAL_HALF - BALL_RADIUS) {
        this.ball.x = Math.sign(this.ball.x) * (FIELD_X - BALL_RADIUS);
        this.ball.vx *= -0.88;
      }
    }
    const drag = Math.exp(-0.32 * dt);
    this.ball.vx *= drag; this.ball.vz *= drag;
    this.idleFor = Math.hypot(this.ball.vx, this.ball.vz) < 0.12 ? this.idleFor + dt : 0;
    if (this.idleFor > 2) {
      this.server = this.ball.x < -0.13 ? 0 : this.ball.x > 0.13 ? 1 : this.server;
      this.phase = "ready"; this.phaseTime = 0; this.idleFor = 0;
    }
  }
}

export function consoleMatch(t: number): { phase: "play" | "goal" | "restart"; scorer: number; score: [number, number]; ball: { x: number; y: number }; progress: number } {
  const elapsed = Number.isFinite(t) ? Math.max(0, t) : 0;
  const round = Math.floor(elapsed / 24);
  const local = elapsed % 24;
  const scorer = round % 2;
  const phase = local < 18 ? "play" : local < 22 ? "goal" : "restart";
  const score: [number, number] = [Math.ceil(round / 2), Math.floor(round / 2)];
  if (local >= 18) score[scorer]++;
  const path = [{ x: 0.5, y: 0.5 }, { x: 0.35, y: 0.3 }, { x: 0.63, y: 0.65 }, { x: 0.76, y: 0.37 }, { x: 1, y: 0.5 }];
  const along = Math.min(3.999, local / 18 * 4);
  const index = Math.floor(along), fraction = along - index;
  const x = THREE.MathUtils.lerp(path[index].x, path[index + 1].x, fraction);
  const y = THREE.MathUtils.lerp(path[index].y, path[index + 1].y, fraction);
  return { phase, scorer, score, ball: phase === "restart" ? { x: 0.5, y: 0.5 } : { x: scorer ? 1 - x : x, y }, progress: local / 24 };
}

function controller(parent: THREE.Object3D): THREE.Group {
  const root = new THREE.Group(); root.name = "dualsense-controller"; parent.add(root);
  box(root, 0.21, 0.035, 0.09, 0, 0, 0, MAT.white);
  for (const side of [-1, 1]) {
    const grip = box(root, 0.067, 0.045, 0.12, side * 0.09, -0.006, 0.025, MAT.white);
    grip.rotation.y = side * -0.25;
    cyl(root, 0.014, 0.014, 0.012, side * 0.043, 0.028, 0.016, MAT.black, 10);
  }
  box(root, 0.06, 0.008, 0.045, 0, 0.023, -0.02, MAT.black);
  for (const [x, z] of [[0.09, -0.02], [0.075, -0.035], [0.105, -0.035], [0.09, -0.05]]) cyl(root, 0.005, 0.005, 0.008, x, 0.025, z, MAT.black, 8);
  box(root, 0.035, 0.01, 0.009, -0.09, 0.025, -0.03, MAT.black);
  box(root, 0.009, 0.01, 0.035, -0.09, 0.025, -0.03, MAT.black);
  for (const side of [-1, 1]) {
    box(root, 0.065, 0.015, 0.018, side * 0.08, 0.012, -0.062, MAT.black);
    const trigger = box(root, 0.054, 0.028, 0.024, side * 0.08, -0.009, -0.065, MAT.black);
    trigger.name = `controller-trigger-${side}`;
    for (let dot = 0; dot < 3; dot++) cyl(root, 0.002, 0.002, 0.003, side * (0.025 + dot * 0.008), 0.027, -0.027, MAT.metal, 5);
  }
  return root;
}

function buildConsole(parent: THREE.Object3D, at: { x: number; z: number }): { tick(t: number): void; dispose(): void } {
  const root = new THREE.Group(); root.name = "ps5-lounge"; root.position.set(at.x, 0, at.z); parent.add(root);
  box(root, 3.5, 0.018, 2.15, 0, 0.112, 0, MAT.fabric);
  sofa(root, 0, 0.66, Math.PI, 2, MAT.fabric);
  box(root, 2.55, 0.32, 0.4, 0, 0.27, -0.79, MAT.woodDark);
  for (const x of [-1, 1]) box(root, 0.08, 0.2, 0.25, x, 0.16, -0.79, MAT.black);
  box(root, 1.8, 1.08, 0.07, 0, 1.16, -0.81, MAT.black);
  box(root, 0.08, 0.3, 0.07, 0, 0.65, -0.81, MAT.black);
  box(root, 0.48, 0.025, 0.25, 0, 0.445, -0.81, MAT.black);
  const ps5 = new THREE.Group(); ps5.name = "ps5-console"; ps5.position.set(1.08, 0.43, -0.8); root.add(ps5);
  const standHeight = 0.022;
  box(ps5, 0.1, 0.44, 0.23, 0, standHeight + 0.22, 0, MAT.black);
  cyl(ps5, 0.13, 0.14, standHeight, 0, standHeight / 2, 0, MAT.black, 24);
  for (const side of [-1, 1]) {
    const panelHeight = (0.48 * Math.cos(0.06) + 0.025 * Math.sin(0.06)) / 2;
    const panel = box(ps5, 0.025, 0.48, 0.25, side * 0.065, standHeight + panelHeight, 0, MAT.white);
    panel.rotation.z = -side * 0.06;
  }
  const lightMaterial = new THREE.MeshStandardMaterial({ color: 0x68b5ff, emissive: 0x2b75ff, emissiveIntensity: 0.8 });
  box(ps5, 0.008, 0.4, 0.012, 0.054, standHeight + 0.22, 0.12, lightMaterial);
  box(ps5, 0.006, 0.16, 0.015, -0.04, standHeight + 0.13, 0.123, MAT.black);
  for (const side of [-1, 1]) for (let vent = 0; vent < 11; vent++) box(ps5, 0.006, 0.008, 0.12, side * 0.053, standHeight + 0.09 + vent * 0.028, -0.015, MAT.metal);
  for (const side of [-1, 1]) {
    const speaker = new THREE.Group(); speaker.name = `console-speaker-${side}`; speaker.position.set(side * 0.8, 0.43, -0.6); root.add(speaker);
    box(speaker, 0.17, 0.3, 0.17, 0, 0.15, 0, MAT.black);
    for (const y of [0.09, 0.21]) { const cone = cyl(speaker, 0.05, 0.05, 0.013, 0, y, 0.095, MAT.metal, 16); cone.rotation.x = Math.PI / 2; }
  }
  const cablePath = new THREE.CatmullRomCurve3([new THREE.Vector3(1.08, 0.53, -0.92), new THREE.Vector3(0.7, 0.35, -0.96), new THREE.Vector3(0, 0.35, -0.97), new THREE.Vector3(0, 0.9, -0.86)]);
  root.add(new THREE.Mesh(new THREE.TubeGeometry(cablePath, 20, 0.008, 5, false), MAT.black));
  const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const screenMaterial = new THREE.MeshBasicMaterial({ map: texture });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.69, 0.95), screenMaterial);
  screen.position.set(0, 1.16, -0.767); root.add(screen);
  const players = [createMascot("codex", false), createMascot("claude", false)];
  const controllers = players.map((mascot, i) => {
    root.add(mascot.root); mascot.root.name = `console-player-${i}`; mascot.root.position.set((i - 0.5) * 0.8, 0.48 - Math.min(...mascot.legs.map(leg => leg.position.y)), 0.69); mascot.root.rotation.y = Math.PI;
    poseMascotSeated(mascot, 1);
    const pad = controller(mascot.body);
    pad.userData.oneHanded = Math.abs(mascot.arms[0].position.x) > 0.4;
    pad.position.set(pad.userData.oneHanded ? mascot.arms[1].position.x - 0.06 : 0, mascot.arms[1].position.y - 0.02, 0.18);
    return pad;
  });
  let painted = -1;
  root.traverse(object => { object.userData.keep = true; });
  return {
    tick(t) {
      const match = consoleMatch(t);
      for (const [i, mascot] of players.entries()) {
        resetMascotHands(mascot);
        const joy = match.phase === "goal" && match.scorer === i ? Math.sin((match.progress * 24 - 18) * Math.PI / 4) : 0;
        mascot.body.rotation.x = match.phase === "play" ? -0.05 + Math.sin(t * 1.5 + i) * 0.025 : -joy * 0.13;
        controllers[i].position.y = mascot.arms[1].position.y - 0.02 + joy * 0.08;
        controllers[i].rotation.z = match.phase === "play" ? Math.sin(t * 6 + i) * 0.045 : joy * (i ? -0.15 : 0.15);
        for (const trigger of controllers[i].children.filter(child => child.name.startsWith("controller-trigger"))) trigger.rotation.x = match.phase === "play" ? Math.max(0, Math.sin(t * 8 + i)) * 0.12 : 0;
        for (let hand = 0; hand < 2; hand++) {
          if (controllers[i].userData.oneHanded && hand === 0) mascot.arms[0].rotation.set(-joy * 0.5, 0, -0.08);
          else reachMascotHand(mascot, hand, controllers[i], hand ? 0.09 : -0.09, 0, 0.025);
        }
      }
      const frame = Math.floor(t * 15);
      if (frame === painted) return;
      painted = frame;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#112d25"; ctx.fillRect(0, 0, 640, 360);
      for (let i = 0; i < 8; i++) { ctx.fillStyle = i % 2 ? "#307a45" : "#286c3c"; ctx.fillRect(18 + i * 75.5, 48, 75.5, 285); }
      ctx.strokeStyle = "#d6efdd"; ctx.lineWidth = 2; ctx.strokeRect(18, 48, 604, 285);
      ctx.beginPath(); ctx.moveTo(320, 48); ctx.lineTo(320, 333); ctx.stroke();
      ctx.beginPath(); ctx.arc(320, 190.5, 43, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeRect(18, 119, 83, 143); ctx.strokeRect(539, 119, 83, 143);
      for (let team = 0; team < 2; team++) for (let p = 0; p < 6; p++) {
        const x = 90 + p % 3 * 110 + team * 190 + Math.sin(t * 0.5 + p) * 15;
        const y = 105 + Math.floor(p / 3) * 145 + Math.cos(t * 0.7 + p) * 25;
        ctx.fillStyle = team ? "#e3714e" : "#65a4ff"; ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = "#fff8e4"; ctx.beginPath(); ctx.arc(18 + match.ball.x * 604, 48 + match.ball.y * 285, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "bold 23px Arial"; ctx.textAlign = "center"; ctx.fillText(`AGENT FC   ${match.score[0]} : ${match.score[1]}   CLAUDE FC`, 320, 31);
      if (match.phase !== "play") { ctx.fillStyle = "#112d25dd"; ctx.fillRect(180, 158, 280, 58); ctx.fillStyle = "#fff"; ctx.fillText(match.phase === "goal" ? "GOAL!" : "KICK OFF", 320, 195); }
      texture.needsUpdate = true;
    },
    dispose() { texture.dispose(); screenMaterial.dispose(); lightMaterial.dispose(); },
  };
}

function buildFoosball(parent: THREE.Object3D, at: { x: number; z: number }): { tick(t: number, dt: number): void; dispose(): void } {
  const root = new THREE.Group(); root.name = "foosball-lounge"; root.position.set(at.x, 0, at.z); parent.add(root);
  const green = new THREE.MeshStandardMaterial({ color: 0x387660, roughness: 0.8 });
  const red = new THREE.MeshStandardMaterial({ color: 0xdc6450, roughness: 0.5 });
  const blue = new THREE.MeshStandardMaterial({ color: 0x508ee0, roughness: 0.5 });
  box(root, 3.35, 0.015, 2.35, 0, 0.112, 0, MAT.fabric);
  box(root, 2.22, 0.28, 1.2, 0, 0.78, 0, MAT.woodDark);
  box(root, 2.0, 0.02, 0.96, 0, 0.925, 0, green);
  for (const x of [-0.91, 0.91]) for (const z of [-0.43, 0.43]) {
    const leg = box(root, 0.1, 0.66, 0.1, x, 0.43, z, MAT.black); leg.rotation.z = -Math.sign(x) * 0.08;
  }
  for (const z of [-0.53, 0.53]) box(root, 2.22, 0.15, 0.1, 0, 1.0, z, MAT.wood);
  for (const x of [-1.04, 1.04]) {
    for (const z of [-0.355, 0.355]) box(root, 0.11, 0.15, 0.37, x, 1.0, z, MAT.wood);
    box(root, 0.11, 0.045, 0.34, x, 1.085, 0, MAT.wood);
    box(root, 0.08, 0.12, 0.32, x * 1.08, 0.975, 0, MAT.black);
    for (const z of [-0.15, 0.15]) box(root, 0.18, 0.11, 0.012, x * 1.05, 0.965, z, MAT.metal);
    for (let thread = -3; thread <= 3; thread++) box(root, 0.007, 0.11, 0.007, x * 1.1, 0.973, thread * 0.044, MAT.white);
    for (const y of [0.94, 0.97, 1]) box(root, 0.007, 0.005, 0.31, x * 1.1, y, 0, MAT.white);
  }
  for (const side of [-1, 1]) {
    box(root, 0.32, 0.13, 0.026, 0.62, 0.73, side * 0.613, MAT.black);
    box(root, 0.34, 0.025, 0.1, 0.62, 0.66, side * 0.64, MAT.metal);
  }
  box(root, 0.07, 0.14, 0.026, -0.63, 0.76, 0.613, MAT.metal);
  box(root, 0.04, 0.009, 0.029, -0.63, 0.79, 0.629, MAT.black);
  box(root, 0.009, 0.002, 0.94, 0, 0.937, 0, MAT.white);
  const circle = new THREE.Mesh(new THREE.RingGeometry(0.15, 0.157, 32), MAT.white); circle.rotation.x = -Math.PI / 2; circle.position.y = 0.938; root.add(circle);
  const game = new FoosballGame();
  const rods = FOOSBALL_RODS.map(spec => {
    const pivot = new THREE.Group(); pivot.name = `foosball-rod-${spec.team}-${spec.count}`; pivot.position.set(spec.x, 1.105, 0); root.add(pivot);
    const bar = cyl(pivot, 0.012, 0.012, 1.64, 0, 0, 0, MAT.metal, 10); bar.rotation.x = Math.PI / 2;
    const handleZ = spec.team ? 0.84 : -0.84;
    const handle = cyl(pivot, 0.034, 0.034, 0.2, 0, 0, handleZ, MAT.black, 12); handle.rotation.x = Math.PI / 2;
    for (const edge of [-0.48, 0.48]) {
      const bumper = cyl(pivot, 0.03, 0.03, 0.065, 0, 0, edge, MAT.black, 12); bumper.rotation.x = Math.PI / 2;
    }
    for (let ring = -3; ring <= 3; ring++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.003, 5, 12), MAT.metal); rib.position.z = handleZ + ring * 0.021; pivot.add(rib);
    }
    for (let i = 0; i < spec.count; i++) {
      const z = figureZ(spec.count, i), material = spec.team ? red : blue;
      cyl(pivot, 0.031, 0.031, 0.07, 0, 0.07, z, material, 10);
      box(pivot, 0.009, 0.012, 0.033, spec.team ? -0.031 : 0.031, 0.077, z, MAT.white);
      box(pivot, 0.056, 0.09, 0.05, 0, -0.01, z, material);
      box(pivot, 0.06, 0.068, 0.065, 0, -0.085, z, material);
    }
    return { pivot, handleZ };
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 12, 8), MAT.white); root.add(ball);
  const players = [createMascot("antigravity", false), createMascot("codex", false)];
  players.forEach((mascot, team) => {
    const elevation = 1.08 - mascot.arms[0].position.y;
    box(root, 2.1, elevation - 0.1, 0.44, 0, (elevation + 0.1) / 2, team ? 1.05 : -1.05, MAT.woodDark).name = `foosball-foot-riser-${team}`;
    mascot.root.name = `foosball-player-${team}`;
    mascot.root.position.set(0, elevation, team ? 1.05 : -1.05);
    mascot.root.rotation.y = team ? Math.PI : 0;
    root.add(mascot.root);
  });
  const grips = players.map(() => [new THREE.Vector3(), new THREE.Vector3()]);
  const markers = [0, 1].map(team => Array.from({ length: 5 }, (_, i) => {
    const bead = cyl(root, 0.035, 0.035, 0.05, (i - 2) * 0.12, 1.09, team ? 0.55 : -0.55, team ? red : blue, 10);
    return bead;
  }));
  root.userData.foosball = game;
  root.traverse(object => { object.userData.keep = true; });
  return {
    tick(t, dt) {
      game.step(dt);
      rods.forEach(({ pivot }, index) => { pivot.position.z = game.rods[index].offset; pivot.rotation.z = game.rods[index].angle; });
      ball.position.set(game.ball.x, 0.938 + BALL_RADIUS, game.ball.z);
      ball.visible = true;
      if (game.phase === "goal" || game.phase === "match") {
        if (game.phaseTime < 0.3) ball.position.y -= game.phaseTime * 0.8;
        else if (game.phaseTime < 0.8) ball.visible = false;
        else ball.position.set(0.62, 0.699, game.server ? 0.64 : -0.64);
      } else if (game.phase === "ready" && game.phaseTime < 0.8) {
        const progress = game.phaseTime / 0.8;
        ball.position.lerpVectors(new THREE.Vector3(0.62, 0.699, game.server ? 0.64 : -0.64), new THREE.Vector3(game.ball.x, 0.963, game.ball.z), progress);
        ball.position.y += Math.sin(progress * Math.PI) * 0.28;
      }
      markers.forEach((team, index) => team.forEach((bead, i) => { bead.position.x = (i - 2) * 0.12 + (i < game.score[index] ? 0.35 : 0); }));
      players.forEach((mascot, team) => {
        const hands = game.activeRods[team].map(index => ({ ...FOOSBALL_RODS[index], index })).sort((a, b) => a.x - b.x);
        const center = (hands[0].x + hands[1].x) / 2;
        mascot.root.position.x += clamp(center - mascot.root.position.x, -dt * 1.7, dt * 1.7);
        mascot.body.rotation.x = -0.07;
        mascot.body.position.y = game.phase === "goal" && game.lastScorer === team ? Math.abs(Math.sin(t * 5)) * 0.025 : 0;
        resetMascotHands(mascot);
        hands.forEach((spec, hand) => {
          const rod = rods[spec.index];
          const target = new THREE.Vector3(0, 0, rod.handleZ); rod.pivot.localToWorld(target); root.worldToLocal(target);
          if (grips[team][hand].lengthSq() === 0 || game.gripTransition[team] <= 0) grips[team][hand].copy(target);
          else grips[team][hand].lerp(target, Math.min(1, dt * 16));
          const grip = grips[team][hand];
          reachMascotHand(mascot, team ? 1 - hand : hand, root, grip.x, grip.y, grip.z);
        });
        if (game.phase === "ready" && game.server === team && game.phaseTime < 0.8) reachMascotHand(mascot, 1, root, ball.position.x, ball.position.y + BALL_RADIUS, ball.position.z);
      });
    },
    dispose() { green.dispose(); red.dispose(); blue.dispose(); },
  };
}

export function createLoungeGames(parent: THREE.Object3D, ps5: { x: number; z: number }, foosball: { x: number; z: number }): { tick(t: number, dt: number): void; dispose(): void } {
  const console = buildConsole(parent, ps5);
  const table = buildFoosball(parent, foosball);
  return {
    tick(t, dt) { const quiet = reducedMotion(); const time = quiet || !Number.isFinite(t) ? 0 : Math.max(0, t); console.tick(time); table.tick(time, quiet || !Number.isFinite(dt) ? 0 : Math.max(0, dt)); },
    dispose() { console.dispose(); table.dispose(); },
  };
}
