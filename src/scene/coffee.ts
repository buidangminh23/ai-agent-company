import * as THREE from "three";
import { MAT, box, cyl, group } from "./props.ts";
import { coffeeCycle } from "./coffee-timeline.ts";
import { reducedMotion } from "../motion.ts";
import { reachMascotHand, type Mascot } from "./mascots.ts";

interface CoffeeCup {
  root: THREE.Group;
  liquid: THREE.Mesh;
  stream: THREE.Mesh;
  puffs: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  brew: THREE.Vector3;
  slot: number;
  button: THREE.Mesh;
  handle: THREE.Group;
  bay: THREE.Group;
}

const smooth = (value: number) => { const x = Math.max(0, Math.min(1, value)); return x * x * (3 - 2 * x); };

export class CoffeeStation {
  readonly root: THREE.Group;
  private readonly cups: CoffeeCup[] = [];
  private readonly needle: THREE.Mesh;
  private readonly light: THREE.MeshStandardMaterial;
  private readonly brewLight: THREE.Mesh;
  private readonly ownedMaterials: THREE.Material[] = [];

  constructor(parent: THREE.Object3D, x: number, z: number) {
    this.root = group(parent, x, z);
    this.root.name = "coffee-station";
    const body = new THREE.MeshStandardMaterial({ color: 0x26343b, metalness: 0.55, roughness: 0.34 });
    const coffee = new THREE.MeshStandardMaterial({ color: 0x492a18, roughness: 0.3 });
    const crema = new THREE.MeshStandardMaterial({ color: 0xb98242, roughness: 0.45 });
    const porcelain = new THREE.MeshStandardMaterial({ color: 0xeeeae3, roughness: 0.5, side: THREE.DoubleSide });
    this.light = new THREE.MeshStandardMaterial({ color: 0x83d6a1, emissive: 0x43ba77, emissiveIntensity: 0.3 });
    this.ownedMaterials.push(body, coffee, crema, porcelain, this.light);
    const center = 0.78;
    box(this.root, 3.16, 0.43, 0.38, center, 1.21, -0.02, body).name = "coffee-machine-housing";
    box(this.root, 3.2, 0.035, 0.48, center, 1.445, 0, MAT.metal);
    box(this.root, 3.1, 0.028, 0.46, center, 0.982, 0, MAT.metal);
    box(this.root, 3.1, 0.48, 0.17, center, 0.73, 0.405, body).name = "coffee-front-service-fascia";
    for (const sx of [-0.72, 2.28]) {
      box(this.root, 0.025, 0.38, 0.035, sx, 1.2, 0.19, MAT.metal);
      for (let vent = 0; vent < 7; vent++) box(this.root, 0.045, 0.008, 0.18, sx, 1.04 + vent * 0.04, -0.08, MAT.black);
    }
    for (const px of [-0.28, 0.78, 1.84]) {
      const hopper = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.08, 0.2, 20), new THREE.MeshPhysicalMaterial({ color: 0x8d7052, transparent: true, opacity: 0.7, roughness: 0.3 }));
      hopper.position.set(px, 1.565, -0.04); this.root.add(hopper); this.ownedMaterials.push(hopper.material);
      cyl(this.root, 0.12, 0.12, 0.025, px, 1.675, -0.04, MAT.black, 20);
      for (let bean = 0; bean < 10; bean++) {
        const seed = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 4), MAT.woodDark);
        seed.scale.set(1, 0.7, 1.4); seed.position.set(px + Math.sin(bean * 2.4) * 0.06, 1.5 + bean % 3 * 0.035, -0.04 + Math.cos(bean * 2.4) * 0.06); this.root.add(seed);
      }
    }
    box(this.root, 0.38, 0.15, 0.012, center, 1.24, 0.179, MAT.screenAlt).name = "coffee-recipe-display";
    for (let row = 0; row < 4; row++) box(this.root, 0.12 + row % 2 * 0.1, 0.008, 0.003, center - 0.035, 1.29 - row * 0.031, 0.187, MAT.metal);
    const gauge = cyl(this.root, 0.06, 0.06, 0.018, 0.43, 1.25, 0.19, MAT.white, 24); gauge.rotation.x = Math.PI / 2;
    this.needle = box(this.root, 0.006, 0.042, 0.005, 0.43, 1.26, 0.203, MAT.black);
    this.brewLight = box(this.root, 0.24, 0.018, 0.008, center, 1.095, 0.19, this.light);
    const wand = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(2.14, 1.2, 0.17), new THREE.Vector3(2.2, 1.06, 0.27), new THREE.Vector3(2.12, 0.99, 0.32)]), 12, 0.012, 8, false), MAT.metal);
    wand.name = "coffee-steam-wand"; this.root.add(wand);
    cyl(this.root, 0.035, 0.035, 0.03, 2.13, 1.28, 0.2, MAT.black, 18).rotation.x = Math.PI / 2;
    for (let i = 0; i < 3; i++) {
      const slot = -0.2 + i * 1.2;
      const brew = new THREE.Vector3(slot - 0.22, 0.54, 0.74);
      box(this.root, 0.74, 0.31, 0.018, brew.x, 1.23, 0.182, MAT.metal);
      box(this.root, 0.69, 0.19, 0.014, brew.x, 1.205, 0.196, body);
      for (let key = 0; key < 3; key++) {
        const buttonFace = cyl(this.root, 0.022, 0.022, 0.014, brew.x - 0.13 + key * 0.13, 1.32, 0.208, key === 1 ? this.light : MAT.black, 18);
        buttonFace.rotation.x = Math.PI / 2;
      }
      cyl(this.root, 0.075, 0.075, 0.035, brew.x, 1.085, 0.23, MAT.metal, 24);
      box(this.root, 0.05, 0.035, 0.17, brew.x + 0.09, 1.065, 0.27, MAT.black).rotation.y = Math.PI / 2;
      for (const screw of [-1, 1]) {
        const fastener = cyl(this.root, 0.01, 0.01, 0.008, brew.x + screw * 0.33, 1.35, 0.198, MAT.charcoal, 10);
        fastener.rotation.x = Math.PI / 2;
      }
      const bay = group(this.root, brew.x, 0);
      bay.name = `coffee-brew-group-${i + 1}`;
      box(bay, 0.46, 0.32, 0.04, 0, 0.715, 0.51, MAT.black);
      for (const side of [-1, 1]) box(bay, 0.035, 0.32, 0.2, side * 0.25, 0.715, 0.57, MAT.metal);
      box(bay, 0.52, 0.03, 0.26, 0, 0.515, 0.62, MAT.metal);
      for (let slat = 0; slat < 7; slat++) box(bay, 0.018, 0.008, 0.22, (slat - 3) * 0.055, 0.535, 0.62, MAT.black);
      cyl(bay, 0.065, 0.065, 0.035, 0, 0.815, 0.64, MAT.metal, 20);
      for (const side of [-1, 1]) cyl(bay, 0.012, 0.015, 0.05, side * 0.025, 0.775, 0.74, MAT.metal, 10);
      const handle = group(bay, 0, 0.64); handle.position.y = 0.82;
      box(handle, 0.035, 0.025, 0.13, 0.08, -0.003, 0.03, MAT.black).rotation.y = Math.PI / 2;
      const button = cyl(this.root, 0.035, 0.035, 0.025, slot - 0.22, 0.71, 0.785, this.light, 18);
      button.rotation.x = Math.PI / 2; button.name = `coffee-brew-button-${i + 1}`;
      const root = group(this.root); root.name = `coffee-service-cup-${i + 1}`;
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.052, 0.12, 24, 1, true), porcelain); cup.position.y = 0.06; root.add(cup);
      cyl(root, 0.05, 0.05, 0.006, 0, 0.004, 0, MAT.white, 20);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.061, 0.005, 6, 24), MAT.white); rim.rotation.x = Math.PI / 2; rim.position.y = 0.12; root.add(rim);
      const cupHandle = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.008, 8, 18, Math.PI * 1.6), MAT.white); cupHandle.position.set(0.067, 0.065, 0); cupHandle.rotation.z = -Math.PI * 0.8; root.add(cupHandle);
      const liquid = cyl(root, 0.052, 0.052, 0.006, 0, 0.025, 0, crema, 24);
      const stream = cyl(this.root, 0.007, 0.008, 0.105, brew.x, 0.721, brew.z, coffee, 10); stream.visible = false;
      const puffs = Array.from({ length: 4 }, () => {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), new THREE.MeshBasicMaterial({ color: 0xf5f4ed, transparent: true, opacity: 0, depthWrite: false }));
        this.ownedMaterials.push(puff.material); root.add(puff); return puff;
      });
      root.position.copy(brew);
      this.cups.push({ root, liquid, stream, puffs, brew, slot, button, handle, bay });
    }
    this.root.traverse(object => { object.userData.keep = true; });
  }

  dispose(): void {
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
  }

  tick(t: number, guests: { x: number; z: number; mascot?: Mascot }[] = []): void {
    const quiet = reducedMotion();
    const time = Number.isFinite(t) ? t : 0;
    const selected = new Set<Mascot>();
    const cycle = coffeeCycle(quiet ? 0 : time);
    const active = guests.length > 0 && !quiet;
    this.light.emissiveIntensity = active && cycle.stage === "brew" ? 0.8 + Math.sin(time * 9) * 0.1 : 0.24;
    this.needle.rotation.z = active && cycle.stage === "brew" ? -0.6 + cycle.progress * 1.2 : -0.6;
    this.brewLight.scale.x = active && cycle.stage === "brew" ? 0.2 + cycle.progress * 0.8 : 1;
    this.cups.forEach((cup, index) => {
      const receiver = guests.find(guest => guest.mascot && !selected.has(guest.mascot) && Math.abs(guest.x - this.root.position.x - cup.slot) < 0.55 && Math.abs(guest.z - this.root.position.z) < 1.5)?.mascot ?? null;
      if (receiver) selected.add(receiver);
      const used = active && receiver !== null;
      if (receiver) {
        const shoulder = receiver.arms[receiver.arms.length - 1].position;
        const shoulderPoint = this.root.worldToLocal(receiver.body.localToWorld(shoulder.clone()));
        cup.brew.x = THREE.MathUtils.clamp(shoulderPoint.x, cup.slot - 0.55, cup.slot - 0.1);
        cup.brew.y = Math.min(0.54, shoulderPoint.y + 0.02);
        cup.button.position.y = Math.min(0.71, shoulderPoint.y + 0.1);
      } else { cup.brew.x = cup.slot - 0.22; cup.brew.y = 0.54; cup.button.position.y = 0.71; }
      cup.bay.position.x = cup.brew.x;
      cup.bay.position.y = cup.brew.y - 0.54;
      cup.button.position.x = cup.stream.position.x = cup.brew.x;
      cup.stream.position.y = cup.brew.y + 0.181;
      cup.stream.position.z = cup.brew.z;
      cup.root.visible = true;
      cup.root.position.copy(cup.brew); cup.root.rotation.set(0, 0, 0);
      cup.stream.visible = used && cycle.stage === "brew" && cycle.progress > 0.06 && cycle.progress < 0.94;
      cup.stream.scale.x = cup.stream.scale.z = 0.85 + Math.sin(time * 17 + index) * 0.1;
      cup.handle.rotation.y = used && cycle.stage === "prepare" ? Math.sin(cycle.progress * Math.PI) * 0.12 : 0;
      cup.button.position.z = 0.785 - (used && cycle.stage === "prepare" ? Math.sin(smooth(cycle.progress / 0.7) * Math.PI) * 0.008 : 0);
      if (used && receiver) {
        const handIndex = receiver.arms.length - 1;
        const shoulder = receiver.arms[handIndex].position;
        const held = this.root.worldToLocal(receiver.body.localToWorld(new THREE.Vector3(shoulder.x, shoulder.y - 0.02, 0.18)));
        const upper = receiver.arms[handIndex].children[0] as THREE.Mesh<THREE.BoxGeometry>;
        const resting = this.root.worldToLocal(receiver.body.localToWorld(new THREE.Vector3(shoulder.x, shoulder.y - upper.geometry.parameters.height, 0)));
        if (cycle.stage === "prepare") {
          const reach = Math.sin(cycle.progress * Math.PI) ** 2;
          const target = resting.clone().lerp(cup.button.position.clone().add(new THREE.Vector3(0, 0, 0.025)), reach);
          reachMascotHand(receiver, handIndex, this.root, target.x, target.y, target.z);
        }
        if (cycle.stage === "serve" || cycle.stage === "return") {
          const enter = cycle.stage === "serve" ? smooth(cycle.progress / 0.35) : 1 - smooth((cycle.progress - 0.65) / 0.35);
          const lift = cycle.stage === "serve" ? smooth((cycle.progress - 0.35) / 0.65) : 1 - smooth(cycle.progress / 0.65);
          const grip = cup.brew.clone().add(new THREE.Vector3(0, 0.06, 0)).lerp(held, lift);
          const target = resting.clone().lerp(grip, enter);
          const reached = reachMascotHand(receiver, handIndex, this.root, target.x, target.y, target.z);
          if (cycle.stage === "serve" && cycle.progress >= 0.35 || cycle.stage === "return" && cycle.progress <= 0.65) cup.root.position.copy(reached).add(new THREE.Vector3(0, -0.06, 0));
        }
        if (cycle.stage === "sip") {
          const sip = cycle.sip;
          const desired = new THREE.Vector3(shoulder.x * (1 - sip * 0.35), THREE.MathUtils.lerp(shoulder.y - 0.02, receiver.height * 0.6, sip), 0.18 - sip * 0.06);
          const reached = reachMascotHand(receiver, handIndex, receiver.body, desired.x, desired.y, desired.z);
          const world = receiver.body.localToWorld(reached);
          cup.root.rotation.x = -sip * 0.55;
          cup.root.position.copy(this.root.worldToLocal(world)).sub(new THREE.Vector3(0, 0.06, 0).applyEuler(cup.root.rotation));
        }
      }
      const filled = used && cycle.stage === "brew" ? smooth(cycle.progress) : used && (cycle.stage === "serve" || cycle.stage === "sip") ? 1 : 0;
      cup.liquid.position.y = 0.025 + filled * 0.083; cup.liquid.visible = filled > 0.01;
      cup.puffs.forEach((puff, puffIndex) => {
        const age = (time * 0.6 + puffIndex / cup.puffs.length + index * 0.17) % 1;
        puff.visible = filled > 0.2 && used && cycle.stage !== "return";
        puff.position.set(Math.sin(time + puffIndex) * 0.02 * age, 0.14 + age * 0.2, Math.cos(puffIndex * 2) * 0.015 * age);
        puff.scale.setScalar(0.5 + age); puff.material.opacity = Math.sin(age * Math.PI) * 0.18;
      });
    });
    this.root.userData.coffeeStage = active ? cycle.stage : "idle";
  }
}
