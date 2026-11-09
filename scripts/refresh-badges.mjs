import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const REPO = "buidangminh23/ai-agent-company";
export const PACKAGE = "@minhspark/ai-agent-company";
const DAY = 86400000;
const NPM_WINDOW_DAYS = 540;

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

export function formatCount(value) {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(value >= 1e5 ? 0 : 1).replace(/\.0$/, "")}k`;
  return value.toLocaleString("en-US");
}

export function renderBadge(label, message, color, detail) {
  const labelWidth = Math.ceil([...label].length * 7.2 + 16);
  const messageWidth = Math.ceil([...message].length * 7.2 + 16);
  const width = labelWidth + messageWidth;
  const accessible = `${label}: ${message}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 20 / 24}" height="20" viewBox="0 0 ${width} 24" role="img" aria-label="${escapeXml(accessible)}"><title>${escapeXml(`${accessible}. ${detail}`)}</title><rect width="${width}" height="24" rx="4" fill="#555"/><path d="M${labelWidth} 0H${width - 4}Q${width} 0 ${width} 4V20Q${width} 24 ${width - 4} 24H${labelWidth}Z" fill="${color}"/><g fill="#fff" font-family="DejaVu Sans Mono,monospace" font-size="12" text-anchor="middle"><text x="${labelWidth / 2}" y="16">${escapeXml(label)}</text><text x="${labelWidth + messageWidth / 2}" y="16">${escapeXml(message)}</text></g></svg>\n`;
}

const isoDay = (time) => new Date(time).toISOString().slice(0, 10);

export function npmWindows(createdAt, now) {
  const windows = [];
  let start = Date.parse(isoDay(createdAt));
  const end = Date.parse(isoDay(now));
  while (start <= end) {
    const stop = Math.min(end, start + (NPM_WINDOW_DAYS - 1) * DAY);
    windows.push(`${isoDay(start)}:${isoDay(stop)}`);
    start = stop + DAY;
  }
  return windows;
}

async function json(fetcher, url, notFound = `${url} returned HTTP 404`) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) throw new Error(notFound);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

const NO_STATS = "npm has no download statistics for this package yet; new packages get them about a day after publishing";

const sum = (rows) => rows.reduce((total, row) => total + row.downloads, 0);

export async function npmBadges({ fetcher = fetch, now = Date.now(), pkg = PACKAGE } = {}) {
  const meta = await json(fetcher, `https://registry.npmjs.org/${pkg.replace("/", "%2F")}`, "the package is not published on npm");
  const createdAt = meta.time?.created;
  if (!createdAt) throw new Error("npm registry did not return a creation date");
  let total = 0;
  for (const window of npmWindows(createdAt, now)) {
    const data = await json(fetcher, `https://api.npmjs.org/downloads/range/${window}/${pkg}`, NO_STATS);
    if (!Array.isArray(data.downloads)) throw new Error("npm range response has no downloads");
    total += sum(data.downloads);
  }
  const month = await json(fetcher, `https://api.npmjs.org/downloads/range/last-month/${pkg}`, NO_STATS);
  if (!Array.isArray(month.downloads)) throw new Error("npm last-month response has no downloads");
  return {
    "stats-npm-downloads.svg": renderBadge("npm downloads", formatCount(total), "#CB3837", `All downloads since ${isoDay(createdAt)} UTC`),
    "stats-npm-downloads-month.svg": renderBadge(`npm downloads / ${month.downloads.length}d`, formatCount(sum(month.downloads)), "#CB3837", `${month.start} to ${month.end} UTC`),
  };
}

async function ghApi(endpoint) {
  const { stdout } = await execute("gh", ["api", "-H", "Accept: application/vnd.github+json", endpoint], { timeout: 60000, windowsHide: true });
  return JSON.parse(stdout);
}

export async function viewsBadge({ gh = ghApi, repo = REPO } = {}) {
  const data = await gh(`repos/${repo}/traffic/views`);
  if (!Number.isSafeInteger(data.count) || !Array.isArray(data.views)) throw new Error("GitHub traffic response is invalid");
  const start = data.views[0]?.timestamp?.slice(0, 10);
  const end = data.views.at(-1)?.timestamp?.slice(0, 10);
  const days = start && end ? (Date.parse(end) - Date.parse(start)) / DAY + 1 : 14;
  return { "stats-github-views.svg": renderBadge(`GitHub views / ${days}d`, formatCount(data.count), "#0369a1", start ? `${start} to ${end} UTC` : "No views in the source window") };
}

export async function refreshBadges(directory, sources = { npm: () => npmBadges(), views: () => viewsBadge() }) {
  await mkdir(directory, { recursive: true });
  const written = [];
  const errors = [];
  for (const [name, source] of Object.entries(sources)) {
    let files;
    try {
      files = await source();
    } catch (error) {
      errors.push({ name, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const [file, content] of Object.entries(files)) {
      await writeFile(path.join(directory, file), content);
      written.push(file);
    }
  }
  return { written, errors };
}

const HINTS = {
  views: " GitHub traffic needs the ANALYTICS_TOKEN secret (fine-grained token, Administration: read).",
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { written, errors } = await refreshBadges(path.resolve(process.argv[2] ?? "analytics"));
  for (const file of written) console.log(`updated ${file}`);
  for (const error of errors) console.log(`::warning::${error.name} badge kept its previous value: ${error.message}.${HINTS[error.name] ?? ""}`);
}
