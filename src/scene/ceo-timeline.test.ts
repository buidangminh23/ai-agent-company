import assert from "node:assert/strict";
import test from "node:test";
import { CEO_CYCLE_SECONDS, CEO_TIMELINE, CEO_WALK_SPEED, meetingSteps, sampleCeoTimeline, sampleCeoRoute, sampleMassageRoute, sampleMeeting, sampleWalk, walkPath } from "./ceo-timeline.ts";

test("CEO cycle reaches every activity and restarts without a timing gap", () => {
  const required = ["typing", "reviewing", "reading", "coffee", "phone", "briefing", "stretching", "walking", "inspecting", "massaging", "sitting"];
  for (const state of required) assert.ok(CEO_TIMELINE.some((entry) => entry.state === state));
  let elapsed = 0;
  CEO_TIMELINE.forEach((entry, index) => {
    assert.ok(entry.duration > 0);
    assert.equal(sampleCeoTimeline(elapsed).state, entry.state);
    assert.equal(sampleCeoTimeline(elapsed + entry.duration - 1e-6).state, entry.state);
    assert.equal(sampleCeoTimeline(elapsed + entry.duration).state, CEO_TIMELINE[(index + 1) % CEO_TIMELINE.length].state);
    elapsed += entry.duration;
  });
  assert.equal(elapsed, CEO_CYCLE_SECONDS);
  assert.deepEqual(sampleCeoTimeline(elapsed * 500 + 1.25), sampleCeoTimeline(1.25));
});

test("invalid animation time cannot create an invalid pose", () => {
  for (const value of [NaN, Infinity, -Infinity, -100]) {
    assert.deepEqual(sampleCeoTimeline(value), sampleCeoTimeline(0));
  }
  for (let time = 0; time < CEO_CYCLE_SECONDS * 2; time += 0.137) {
    const sample = sampleCeoTimeline(time);
    assert.ok(sample.time >= 0 && sample.time < sample.duration);
    assert.ok(sample.progress >= 0 && sample.progress < 1);
  }
});

test("inspection and massage walks avoid the desk and have continuous reversible paths", () => {
  for (const route of [sampleCeoRoute, sampleMassageRoute]) {
    for (const returning of [false, true]) {
      let previous = route(0, returning);
      for (let step = 0; step <= 2000; step++) {
        const progress = step / 2000;
        const pose = route(progress, returning);
        assert.ok(Object.values(pose).every(Number.isFinite));
        assert.ok(pose.speed >= 0 && pose.speed <= 1);
        assert.ok(Math.hypot(pose.x - previous.x, pose.z - previous.z) < 0.025);
        const overlapsDesk = Math.abs(pose.x) < 3.18 && pose.z > -0.235 && pose.z < 1.725;
        assert.equal(overlapsDesk, false, `Desk collision at ${pose.x}, ${pose.z}`);
        assert.ok(Math.abs(pose.x) < 11.8 && pose.z > -4.6 && pose.z < 5.4);
        const reverse = route(1 - progress, !returning);
        assert.ok(Math.hypot(pose.x - reverse.x, pose.z - reverse.z) < 1e-8);
        previous = pose;
      }
    }
    assert.equal(route(0).speed, 0);
    assert.ok(route(1).speed < 1e-12);
    assert.deepEqual(route(-1), route(0));
    assert.deepEqual(route(2), route(1));
  }
});

test("massage approach stays in front of the seat until the sit-down transition", () => {
  const target = sampleMassageRoute(1);
  assert.ok(target.z > 0.8);
  assert.ok(Math.abs(target.x + 4.35) < 1e-8);
  assert.deepEqual(sampleMassageRoute(0), sampleCeoRoute(0));
  const returnEnd = sampleMassageRoute(1, true);
  assert.ok(Math.hypot(returnEnd.x, returnEnd.z + 0.45) < 1e-8);
});

test("meeting schedule skips empty steps and ends after the walk back", () => {
  const seated = meetingSteps(true, 20, 18);
  assert.equal(seated[0].state, "meetRise");
  assert.equal(seated.at(-1)!.state, "meetReturn");
  const walking = meetingSteps(false, 12, 18);
  assert.equal(walking[0].state, "meetWalk");
  const total = walking.reduce((sum, step) => sum + step.duration, 0);
  assert.equal(sampleMeeting(walking, total), null);
  assert.equal(sampleMeeting(walking, total - 1e-6)!.state, "meetReturn");
  assert.equal(sampleMeeting(walking, NaN)!.state, "meetWalk");
  for (const step of ["meetSit", "meetOpen", "meetOrder", "meetListen", "meetApprove", "meetStand"]) assert.ok(walking.some((s) => s.state === step));
});

test("meeting walk moves continuously, eases in and out and ends facing the seat", () => {
  const path = walkPath([{ x: 0, z: -0.45 }, { x: 3.4, z: -0.45 }, { x: 3.4, z: 2.52 }, { x: 0, z: 5.02 }, { x: 0, z: 6.9 }, { x: 26, z: 6.9 }, { x: 26.4, z: 0.3 }], 0, -Math.PI / 2);
  assert.ok(Math.abs(path.duration - (path.total / CEO_WALK_SPEED + 0.8)) < 1e-9);
  let previous = sampleWalk(path, 0);
  assert.equal(previous.speed, 0);
  assert.equal(previous.yaw, 0);
  for (let step = 1; step <= 4000; step++) {
    const pose = sampleWalk(path, (path.duration * step) / 4000);
    assert.ok(Object.values(pose).every(Number.isFinite));
    assert.ok(pose.speed >= 0 && pose.speed <= 1);
    assert.ok(Math.hypot(pose.x - previous.x, pose.z - previous.z) < 0.03);
    assert.ok(Math.abs(Math.atan2(Math.sin(pose.yaw - previous.yaw), Math.cos(pose.yaw - previous.yaw))) < 0.25);
    previous = pose;
  }
  const end = sampleWalk(path, path.duration);
  assert.ok(Math.hypot(end.x - 26.4, end.z - 0.3) < 1e-9);
  assert.ok(Math.abs(Math.atan2(Math.sin(end.yaw + Math.PI / 2), Math.cos(end.yaw + Math.PI / 2))) < 1e-9);
  assert.ok(end.speed < 1e-9);
  const still = walkPath([{ x: 1, z: 1 }], 0.3, 0.3);
  assert.deepEqual(sampleWalk(still, 5), { x: 1, z: 1, yaw: 0.3, speed: 0 });
});
