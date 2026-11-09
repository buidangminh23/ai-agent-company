import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BADGES, presentBadges, readyBadges, renderBlock, updateReadme } from "./add-ready-badges.mjs";

const readme = (ids) => `<h1 align="center">AI Agent Company</h1>\n\n${renderBlock(new Set(ids))}\n![screenshot](docs/screenshot.png)\n`;

test("updateReadme adds ready badges in the canonical order", () => {
  const after = updateReadme(readme(["npm", "views", "license"]), new Set(["downloads", "downloads-month"]));
  assert.deepEqual([...presentBadges(after)], ["npm", "downloads", "downloads-month", "views", "license"]);
  const order = BADGES.map((badge) => after.indexOf(badge.html)).filter((index) => index >= 0);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("updateReadme never removes a badge that is already shown", () => {
  const before = readme(["npm", "views", "license"]);
  assert.equal(updateReadme(before, new Set(["license"])), before);
});

test("updateReadme refuses a README without the badge block", () => {
  assert.throws(() => updateReadme("# Title\n", new Set(["license"])), /no centered badge block/);
});

test("readyBadges only reports badges whose source has data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ready-"));
  await writeFile(path.join(directory, "stats-github-views.svg"), "<svg/>");
  const fetcher = async (url) => url.includes("librariesio")
    ? { ok: true, text: async () => '{"label":"dependent repos","message":"package not found"}' }
    : { ok: true };
  assert.deepEqual([...await readyBadges(directory, fetcher)], ["npm", "views", "license"]);
});

test("readyBadges adds Used by once Libraries.io knows the package", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ready-"));
  const fetcher = async (url) => url.includes("librariesio")
    ? { ok: true, text: async () => '{"label":"dependent repos","message":"0"}' }
    : { ok: false };
  assert.deepEqual([...await readyBadges(directory, fetcher)], ["used-by", "license"]);
});
