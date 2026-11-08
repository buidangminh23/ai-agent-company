import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { animateLoungeProps, BILLIARD_RADIUS, BilliardsPhysics, createBilliards, createLoungeProps, LoungeDirector, loungePose, tickBilliards, type LoungeCue } from "./lounge.ts";
import { createMascot, mascotArmReach } from "./mascots.ts";

test("autonomous aiming completes an adjudicated eight-ball game without targeting the eight early", () => {
  const game = new BilliardsPhysics();
  let shots = 0;
  while (game.rules.winner === null && shots < 60) {
    game.prepare();
    const plan = game.plan();
    assert.ok(plan);
    const remaining = game.balls.filter(ball => !ball.pocketed && ball.number).map(ball => ball.number);
    assert.ok(game.rules.legalTargets(remaining).includes(plan.ball));
    assert.equal(game.strike(undefined, plan), true);
    for (let frame = 0; frame < 2400 && game.moving; frame++) game.step(1 / 120);
    assert.equal(game.moving, false);
    shots++;
  }
  assert.notEqual(game.rules.winner, null);
  assert.ok(shots > 2);
  assert.equal(game.balls[8].pocketed, true);
  assert.equal(game.rules.lastFoul, null);
});

test("a rack has all sixteen unique balls and a break transfers momentum, rebounds, pockets and settles", () => {
  const game = new BilliardsPhysics();
  assert.equal(game.balls.length, 16);
  assert.deepEqual([...game.balls.map(ball => ball.number)].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i));
  assert.ok(game.balls.every(ball => !ball.pocketed));
  assert.equal(game.strike(), true);
  assert.equal(game.strike(), false);
  const events = new Set<string>();
  for (let i = 0; i < 720; i++) {
    game.step(1 / 120);
    for (const event of game.events.splice(0)) events.add(event.kind);
  }
  assert.ok(events.has("collision"));
  assert.ok(events.has("cushion"));
  assert.ok(events.has("pocket"));
  assert.equal(game.moving, false);
  assert.ok(game.balls.every(ball => Number.isFinite(ball.x) && Number.isFinite(ball.z)));
});

test("a ball pockets, a scratched cue ball returns to a free spot, and a completed game reracks", () => {
  const game = new BilliardsPhysics();
  Object.assign(game.balls[1], { x: 0, z: 0.43, vx: 0, vz: 1 });
  game.step(0.02);
  assert.equal(game.balls[1].pocketed, true);
  Object.assign(game.balls[0], { pocketed: true, sink: 1 });
  game.prepare();
  assert.equal(game.balls[0].pocketed, false);
  assert.ok(game.balls.slice(1).every(ball => ball.pocketed || Math.hypot(ball.x - game.balls[0].x, ball.z - game.balls[0].z) >= BILLIARD_RADIUS * 2));
  game.shots = 7;
  game.prepare();
  assert.equal(game.shots, 7);
  game.rules.winner = 0;
  game.prepare();
  assert.equal(game.shots, 0);
  assert.equal(game.balls.filter(ball => !ball.pocketed).length, 16);
});

test("explicit strike direction follows the cue and frame gaps remain bounded", () => {
  const game = new BilliardsPhysics();
  game.strike({ x: 0, z: -1 });
  assert.ok(Math.abs(game.balls[0].vx) < 1e-9);
  assert.ok(game.balls[0].vz < 0);
  game.step(Number.NaN);
  assert.equal(game.balls[0].z, 0);
  game.step(30);
  assert.ok(game.balls.every(ball => Number.isFinite(ball.x) && Math.abs(ball.x) <= 1.01 && Math.abs(ball.z) <= 0.51));
});

test("table creation survives preattachment, shoots at cue contact, and disposes a detached office", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const context = { fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillText() {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } });
  const scene = new THREE.Scene();
  const office = new THREE.Group();
  office.position.set(4, 0, -3);
  office.rotation.y = 0.73;
  office.scale.y = 0.72;
  try {
    createBilliards(office);
    const game = office.getObjectByName("billiards-game")!;
    assert.equal(game.children.filter(child => child.name.startsWith("billiard-ball-")).length, 16);
    scene.add(office);
    const director = new LoungeDirector();
    const position = office.localToWorld(new THREE.Vector3(-1.5, 0, 0));
    const members = [{ id: "player", circle: "pool", activity: "pool" as const, x: position.x, z: position.z }];
    director.cues(members, 0);
    tickBilliards(0, 1 / 60);
    director.cues(members, 4.2);
    tickBilliards(4.2, 1 / 60);
    assert.equal(game.userData.billiards.shots, 0);
    const aim = director.cues(members, 4.2575).get("player")!.poolAim!;
    const direction = new THREE.Vector3(aim.dx, 0, aim.dz);
    const white = game.getObjectByName("billiard-ball-0")!;
    const before = white.getWorldPosition(new THREE.Vector3());
    const apex = game.getObjectByName("billiard-ball-1")!.getWorldPosition(new THREE.Vector3());
    assert.ok(apex.sub(before).normalize().dot(direction) > 0.999999);
    tickBilliards(4.3, 1 / 60);
    assert.ok(white.getWorldPosition(new THREE.Vector3()).sub(before).normalize().dot(direction) > 0.999999);
    const ballScale = white.getWorldScale(new THREE.Vector3());
    assert.ok(Math.abs(ballScale.x - 1) < 1e-9 && Math.abs(ballScale.y - 1) < 1e-9 && Math.abs(ballScale.z - 1) < 1e-9);
    assert.ok(Math.abs(before.y - (0.87 * 0.72 + BILLIARD_RADIUS)) < 1e-9);
    assert.equal(game.userData.billiards.shots, 1);
    assert.equal(director.cues(members, 6.6).get("player")!.shotPhase, 1);
    director.cues(members, 4.4);
    tickBilliards(4.4, 1 / 60);
    assert.equal(game.userData.billiards.shots, 1);
    let disposed = 0;
    const mesh = game.children.find(child => (child as THREE.Mesh).geometry && !child.name.startsWith("billiard-ball-")) as THREE.Mesh;
    mesh.geometry.addEventListener("dispose", () => disposed++);
    scene.remove(office);
    assert.equal(director.cues(members, 4.5).get("player")!.poolAim, undefined);
    tickBilliards(4.5, 1 / 60);
    assert.equal(disposed, 1);
    tickBilliards(4.6, 1 / 60);
    assert.equal(disposed, 1);
  } finally {
    scene.remove(office);
    tickBilliards(5, 0);
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("cue contacts the near ball surface in every direction regardless of parent, scale, lean and breathing", () => {
  for (const small of [false, true]) for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const rootParent of [false, true]) {
    const mascot = createMascot("codex", small);
    mascot.root.position.set(3, 0.1, -2);
    mascot.root.rotation.y = yaw;
    mascot.body.rotation.set(0.3, 0.2, -0.03);
    mascot.body.scale.set(0.991, 1.018, 0.991);
    const props = createLoungeProps(mascot);
    if (rootParent) mascot.root.add(props.cue);
    const direction = new THREE.Vector3(Math.sin(yaw), -0.045, Math.cos(yaw)).normalize();
    const ball = new THREE.Vector3(3 + Math.sin(yaw), 0.922, -2 + Math.cos(yaw));
    const cue: LoungeCue = { activity: "pool", lookAt: ball, speaking: false, laugh: 0, shooter: true, shotPhase: 0.655, cheer: 0, poolAim: { x: ball.x, y: ball.y, z: ball.z, dx: Math.sin(yaw), dz: Math.cos(yaw) } };
    animateLoungeProps(props, cue, loungePose(cue, yaw, mascot.root.position, 4.2575, 0, false), false, 4.2575, 1 / 60, yaw);
    const tip = props.cue.localToWorld(new THREE.Vector3(0, 0, 1.015));
    assert.ok(tip.distanceTo(ball.clone().addScaledVector(direction, -BILLIARD_RADIUS)) < 1e-9);
    const shaft = props.cue.children[0] as THREE.Mesh<THREE.BoxGeometry>;
    const butt = props.cue.localToWorld(new THREE.Vector3(0, 0, shaft.position.z - shaft.geometry.parameters.depth * shaft.scale.z / 2));
    assert.ok(Math.abs(tip.distanceTo(butt) - 1.5) < 1e-9);
    assert.ok(tip.clone().sub(butt).normalize().dot(direction) > 0.999999);
  }
});

test("mechanical bridge stays planted while fixed-length arms control the cue stroke", () => {
  const mascot = createMascot("codex", false);
  const props = createLoungeProps(mascot);
  const cue: LoungeCue = { activity: "pool", lookAt: { x: 0.4, z: 1 }, speaking: false, laugh: 0, shooter: true, shotPhase: 0, cheer: 0, poolAim: { x: 0.4, y: 0.922, z: 1, dx: 0, dz: 1 } };
  let bridge: THREE.Vector3 | undefined;
  let firstGrip: THREE.Vector3 | undefined;
  let lastGrip: THREE.Vector3 | undefined;
  for (const phase of [0.36, 0.4, 0.5, 0.6, 0.654, 0.655, 0.7]) {
    cue.shotPhase = phase;
    mascot.body.rotation.x = 0.3;
    mascot.body.scale.set(1, 1 + Math.sin(phase * 6) * 0.018, 1);
    animateLoungeProps(props, cue, loungePose(cue, 0, mascot.root.position, phase * 6.5, 0, false), false, phase * 6.5, 1 / 60, 0);
    const hand = props.poolRest.head.getWorldPosition(new THREE.Vector3());
    bridge ??= hand;
    assert.ok(hand.distanceTo(bridge) < 1e-9);
    const grip = props.poolRest.rear.localToWorld(new THREE.Vector3(0, 0.5, 0));
    for (const [index, arm] of props.poolArms.entries()) {
      assert.ok(Math.abs(arm.upper.scale.y - 0.16) < 1e-9);
      assert.ok(Math.abs(arm.forearm.scale.y - 0.144) < 1e-9);
      assert.ok(arm.hand.position.distanceTo(mascot.arms[index].position) < mascotArmReach(mascot, index));
      assert.equal((mascot.arms[index].children[0] as THREE.Mesh).scale.y, 1);
    }
    assert.equal(props.poolRest.root.visible, true);
    firstGrip ??= grip;
    lastGrip = grip;
    if (phase < 0.655) assert.ok(props.cue.localToWorld(new THREE.Vector3(0, 0, 1.015)).z < 1 - BILLIARD_RADIUS);
  }
  assert.ok(lastGrip!.z > firstGrip!.z + 0.13);
  assert.ok(Math.abs(lastGrip!.x - firstGrip!.x) < 1e-9);
  assert.ok(Math.abs((lastGrip!.y - firstGrip!.y) / (lastGrip!.z - firstGrip!.z) + 0.045) < 1e-9);
  cue.shotPhase = 0.8;
  animateLoungeProps(props, cue, loungePose(cue, 0, mascot.root.position, 5.2, 0, false), false, 5.2, 1 / 60, 0);
  assert.equal(props.cue.visible, false);
  assert.ok(props.poolArms.every(arm => !arm.root.visible));
  animateLoungeProps(props, null, null, false, 7, 1, 0);
  assert.ok(props.poolArms.every(arm => !arm.root.visible));
  assert.ok(mascot.arms.every(arm => arm.children[0].visible));
});

test("a lone player walks around the table for distant balls at walking speed with a reachable grip", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const context = { fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillText() {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } });
  const scene = new THREE.Scene();
  const table = new THREE.Group();
  table.rotation.y = Math.PI / 2;
  scene.add(table);
  try {
    createBilliards(table);
    const director = new LoungeDirector();
    const members = [{ id: "player", circle: "pool", activity: "pool" as const, x: 0, z: -1.8 }];
    let approaches = 0;
    let previous = { x: 0, z: -1.8 };
    for (let frame = 0; frame < 3600; frame++) {
      const t = frame / 60;
      const cue = director.cues(members, t).get("player")!;
      const pose = loungePose(cue, 0, members[0], t, 0, false);
      const position = pose.stance ?? members[0];
      if (cue.poolAim?.approach) approaches++;
      if (cue.poolAim) {
        assert.ok(cue.poolAim.gripDistance! < 2.6);
        assert.ok(cue.poolAim.gripDistance! - cue.poolAim.bridgeDistance! < 0.9);
      }
      const local = table.worldToLocal(new THREE.Vector3(position.x, 0, position.z));
      assert.ok(Math.abs(local.x) >= 1.1 || Math.abs(local.z) >= 0.6, "player walks through the table");
      assert.ok(Math.hypot(position.x - previous.x, position.z - previous.z) * 60 < 2.05, "approach exceeds walking speed");
      previous = position;
      tickBilliards(t, 1 / 60);
    }
    assert.ok(approaches > 0);
  } finally {
    scene.remove(table);
    tickBilliards(61, 0);
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("the cue clears the head and torso at all three pool seats during the complete stroke", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const context = { fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, fillText() {} };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } });
  try {
    for (const [x, z] of [[-1.05, 0], [1.05, 0], [0, -1.8]]) for (const small of [false, true]) {
      const scene = new THREE.Scene();
      const table = new THREE.Group();
      table.rotation.y = Math.PI / 2;
      table.scale.y = 0.72;
      scene.add(table);
      createBilliards(table);
      const director = new LoungeDirector();
      const members = [{ id: "player", circle: "pool", activity: "pool" as const, x, z }];
      const mascot = createMascot("codex", small);
      mascot.root.position.set(x, 0.1, z);
      const yaw = Math.atan2(-x, -z);
      mascot.root.rotation.y = yaw;
      mascot.body.scale.set(0.991, 1.018, 0.991);
      const bodyMeshes = mascot.body.children.filter((child): child is THREE.Mesh<THREE.BoxGeometry> => (child as THREE.Mesh).isMesh === true);
      const props = createLoungeProps(mascot);
      director.cues(members, 0);
      for (const phase of [0.36, 0.4, 0.5, 0.6, 0.655, 0.7]) {
        const cue = director.cues(members, phase * 6.5).get("player")!;
        cue.shotPhase = phase;
        const pose = loungePose(cue, yaw, { x, z }, phase * 6.5, 0, false);
        mascot.root.position.set(pose.stance?.x ?? x, 0.1, pose.stance?.z ?? z);
        mascot.body.rotation.set(pose.lean ?? 0, pose.bodyYaw ?? 0, 0, "YXZ");
        animateLoungeProps(props, cue, pose, false, phase * 6.5, 1 / 60, yaw);
        const shaft = props.cue.children[0] as THREE.Mesh<THREE.BoxGeometry>;
        const start = props.cue.localToWorld(new THREE.Vector3(0, 0, shaft.position.z - shaft.geometry.parameters.depth * shaft.scale.z / 2));
        const end = props.cue.localToWorld(new THREE.Vector3(0, 0, 1.015));
        const bridge = (props.poolRest.head.scale.x > 0 && props.poolRest.root.visible ? props.poolRest.head : props.poolArms[0].hand).getWorldPosition(new THREE.Vector3());
        const localBridge = table.worldToLocal(bridge.clone());
        assert.ok(Math.abs(localBridge.x) <= 1.02 && Math.abs(localBridge.z) <= 0.52);
        assert.ok(Math.abs(bridge.y - cue.poolAim!.bridgeY!) < 1e-9);
        for (const [index, arm] of props.poolArms.entries()) {
          assert.ok(arm.hand.position.distanceTo(mascot.arms[index].position) <= mascotArmReach(mascot, index));
          assert.ok(Math.abs(arm.upper.scale.y - 0.16) < 1e-9);
          assert.ok(Math.abs(arm.forearm.scale.y - 0.144) < 1e-9);
        }
        for (const mesh of bodyMeshes) {
          mesh.geometry.computeBoundingBox();
          const bounds = mesh.geometry.boundingBox!.clone().expandByScalar(0.025 / mascot.root.scale.x);
          const a = mesh.worldToLocal(start.clone());
          const b = mesh.worldToLocal(end.clone());
          const ray = new THREE.Ray(a, b.clone().sub(a).normalize());
          const hit = ray.intersectBox(bounds, new THREE.Vector3());
          assert.ok(!hit || hit.distanceTo(a) > b.distanceTo(a), `cue overlaps body at seat ${x},${z}, small=${small}, phase=${phase}`);
        }
      }
      scene.remove(table);
      tickBilliards(7, 0);
    }
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
