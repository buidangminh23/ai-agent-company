import { L } from "../../shared/i18n.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildGitHub, type GitAction, type GitHubSnapshot, type GitItem, type RawGitHub, type RawNotification } from "../../shared/github.ts";
import { ghPath } from "./github.ts";

const run = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 60_000;
const CODE_SCAN_TTL_MS = 15 * 60_000;
const CODE_SCAN_CONCURRENCY = 4;
const MAX_NOTIFICATIONS = 50;

const PULL = "number title url isDraft author { login } updatedAt reviewDecision mergeable headRefName baseRefName commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }";
const ISSUE = "number title url author { login } updatedAt labels(first: 5) { nodes { name } } comments { totalCount }";
const SEARCH = `nodes { __typename ... on PullRequest { ${PULL} repository { nameWithOwner owner { login } } } ... on Issue { ${ISSUE} repository { nameWithOwner owner { login } } } }`;

const USAGE_DAYS = 30;

const query = (since: string) => `query {
  viewer {
    login
    repositories(first: 50, ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }) {
      nodes {
        name nameWithOwner url isArchived pushedAt
        defaultBranchRef { name target { ... on Commit { history(since: "${since}") { totalCount } statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name conclusion status detailsUrl checkSuite { workflowRun { databaseId url workflow { name } } } } ... on StatusContext { context state targetUrl } } } } } } }
        pullRequests(states: OPEN, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PULL} } }
        issues(states: OPEN, first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${ISSUE} } }
        vulnerabilityAlerts(states: OPEN, first: 100) { totalCount nodes { number createdAt vulnerableManifestPath securityVulnerability { severity package { name ecosystem } advisory { summary } } } }
      }
    }
  }
  reviews: search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: 30) { ${SEARCH} }
  authored: search(query: "is:open is:pr author:@me archived:false", type: ISSUE, first: 30) { ${SEARCH} }
  assigned: search(query: "is:open is:issue assignee:@me archived:false", type: ISSUE, first: 30) { ${SEARCH} }
}`;

function firstLine(error: unknown): string {
  return String((error as { stderr?: string }).stderr || (error as Error).message).trim().split("\n")[0].slice(0, 200);
}

async function gh(args: string[], timeout = GH_TIMEOUT_MS): Promise<string> {
  const { stdout } = await run(ghPath(), args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return stdout;
}

const codeScanning = new Map<string, number>();
let codeScannedAt = 0;

async function refreshCodeScanning(repos: string[], now: number): Promise<void> {
  if (now - codeScannedAt < CODE_SCAN_TTL_MS) return;
  codeScannedAt = now;
  const queue = [...repos];
  const worker = async () => {
    for (let repo = queue.shift(); repo; repo = queue.shift()) {
      try {
        const alerts = JSON.parse(await gh(["api", `repos/${repo}/code-scanning/alerts?state=open&per_page=100`])) as unknown[];
        codeScanning.set(repo, Array.isArray(alerts) ? alerts.length : 0);
      } catch {
        codeScanning.delete(repo);
      }
    }
  };
  await Promise.all(Array.from({ length: CODE_SCAN_CONCURRENCY }, worker));
}

export async function readGitHub(now = Date.now()): Promise<GitHubSnapshot> {
  try {
    const raw = JSON.parse(await gh(["api", "graphql", "-f", `query=${query(new Date(now - USAGE_DAYS * 86_400_000).toISOString())}`])) as { data?: RawGitHub; errors?: { message: string }[] };
    if (!raw.data?.viewer) throw new Error(raw.errors?.[0]?.message ?? L("GitHub không trả dữ liệu"));
    const notifications = (JSON.parse(await gh(["api", `notifications?per_page=${MAX_NOTIFICATIONS}`]).catch(() => "[]")) as RawNotification[]).slice(0, MAX_NOTIFICATIONS);
    const repos = (raw.data.viewer.repositories?.nodes ?? []).filter((repo) => !repo.isArchived).map((repo) => repo.nameWithOwner);
    await refreshCodeScanning(repos, now);
    const snapshot = buildGitHub(raw.data, notifications, codeScanning, now);
    const partial = raw.errors?.length ? L("GitHub trả thiếu một phần: {0}", raw.errors[0].message.slice(0, 120)) : "";
    return { ...snapshot, note: partial };
  } catch (error) {
    return { connected: false, note: L("GitHub CLI lỗi: {0}", firstLine(error)), login: "", fetchedAt: null, repos: 0, items: [] };
  }
}

function itemNumber(item: GitItem): string {
  return item.id.slice(item.id.lastIndexOf("#") + 1);
}

export function actionArgs(item: GitItem, action: GitAction): string[] {
  if (!item.actions.includes(action)) throw new Error(L("Thao tác không áp dụng cho mục này"));
  if (action === "rerun") {
    const runId = /:run:(\d+)$/.exec(item.id)?.[1];
    if (!runId) throw new Error(L("Không tìm thấy lượt chạy CI"));
    return ["run", "rerun", runId, "--failed", "-R", item.repo];
  }
  if (action === "merge") return ["pr", "merge", itemNumber(item), "-R", item.repo, "--squash", "--delete-branch"];
  if (action === "close") return ["issue", "close", itemNumber(item), "-R", item.repo];
  const thread = item.id.slice("notification:".length);
  if (!/^\d+$/.test(thread)) throw new Error(L("Không tìm thấy thông báo"));
  return ["api", "-X", "PATCH", `notifications/threads/${thread}`];
}

export async function runGitAction(item: GitItem, action: GitAction): Promise<void> {
  try {
    await gh(actionArgs(item, action), ACTION_TIMEOUT_MS);
  } catch (error) {
    throw new Error(firstLine(error));
  }
}

export async function markAllRead(): Promise<void> {
  try {
    await gh(["api", "-X", "PUT", "notifications", "-F", "read=true"], ACTION_TIMEOUT_MS);
  } catch (error) {
    throw new Error(firstLine(error));
  }
}
