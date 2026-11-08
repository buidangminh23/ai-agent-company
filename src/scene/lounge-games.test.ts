import assert from "node:assert/strict";
import test from "node:test";
const context = { fillRect() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, stroke() {}, strokeRect() {}, arc() {}, fill() {}, fillText() {} };
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } });
const { consoleMatch, FOOSBALL_RODS, FoosballGame, createLoungeGames } = await import("./lounge-games.ts");
const THREE = await import("three");
test.after(() => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

test("foosball has eight rods and each side uses one, two, five and three figures", () => {
  assert.equal(FOOSBALL_RODS.length, 8);
  for (const team of [0, 1]) assert.deepEqual(FOOSBALL_RODS.filter(rod => rod.team === team).map(rod => rod.count).sort(), [1, 2, 3, 5]);
});

test("a ball scores only through the goal mouth and the conceding team serves", () => {
  const game = new FoosballGame(); game.phase = "play";
  Object.assign(game.ball, { x: 0.96, z: 0.32, vx: 2, vz: 0 });
  game.step(0.05);
  assert.deepEqual(game.score, [0, 0]); assert.ok(game.ball.vx < 0);
  Object.assign(game.ball, { x: 0.97, z: 0, vx: 2, vz: 0 });
  game.step(0.05);
  assert.deepEqual(game.score, [1, 0]); assert.equal(game.server, 1); assert.equal(game.phase, "goal");
  for (let i = 0; i < 35; i++) game.step(0.1);
  assert.equal(game.phase, "ready"); assert.ok(game.ball.x > 0);
});

test("five goals end the match before scores reset and serving resumes", () => {
  const game = new FoosballGame(); game.score[1] = 4; game.phase = "play";
  Object.assign(game.ball, { x: -0.98, z: 0, vx: -2, vz: 0 }); game.step(0.05);
  assert.equal(game.winner, 1); assert.equal(game.phase, "match"); assert.equal(game.score[1], 5);
  for (let i = 0; i < 55; i++) game.step(0.1);
  assert.deepEqual(game.score, [0, 0]); assert.equal(game.winner, null); assert.equal(game.server, 0);
});

test("autonomous play keeps the ball bounded, rods controlled and motion deterministic", () => {
  const a = new FoosballGame(), b = new FoosballGame(); let goals = 0; let previous = "ready";
  for (let frame = 0; frame < 60 * 180; frame++) {
    a.step(1 / 60); b.step(1 / 60);
    assert.ok(Number.isFinite(a.ball.x) && Math.abs(a.ball.x) < 1.04 && Math.abs(a.ball.z) <= 0.431);
    assert.ok(a.rods.every(rod => Math.abs(rod.angle) <= 0.95 && Math.abs(rod.offset) <= 0.43));
    if (a.phase === "goal" && previous !== "goal") goals++;
    previous = a.phase;
  }
  assert.deepEqual(a.ball, b.ball); assert.deepEqual(a.score, b.score); assert.ok(goals > 0);
});

test("console football score and celebrations follow the actual goal sequence", () => {
  assert.equal(consoleMatch(17).phase, "play"); assert.deepEqual(consoleMatch(17).score, [0, 0]);
  assert.equal(consoleMatch(19).phase, "goal"); assert.deepEqual(consoleMatch(19).score, [1, 0]);
  assert.equal(consoleMatch(23).phase, "restart"); assert.deepEqual(consoleMatch(24).score, [1, 0]);
  assert.equal(consoleMatch(43).scorer, 1); assert.deepEqual(consoleMatch(43).score, [1, 1]);
  assert.deepEqual(consoleMatch(Number.NaN).score, [0, 0]);
});

test("lounge props remain finite and animated under transformed parents", () => {
  const scene = new THREE.Scene();
  const parent = new THREE.Group(); parent.position.set(8, 0, 3); parent.rotation.y = 0.7; scene.add(parent);
  const games = createLoungeGames(parent, { x: -3, z: 0 }, { x: 3, z: 0 });
  const console = parent.getObjectByName("ps5-lounge")!;
  const table = parent.getObjectByName("foosball-lounge")!;
  assert.ok(console.getObjectByName("ps5-console"));
  assert.ok(console.getObjectByName("console-player-0")!.getObjectByName("dualsense-controller"));
  assert.equal(table.children.filter(child => child.name.startsWith("foosball-rod-")).length, 8);
  const armAnchors = new Map<InstanceType<typeof THREE.Object3D>, InstanceType<typeof THREE.Vector3>>();
  parent.traverse(object => {
    if (object.name.startsWith("mascot-forearm-")) armAnchors.set(object.parent!, object.parent!.position.clone());
  });
  for (let frame = 0; frame < 60 * 25; frame++) {
    games.tick(frame / 60, 1 / 60);
    parent.updateWorldMatrix(true, true);
    if (frame % 60) continue;
    for (const [arm, anchor] of armAnchors) {
      assert.deepEqual(arm.position.toArray(), anchor.toArray());
      const upper = arm.children[0] as InstanceType<typeof THREE.Mesh>;
      assert.equal(upper.scale.y, 1);
      const forearm = arm.children.find(child => child.name.startsWith("mascot-forearm-"))!;
      const lower = forearm.children[0] as InstanceType<typeof THREE.Mesh>;
      assert.equal(lower.scale.y, 1);
      const wrist = arm.parent!.worldToLocal(forearm.children[1].getWorldPosition(new THREE.Vector3()));
      const dimensions = upper.geometry as InstanceType<typeof THREE.BoxGeometry>;
      assert.ok(wrist.distanceTo(arm.position) <= dimensions.parameters.height * 1.9 + 0.00001);
    }
    for (const index of [0, 1]) {
      const actor = console.getObjectByName(`console-player-${index}`)!;
      const pad = actor.getObjectByName("dualsense-controller")!;
      for (const hand of pad.userData.oneHanded ? [1] : [0, 1]) {
        const wrist = actor.getObjectByName(`mascot-hand-${hand}`)!.getWorldPosition(new THREE.Vector3());
        const grip = pad.localToWorld(new THREE.Vector3(hand ? 0.09 : -0.09, 0, 0.025));
        assert.ok(wrist.distanceTo(grip) < 0.00001);
      }
    }
    parent.traverse(object => {
      assert.ok(object.matrixWorld.elements.every(Number.isFinite), object.name);
      assert.equal(object.userData.keep, object === parent ? undefined : true);
    });
  }
  const consoleBounds = new THREE.Box3().setFromObject(console);
  assert.ok(!consoleBounds.isEmpty());
  games.dispose();
});
