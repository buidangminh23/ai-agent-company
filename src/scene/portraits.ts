import * as THREE from "three";
import type { AgentApp } from "../../shared/types.ts";
import { createMascot } from "./mascots.ts";

const SIZE = 256;
const FOV = 20;
const FILL = 0.84;
const LIFT = 0.32;
const APPS: AgentApp[] = ["claude", "codex", "antigravity"];

let portraits: Record<AgentApp, string> | null = null;

function contactShadow(width: number, depth: number, y: number): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const g = canvas.getContext("2d")!;
  const gradient = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(16,24,40,0.55)");
  gradient.addColorStop(0.55, "rgba(16,24,40,0.22)");
  gradient.addColorStop(1, "rgba(16,24,40,0)");
  g.fillStyle = gradient;
  g.fillRect(0, 0, 128, 128);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = y + 0.002;
  return plane;
}

function stage(mascot: THREE.Object3D): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b6257, 1.5));
  const key = new THREE.DirectionalLight(0xfff4e8, 2.8);
  key.position.set(-2.5, 4, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.01;
  Object.assign(key.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 12 });
  const rim = new THREE.DirectionalLight(0xdbe8ff, 1.8);
  rim.position.set(3, 2.5, -4);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(3, 1, 3);
  scene.add(key, rim, fill, mascot);
  mascot.traverse((part) => {
    part.castShadow = true;
    part.receiveShadow = true;
  });
  return scene;
}

function frame(mascot: THREE.Object3D): THREE.PerspectiveCamera {
  const box = new THREE.Box3().setFromObject(mascot);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const distance = sphere.radius / Math.sin(THREE.MathUtils.degToRad(FOV / 2)) * FILL;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  camera.position.set(sphere.center.x, sphere.center.y + distance * LIFT, sphere.center.z + distance);
  camera.lookAt(sphere.center);
  return camera;
}

function render(): Record<AgentApp, string> {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const result = {} as Record<AgentApp, string>;
  for (const app of APPS) {
    const mascot = createMascot(app, false).root;
    mascot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mascot);
    const size = box.getSize(new THREE.Vector3());
    const scene = stage(mascot);
    scene.add(contactShadow(size.x * 1.25, size.z * 1.6, box.min.y));
    renderer.render(scene, frame(mascot));
    result[app] = renderer.domElement.toDataURL("image/png");
  }
  renderer.dispose();
  renderer.forceContextLoss();
  return result;
}

export function mascotPortrait(app: AgentApp): string {
  portraits ??= render();
  return portraits[app];
}
