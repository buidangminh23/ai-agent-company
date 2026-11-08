import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { AgentManager } from "./agents.ts";
import { buildLife } from "./life.ts";
import { DRINK_BAR_SEATS, LOUNGE_SPOTS, ZONE_BY_ID, configureLayout, constrainWalk, roleSeat, routeBetween, walkSegmentClear, zoneOf } from "./scene/layout.ts";
import type { AgentInfo } from "../shared/types.ts";
import { createMascot, mascotArmReach, mascotDeskPosture, mascotHandPosition, poseMascotSeated, resetMascotHands } from "./scene/mascots.ts";
import { animateClipboard, animateTrainingProps, animateWorkProps, animateWorkstation, createTrainingProps, createWorkProps, resetWorkstation, sampleDeskAction, sampleDeskKeystroke, type WorkstationRig } from "./scene/work.ts";
import { animateRackProps, createRackProps, rackPose, rackStep } from "./scene/rackwork.ts";
import { reachMascotHand } from "./scene/mascots.ts";

const NOW = Date.parse("2026-11-02T08:00:00Z");

function deskFixture(): THREE.Group {
  const root = new THREE.Group();
  root.name = "agent-workstation";
  const part = (parent: THREE.Object3D, x = 0, y = 0, z = 0) => { const group = new THREE.Group(); group.position.set(x, y, z); parent.add(group); return group; };
  const keyboardTray = part(root, 0, 0.76, 0.27);
  const keyboard = part(keyboardTray, 0, 0.034, 0);
  const mouseTray = part(root, 0.42, 0.76, 0.27);
  const mouse = part(mouseTray, 0, 0.035, 0);
  const cupTray = part(root, 0.73, 0.775, 0.2);
  const mug = part(cupTray);
  const notebook = part(root, -0.69, 0.775, 0.18);
  const chair = part(root, 0, 0, 0.58);
  const chairSeat = part(chair, 0, 0.44, 0);
  const chairBack = part(chairSeat, 0, 0.1, -0.23);
  const keys = new THREE.InstancedMesh(new THREE.BoxGeometry(0.028, 0.012, 0.025), new THREE.MeshBasicMaterial(), 56);
  const keyRest = Array.from({ length: 56 }, (_, index) => new THREE.Matrix4().makeTranslation((index % 14 - 6.5) * 0.034, 0.023, (Math.floor(index / 14) - 1.5) * 0.034));
  keyRest.forEach((matrix, index) => keys.setMatrixAt(index, matrix));
  keyboard.add(keys);
  root.userData.workstation = { keyboard, mouse, mug, notebook, chair, chairSeat, chairBack, keyboardTray, mouseTray, cupTray, keys, keyRest, fans: [], seatHeight: 0.48 } satisfies WorkstationRig;
  return root;
}

test("desk schedules use distinct work, rest and thought actions and reduced motion stays neutral", () => {
  const seen = new Set<string>();
  for (const state of ["working", "thinking", "waiting", "idle"] as const) {
    for (let time = 0; time < 120; time += 0.1) {
      const sample = sampleDeskAction(state, time);
      seen.add(sample.action);
      assert.ok(sample.progress >= 0 && sample.progress < 1);
      assert.ok(Object.values(sample).filter(value => typeof value === "number").every(Number.isFinite));
      assert.deepEqual(sampleDeskAction(state, time, 1, true), sampleDeskAction(state, 0, 0, true));
    }
  }
  assert.deepEqual([...seen].sort(), ["mouse", "read", "recline", "settle", "sip", "stretch", "think", "type"]);
  assert.deepEqual(sampleDeskAction("working", NaN), sampleDeskAction("working", 0));
});

test("real workstation controls survive static batching and hands meet the moving key surfaces", async (t) => {
  const context = { fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, stroke() {}, strokeRect() {} };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ width: 0, height: 0, getContext: () => context }) } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const { workstation } = await import("./scene/props.ts");
  const scene = new THREE.Scene();
  const desk = workstation(scene, 3, -2);
  desk.rotation.y = 0.65;
  const rig = desk.userData.workstation as WorkstationRig;
  const staticMeshes: THREE.Object3D[] = [];
  scene.traverse(object => { if ((object as THREE.Mesh).isMesh && !object.userData.keep) staticMeshes.push(object); });
  staticMeshes.forEach(object => object.removeFromParent());
  assert.equal(rig.keys.parent, rig.keyboard);
  assert.equal(rig.keys.count, 56);
  for (const part of [rig.keyboard, rig.mouse, rig.mug, rig.chairSeat, rig.chairBack, ...rig.fans]) assert.ok(part.children.length > 0);
  for (const app of ["claude", "codex", "antigravity"] as const) for (const small of [false, true]) {
    const mascot = createMascot(app, small);
    const broad = Math.abs(mascot.arms[0].position.x) > 0.4;
    const hip = Math.min(...mascot.legs.map(leg => leg.position.y));
    const { seatHeight, seatZ } = mascotDeskPosture(mascot);
    mascot.root.position.copy(desk.localToWorld(new THREE.Vector3(0, seatHeight - hip * mascot.root.scale.y, seatZ)));
    mascot.root.rotation.y = Math.PI + desk.rotation.y;
    scene.add(mascot.root);
    poseMascotSeated(mascot, 1, true);
    for (const time of [7, 19.5]) {
      resetMascotHands(mascot);
      resetWorkstation(desk, time);
      const sample = sampleDeskAction("working", time);
      mascot.body.rotation.set(sample.lean, sample.yaw, 0);
      const hipPoint = new THREE.Vector3(0, hip, 0);
      mascot.body.position.copy(hipPoint.clone().sub(hipPoint.clone().applyQuaternion(mascot.body.quaternion)));
      animateWorkstation(desk, mascot, sample, time, app);
      const key = new THREE.Matrix4();
      rig.keys.getMatrixAt(sampleDeskKeystroke(time, broad).index, key);
      const keyTop = rig.keyboard.localToWorld(new THREE.Vector3().setFromMatrixPosition(key).add(new THREE.Vector3(0, 0.006, 0)));
      const target = time === 7 ? keyTop : rig.mouse.localToWorld(new THREE.Vector3(0, 0.024, -0.015));
      const wrist = mascot.body.localToWorld(mascotHandPosition(mascot, time === 7 ? 1 : 0, mascot.body));
      assert.ok(target.distanceTo(wrist) < 0.000001, `${app} ${small} at ${time}`);
      const rightSide = new THREE.Vector3(-1, 0, 0).applyQuaternion(mascot.root.quaternion);
      const keyboardCenter = rig.keyboard.getWorldPosition(new THREE.Vector3());
      const mouseCenter = rig.mouse.getWorldPosition(new THREE.Vector3());
      assert.ok(mouseCenter.sub(keyboardCenter).dot(rightSide) > 0.3 * mascot.root.scale.x);
      const keyboardRight = rig.keyboardTray.position.x + 0.26 * rig.keyboard.scale.x;
      assert.ok(rig.mouseTray.position.x - 0.11 * rig.mouseTray.scale.x - keyboardRight >= 0.06 * mascot.root.scale.x);
      if (app !== "antigravity") {
        const core = new THREE.Box3();
        for (const part of mascot.body.children.filter(object => (object as THREE.Mesh).isMesh) as THREE.Mesh[]) {
          part.geometry.computeBoundingBox();
          const bounds = part.geometry.boundingBox!;
          for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
            core.expandByPoint(desk.worldToLocal(part.localToWorld(new THREE.Vector3(x, y, z))));
          }
        }
        assert.ok(core.min.z - rig.keyboardTray.position.z - 0.09 > 0.04 * mascot.root.scale.x, `${app} face clearance`);
      }
    }
    poseMascotSeated(mascot, 0);
    mascot.arms.forEach(arm => assert.equal(arm.position.z, 0));
    mascot.root.removeFromParent();
  }
});

test("all desk actions preserve short arm geometry, physical cup contact and vacant gear homes", () => {
  for (const app of ["claude", "codex", "antigravity"] as const) for (const small of [false, true]) {
    const scene = new THREE.Scene();
    const desk = deskFixture();
    desk.position.set(3, 0, -2);
    desk.rotation.y = 0.65;
    scene.add(desk);
    const mascot = createMascot(app, small);
    const hip = Math.min(...mascot.legs.map(leg => leg.position.y));
    const { seatHeight, seatZ } = mascotDeskPosture(mascot);
    mascot.root.position.copy(desk.localToWorld(new THREE.Vector3(0, seatHeight - hip * mascot.root.scale.y, seatZ)));
    mascot.root.rotation.y = Math.PI + desk.rotation.y;
    scene.add(mascot.root);
    poseMascotSeated(mascot, 1, true);
    const rig = desk.userData.workstation as WorkstationRig;
    const homes = [rig.keyboardTray, rig.mouseTray, rig.cupTray!, rig.mug, rig.notebook].map(object => object.position.clone());
    const shoulders = mascot.arms.map(arm => arm.position.clone());
    const touched = new Set<number>();
    const wristXs: number[] = [];
    const rightTouched = new Set<number>();
    const rightWristXs: number[] = [];
    for (let time = 0; time < 56; time += 0.1) {
      resetMascotHands(mascot);
      resetWorkstation(desk, time);
      const sample = sampleDeskAction("working", time);
      animateWorkstation(desk, mascot, sample, time, app);
      scene.updateWorldMatrix(true, true);
      assert.ok(Math.abs(rig.keyboardTray.position.y - 0.76) < 0.00001, "keyboard stays on the desktop");
      assert.ok(Math.abs(rig.mouseTray.position.y - 0.76) < 0.00001, "mouse stays on the desktop");
      mascot.arms.forEach((arm, index) => {
        assert.deepEqual(arm.position, shoulders[index]);
        assert.equal((arm.children[0] as THREE.Mesh).scale.y, 1);
        const wrist = mascotHandPosition(mascot, index, mascot.body);
        assert.ok(wrist.distanceTo(shoulders[index]) <= mascotArmReach(mascot, index));
      });
      if (sample.action === "sip" && sample.progress > 0.3 && sample.progress < 0.7) {
        const grip = rig.mug.localToWorld(new THREE.Vector3(0.055, 0.05, 0));
        const wrist = mascot.body.localToWorld(mascotHandPosition(mascot, 0, mascot.body));
        assert.ok(grip.distanceTo(wrist) < 0.000001, `${app} cup at ${time}`);
      }
      if (sample.action === "type" && sample.weight > 0.9999) {
        const stroke = sampleDeskKeystroke(time, Math.abs(mascot.arms[0].position.x) > 0.4);
        const wrist = mascot.body.localToWorld(mascotHandPosition(mascot, 1, mascot.body));
        wristXs.push(desk.worldToLocal(wrist.clone()).x);
        if (stroke.depth > 0.001) {
          const matrix = new THREE.Matrix4();
          rig.keys.getMatrixAt(stroke.index, matrix);
          const top = rig.keyboard.localToWorld(new THREE.Vector3().setFromMatrixPosition(matrix).add(new THREE.Vector3(0, 0.006, 0)));
          assert.ok(top.distanceTo(wrist) < 0.000001, `${app} keyboard at ${time}`);
          touched.add(stroke.index);
        }
        const rightStroke = sampleDeskKeystroke(time, Math.abs(mascot.arms[0].position.x) > 0.4, true);
        const rightWrist = mascot.body.localToWorld(mascotHandPosition(mascot, 0, mascot.body));
        rightWristXs.push(desk.worldToLocal(rightWrist.clone()).x);
        if (rightStroke.depth > 0.001) {
          const matrix = new THREE.Matrix4();
          rig.keys.getMatrixAt(rightStroke.index, matrix);
          const top = rig.keyboard.localToWorld(new THREE.Vector3().setFromMatrixPosition(matrix).add(new THREE.Vector3(0, 0.006, 0)));
          assert.ok(top.distanceTo(rightWrist) < 0.000001, `${app} right keyboard at ${time}`);
          rightTouched.add(rightStroke.index);
        }
      }
      if (sample.action === "mouse" && sample.weight > 0.9999) {
        const grip = rig.mouse.localToWorld(new THREE.Vector3(0, 0.024, -0.015));
        const wrist = mascot.body.localToWorld(mascotHandPosition(mascot, 0, mascot.body));
        assert.ok(wrist.distanceTo(grip) < 0.00001, `${app} mouse at ${time}`);
      }
    }
    assert.ok(touched.size >= 5, `${app} must press different keys`);
    assert.ok(Math.max(...wristXs) - Math.min(...wristXs) > 0.06 * mascot.root.scale.x, `${app} must move across the keyboard`);
    assert.ok(rightTouched.size >= (app === "claude" ? 5 : 4), `${app} right hand must press different keys`);
    assert.ok(Math.max(...rightWristXs) - Math.min(...rightWristXs) > 0.06 * mascot.root.scale.x, `${app} right hand must move across the keyboard`);
    resetWorkstation(desk, 0, true);
    [rig.keyboardTray, rig.mouseTray, rig.cupTray!, rig.mug, rig.notebook].forEach((object, index) => assert.deepEqual(object.position, homes[index]));
    assert.equal(desk.userData.deskOccupant, null);
  }
});

test("all seated mascots bend knees and keep the hip on the seat during torso motion", () => {
  for (const app of ["claude", "codex", "antigravity"] as const) for (const small of [false, true]) {
    const mascot = createMascot(app, small);
    const hip = new THREE.Vector3(0, Math.min(...mascot.legs.map(leg => leg.position.y)), 0);
    mascot.root.position.y = 0.48 - hip.y * mascot.root.scale.y;
    for (const lean of [-0.12, 0, 0.055]) {
      mascot.body.rotation.set(lean, 0.1, 0);
      mascot.body.scale.set(0.995, 1.012, 0.995);
      const displaced = hip.clone().multiply(mascot.body.scale).applyQuaternion(mascot.body.quaternion);
      mascot.body.position.copy(hip).sub(displaced);
      poseMascotSeated(mascot, 1);
      mascot.root.updateWorldMatrix(true, true);
      assert.ok(Math.abs(mascot.body.localToWorld(hip.clone()).y - 0.48) < 0.000001);
      mascot.legs.forEach((leg, index) => {
        assert.equal(leg.rotation.x, -Math.PI / 2);
        const knee = leg.getObjectByName(`mascot-knee-${index}`)!;
        assert.equal(knee.rotation.x, Math.PI / 2);
        const thigh = leg.children[0] as THREE.Mesh<THREE.BoxGeometry>;
        assert.equal(thigh.scale.y, 1);
        assert.ok(Math.abs(knee.position.y) === thigh.geometry.parameters.height);
      });
    }
  }
});

test("clipboards stay in the real holding hand with their paper facing the reader", () => {
  for (const app of ["claude", "codex", "antigravity"] as const) {
    const mascot = createMascot(app, true);
    mascot.root.rotation.y = 1.3;
    mascot.body.rotation.set(0.08, -0.15, 0);
    const props = createWorkProps(mascot);
    for (let time = 0; time < 3; time += 0.1) {
      resetMascotHands(mascot);
      animateWorkProps(props, { crate: false, board: true, can: false, pouring: false }, time, 0.1);
      animateClipboard(props, mascot, time);
      const grip = props.board.localToWorld(new THREE.Vector3(-0.085, -0.055, 0.012));
      const wrist = mascot.body.localToWorld(mascotHandPosition(mascot, 0, mascot.body));
      assert.ok(grip.distanceTo(wrist) < 0.000001);
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(props.board.getWorldQuaternion(new THREE.Quaternion()));
      const facing = mascot.body.worldToLocal(props.board.getWorldPosition(new THREE.Vector3()).add(normal)).sub(mascot.body.worldToLocal(props.board.getWorldPosition(new THREE.Vector3())));
      assert.ok(facing.y > 0 && facing.z < 0);
    }
  }
});

test("study poses keep every mascot limb and shoulder fixed while pencils follow the wrist", () => {
  for (const app of ["claude", "codex", "antigravity"] as const) for (const small of [false, true]) {
    const mascot = createMascot(app, small);
    mascot.root.position.y = 0.46 - Math.min(...mascot.legs.map(leg => leg.position.y)) * mascot.root.scale.y;
    const props = createTrainingProps(mascot);
    const shoulders = mascot.arms.map(arm => arm.position.clone());
    for (const action of ["write", "type", "read"] as const) for (let frame = 0; frame < 120; frame++) {
      resetMascotHands(mascot);
      const cue = { action, teacher: false, lookAt: null, speaking: false, time: frame / 60 };
      animateTrainingProps(props, mascot, cue, frame / 60, 1 / 60, 0, false);
      mascot.arms.forEach((arm, index) => {
        assert.deepEqual(arm.position.toArray(), shoulders[index].toArray());
        assert.equal((arm.children[0] as THREE.Mesh).scale.y, 1);
        if (action !== "read") assert.ok(mascotHandPosition(mascot, index, mascot.body).distanceTo(shoulders[index]) <= mascotArmReach(mascot, index));
      });
      if (action === "write") {
        const grip = props.pencil.localToWorld(new THREE.Vector3(0, -0.09, 0));
        const wrist = mascot.body.localToWorld(mascotHandPosition(mascot, 0, mascot.body));
        assert.ok(grip.distanceTo(wrist) < 0.000001);
      }
    }
  }
});

test("rack controls meet all mascot hands without growing limbs or moving shoulder anchors", () => {
  for (const app of ["claude", "codex", "antigravity"] as const) for (const small of [false, true]) {
    const mascot = createMascot(app, small);
    mascot.root.position.set(3, 0.1, -2);
    mascot.root.rotation.y = 0.7;
    const props = createRackProps(mascot);
    const anchors = mascot.arms.map(arm => arm.position.clone());
    for (let frame = 0; frame < 300; frame++) {
      const time = frame / 10;
      const pose = rackPose(time, 0);
      mascot.body.rotation.set(pose.lean, pose.yaw, 0);
      resetMascotHands(mascot);
      animateRackProps(props, true, time, 0.1, 0);
      const controls = rackStep(time, 0).step === "console" ? props.consoleGrips : props.pullGrips;
      controls.forEach((grip, index) => {
        if (!grip.visible) return;
        const reached = reachMascotHand(mascot, index, grip, 0, 0, 0);
        assert.ok(reached.length() < 0.000001, `${app} ${small} ${time}`);
        assert.deepEqual(mascot.arms[index].position.toArray(), anchors[index].toArray());
        assert.equal((mascot.arms[index].children[0] as THREE.Mesh).scale.y, 1);
      });
    }
  }
});

test("lounge seats stay reachable around the cafe and games at every office width", () => {
  try {
    for (const width of [30, 42, 60]) {
      configureLayout(width);
      const common = ZONE_BY_ID.get("common")!;
      const entrance = { x: common.door.x, z: 5 };
      const barX = (common.x0 + common.x1) / 2;
      for (const side of [-1, 1]) assert.equal(walkSegmentClear({ x: barX + side * 1.65, z: 18 }, { x: barX + side * 1.65, z: 18.4 }), true);
      for (const seat of DRINK_BAR_SEATS) assert.equal(walkSegmentClear({ x: barX + seat.x, z: 15.2 + seat.z }, { x: barX + seat.x + 0.01, z: 15.2 + seat.z + 0.01 }), false);
      assert.equal(walkSegmentClear({ x: common.door.x, z: 13 }, { x: common.door.x, z: 17 }), false);
      for (const seat of LOUNGE_SPOTS) {
        let previous = entrance;
        for (const destination of [seat.approach, seat].filter(point => point !== null)) {
          const route = routeBetween(previous, destination);
          assert.ok(route.length > 0, JSON.stringify({ width, destination }));
          for (const point of route) {
            assert.equal(walkSegmentClear(previous, point), true);
            previous = point;
          }
          assert.deepEqual(previous, destination);
        }
      }
      for (const target of buildLife(NOW, new Date(NOW).toISOString()).pins.values()) {
        if (!target.key.startsWith("lounge:") || !target.alt) continue;
        assert.ok(routeBetween(entrance, target.alt).length > 0);
        assert.equal(walkSegmentClear(target.alt, { x: target.alt.x + 0.01, z: target.alt.z + 0.01 }), true);
      }
      const server = ZONE_BY_ID.get("server")!;
      assert.equal(walkSegmentClear({ x: server.door.x, z: 16 }, { x: server.door.x, z: 18 }), false);
    }
  } finally {
    configureLayout(30);
  }
});

function idle(id: string): AgentInfo {
  return { id, app: "codex", machine: "WORKSTATION", title: "Resting", project: "Test", role: null, state: "idle", detail: "", parentId: null, updatedAt: new Date(NOW - 600_000).toISOString(), pending: null };
}

function setup(t: { after: (callback: () => void) => void }): AgentManager {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  class Element {
    style = {};
    dataset = {};
    classes = new Set<string>();
    classList = {
      toggle: (name: string, force?: boolean) => {
        const add = force ?? !this.classes.has(name);
        if (add) this.classes.add(name);
        else this.classes.delete(name);
        return add;
      },
      contains: (name: string) => this.classes.has(name),
    };
    ownerDocument = { defaultView: { Element } };
    parentNode = null;
    setAttribute() {}
    addEventListener() {}
    remove() {}
  }
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => new Element() } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  return new AgentManager(new THREE.Scene(), () => {}, () => {});
}

test("routes from corridors and the lobby reach rooms through clear wall openings", () => {
  const cases = [
    { from: { x: 10.5, z: -3 }, to: roleSeat("WORKSTATION", "ai").lane },
    { from: { x: 0, z: 22.6 }, to: roleSeat("SERVER", "ai").lane },
    { from: { x: -10.5, z: 5 }, to: roleSeat("LAPTOP", "ai").lane },
  ];
  for (const { from, to } of cases) {
    const route = routeBetween(from, to);
    assert.ok(route.length > 1);
    assert.deepEqual(route.at(-1), to);
    let previous = from;
    for (const point of route) {
      assert.equal(walkSegmentClear(previous, point), true, JSON.stringify({ previous, point }));
      previous = point;
    }
  }
});

test("walking constraints stop at a glass wall and permit its doorway", () => {
  const from = { x: 10.5, z: -3 };
  const throughWall = { x: 7, z: -3 };
  assert.equal(walkSegmentClear(from, throughWall), false);
  const stopped = constrainWalk(from, throughWall);
  assert.ok(stopped.x > 9);
  assert.equal(walkSegmentClear(from, stopped), true);
  assert.deepEqual(constrainWalk({ x: 0, z: 5 }, { x: 0, z: 3 }), { x: 0, z: 3 });
});

test("retargeting a walking actor inside an unzoned corridor keeps every move outside walls", (t) => {
  const manager = setup(t);
  const agent = { ...idle("reroute"), state: "working" as const };
  const seat = (machine: AgentInfo["machine"]) => {
    const point = roleSeat(machine, "ai");
    return { ...point, pose: "sit" as const, approach: point.lane };
  };
  manager.update([agent], new Map([[agent.id, seat("SERVER")]]), NOW);
  manager.update([agent], new Map([[agent.id, seat("LAPTOP")]]), NOW + 1000);
  let previous = manager.position(agent.id)!;
  let redirected = false;
  const destination = seat("WORKSTATION");
  for (let frame = 0; frame < 90 * 60; frame++) {
    manager.tick(1 / 60, frame / 60);
    const current = manager.position(agent.id)!;
    assert.equal(walkSegmentClear(previous, current), true);
    if (!redirected && !zoneOf(current.x, current.z)) {
      manager.update([agent], new Map([[agent.id, destination]]), NOW + 2000);
      redirected = true;
    }
    previous = current;
  }
  assert.equal(redirected, true);
  assert.equal(manager.arrived(agent.id, destination.key), true);
});

test("snapshot reordering and animation ticks keep resting agents in their seats", (t) => {
  const manager = setup(t);
  const agents = [idle("a"), idle("b"), idle("c")];
  manager.update(agents, new Map(), NOW);
  for (let round = 0; round < 6; round++) {
    manager.update(round % 2 ? agents : [...agents].reverse(), new Map(), NOW + round * 1000);
    for (let i = 0; i < agents.length; i++) assert.equal(manager.arrived(agents[i].id, `lounge:${i}`), true);
    manager.tick(1 / 60, round + 2);
    for (let i = 0; i < agents.length; i++) assert.equal(manager.arrived(agents[i].id, `lounge:${i}`), true);
  }
});

test("a new resting agent does not displace existing lounge occupants", (t) => {
  const manager = setup(t);
  const agents = [idle("b"), idle("c")];
  manager.update(agents, new Map(), NOW);
  manager.update([idle("a"), ...agents], new Map(), NOW + 1000);
  assert.equal(manager.arrived("b", "lounge:0"), true);
  assert.equal(manager.arrived("c", "lounge:1"), true);
  assert.equal(manager.arrived("a", "lounge:2"), true);
});

test("a full lounge keeps overflow at desks instead of overlapping occupied seats", (t) => {
  const manager = setup(t);
  const agents = Array.from({ length: LOUNGE_SPOTS.length + 3 }, (_, index) => idle(`agent-${String(index).padStart(2, "0")}`));
  manager.update(agents, new Map(), NOW);
  const positions = agents.map((agent) => manager.position(agent.id)!);
  assert.equal(new Set(positions.map((position) => `${position.x}:${position.z}`)).size, agents.length);
  for (const agent of agents.slice(LOUNGE_SPOTS.length)) {
    const position = manager.position(agent.id)!;
    assert.equal(LOUNGE_SPOTS.some((spot) => spot.x === position.x && spot.z === position.z), false);
  }
});

test("a brief missing snapshot preserves the actor, label and home seat", (t) => {
  const manager = setup(t);
  const agent = { ...idle("gap"), updatedAt: new Date(NOW).toISOString() };
  manager.update([agent], new Map(), NOW);
  const actor = manager.pickables()[0];
  const label = actor.children.find((child) => "isCSS2DObject" in child);
  const seat = manager.desk(agent.id);
  manager.update([], new Map(), NOW + 1000);
  for (let i = 0; i < 90; i++) {
    if (i % 30 === 0) manager.update([], new Map(), NOW + 1000 + i * 1000 / 60);
    manager.tick(1 / 60, 1 + i / 60);
  }
  manager.update([agent], new Map(), NOW + 2500);
  assert.equal(manager.pickables()[0], actor);
  assert.equal(actor.children.find((child) => "isCSS2DObject" in child), label);
  assert.equal(manager.desk(agent.id), seat);
  assert.equal(actor.visible, true);
});

test("sustained absence releases the home seat and walks outside before removal", (t) => {
  const manager = setup(t);
  const agent = { ...idle("expired"), updatedAt: new Date(NOW).toISOString() };
  manager.update([agent], new Map(), NOW);
  manager.update([], new Map(), NOW + 1000);
  for (let i = 0; i < 90; i++) manager.tick(0.1, i / 10);
  assert.notEqual(manager.position(agent.id), null);
  manager.update([], new Map(), NOW + 10000);
  for (let i = 0; i < 20; i++) manager.tick(0.1, 9 + i / 10);
  assert.notEqual(manager.get(agent.id), undefined);
  assert.equal(manager.desk(agent.id), null);
  for (let i = 0; i < 600; i++) manager.tick(0.1, 11 + i / 10);
  assert.equal(manager.position(agent.id), null);
  assert.equal(manager.get(agent.id), undefined);
  assert.equal(manager.desk(agent.id), null);
});

test("crew departures begin walking outside without a missing-snapshot grace", (t) => {
  const manager = setup(t);
  const agent = { ...idle("staff:WORKSTATION:ai"), updatedAt: new Date(NOW).toISOString() };
  manager.update([agent], new Map(), NOW);
  const actor = manager.pickables()[0];
  const start = manager.position(agent.id)!;
  manager.update([], new Map(), NOW + 1000);
  for (let i = 0; i < 30; i++) manager.tick(1 / 60, i / 60);
  assert.ok(manager.pickables().includes(actor));
  assert.ok(actor.position.distanceTo(start) > 0.1);
  assert.equal(manager.desk(agent.id), null);
  for (let i = 0; i < 600; i++) manager.tick(0.1, 1 + i / 10);
  assert.equal(manager.position(agent.id), null);
});

test("a departing crowd clears the shared exit despite repeated missing snapshots", async (t) => {
  const manager = setup(t);
  const agents = Array.from({ length: 20 }, (_, i) => ({ ...idle(`depart-${String(i).padStart(2, "0")}`), updatedAt: new Date(NOW).toISOString() }));
  const pins = new Map(agents.map((agent, i) => [agent.id, { key: `lobby:${i}`, x: -4 + i % 10 * 0.85, z: 21 + Math.floor(i / 10) * 0.85, facing: 0, pose: "stand" as const, approach: null }]));
  manager.update(agents, pins, NOW);
  await Promise.resolve();
  manager.update([], new Map(), NOW + 1000);
  for (let frame = 0; frame < 120 * 60; frame++) {
    if (frame % 60 === 0) manager.update([], new Map(), NOW + 1000 + frame * 1000 / 60);
    manager.tick(1 / 60, frame / 60);
  }
  assert.equal(manager.pickables().length, 0);
  for (const agent of agents) assert.equal(manager.get(agent.id), undefined);
});

test("a simultaneous entering crowd reaches its assigned desks across snapshot updates", async (t) => {
  const manager = setup(t);
  manager.update([], new Map(), NOW);
  await Promise.resolve();
  const agents = Array.from({ length: 20 }, (_, i) => ({ ...idle(`enter-${String(i).padStart(2, "0")}`), role: "ai" as const, state: "working" as const, updatedAt: new Date(NOW).toISOString() }));
  manager.update(agents, new Map(), NOW + 1000);
  const actors = manager.pickables();
  const desks = agents.map((agent) => manager.desk(agent.id)!);
  for (let frame = 0; frame < 120 * 60; frame++) {
    if (frame % 60 === 0) manager.update(frame % 120 ? agents : [...agents].reverse(), new Map(), NOW + 1000 + frame * 1000 / 60);
    manager.tick(1 / 60, frame / 60);
  }
  assert.deepEqual(manager.pickables(), actors);
  for (const [index, agent] of agents.entries()) assert.equal(manager.arrived(agent.id, desks[index].key), true, agent.id);
});

test("a replacement enters from outside while the old actor vacates its seat", async (t) => {
  const manager = setup(t);
  const previous = { ...idle("old"), role: "ai" as const, updatedAt: new Date(NOW).toISOString() };
  manager.update([previous], new Map(), NOW);
  const outgoing = manager.pickables()[0];
  const seat = manager.desk(previous.id)!;
  await Promise.resolve();
  manager.update([], new Map(), NOW + 1000);
  for (let i = 0; i < 102; i++) manager.tick(0.1, i / 10);
  const replacement = { ...previous, id: "new" };
  manager.update([replacement], new Map(), NOW + 11200);
  assert.equal(manager.desk(replacement.id)!.key, seat.key);
  assert.ok(manager.position(replacement.id)!.z >= 22.6);
  assert.ok(manager.position(replacement.id)!.distanceTo(outgoing.position) > 1);
  for (let i = 0; i < 600; i++) manager.tick(0.1, 10.2 + i / 10);
  assert.equal(manager.arrived(replacement.id, seat.key), true);
  assert.equal(manager.position(previous.id), null);
});

test("a returning session keeps its actor and turns back from the exit route", async (t) => {
  const manager = setup(t);
  const agent = { ...idle("returning"), updatedAt: new Date(NOW).toISOString() };
  manager.update([agent], new Map(), NOW);
  const actor = manager.pickables()[0];
  await Promise.resolve();
  manager.update([], new Map(), NOW + 1000);
  for (let i = 0; i < 110; i++) manager.tick(0.1, i / 10);
  manager.update([agent], new Map(), NOW + 12000);
  assert.equal(manager.pickables()[0], actor);
  const seat = manager.desk(agent.id)!;
  for (let i = 0; i < 600; i++) manager.tick(0.1, 11 + i / 10);
  assert.equal(manager.arrived(agent.id, seat.key), true);
});

test("state changes retain arrival animation without repeatedly bouncing the whole actor", async (t) => {
  const manager = setup(t);
  const agent = { ...idle("states"), updatedAt: new Date(NOW).toISOString() };
  manager.update([agent], new Map(), NOW);
  await Promise.resolve();
  const actor = manager.pickables()[0];
  for (let i = 0; i < 180; i++) manager.tick(1 / 60, i / 60);
  const settledScale = actor.scale.clone();
  for (let i = 0; i < 20; i++) {
    manager.update([{ ...agent, state: i % 2 ? "idle" : "working" }], new Map(), NOW + 3000 + i * 100);
    manager.tick(1 / 60, 3 + i / 60);
    assert.ok(actor.scale.distanceTo(settledScale) < 0.00001);
  }
});

function labelScene(t: Parameters<typeof setup>[0], anchors: { left: number; top: number }[]) {
  const manager = setup(t);
  const agents = anchors.map((_, index) => ({ ...idle(`label-${String(index).padStart(2, "0")}`), state: "working" as const, updatedAt: new Date(NOW).toISOString() }));
  manager.update(agents, new Map(), NOW);
  const tags = manager.pickables().map((actor) => actor.children.find((child): child is CSS2DObject => child instanceof CSS2DObject)!);
  const labels = tags.map((tag, index) => {
    const label = tag.element;
    label.getBoundingClientRect = () => {
      const left = anchors[index].left + Math.round((Number.parseFloat(label.style.marginLeft) || 0) * 64) / 64;
      const top = anchors[index].top + Math.round((Number.parseFloat(label.style.marginTop) || 0) * 64) / 64;
      return { left, top, right: left + 192, bottom: top + 63.359375, x: left, y: top, width: 192, height: 63.359375, toJSON: () => ({}) };
    };
    return label;
  });
  return { manager, labels, tags, agents };
}

test("crowded stationary labels settle without oscillation or overlap", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const anchors = Array.from({ length: 12 }, (_, i) => ({ left: 500 + (i % 4) * 72, top: 250 + Math.floor(i / 4) * 72 }));
  const { manager, labels, agents } = labelScene(t, anchors);
  let previous: string[] = [];
  for (let frame = 0; frame < 600; frame++) {
    now = frame * 1000 / 60;
    if (frame === 300) manager.update([...agents].reverse(), new Map(), NOW);
    manager.layoutLabels(1440, 900, 1 / 60);
    const positions = labels.map((label) => `${label.classList.contains("offview")}:${label.style.marginLeft}:${label.style.marginTop}`);
    if (frame > 180) {
      assert.deepEqual(positions, previous);
      const visible = labels.filter((label) => !label.classList.contains("offview")).map((label) => label.getBoundingClientRect());
      assert.ok(visible.length >= 8);
      for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
        const a = visible[i];
        const b = visible[j];
        assert.ok(Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom) >= 7.94);
      }
    }
    previous = positions;
  }
});

test("a valid displaced label stays put when its original position briefly clears", (t) => {
  const anchors = [{ left: 500, top: 300 }, { left: 500, top: 300 }];
  const { manager, labels } = labelScene(t, anchors);
  manager.layoutLabels(1440, 900, 1);
  const position = [labels[1].style.marginLeft, labels[1].style.marginTop];
  for (let frame = 0; frame < 120; frame++) {
    anchors[0].left = frame % 2 ? 500 : 100;
    anchors[1].left = 500 + (frame % 3 - 1) / 128;
    manager.layoutLabels(1440, 900, 1 / 60);
    assert.deepEqual([labels[1].style.marginLeft, labels[1].style.marginTop], position);
  }
});

test("labels do not ease through an occupied rectangle on the way to a free slot", (t) => {
  const anchors = [{ left: 500, top: 300 }, { left: 500, top: 300 }];
  const { manager, labels } = labelScene(t, anchors);
  for (let frame = 0; frame < 120; frame++) {
    if (frame === 60) anchors[0].top -= 40;
    manager.layoutLabels(1440, 900, 1 / 60);
    const [a, b] = labels.map((label) => label.getBoundingClientRect());
    assert.ok(Math.max(a.left - b.right, b.left - a.right, a.top - b.bottom, b.top - a.bottom) >= 7.94);
  }
});

test("hidden labels reserve distinct destinations before reappearing", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const anchors = Array.from({ length: 3 }, () => ({ left: -500, top: 300 }));
  const { manager, labels, tags } = labelScene(t, anchors);
  manager.layoutLabels(1440, 900, 1 / 60);
  now = 1000;
  manager.layoutLabels(1440, 900, 1 / 60);
  assert.ok(labels.every((label) => label.classList.contains("offview")));
  for (const anchor of anchors) anchor.left = 500;
  now = 1100;
  manager.layoutLabels(1440, 900, 1 / 60);
  const positions = labels.map((label) => `${label.style.marginLeft}:${label.style.marginTop}`);
  assert.equal(new Set(positions).size, 3);
  for (let frame = 0; frame < 180; frame++) {
    now += 1000 / 60;
    manager.layoutLabels(1440, 900, 1 / 60);
    assert.deepEqual(labels.map((label) => `${label.style.marginLeft}:${label.style.marginTop}`), positions);
  }
  assert.ok(labels.every((label) => !label.classList.contains("offview")));
  assert.equal(new Set(tags.map((tag) => tag.renderOrder)).size, 3);
});
