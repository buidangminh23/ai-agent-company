import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { createDrinkBar, drinkGuestPosition, DRINK_BAR_CYCLE, DRINK_BAR_FOOTPRINT, DRINK_BAR_MENU, DRINK_BAR_STAGES, MATCHA_LATTE_METHOD, sampleDrinkBar } from "./drink-bar.ts";
import { DRINK_BAR_SEATS } from "./layout.ts";
import { createMascot, mascotArmReach, mascotHandPosition, reachMascotHand, resetMascotHands } from "./mascots.ts";

const services = DRINK_BAR_MENU.map((recipe, index) => ({
  recipe,
  index,
  start: DRINK_BAR_MENU.slice(0, index).reduce((sum, item) => sum + DRINK_BAR_CYCLE - 6 + item.brewSeconds, 0),
  duration: DRINK_BAR_CYCLE - 6 + recipe.brewSeconds,
}));
const menuDuration = services.reduce((sum, service) => sum + service.duration, 0);
const stageDurations = (brewSeconds: number) => DRINK_BAR_STAGES.map(([stage, duration]) => [stage, stage === "brew" ? brewSeconds : duration] as const);

test("all seven drinks complete their own preparation timing and alternate guests", () => {
  assert.deepEqual(DRINK_BAR_MENU.map(recipe => recipe.id), ["espresso", "orange", "matcha-latte", "latte", "cappuccino", "americano", "lemon-tea"]);
  assert.equal(DRINK_BAR_CYCLE, 62);
  for (let repetition = 0; repetition < 2; repetition++) for (const service of services) {
    let time = repetition * menuDuration + service.start;
    for (const [stage, duration] of stageDurations(service.recipe.brewSeconds)) {
      const sample = sampleDrinkBar(time + duration / 2);
      assert.equal(sample.stage, stage, `${service.recipe.id}: ${stage}`);
      assert.equal(sample.recipe, service.recipe.id);
      assert.equal(sample.guest, (repetition * services.length + service.index) % 2);
      assert.equal(sample.brewSeconds, service.recipe.brewSeconds);
      assert.ok(Number.isFinite(sample.fill) && sample.fill >= 0 && sample.fill <= 1);
      if (stage === "brew") assert.ok(Math.abs(sample.brewElapsed - duration / 2) < 0.00001);
      time += duration;
    }
    assert.equal(time, repetition * menuDuration + service.start + service.duration);
  }
  assert.equal(sampleDrinkBar(Number.NaN).stage, "approach");
  assert.equal(sampleDrinkBar(Number.POSITIVE_INFINITY).stage, "approach");
  assert.equal(sampleDrinkBar(-5).stage, "approach");
});

test("matcha is sifted, hydrated, whisked for fifteen seconds, transferred and finished with milk", () => {
  const service = services.find(entry => entry.recipe.id === "matcha-latte")!;
  assert.equal(service.recipe.brewSeconds, 36);
  assert.deepEqual(MATCHA_LATTE_METHOD, { matchaGrams: 3, waterMl: 100, waterCelsius: 80, whiskSeconds: 15, milkMl: 100 });
  const brewStart = service.start + 14;
  const phases = [["sift", 0, 4], ["water", 4, 7], ["whisk-setup", 7, 8], ["whisk", 8, 23], ["whisk-rest", 23, 24], ["transfer", 24, 29], ["milk", 29, 34], ["finish", 34, 36]] as const;
  for (const [step, start, end] of phases) {
    for (const offset of [start, (start + end) / 2, end - 0.00001]) {
      const sample = sampleDrinkBar(brewStart + offset);
      assert.equal(sample.stage, "brew");
      assert.equal(sample.recipeStep, step, `matcha step at ${offset}s`);
      assert.ok(Math.abs(sample.brewElapsed - offset) < 0.00001);
    }
  }
  let whiskSeconds = 0;
  for (let elapsed = 0; elapsed < 36; elapsed += 0.25) if (sampleDrinkBar(brewStart + elapsed).recipeStep === "whisk") whiskSeconds += 0.25;
  assert.equal(whiskSeconds, 15);
  assert.equal(sampleDrinkBar(brewStart + 36).stage, "serve");
});

test("matcha whisk makes an M stroke inside the bowl for all fifteen working seconds", (t) => {
  const bar = createDrinkBar(new THREE.Scene(), 0, 0);
  t.after(() => bar.dispose());
  const service = services.find(entry => entry.recipe.id === "matcha-latte")!;
  const whisk = bar.root.getObjectByName("bar-matcha-whisk")!;
  const bowl = bar.root.getObjectByName("bar-matcha-bowl")!;
  const whiskStart = service.start + 14 + 8;
  for (let second = 0; second < MATCHA_LATTE_METHOD.whiskSeconds; second++) {
    const tips: THREE.Vector3[] = [];
    for (let frame = 0; frame < 60; frame++) {
      const time = whiskStart + second + frame / 60;
      bar.tick(time, 1 / 60);
      bar.root.updateWorldMatrix(true, true);
      assert.equal(sampleDrinkBar(time).recipeStep, "whisk");
      const tip = bowl.worldToLocal(whisk.localToWorld(new THREE.Vector3(0, 0.012, 0)));
      assert.ok(Math.hypot(tip.x, tip.z) < 0.13, `whisk outside bowl at ${time}`);
      assert.ok(tip.y > 0.016 && tip.y < 0.065, `whisk not in liquid at ${time}`);
      tips.push(tip);
    }
    assert.ok(Math.max(...tips.map(tip => tip.x)) - Math.min(...tips.map(tip => tip.x)) > 0.04, `whisk stopped sweeping at second ${second}`);
    assert.ok(Math.max(...tips.map(tip => tip.z)) - Math.min(...tips.map(tip => tip.z)) > 0.02, `whisk stopped its M stroke at second ${second}`);
  }
  const stroke: THREE.Vector3[] = [];
  for (let frame = 0; frame < 240; frame++) {
    bar.tick(whiskStart + frame / 240, 0);
    stroke.push(whisk.position.clone());
  }
  const turn = stroke.findIndex((point, index) => index > 0 && point.x < stroke[index - 1].x);
  assert.ok(turn > 4, "whisk does not sweep across the bowl");
  const traverse = stroke.slice(0, turn);
  const peaks = traverse.filter((point, index) => index > 0 && index < traverse.length - 1 && point.z > traverse[index - 1].z && point.z > traverse[index + 1].z);
  const valleys = traverse.filter((point, index) => index > 0 && index < traverse.length - 1 && point.z < traverse[index - 1].z && point.z < traverse[index + 1].z);
  assert.equal(peaks.length, 2, "whisk lacks the two peaks of an M stroke");
  assert.equal(valleys.length, 1, "whisk lacks the middle valley of an M stroke");
});

test("coffee milk, citrus and tea tools are used only by their matching recipes", (t) => {
  const bar = createDrinkBar(new THREE.Scene(), 0, 0);
  t.after(() => bar.dispose());
  const pitcher = bar.root.getObjectByName("drink-milk-pitcher")!;
  const teaPot = bar.root.getObjectByName("bar-tea-pot")!;
  const citrus = bar.root.getObjectByName("bar-orange-half")!;
  const bartender = bar.root.getObjectByName("drink-bar-bartender")!;
  const stream = bar.root.getObjectByName("drink-pour-stream")! as THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  for (const service of services) {
    const brewStart = service.start + 14;
    bar.tick(brewStart + service.recipe.brewSeconds * 0.8, 0);
    assert.equal(bartender.rotation.y, service.recipe.family === "matcha" ? -Math.PI / 2 : service.recipe.family === "cold" ? Math.PI / 2 : -Math.PI);
    if (service.recipe.id === "latte" || service.recipe.id === "cappuccino") {
      assert.ok(pitcher.rotation.z > 0.1);
      assert.equal(stream.visible, true);
      assert.equal(stream.material.color.getHex(), 0xfff5dc);
      assert.equal(sampleDrinkBar(brewStart + service.recipe.brewSeconds * 0.8).recipeStep, "milk");
    } else {
      assert.equal(pitcher.rotation.z, 0, `unexpected coffee milk for ${service.recipe.id}`);
    }
    if (service.recipe.id === "americano") {
      assert.equal(stream.visible, true);
      assert.equal(stream.material.color.getHex(), 0xcadadd);
      assert.equal(sampleDrinkBar(brewStart + service.recipe.brewSeconds * 0.8).recipeStep, "water");
    }
    bar.tick(brewStart + 2, 0);
    assert.equal(Math.abs(citrus.rotation.y) > 0.1, service.recipe.id === "orange");
    assert.equal(Math.abs(teaPot.rotation.x) > 0.1, service.recipe.id === "lemon-tea");
  }
});

test("guests walk around the counter and stay within the reserved area", () => {
  for (let t = 0; t < menuDuration; t += 1 / 60) {
    const position = drinkGuestPosition(sampleDrinkBar(t));
    assert.ok(Math.hypot(position.x, position.z) >= (Math.abs(position.x) < 0.1 ? 1.4499 : 1.8));
    assert.ok(position.x >= DRINK_BAR_FOOTPRINT.x0 && position.x <= DRINK_BAR_FOOTPRINT.x1 && position.z >= DRINK_BAR_FOOTPRINT.z0 && position.z <= DRINK_BAR_FOOTPRINT.z1);
    const next = drinkGuestPosition(sampleDrinkBar(t + 1 / 60));
    if (sampleDrinkBar(t).guest === sampleDrinkBar(t + 1 / 60).guest) assert.ok(Math.hypot(next.x - position.x, next.z - position.z) * 60 < 2.1);
  }
});

test("one physical service cup follows ownership without duplicate cups", (t) => {
  const scene = new THREE.Scene();
  const bar = createDrinkBar(scene, 10, 11);
  t.after(() => bar.dispose());
  const cup = bar.root.getObjectByName("drink-service-cup")!;
  const owners = new Set<string>();
  for (let time = 0; time < menuDuration; time += 0.2) {
    bar.tick(time, 0.2);
    const sample = sampleDrinkBar(time);
    owners.add(sample.cupOwner);
    assert.equal(bar.root.getObjectsByProperty("name", "drink-service-cup").length, 1);
    assert.ok(cup.position.toArray().every(Number.isFinite));
    if (sample.stage === "drop" && sample.progress > 0.6) assert.equal(cup.position.x, -0.21);
    if (sample.stage === "drink" && sample.progress > 0.88) {
      const guest = bar.root.getObjectByName(`drink-bar-guest-${sample.guest + 1}`)!;
      const seat = DRINK_BAR_SEATS[sample.guest];
      assert.equal(guest.position.x, seat.x);
      assert.equal(guest.position.z, seat.z);
      assert.equal(guest.rotation.y, seat.yaw);
    }
  }
  assert.deepEqual([...owners].sort(), ["bartender", "counter", "guest", "return"]);
});

test("all mascot apps keep immutable arm geometry and fixed joints for distant and transformed targets", () => {
  for (const app of ["claude", "codex", "antigravity"] as const) {
    const scene = new THREE.Scene();
    const mascot = createMascot(app, true);
    mascot.root.position.set(4, 0.6, -7);
    mascot.root.rotation.set(0.1, 1.2, -0.05);
    mascot.body.scale.set(0.99, 1.02, 0.99);
    scene.add(mascot.root);
    const anchor = new THREE.Group();
    anchor.position.set(-3, 2, 5);
    anchor.rotation.y = -0.7;
    scene.add(anchor);
    for (const [index, arm] of mascot.arms.entries()) {
      const upper = arm.children[0] as THREE.Mesh<THREE.BoxGeometry>;
      const length = upper.geometry.parameters.height;
      const shoulder = arm.position.clone();
      const forearm = arm.getObjectByName(`mascot-forearm-${index}`)!;
      for (let frame = 0; frame < 180; frame++) {
        resetMascotHands(mascot);
        const point = reachMascotHand(mascot, index, anchor, Math.sin(frame) * 20, Math.cos(frame * 0.9) * 15, Math.cos(frame * 0.7) * 20);
        scene.updateWorldMatrix(true, true);
        const actual = mascotHandPosition(mascot, index, anchor);
        assert.ok(point.distanceTo(actual) < 0.00001);
        const wrist = mascot.body.worldToLocal(anchor.localToWorld(actual));
        const elbow = mascot.body.worldToLocal(forearm.getWorldPosition(new THREE.Vector3()));
        assert.equal(upper.geometry.parameters.height, length);
        assert.equal(upper.scale.y, 1);
        assert.deepEqual(arm.position, shoulder);
        assert.ok(Math.abs(elbow.distanceTo(shoulder) - length) < 0.00001);
        assert.ok(Math.abs(wrist.distanceTo(elbow) - length * 0.9) < 0.00001);
        assert.ok(wrist.distanceTo(shoulder) <= mascotArmReach(mascot, index));
      }
    }
  }
});

test("both cafe guests keep short arms and their service cup touches the real wrist throughout every drink", (t) => {
  const bar = createDrinkBar(new THREE.Scene(), 10, -7);
  t.after(() => bar.dispose());
  bar.root.rotation.y = 0.6;
  const cup = bar.root.getObjectByName("drink-service-cup")!;
  for (let frame = 0; frame < menuDuration * 30; frame++) {
    const time = frame / 30;
    bar.tick(time, 1 / 30);
    bar.root.updateWorldMatrix(true, true);
    const sample = sampleDrinkBar(time);
    for (let index = 0; index < 2; index++) {
      const guest = bar.root.getObjectByName(`drink-bar-guest-${index + 1}`)!;
      for (const handIndex of [0, 1]) {
        const arm = guest.getObjectByName(`mascot-arm-${handIndex}`)!;
        const mesh = arm.children[0] as THREE.Mesh;
        assert.equal(mesh.scale.y, 1, `stretched guest ${index} at ${time}`);
      }
    }
    if (sample.cupOwner === "guest") {
      const guest = bar.root.getObjectByName(`drink-bar-guest-${sample.guest + 1}`)!;
      const wrist = guest.getObjectByName("mascot-hand-1")!.getWorldPosition(new THREE.Vector3());
      const grip = cup.localToWorld(new THREE.Vector3(0.069, 0.065, 0));
      assert.ok(wrist.distanceTo(grip) < 0.00001, `detached cafe cup at ${time}`);
    }
  }
});

test("cafe guests climb ahead of each solid stair tread without walking through the steps", (t) => {
  const bar = createDrinkBar(new THREE.Scene(), 0, 0);
  t.after(() => bar.dispose());
  const steps = bar.root.getObjectByName("drink-service-steps")!;
  const ray = new THREE.Raycaster();
  for (let frame = 0; frame < DRINK_BAR_CYCLE * 120; frame++) {
    const time = frame / 120;
    bar.tick(time, 1 / 120);
    bar.root.updateWorldMatrix(true, true);
    const guest = bar.root.getObjectByName(`drink-bar-guest-${sampleDrinkBar(time).guest + 1}`)!;
    ray.set(new THREE.Vector3(guest.position.x, 3, guest.position.z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(steps, true)[0];
    if (hit) assert.ok(guest.position.y >= hit.point.y - 0.015, `step penetration at ${time}`);
  }
});

test("cup, bartender and wrists remain continuous through every recipe and stage boundary", (t) => {
  const bar = createDrinkBar(new THREE.Scene(), 0, 0);
  t.after(() => bar.dispose());
  const names = ["drink-service-cup", "drink-bar-bartender", "drink-bartender-wrist-0", "drink-bartender-wrist-1"];
  const objects = names.map(name => bar.root.getObjectByName(name)!);
  for (const service of services) {
    let boundary = service.start;
    for (const [, duration] of stageDurations(service.recipe.brewSeconds)) {
      boundary += duration;
      bar.tick(boundary - 0.0001, 0);
      bar.root.updateWorldMatrix(true, true);
      const before = objects.map(object => ({ position: object.getWorldPosition(new THREE.Vector3()), rotation: object.getWorldQuaternion(new THREE.Quaternion()) }));
      bar.tick(boundary + 0.0001, 0);
      bar.root.updateWorldMatrix(true, true);
      objects.forEach((object, index) => {
        assert.ok(object.getWorldPosition(new THREE.Vector3()).distanceTo(before[index].position) < 0.001, `${names[index]} position discontinuity at ${boundary}`);
        if (names[index] === "drink-bar-bartender") assert.ok(object.getWorldQuaternion(new THREE.Quaternion()).angleTo(before[index].rotation) < 0.001, `bartender turn discontinuity at ${boundary}`);
      });
    }
  }
});

test("bartender uses fixed-length elbows, faces held props and moves wrists continuously for every drink", (t) => {
  const bar = createDrinkBar(new THREE.Scene(), 10, 11);
  t.after(() => bar.dispose());
  bar.root.rotation.y = 0.7;
  const bartender = bar.root.getObjectByName("drink-bar-bartender")!;
  const shoulders = [0, 1].map(index => bar.root.getObjectByName(`drink-bartender-shoulder-${index}`)!);
  const elbows = [0, 1].map(index => bar.root.getObjectByName(`drink-bartender-elbow-${index}`)!);
  const wrists = [0, 1].map(index => bar.root.getObjectByName(`drink-bartender-wrist-${index}`)!);
  let previous: THREE.Vector3[] | null = null;
  let previousYaw = 0;
  for (let frame = 0; frame <= Math.ceil(menuDuration * 60); frame++) {
    const time = frame / 60;
    bar.tick(time, 1 / 60);
    bar.root.updateWorldMatrix(true, true);
    const hands = bar.root.userData.bartenderHands as { weight: number; target: number[] }[];
    const points = wrists.map(wrist => wrist.getWorldPosition(new THREE.Vector3()));
    for (let index = 0; index < 2; index++) {
      const shoulder = shoulders[index].getWorldPosition(new THREE.Vector3());
      const elbow = elbows[index].getWorldPosition(new THREE.Vector3());
      assert.ok(Math.abs(shoulder.distanceTo(elbow) - 0.44) < 0.00001, `upper arm at ${time}`);
      assert.ok(Math.abs(elbow.distanceTo(points[index]) - 0.44) < 0.00001, `forearm at ${time}`);
      if (previous) assert.ok(points[index].distanceTo(previous[index]) * 60 < 3.5, `wrist speed at ${time}`);
      if (hands[index].weight > 0.99999) {
        const target = bar.root.localToWorld(new THREE.Vector3().fromArray(hands[index].target));
        assert.ok(points[index].distanceTo(target) < 0.001, `detached hand at ${time}`);
        assert.ok(bartender.worldToLocal(target.clone()).z > 0, `backwards reach at ${time}`);
      }
    }
    const yaw = bartender.rotation.y;
    if (previous) assert.ok(Math.abs(Math.atan2(Math.sin(yaw - previousYaw), Math.cos(yaw - previousYaw))) * 60 < 3.5, `turn speed at ${time}`);
    previous = points;
    previousYaw = yaw;
  }
});

test("bartender and tools render the same pose when seeking or skipping animation frames", (t) => {
  const bar = createDrinkBar(new THREE.Scene(), 0, 0);
  t.after(() => bar.dispose());
  const names = ["drink-bar-bartender", "drink-bartender-wrist-0", "drink-bartender-wrist-1", "drink-service-cup", "drink-shaker", "drink-milk-pitcher", "drink-pour-stream", "bar-matcha-bowl", "bar-matcha-whisk", "bar-matcha-sieve", "bar-matcha-scoop", "bar-temperature-kettle", "bar-matcha-milk-pitcher", "bar-citrus-juicer", "bar-tea-pot", "bar-orange-half"];
  const pose = (time: number) => {
    bar.tick(time, 0);
    bar.root.updateWorldMatrix(true, true);
    return names.map(name => bar.root.getObjectByName(name)!.matrixWorld.toArray());
  };
  const times = services.flatMap(service => {
    let boundary = service.start;
    return stageDurations(service.recipe.brewSeconds).flatMap(([, duration]) => {
      const points = [boundary, boundary + duration / 2, boundary + duration - 0.0001];
      boundary += duration;
      return points;
    });
  });
  const matcha = services.find(service => service.recipe.id === "matcha-latte")!;
  times.push(...[0, 4, 7, 8, 15.5, 23, 24, 29, 34, 36].map(elapsed => matcha.start + 14 + elapsed));
  for (const time of times) {
    const expected = pose(time);
    pose(0);
    pose(menuDuration + 17);
    assert.deepEqual(pose(time), expected, `frame history affected pose at ${time}`);
  }
});
