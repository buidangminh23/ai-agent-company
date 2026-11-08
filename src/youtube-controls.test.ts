import assert from "node:assert/strict";
import test from "node:test";
import { clockText, qualityLabel, rateLabel, seekFraction, stepVolume } from "./youtube-controls.ts";

test("qualityLabel names YouTube quality levels and falls back to auto", () => {
  assert.equal(qualityLabel("hd2160"), "2160p 4K");
  assert.equal(qualityLabel("large"), "480p");
  assert.equal(qualityLabel(""), "Tự động");
  assert.equal(qualityLabel(undefined), "Tự động");
  assert.equal(qualityLabel("unknown"), "Tự động");
});

test("rateLabel reads normal speed in words and others with a Vietnamese decimal comma", () => {
  assert.equal(rateLabel(1), "Bình thường");
  assert.equal(rateLabel(1.25), "1,25×");
  assert.equal(rateLabel(2), "2×");
});

test("seekFraction clamps to the track and survives a zero-width track", () => {
  assert.equal(seekFraction(50, 200), 0.25);
  assert.equal(seekFraction(-10, 200), 0);
  assert.equal(seekFraction(400, 200), 1);
  assert.equal(seekFraction(10, 0), 0);
  assert.equal(seekFraction(Number.NaN, 200), 0);
});

test("clockText shows elapsed and total, or elapsed alone when the length is unknown", () => {
  assert.equal(clockText(65, 3_725), "1:05 / 1:02:05");
  assert.equal(clockText(-3, 0), "0:00");
  assert.equal(clockText(Number.NaN, 30), "0:00 / 0:30");
});

test("stepVolume stays within 0 to 100", () => {
  assert.equal(stepVolume(98, 5), 100);
  assert.equal(stepVolume(3, -5), 0);
  assert.equal(stepVolume(50, 5), 55);
});
