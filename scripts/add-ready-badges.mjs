import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "buidangminh23/ai-agent-company";
const PACKAGE = "@minhspark/ai-agent-company";
const RAW = `https://raw.githubusercontent.com/${REPO}/analytics`;

export const BADGES = [
  { id: "npm", ready: "registry", html: `<a href="https://www.npmjs.com/package/${PACKAGE}"><img src="https://img.shields.io/npm/v/${PACKAGE}?logo=npm&amp;color=CB3837" height="20" alt="npm" /></a>` },
  { id: "downloads", ready: "stats-npm-downloads.svg", html: `<a href="https://www.npmjs.com/package/${PACKAGE}"><img src="${RAW}/stats-npm-downloads.svg" height="20" alt="npm downloads" /></a>` },
  { id: "downloads-month", ready: "stats-npm-downloads-month.svg", html: `<a href="https://npmcharts.com/compare/${encodeURIComponent(PACKAGE)}?minimal=true"><img src="${RAW}/stats-npm-downloads-month.svg" height="20" alt="npm downloads / 30 days" /></a>` },
  { id: "used-by", ready: "librariesio", html: `<a href="https://github.com/${REPO}/network/dependents"><img src="https://img.shields.io/librariesio/dependent-repos/npm/${PACKAGE}?label=Used%20by&amp;logo=github&amp;color=0969da" height="20" alt="Used by repositories (Libraries.io)" /></a>` },
  { id: "views", ready: "stats-github-views.svg", html: `<a href="https://github.com/${REPO}/tree/analytics"><img src="${RAW}/stats-github-views.svg" height="20" alt="GitHub views / 14 days" /></a>` },
  { id: "license", ready: "always", html: `<a href="LICENSE"><img src="https://img.shields.io/github/license/${REPO}" height="20" alt="license" /></a>` },
];

const BLOCK = /<p align="center">\n(?:  <a [^\n]*\n)*<\/p>\n/;

export function renderBlock(ready) {
  return `<p align="center">\n${BADGES.filter((badge) => ready.has(badge.id)).map((badge) => `  ${badge.html}\n`).join("")}</p>\n`;
}

export function presentBadges(readme) {
  const block = readme.match(BLOCK)?.[0] ?? "";
  return new Set(BADGES.filter((badge) => block.includes(badge.html)).map((badge) => badge.id));
}

export function updateReadme(readme, ready) {
  if (!BLOCK.test(readme)) throw new Error("README has no centered badge block");
  const wanted = new Set([...presentBadges(readme), ...ready]);
  return readme.replace(BLOCK, renderBlock(wanted));
}

async function shieldsReady(url, fetcher) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) return false;
  return !/not found|too new|invalid|inaccessible/i.test(await response.text());
}

export async function readyBadges(analyticsDir, fetcher = fetch) {
  const ready = new Set();
  for (const badge of BADGES) {
    try {
      if (badge.ready === "always") ready.add(badge.id);
      else if (badge.ready === "registry") (await fetcher(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2F")}/latest`, { signal: AbortSignal.timeout(30000) })).ok && ready.add(badge.id);
      else if (badge.ready === "librariesio") (await shieldsReady(`https://img.shields.io/librariesio/dependent-repos/npm/${PACKAGE}.json`, fetcher)) && ready.add(badge.id);
      else if (existsSync(path.join(analyticsDir, badge.ready))) ready.add(badge.id);
    } catch {}
  }
  return ready;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const analyticsDir = path.resolve(process.argv[2] ?? "analytics");
  const ready = await readyBadges(analyticsDir);
  for (const file of ["README.md", "README.vi.md"]) {
    const before = readFileSync(file, "utf8");
    const after = updateReadme(before, ready);
    if (after !== before) {
      writeFileSync(file, after);
      console.log(`${file}: badges ${[...presentBadges(after)].join(", ")}`);
    }
  }
}
