import * as THREE from "three";
import { damp, reducedMotion, stepSpring, type Spring } from "../motion.ts";

const THINK_COLOR = 0xa78bfa;
const WAIT_COLOR = 0xffb547;
const DOT_COUNT = 3;
const DOT_RADIUS = 0.34;
const RING_INNER = 0.62;
const RING_OUTER = 0.74;

const thinkMat = new THREE.MeshStandardMaterial({ color: THINK_COLOR, emissive: THINK_COLOR, emissiveIntensity: 1.4 });
const waitMat = new THREE.MeshStandardMaterial({ color: WAIT_COLOR, emissive: WAIT_COLOR, emissiveIntensity: 1.6 });
const dotGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
const barGeo = new THREE.BoxGeometry(0.09, 0.26, 0.09);

export interface StatusFx {
  root: THREE.Group;
  think: THREE.Group;
  wait: THREE.Group;
  thinkLevel: number;
  waitLevel: number;
}

export function createStatusFx(height: number): StatusFx {
  const root = new THREE.Group();
  root.position.y = height + 0.18;
  const think = new THREE.Group();
  for (let i = 0; i < DOT_COUNT; i++) think.add(new THREE.Mesh(dotGeo, thinkMat));
  const wait = new THREE.Group();
  const bar = new THREE.Mesh(barGeo, waitMat);
  bar.position.y = 0.16;
  const dot = new THREE.Mesh(dotGeo, waitMat);
  wait.add(bar, dot);
  wait.position.x = 0.42;
  root.add(think, wait);
  think.visible = false;
  wait.visible = false;
  return { root, think, wait, thinkLevel: 0, waitLevel: 0 };
}

export function animateStatusFx(fx: StatusFx, thinking: boolean, waiting: boolean, t: number, dt: number, phase: number): void {
  fx.thinkLevel = damp(fx.thinkLevel, thinking ? 1 : 0, 12, dt);
  fx.waitLevel = damp(fx.waitLevel, waiting ? 1 : 0, 12, dt);
  const still = reducedMotion();
  fx.think.visible = fx.thinkLevel > 0.02;
  fx.think.scale.setScalar(0.6 + 0.4 * fx.thinkLevel);
  fx.think.children.forEach((dot, i) => {
    const a = (still ? 0 : t * 2.4) + phase + (i / DOT_COUNT) * Math.PI * 2;
    dot.position.set(Math.cos(a) * DOT_RADIUS, still ? 0 : Math.sin(t * 3 + i * 1.7) * 0.05, Math.sin(a) * DOT_RADIUS);
    dot.rotation.y = a;
  });
  fx.wait.visible = fx.waitLevel > 0.02;
  fx.wait.scale.setScalar(0.6 + 0.4 * fx.waitLevel);
  fx.wait.position.y = still ? 0 : Math.sin(t * 3.2 + phase) * 0.06;
  fx.wait.rotation.z = still ? 0 : Math.sin(t * 2.1 + phase) * 0.12;
  waitMat.emissiveIntensity = still ? 1.6 : 1.3 + Math.sin(t * 5) * 0.4;
}

export class FocusRing {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly grow: Spring = { x: 0.8, v: 0 };
  private opacity = 0;

  constructor(scene: THREE.Scene) {
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.RingGeometry(RING_INNER, RING_OUTER, 48), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  retarget(color: string): void {
    this.material.color.set(color);
    this.grow.x = 0.8;
    this.grow.v = 0;
  }

  update(position: THREE.Vector3 | null, scale: number, t: number, dt: number): void {
    this.opacity = damp(this.opacity, position ? 1 : 0, position ? 16 : 10, dt);
    this.mesh.visible = this.opacity > 0.01;
    if (!this.mesh.visible) return;
    stepSpring(this.grow, 1, dt, 300, 20);
    const pulse = reducedMotion() ? 0 : Math.sin(t * 3.4) * 0.04;
    this.mesh.scale.setScalar((this.grow.x + pulse) * scale);
    this.material.opacity = this.opacity * (0.75 + pulse * 2);
    if (position) this.mesh.position.set(position.x, 0.115, position.z);
  }
}
