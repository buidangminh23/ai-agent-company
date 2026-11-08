import assert from "node:assert/strict";
import test from "node:test";
import { EightBallRules, type PoolShot } from "./eight-ball.ts";

const RACK = Array.from({ length: 15 }, (_, index) => index + 1);

function shot(changes: Partial<PoolShot> = {}): PoolShot {
  return { breakShot: false, firstContact: 1, pocketed: [], railAfterContact: true, objectRails: [], remainingBefore: [...RACK], calledBall: 1, calledPocket: 0, ...changes };
}

function assigned(): EightBallRules {
  const rules = new EightBallRules();
  rules.resolveShot(shot({ pocketed: [{ number: 1, pocket: 0 }] }));
  return rules;
}

test("a legal break leaves the table open and retains the breaker only after a pot", () => {
  const rules = new EightBallRules();
  rules.resolveShot(shot({ breakShot: true, pocketed: [{ number: 1, pocket: 0 }] }));
  assert.deepEqual(rules.groups, [null, null]);
  assert.equal(rules.currentPlayer, 0);
  assert.equal(rules.ballInHand, false);
  rules.reset();
  rules.resolveShot(shot({ breakShot: true, objectRails: [1, 2, 3, 4] }));
  assert.equal(rules.currentPlayer, 1);
  assert.equal(rules.lastFoul, null);
});

test("an illegal break counts distinct object balls and elects an incoming-player rerack", () => {
  const rules = new EightBallRules();
  const result = rules.resolveShot(shot({ breakShot: true, objectRails: [0, 1, 1, 2, 3] }));
  assert.deepEqual(result, { rerack: true, respotEight: false });
  assert.equal(rules.currentPlayer, 1);
  assert.equal(rules.lastFoul, "illegal-break");
  assert.equal(rules.behindHeadString, true);
});

test("the eight on a legal break is respotted and a break scratch gives hand behind the line", () => {
  for (const scratch of [false, true]) {
    const rules = new EightBallRules();
    const result = rules.resolveShot(shot({ breakShot: true, pocketed: [{ number: 8, pocket: 0 }, ...(scratch ? [{ number: 0, pocket: 1 }] : [])] }));
    assert.deepEqual(result, { rerack: false, respotEight: true });
    assert.equal(rules.winner, null);
    assert.equal(rules.currentPlayer, scratch ? 1 : 0);
    assert.equal(rules.ballInHand, scratch);
    assert.equal(rules.behindHeadString, scratch);
    assert.deepEqual(rules.groups, [null, null]);
  }
});

test("only a legal called pot chooses groups and keeps the shooter's turn", () => {
  const rules = new EightBallRules();
  rules.resolveShot(shot({ firstContact: 9, pocketed: [{ number: 9, pocket: 2 }, { number: 1, pocket: 0 }] }));
  assert.deepEqual(rules.groups, ["solid", "stripe"]);
  assert.equal(rules.currentPlayer, 0);
  assert.deepEqual(rules.legalTargets([2, 3, 8, 9, 10]), [2, 3]);
  rules.resolveShot(shot({ firstContact: 2, calledBall: 2, pocketed: [{ number: 2, pocket: 0 }], remainingBefore: [2, 3, 8, 9, 10] }));
  assert.equal(rules.currentPlayer, 0);
  rules.resolveShot(shot({ firstContact: 3, remainingBefore: [3, 8, 9, 10] }));
  assert.equal(rules.currentPlayer, 1);
  assert.deepEqual(rules.legalTargets([3, 8, 9, 10]), [9, 10]);
});

test("an uncalled pocket switches turns without assigning a group or awarding ball in hand", () => {
  const rules = new EightBallRules();
  rules.resolveShot(shot({ pocketed: [{ number: 1, pocket: 1 }] }));
  assert.deepEqual(rules.groups, [null, null]);
  assert.equal(rules.currentPlayer, 1);
  assert.equal(rules.ballInHand, false);
});

test("scratch, wrong first contact, no contact and no rail produce incoming ball in hand", () => {
  for (const [changes, foul] of [
    [{ pocketed: [{ number: 0, pocket: 0 }, { number: 1, pocket: 0 }] }, "scratch"],
    [{ firstContact: 9 }, "wrong-first-ball"],
    [{ firstContact: null }, "no-contact"],
    [{ railAfterContact: false }, "no-rail"],
  ] as const) {
    const rules = assigned();
    rules.resolveShot(shot(changes as Partial<PoolShot>));
    assert.equal(rules.currentPlayer, 1);
    assert.equal(rules.lastFoul, foul);
    assert.equal(rules.ballInHand, true);
    assert.equal(rules.behindHeadString, false);
    assert.deepEqual(rules.groups, ["solid", "stripe"]);
  }
});

test("a scratch does not choose groups even when the called ball drops", () => {
  const rules = new EightBallRules();
  rules.resolveShot(shot({ pocketed: [{ number: 1, pocket: 0 }, { number: 0, pocket: 2 }] }));
  assert.deepEqual(rules.groups, [null, null]);
  assert.equal(rules.ballInHand, true);
});

test("a legal safety switches turns and clears the preceding hand-in-ball flags", () => {
  const rules = assigned();
  rules.resolveShot(shot({ firstContact: null }));
  rules.resolveShot(shot({ firstContact: 9, calledBall: null, calledPocket: null }));
  assert.equal(rules.currentPlayer, 0);
  assert.equal(rules.ballInHand, false);
  assert.equal(rules.lastFoul, null);
});

test("eight is legal only once the shooter's group was cleared before this shot", () => {
  const rules = assigned();
  assert.deepEqual(rules.legalTargets([8, 9, 10]), [8]);
  assert.deepEqual(rules.legalTargets([7, 8, 9]), [7]);
  rules.resolveShot(shot({ firstContact: 7, calledBall: 8, pocketed: [{ number: 7, pocket: 0 }, { number: 8, pocket: 0 }], remainingBefore: [7, 8, 9] }));
  assert.equal(rules.winner, 1);
  assert.equal(rules.lastFoul, "early-eight");
});

test("a correctly called eight wins; an early eight, wrong pocket or eight scratch loses", () => {
  for (const variant of ["win", "early", "wrong-pocket", "scratch", "uncalled"] as const) {
    const rules = assigned();
    rules.resolveShot(shot({ firstContact: 8, calledBall: variant === "uncalled" ? null : 8, calledPocket: 0, remainingBefore: variant === "early" ? [7, 8, 9] : [8, 9], pocketed: [{ number: 8, pocket: variant === "wrong-pocket" ? 2 : 0 }, ...(variant === "scratch" ? [{ number: 0, pocket: 1 }] : [])] }));
    assert.equal(rules.winner, variant === "win" ? 0 : 1, variant);
    assert.deepEqual(rules.legalTargets([9]), []);
    rules.resolveShot(shot());
    assert.equal(rules.winner, variant === "win" ? 0 : 1);
  }
});

test("scratching while attempting the eight without potting it is only a foul", () => {
  const rules = assigned();
  rules.resolveShot(shot({ firstContact: 8, calledBall: 8, remainingBefore: [8, 9], pocketed: [{ number: 0, pocket: 1 }] }));
  assert.equal(rules.winner, null);
  assert.equal(rules.currentPlayer, 1);
  assert.equal(rules.ballInHand, true);
});

test("an open table may claim a completely cleared group and call the eight", () => {
  const rules = new EightBallRules();
  assert.ok(!rules.legalTargets(RACK).includes(8));
  assert.ok(rules.legalTargets([8, 9, 10]).includes(8));
  rules.resolveShot(shot({ firstContact: 8, calledBall: 8, remainingBefore: [8, 9, 10], pocketed: [{ number: 8, pocket: 0 }] }));
  assert.equal(rules.winner, 0);
});

test("reset starts a fresh unassigned game with the requested breaker", () => {
  const rules = assigned();
  rules.resolveShot(shot({ firstContact: 8, calledBall: 8, remainingBefore: [8, 9], pocketed: [{ number: 8, pocket: 0 }] }));
  rules.reset(1);
  assert.equal(rules.currentPlayer, 1);
  assert.equal(rules.winner, null);
  assert.deepEqual(rules.groups, [null, null]);
  assert.equal(rules.lastFoul, null);
  assert.equal(rules.ballInHand, false);
});
