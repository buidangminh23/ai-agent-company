import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatCount, npmBadges, npmWindows, refreshBadges, renderBadge, viewsBadge } from "./refresh-badges.mjs";

test("formatCount keeps small numbers exact and shortens large ones", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(9876), "9,876");
  assert.equal(formatCount(12345), "12.3k");
  assert.equal(formatCount(2500000), "2.5M");
});

test("npmWindows splits long histories into 540-day ranges", () => {
  assert.deepEqual(npmWindows("2026-11-09T10:00:00Z", Date.parse("2026-11-09T23:00:00Z")), ["2026-11-09:2026-11-09"]);
  assert.deepEqual(npmWindows("2025-01-01T00:00:00Z", Date.parse("2026-11-09T00:00:00Z")), ["2025-01-01:2026-06-24", "2026-06-25:2026-11-09"]);
});

test("npmBadges sums every day since the package was created", async () => {
  const fetcher = async (url) => ({
    ok: true,
    json: async () => url.startsWith("https://registry.npmjs.org/")
      ? { time: { created: "2026-11-01T00:00:00Z" } }
      : url.includes("last-month")
        ? { start: "2026-10-10", end: "2026-11-08", downloads: [{ day: "2026-11-07", downloads: 3 }, { day: "2026-11-08", downloads: 4 }] }
        : { downloads: [{ day: "2026-11-01", downloads: 5 }, { day: "2026-11-02", downloads: 6 }] },
  });
  const files = await npmBadges({ fetcher, now: Date.parse("2026-11-09T00:00:00Z") });
  assert.match(files["stats-npm-downloads.svg"], /npm downloads: 11/);
  assert.match(files["stats-npm-downloads-month.svg"], /npm downloads \/ 2d: 7/);
});

test("npmBadges fails instead of drawing a badge for an unpublished package", async () => {
  const fetcher = async () => ({ ok: false, status: 404 });
  await assert.rejects(npmBadges({ fetcher }), /HTTP 404/);
});

test("viewsBadge reports the GitHub traffic window", async () => {
  const gh = async () => ({ count: 42, uniques: 7, views: [{ timestamp: "2026-10-27T00:00:00Z" }, { timestamp: "2026-11-09T00:00:00Z" }] });
  const files = await viewsBadge({ gh });
  assert.match(files["stats-github-views.svg"], /GitHub views \/ 14d: 42/);
});

test("a failing source writes nothing and keeps the other badges", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "badges-"));
  const result = await refreshBadges(directory, {
    npm: async () => { throw new Error("404"); },
    views: async () => ({ "stats-github-views.svg": renderBadge("GitHub views / 14d", "1", "#0369a1", "test") }),
  });
  assert.deepEqual(result.written, ["stats-github-views.svg"]);
  assert.deepEqual(result.errors.map((error) => error.name), ["npm"]);
  assert.deepEqual(await readdir(directory), ["stats-github-views.svg"]);
});
