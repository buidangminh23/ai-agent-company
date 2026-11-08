import assert from "node:assert/strict";
import { test } from "node:test";
import { isSkillPath, trainingFocus, TrainingDirector, TRAINING_STAGES, TRAINING_CYCLE_SECONDS, sampleTraining, type TrainingMember } from "./training.ts";
import { trainingPose } from "../src/scene/work.ts";
import { createMascot, mascotArmReach, mascotHandPosition, reachMascotHand, resetMascotHands } from "../src/scene/mascots.ts";
import * as THREE from "three";

test("all mascot hands reach nearby transformed props, clamp distant props and restore their original limbs", () => {
  for (const app of ["claude", "codex", "antigravity"] as const) {
    for (const small of [false, true]) {
      const mascot = createMascot(app, small);
      mascot.root.position.set(5, 0.25, -3);
      mascot.root.rotation.y = 2.8;
      mascot.body.rotation.set(0.17, -0.3, 0.04);
      const prop = new THREE.Group();
      prop.position.set(4.8, 0.81, -3.6);
      prop.rotation.y = 0.7;
      const before = mascot.arms.map((arm) => arm.children[0].position.y);
      for (let i = 0; i < 2; i++) {
        const shoulder = mascot.arms[i].position.clone();
        const local = shoulder.clone().add(new THREE.Vector3(0, -0.08, 0.08));
        const target = prop.worldToLocal(mascot.body.localToWorld(local));
        reachMascotHand(mascot, i, prop, target.x, target.y, target.z);
        const tip = mascotHandPosition(mascot, i, prop);
        assert.ok(tip.distanceTo(target) < 1e-8, `${app} ${small} hand ${i}`);
        const distant = reachMascotHand(mascot, i, prop, 10, 10, 10);
        const actual = mascot.body.worldToLocal(prop.localToWorld(distant));
        assert.ok(actual.distanceTo(shoulder) <= mascotArmReach(mascot, i));
        const mesh = mascot.arms[i].children[0] as THREE.Mesh;
        assert.equal(mesh.scale.y, 1);
      }
      resetMascotHands(mascot);
      mascot.arms.forEach((arm, i) => {
        assert.equal(arm.children[0].position.y, before[i]);
        assert.equal(arm.children[0].scale.y, 1);
      });
    }
  }
});

test("training stages cover the full lesson and wrap without a timing gap", () => {
  let start = 0;
  for (const entry of TRAINING_STAGES) {
    assert.equal(sampleTraining(start).stage, entry.stage);
    assert.equal(sampleTraining(start + entry.duration - 0.001).stage, entry.stage);
    start += entry.duration;
  }
  assert.equal(start, TRAINING_CYCLE_SECONDS);
  assert.equal(sampleTraining(start).stage, "lecture");
  for (const time of [NaN, Infinity, -1]) assert.equal(sampleTraining(time).time, 0);
});

const classMembers: TrainingMember[] = [
  { id: "teacher", seat: "host", x: 0, z: 8.3 },
  { id: "first", seat: 0, x: -2, z: 10.7 },
  { id: "second", seat: 3, x: 2, z: 10.7 },
];

test("one learner asks while the teacher listens, then the teacher answers that learner", () => {
  const director = new TrainingDirector();
  assert.equal(director.cues(classMembers, 48).get("first")?.action, "raise");
  const question = director.cues(classMembers, 50);
  assert.equal(question.get("first")?.action, "ask");
  assert.equal(question.get("teacher")?.speaking, false);
  assert.equal([...question.values()].filter((cue) => cue.speaking).length, 1);
  const answer = director.cues(classMembers, 55);
  assert.equal(answer.get("teacher")?.action, "answer");
  assert.equal(answer.get("teacher")?.lookAt?.x, -2);
  assert.equal(answer.get("first")?.speaking, false);
  assert.equal(director.cues(classMembers, TRAINING_CYCLE_SECONDS + 48).get("second")?.action, "raise");
});

test("departing learners and empty classes do not leave a phantom speaker", () => {
  const director = new TrainingDirector();
  director.cues(classMembers, 48);
  const remaining = director.cues(classMembers.filter((member) => member.id !== "first"), 50);
  assert.equal([...remaining.values()].some((cue) => cue.action === "ask"), false);
  assert.equal(director.cues([], 55).size, 0);
});

test("classroom poses remain finite and reduced motion stays still through the entire cycle", () => {
  const director = new TrainingDirector();
  for (let t = 0; t < TRAINING_CYCLE_SECONDS * 2; t += 0.17) {
    for (const [id, cue] of director.cues(classMembers, t)) {
      const member = classMembers.find((item) => item.id === id)!;
      const pose = trainingPose(cue, cue.teacher ? 0 : Math.PI, member, t, 1.2);
      assert.ok([...pose.arms, ...pose.spread, pose.reach, pose.lean, pose.yaw].every(Number.isFinite));
    }
    const quiet = director.cues(classMembers, t, true);
    assert.deepEqual(quiet, director.cues(classMembers, 0, true));
    for (const cue of quiet.values()) assert.equal(cue.speaking, false);
  }
});

test("skill repositories and installed skill folders count as training", () => {
  assert.equal(isSkillPath("C:\\Work\\My Skills\\design-skill\\docs\\LEARNINGS.md"), true);
  assert.equal(isSkillPath("/Volumes/Work/design-skill"), true);
  assert.equal(isSkillPath("C:\\Users\\Work\\.claude\\skills\\icon-kit\\SKILL.md"), true);
  assert.equal(isSkillPath("/Users/dev/.agents/skills/emil-design-eng"), true);
  assert.equal(isSkillPath("C:\\Work\\Claude\\skills\\seo\\SKILL.md"), true);
  assert.equal(isSkillPath("/Volumes/Work/brand-skills/skills/apple"), true);
});

test("ordinary project paths do not count as training", () => {
  assert.equal(isSkillPath("C:\\Work\\AI Agent Company\\src\\hud.css"), false);
  assert.equal(isSkillPath("/Volumes/Work/quota-app/src/skill-list.ts"), false);
  assert.equal(isSkillPath("C:\\Work\\Backend\\apps\\web"), false);
});

test("the latest written file decides before the working folder", () => {
  const app = { path: "C:\\Work\\AI Agent Company\\src\\hud.css", at: "2026-10-31T10:00:00Z" };
  const learning = { path: "C:\\Work\\My Skills\\design-skill\\docs\\LEARNINGS.md", at: "2026-10-31T10:05:00Z" };
  assert.equal(trainingFocus({ cwd: "C:\\Work\\AI Agent Company", files: [app, learning] }), learning.path);
  assert.equal(trainingFocus({ cwd: "C:\\Work\\AI Agent Company", files: [{ ...learning, at: "2026-10-31T09:00:00Z" }, app] }), null);
  assert.equal(trainingFocus({ cwd: "/Volumes/Work/design-skill", files: [] }), "/Volumes/Work/design-skill");
  assert.equal(trainingFocus({ cwd: undefined, files: undefined }), null);
});
