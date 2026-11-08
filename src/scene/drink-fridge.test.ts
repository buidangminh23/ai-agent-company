import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createDrinkFridge, DRINK_FRIDGE_CYCLE, DRINK_FRIDGE_STAGES, sampleDrinkFridge, type DrinkFridgeStage } from "./drink-fridge.ts";

function timeAt(stage: DrinkFridgeStage, progress = 0.5): number {
  let time = 0;
  for (const [name, duration] of DRINK_FRIDGE_STAGES) {
    if (name === stage) return time + duration * progress;
    time += duration;
  }
  throw new Error(stage);
}

test("fridge timeline opens, takes, closes, drinks, refills and physically restocks one bottle", () => {
  assert.equal(sampleDrinkFridge(0).bottleOwner, "shelf");
  assert.equal(sampleDrinkFridge(timeAt("take")).bottleOwner, "hand");
  assert.equal(sampleDrinkFridge(timeAt("drink")).door, 0);
  assert.equal(sampleDrinkFridge(timeAt("drink")).bottleOwner, "hand");
  assert.equal(sampleDrinkFridge(timeAt("refill")).bottleOwner, "tray");
  assert.equal(sampleDrinkFridge(timeAt("restock")).door, 1);
  assert.equal(sampleDrinkFridge(timeAt("reclose")).bottleOwner, "shelf");
  assert.equal(sampleDrinkFridge(timeAt("idle")).door, 0);
  assert.deepEqual(sampleDrinkFridge(DRINK_FRIDGE_CYCLE), sampleDrinkFridge(0));
});

test("door, water bottle, cap and actor remain continuous across stage boundaries and repeated loops", () => {
  let previous = sampleDrinkFridge(0);
  for (let frame = 1; frame <= DRINK_FRIDGE_CYCLE * 120 * 2; frame++) {
    const next = sampleDrinkFridge(frame / 120);
    assert.ok(Math.hypot(next.bottle.x - previous.bottle.x, next.bottle.y - previous.bottle.y, next.bottle.z - previous.bottle.z) < 0.02, next.stage);
    assert.ok(Math.hypot(next.actor.x - previous.actor.x, next.actor.z - previous.actor.z) < 0.01, next.stage);
    assert.ok(Math.abs(next.door - previous.door) < 0.01, next.stage);
    assert.ok(Math.abs(next.cap - previous.cap) < 0.03, next.stage);
    assert.ok(Math.abs(next.bottleTilt - previous.bottleTilt) < 0.03, next.stage);
    assert.ok(next.fill >= 0.1 - 1e-9 && next.fill <= 1);
    assert.equal(next.light > 0, next.door > 0);
    previous = next;
  }
});

test("water decreases only while drinking and returns visibly at the refill stand", () => {
  assert.equal(sampleDrinkFridge(timeAt("drink", 0)).fill, 1);
  assert.ok(sampleDrinkFridge(timeAt("drink", 0.95)).fill < 0.11);
  assert.equal(sampleDrinkFridge(timeAt("refill", 0)).stream, false);
  assert.equal(sampleDrinkFridge(timeAt("refill", 0.5)).stream, true);
  assert.equal(sampleDrinkFridge(timeAt("refill", 0.95)).stream, false);
  assert.ok(sampleDrinkFridge(timeAt("refill", 0.95)).fill > 0.99);
});

test("reduced motion yields a closed quiet fridge with a full shelf bottle", () => {
  const first = sampleDrinkFridge(0, true);
  assert.equal(first.stage, "idle");
  assert.equal(first.door, 0);
  assert.equal(first.light, 0);
  assert.equal(first.stream, false);
  assert.equal(first.bottleOwner, "shelf");
  for (const t of [5, 27, 80, Infinity, Number.NaN]) assert.deepEqual(sampleDrinkFridge(t, true), first);
});

test("rendered fridge has one animated bottle and keeps ownership, hinge, lamp and shelf state synchronized", () => {
  const scene = new THREE.Scene();
  scene.position.set(2, 0, -3);
  scene.rotation.y = 0.42;
  const fridge = createDrinkFridge(scene, 4, 7);
  const door = fridge.root.getObjectByName("fridge-door")!;
  const light = fridge.root.getObjectByName("fridge-light") as THREE.PointLight;
  const bottle = fridge.root.getObjectByName("reusable-water-bottle")!;
  const stream = fridge.root.getObjectByName("refill-water")!;
  const id = bottle.uuid;
  for (const [stage] of DRINK_FRIDGE_STAGES) {
    const t = timeAt(stage);
    fridge.tick(t, 1 / 60);
    const sample = sampleDrinkFridge(t);
    assert.equal(bottle.uuid, id);
    assert.equal(bottle.parent, fridge.root);
    assert.equal(bottle.userData.owner, sample.bottleOwner);
    assert.deepEqual(bottle.position.toArray(), [sample.bottle.x, sample.bottle.y, sample.bottle.z]);
    assert.ok(Math.abs(door.rotation.y - sample.door * 1.72) < 1e-9);
    assert.ok(Math.abs(light.intensity - sample.light * 1.8) < 1e-9);
    assert.equal(stream.visible, sample.stream);
    let count = 0;
    fridge.root.traverse(object => { assert.equal(object.userData.keep, true); if (object.name === "reusable-water-bottle") count++; });
    assert.equal(count, 1);
  }
  fridge.dispose();
});

test("disposal releases each owned resource once without destroying shared mascot materials", () => {
  const scene = new THREE.Scene();
  const fridge = createDrinkFridge(scene, 0, 0);
  const actor = fridge.root.getObjectByName("fridge-guest")!;
  const mascotMaterials = new Set<THREE.Material>();
  actor.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mascotMaterials.add(material);
  });
  const geometryCalls = new Map<THREE.BufferGeometry, number>();
  const materialCalls = new Map<THREE.Material, number>();
  fridge.root.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!geometryCalls.has(mesh.geometry)) {
      geometryCalls.set(mesh.geometry, 0);
      mesh.geometry.addEventListener("dispose", () => geometryCalls.set(mesh.geometry, geometryCalls.get(mesh.geometry)! + 1));
    }
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (materialCalls.has(material)) continue;
      materialCalls.set(material, 0);
      material.addEventListener("dispose", () => materialCalls.set(material, materialCalls.get(material)! + 1));
    }
  });
  const state = fridge.root.userData.fridge;
  fridge.dispose();
  fridge.dispose();
  fridge.tick(30, 1);
  assert.equal(fridge.root.parent, null);
  assert.equal(fridge.root.userData.fridge, state);
  assert.ok([...geometryCalls.values()].every(count => count === 1));
  for (const [material, count] of materialCalls) assert.equal(count, mascotMaterials.has(material) ? 0 : 1);
});

test("fridge actor steps within reach and keeps fixed arms attached to the handle and bottle", (t) => {
  const scene = new THREE.Scene();
  scene.position.set(2, 0.3, -4);
  scene.rotation.y = 0.42;
  const fridge = createDrinkFridge(scene, 3, 6);
  t.after(() => fridge.dispose());
  const actor = fridge.root.getObjectByName("fridge-guest")!;
  const handle = fridge.root.getObjectByName("door-handle")!;
  const bottle = fridge.root.getObjectByName("reusable-water-bottle")!;
  assert.ok(fridge.root.getObjectByName("access-platform"));
  for (let frame = 0; frame <= DRINK_FRIDGE_CYCLE * 60; frame++) {
    fridge.tick(frame / 60, 1 / 60);
    fridge.root.updateWorldMatrix(true, true);
    const state = sampleDrinkFridge(frame / 60);
    const targets = [handle.localToWorld(new THREE.Vector3(0, -0.25, 0)), bottle.localToWorld(new THREE.Vector3(0, 0.11, 0))];
    for (let index = 0; index < 2; index++) {
      const shoulder = actor.getObjectByName(`mascot-forearm-${index}`)!.parent!;
      assert.equal((shoulder.children[0] as THREE.Mesh).scale.y, 1);
      const amount = index ? state.bottleReach : state.handleReach;
      if (amount < 0.99999) continue;
      const wrist = actor.getObjectByName(`mascot-hand-${index}`)!.getWorldPosition(new THREE.Vector3());
      assert.ok(wrist.distanceTo(targets[index]) < 0.001, `${state.stage} hand ${index} at ${frame / 60}`);
    }
  }
});
