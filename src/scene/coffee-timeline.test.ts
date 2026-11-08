import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { coffeeCycle } from "./coffee-timeline.ts";
import { createMascot, mascotHandPosition, resetMascotHands } from "./mascots.ts";

test("coffee progresses through preparation, brewing, serving, drinking and returning", () => {
  assert.deepEqual([0, 3, 8, 10, 16, 20].map((time) => coffeeCycle(time).stage), ["prepare", "brew", "serve", "sip", "return", "prepare"]);
  for (let time = 0; time < 40; time += 0.05) {
    const sample = coffeeCycle(time);
    assert.ok(sample.progress >= 0 && sample.progress < 1);
    assert.equal(sample.cupHeld, sample.stage === "sip");
    assert.ok(sample.sip >= 0 && sample.sip <= 1);
    if (sample.stage !== "brew") assert.equal(sample.brew, 0);
    if (sample.stage !== "sip") assert.equal(sample.sip, 0);
  }
});

test("coffee drinking starts and ends with a lowered cup and repeats deterministically", () => {
  assert.equal(coffeeCycle(10).sip, 0);
  assert.ok(coffeeCycle(12.64).sip > 0.99);
  assert.ok(coffeeCycle(15.99).sip < 0.001);
  assert.deepEqual(coffeeCycle(7), coffeeCycle(27));
});

test("coffee cups are picked up from fixed dispensing bays without rails or elongated arms", async (t) => {
  const context = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, stroke() {}, strokeRect() {} };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const { CoffeeStation } = await import("./coffee.ts");
  const scene = new THREE.Scene();
  const station = new CoffeeStation(scene, 0, 0);
  const mascots = (["claude", "codex", "antigravity"] as const).map((app, index) => {
    const mascot = createMascot(app, false);
    mascot.root.position.set(-0.2 + index * 1.2, 0.1, 0.8);
    mascot.root.rotation.y = Math.PI;
    scene.add(mascot.root);
    return mascot;
  });
  const guests = mascots.map(mascot => ({ x: mascot.root.position.x, z: mascot.root.position.z, mascot }));
  assert.equal(station.root.children.some(object => /rail/i.test(object.name)), false);
  assert.ok(station.root.getObjectByName("coffee-machine-housing"));
  assert.ok(station.root.getObjectByName("coffee-steam-wand"));
  for (const time of [0.5, 1.7, 8.2, 9.5, 9.99, 16, 16.5, 16.99]) {
    mascots.forEach(resetMascotHands);
    station.tick(time, guests);
    scene.updateWorldMatrix(true, true);
    for (const [index, mascot] of mascots.entries()) {
      for (const arm of mascot.arms) assert.equal((arm.children[0] as THREE.Mesh).scale.y, 1);
      if (time >= 9.5 && time < 10 || time >= 16 && time <= 16.99) {
        const cup = station.root.getObjectByName(`coffee-service-cup-${index + 1}`)!;
        const wrist = mascotHandPosition(mascot, mascot.arms.length - 1, station.root);
        assert.ok(wrist.distanceTo(cup.position.clone().add(new THREE.Vector3(0, 0.06, 0))) < 0.001, `${index} at ${time}`);
        assert.ok(cup.position.y < 0.8);
      }
    }
  }
  let previous: THREE.Vector3[] | null = null;
  for (let frame = 0; frame <= 40 * 60; frame++) {
    mascots.forEach(resetMascotHands);
    const time = frame / 60;
    station.tick(time, guests);
    scene.updateWorldMatrix(true, true);
    const points = mascots.map((mascot, index) => {
      const cup = station.root.getObjectByName(`coffee-service-cup-${index + 1}`)!;
      if (coffeeCycle(time).stage === "sip") {
        assert.equal(cup.visible, true);
        const wrist = mascotHandPosition(mascot, 1, station.root);
        const grip = station.root.worldToLocal(cup.localToWorld(new THREE.Vector3(0, 0.06, 0)));
        assert.ok(grip.distanceTo(wrist) < 0.000001);
      }
      return cup.position.clone();
    });
    if (previous) points.forEach((point, index) => assert.ok(point.distanceTo(previous![index]) * 60 < 1.2, `coffee teleported at ${time}`));
    previous = points;
  }
  station.dispose();
});
