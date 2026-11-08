import { BLINK_MATERIALS, MAT, type BlinkInfo } from "./props.ts";
import { reducedMotion } from "../motion.ts";
import type * as THREE from "three";

const rotors = new Set<WeakRef<THREE.Object3D>>();

export function registerAmbientRotor(rotor: THREE.Object3D): void {
  rotors.add(new WeakRef(rotor));
}

const GLOWS = [
  { mat: MAT.screen, base: MAT.screen.emissiveIntensity, rate: 0.7, depth: 0.06 },
  { mat: MAT.screenAlt, base: MAT.screenAlt.emissiveIntensity, rate: 0.53, depth: 0.08 },
  { mat: MAT.rackFace, base: MAT.rackFace.emissiveIntensity, rate: 0.31, depth: 0.12 },
];

function blinkLevel(t: number, info: BlinkInfo): number {
  const beat = (t * info.rate + info.phase) % 1;
  const flicker = Math.sin(t * 23 + info.phase * 5) > 0.82 ? 0.35 : 1;
  return beat < 0.12 ? 0.25 : flicker;
}

export function tickAmbient(t: number): void {
  const still = reducedMotion();
  for (const reference of rotors) {
    const rotor = reference.deref();
    if (!rotor) { rotors.delete(reference); continue; }
    let ancestor: THREE.Object3D = rotor;
    while (ancestor.parent) ancestor = ancestor.parent;
    if (ancestor.type !== "Scene") { rotors.delete(reference); continue; }
    rotor.rotation.z = still ? 0 : t * 7;
  }
  for (const mat of BLINK_MATERIALS) {
    const info = mat.userData.blink as BlinkInfo;
    mat.emissiveIntensity = still ? info.base : info.base * blinkLevel(t, info);
  }
  for (const glow of GLOWS) {
    glow.mat.emissiveIntensity = still ? glow.base : glow.base * (1 + Math.sin(t * glow.rate * Math.PI * 2) * glow.depth);
  }
}
