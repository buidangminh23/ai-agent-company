import { L } from "./i18n.ts";
export type GitKind = "ci" | "pr" | "issue" | "security" | "notification";
export type GitAction = "rerun" | "merge" | "close" | "read";
export type GitSeverity = "error" | "warning" | "info";

export interface GitTag {
  label: string;
  tone: "red" | "amber" | "green" | "blue" | "gray";
}

export interface GitItem {
  id: string;
  kind: GitKind;
  repo: string;
  project: string;
  title: string;
  detail: string[];
  url: string;
  updatedAt: string;
  severity: GitSeverity;
  tags: GitTag[];
  actions: GitAction[];
  author?: string;
}

export interface GitHubSnapshot {
  connected: boolean;
  note: string;
  login: string;
  fetchedAt: string | null;
  repos: number;
  items: GitItem[];
  usage?: RepoUsage[];
  pinned?: string[];
}

export interface RepoUsage {
  repo: string;
  commits: number;
  pushedAt: string | null;
}

export const EMPTY_GITHUB: GitHubSnapshot = { connected: false, note: L("Đang đọc GitHub"), login: "", fetchedAt: null, repos: 0, items: [] };

export const GIT_GROUPS: [GitKind, string][] = [["ci", L("CI lỗi")], ["pr", "Pull request"], ["issue", "Issue"], ["security", L("Bảo mật")], ["notification", L("Thông báo chưa đọc")]];

export const ACTION_LABELS: Record<GitAction, { label: string; confirm: string; done: string }> = {
  rerun: { label: L("Chạy lại job lỗi"), confirm: L("Chạy lại các job lỗi?"), done: L("Đã yêu cầu GitHub chạy lại các job lỗi.") },
  merge: { label: "Merge (squash)", confirm: L("Merge và xoá nhánh?"), done: L("Đã merge pull request và xoá nhánh.") },
  close: { label: L("Đóng issue"), confirm: L("Đóng issue này?"), done: L("Đã đóng issue.") },
  read: { label: L("Đánh dấu đã đọc"), confirm: L("Đánh dấu đã đọc?"), done: L("Đã đánh dấu thông báo là đã đọc.") },
};

const FAILED_CHECK = /^(FAILURE|TIMED_OUT|STARTUP_FAILURE|ACTION_REQUIRED|ERROR)$/;
const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MODERATE", "LOW"];
const SEVERITY_NAMES: Record<string, string> = { CRITICAL: L("nghiêm trọng"), HIGH: "cao", MODERATE: L("trung bình"), LOW: L("thấp") };
const REASONS: Record<string, string> = {
  assign: L("Được giao"), author: L("Sếp tạo"), comment: L("Có bình luận"), ci_activity: L("Hoạt động CI"), invitation: L("Lời mời"), manual: L("Đang theo dõi"),
  mention: L("Nhắc tới sếp"), review_requested: L("Cần review"), security_alert: L("Cảnh báo bảo mật"), state_change: L("Đổi trạng thái"), subscribed: L("Đang theo dõi"),
  team_mention: L("Nhắc tới nhóm"), approval_requested: L("Cần duyệt"), member_feature_requested: L("Yêu cầu tính năng"), security_advisory_credit: L("Ghi công bảo mật"),
};
const SUBJECTS: Record<string, string> = { PullRequest: "Pull request", Issue: "Issue", CheckSuite: "CI", Release: L("Bản phát hành"), Discussion: L("Thảo luận"), Commit: "Commit", RepositoryVulnerabilityAlert: L("Cảnh báo bảo mật"), RepositoryDependabotAlertsThread: "Dependabot" };

export interface RawCheck {
  __typename?: string;
  name?: string;
  conclusion?: string | null;
  status?: string;
  detailsUrl?: string | null;
  checkSuite?: { workflowRun?: { databaseId?: number; url?: string; workflow?: { name?: string } } | null } | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
}

export interface RawPull {
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  author?: { login?: string } | null;
  updatedAt: string;
  reviewDecision?: string | null;
  mergeable?: string;
  headRefName?: string;
  baseRefName?: string;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
  repository?: { nameWithOwner: string; owner?: { login?: string } };
}

export interface RawIssue {
  number: number;
  title: string;
  url: string;
  author?: { login?: string } | null;
  updatedAt: string;
  labels?: { nodes?: { name: string }[] };
  comments?: { totalCount?: number };
  repository?: { nameWithOwner: string; owner?: { login?: string } };
}

export interface RawAlert {
  number: number;
  createdAt: string;
  vulnerableManifestPath?: string;
  securityVulnerability?: { severity?: string; package?: { name?: string; ecosystem?: string }; advisory?: { summary?: string } };
}

export interface RawRepo {
  name: string;
  nameWithOwner: string;
  url: string;
  isArchived?: boolean;
  pushedAt?: string;
  defaultBranchRef?: { name?: string; target?: { history?: { totalCount?: number } | null; statusCheckRollup?: { state?: string; contexts?: { nodes?: RawCheck[] } } | null } | null } | null;
  pullRequests?: { nodes?: RawPull[] };
  issues?: { nodes?: RawIssue[] };
  vulnerabilityAlerts?: { totalCount?: number; nodes?: RawAlert[] };
}

export interface RawViewer {
  login: string;
  repositories?: { nodes?: RawRepo[] };
}

export interface RawSearch {
  nodes?: (RawPull & RawIssue & { __typename?: string })[];
}

export interface RawGitHub {
  viewer: RawViewer;
  reviews?: RawSearch;
  authored?: RawSearch;
  assigned?: RawSearch;
}

export interface RawNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: { title: string; type: string; url: string | null };
  repository: { full_name: string; html_url: string };
}

function shortName(nameWithOwner: string): string {
  return nameWithOwner.split("/").pop() ?? nameWithOwner;
}

export function htmlUrl(apiUrl: string | null, repoUrl: string, type: string): string {
  const match = apiUrl ? /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(pulls|issues|releases|commits)\/([^/]+)$/.exec(apiUrl) : null;
  if (match && match[2] === "pulls") return `https://github.com/${match[1]}/pull/${match[3]}`;
  if (match && match[2] === "issues") return `https://github.com/${match[1]}/issues/${match[3]}`;
  if (match && match[2] === "commits") return `https://github.com/${match[1]}/commit/${match[3]}`;
  if (type === "Release") return `${repoUrl}/releases`;
  if (type === "CheckSuite") return `${repoUrl}/actions`;
  if (/Alert/.test(type)) return `${repoUrl}/security`;
  return repoUrl;
}

function ciItems(repo: RawRepo): GitItem[] {
  const branch = repo.defaultBranchRef?.name ?? "main";
  const checks = repo.defaultBranchRef?.target?.statusCheckRollup?.contexts?.nodes ?? [];
  const runs = new Map<string, { workflow: string; url: string; runId?: number; jobs: string[] }>();
  for (const check of checks) {
    const state = check.conclusion ?? check.state ?? "";
    if (!FAILED_CHECK.test(state)) continue;
    const run = check.checkSuite?.workflowRun;
    const key = run?.databaseId ? `run:${run.databaseId}` : `ctx:${check.name ?? check.context}`;
    const entry = runs.get(key) ?? { workflow: run?.workflow?.name ?? check.context ?? check.name ?? L("Kiểm tra"), url: run?.url ?? check.detailsUrl ?? check.targetUrl ?? `${repo.url}/actions`, runId: run?.databaseId, jobs: [] };
    entry.jobs.push(check.name ?? check.context ?? "");
    runs.set(key, entry);
  }
  return [...runs.entries()].map(([key, run]) => ({
    id: `ci:${repo.nameWithOwner}:${key}`,
    kind: "ci" as const,
    repo: repo.nameWithOwner,
    project: repo.name,
    title: L("{0}: {1} lỗi", repo.name, run.workflow),
    detail: [L("Nhánh {0}", branch), L("Job lỗi: {0}", run.jobs.filter(Boolean).join(", "))],
    url: run.url,
    updatedAt: repo.pushedAt ?? "",
    severity: "error" as const,
    tags: [{ label: L("{0} job lỗi", run.jobs.length), tone: "red" as const }],
    actions: run.runId ? ["rerun" as const] : [],
  }));
}

function pullItem(pull: RawPull, repo: string, owned: boolean, viewer: string, extra: GitTag[] = []): GitItem {
  const checks = pull.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  const tags: GitTag[] = [...extra];
  if (pull.isDraft) tags.push({ label: L("Bản nháp"), tone: "gray" });
  if (pull.reviewDecision === "REVIEW_REQUIRED") tags.push({ label: L("Chờ review"), tone: "amber" });
  if (pull.reviewDecision === "APPROVED") tags.push({ label: L("Đã duyệt"), tone: "green" });
  if (pull.reviewDecision === "CHANGES_REQUESTED") tags.push({ label: L("Cần sửa"), tone: "red" });
  if (checks === "SUCCESS") tags.push({ label: "CI xanh", tone: "green" });
  else if (checks && FAILED_CHECK.test(checks)) tags.push({ label: L("CI lỗi"), tone: "red" });
  else if (checks) tags.push({ label: L("CI đang chạy"), tone: "blue" });
  if (pull.mergeable === "CONFLICTING") tags.push({ label: L("Xung đột"), tone: "red" });
  const ready = !pull.isDraft && pull.mergeable === "MERGEABLE" && (checks === null || checks === "SUCCESS") && pull.reviewDecision !== "CHANGES_REQUESTED";
  if (ready) tags.push({ label: L("Sẵn sàng merge"), tone: "green" });
  const author = pull.author?.login ?? "";
  const failing = (checks !== null && FAILED_CHECK.test(checks)) || pull.mergeable === "CONFLICTING";
  return {
    id: `pr:${repo}#${pull.number}`,
    kind: "pr",
    repo,
    project: shortName(repo),
    title: pull.title,
    detail: [`${repo} #${pull.number}${author && author !== viewer ? L(" · mở bởi {0}", author) : ""}`, ...(pull.headRefName ? [`${pull.headRefName} → ${pull.baseRefName ?? "main"}`] : [])],
    url: pull.url,
    updatedAt: pull.updatedAt,
    severity: pull.isDraft ? "info" : failing ? "error" : "warning",
    tags,
    actions: owned && ready ? ["merge"] : [],
    author,
  };
}

function issueItem(issue: RawIssue, repo: string, owned: boolean, viewer: string): GitItem {
  const author = issue.author?.login ?? "";
  const comments = issue.comments?.totalCount ?? 0;
  return {
    id: `issue:${repo}#${issue.number}`,
    kind: "issue",
    repo,
    project: shortName(repo),
    title: issue.title,
    detail: [`${repo} #${issue.number}${author && author !== viewer ? L(" · mở bởi {0}", author) : ""}${comments ? L(" · {0} bình luận", comments) : ""}`],
    url: issue.url,
    updatedAt: issue.updatedAt,
    severity: "warning",
    tags: (issue.labels?.nodes ?? []).slice(0, 4).map((label) => ({ label: label.name, tone: "gray" as const })),
    actions: owned ? ["close"] : [],
    author,
  };
}

function securityItem(repo: RawRepo, codeScanning: number): GitItem | null {
  const total = repo.vulnerabilityAlerts?.totalCount ?? 0;
  if (!total && !codeScanning) return null;
  const alerts = repo.vulnerabilityAlerts?.nodes ?? [];
  const bySeverity = new Map<string, number>();
  for (const alert of alerts) {
    const level = alert.securityVulnerability?.severity ?? "LOW";
    bySeverity.set(level, (bySeverity.get(level) ?? 0) + 1);
  }
  const packages = [...new Set(alerts.map((alert) => alert.securityVulnerability?.package?.name).filter(Boolean))].slice(0, 6);
  const tags: GitTag[] = SEVERITY_ORDER.filter((level) => bySeverity.get(level)).map((level) => ({ label: `${bySeverity.get(level)} ${SEVERITY_NAMES[level]}`, tone: level === "CRITICAL" || level === "HIGH" ? "red" : level === "MODERATE" ? "amber" : "gray" }));
  if (codeScanning) tags.push({ label: `${codeScanning} code scanning`, tone: "amber" });
  const detail = [
    ...(total ? [L("{0} cảnh báo Dependabot{1}", total, alerts.length < total ? L(" (phân loại theo {0} cảnh báo mới nhất)", alerts.length) : "")] : []),
    ...(packages.length ? [L("Gói bị ảnh hưởng: {0}", packages.join(", "))] : []),
    ...(codeScanning ? [L("{0} cảnh báo code scanning", codeScanning)] : []),
  ];
  const latest = alerts.map((alert) => alert.createdAt).sort().at(-1) ?? repo.pushedAt ?? "";
  const severe = bySeverity.get("CRITICAL") || bySeverity.get("HIGH");
  return {
    id: `security:${repo.nameWithOwner}`,
    kind: "security",
    repo: repo.nameWithOwner,
    project: repo.name,
    title: L("{0}: {1} cảnh báo bảo mật", repo.name, total + codeScanning),
    detail,
    url: total ? `${repo.url}/security/dependabot` : `${repo.url}/security/code-scanning`,
    updatedAt: latest,
    severity: severe ? "error" : "warning",
    tags,
    actions: [],
  };
}

function notificationItem(note: RawNotification): GitItem {
  return {
    id: `notification:${note.id}`,
    kind: "notification",
    repo: note.repository.full_name,
    project: shortName(note.repository.full_name),
    title: note.subject.title,
    detail: [`${note.repository.full_name} · ${REASONS[note.reason] ?? note.reason}`],
    url: htmlUrl(note.subject.url, note.repository.html_url, note.subject.type),
    updatedAt: note.updated_at,
    severity: "info",
    tags: [{ label: SUBJECTS[note.subject.type] ?? note.subject.type, tone: "blue" }],
    actions: ["read"],
  };
}

function byTime(a: GitItem, b: GitItem): number {
  return Date.parse(b.updatedAt || "0") - Date.parse(a.updatedAt || "0");
}

export function buildGitHub(raw: RawGitHub, notifications: RawNotification[], codeScanning: Map<string, number>, now: number): GitHubSnapshot {
  const viewer = raw.viewer.login;
  const repos = (raw.viewer.repositories?.nodes ?? []).filter((repo) => !repo.isArchived);
  const items: GitItem[] = [];
  const seen = new Set<string>();
  const add = (item: GitItem | null) => {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  };
  for (const repo of repos) {
    ciItems(repo).forEach(add);
    for (const pull of repo.pullRequests?.nodes ?? []) add(pullItem(pull, repo.nameWithOwner, true, viewer));
    for (const issue of repo.issues?.nodes ?? []) add(issueItem(issue, repo.nameWithOwner, true, viewer));
    add(securityItem(repo, codeScanning.get(repo.nameWithOwner) ?? 0));
  }
  const owned = (node: { repository?: { owner?: { login?: string } } }) => node.repository?.owner?.login === viewer;
  for (const pull of raw.reviews?.nodes ?? []) if (pull.repository) add(pullItem(pull, pull.repository.nameWithOwner, owned(pull), viewer, [{ label: L("Nhờ sếp review"), tone: "amber" }]));
  for (const pull of raw.authored?.nodes ?? []) if (pull.repository) add(pullItem(pull, pull.repository.nameWithOwner, owned(pull), viewer, [{ label: L("Sếp mở"), tone: "blue" }]));
  for (const issue of raw.assigned?.nodes ?? []) if (issue.repository && issue.__typename !== "PullRequest") add(issueItem(issue, issue.repository.nameWithOwner, owned(issue), viewer));
  notifications.forEach((note) => add(notificationItem(note)));
  return { connected: true, note: "", login: viewer, fetchedAt: new Date(now).toISOString(), repos: repos.length, items: items.sort(byTime), usage: repos.map((repo) => ({ repo: repo.nameWithOwner, commits: repo.defaultBranchRef?.target?.history?.totalCount ?? 0, pushedAt: repo.pushedAt ?? null })) };
}

export function actionable(snapshot: GitHubSnapshot | null): number {
  return snapshot?.items.filter((item) => item.kind !== "notification" && item.severity !== "info").length ?? 0;
}

export interface RepoGroup {
  repo: string;
  items: GitItem[];
  counts: Partial<Record<GitKind, number>>;
}

export function parsePinned(raw: string): string[] {
  return [...new Set(raw.split(",").map((name) => name.trim()).filter(Boolean))].slice(0, 20);
}

const SEVERITY_RANK: Record<GitSeverity, number> = { error: 0, warning: 1, info: 2 };
const KIND_RANK = new Map(GIT_GROUPS.map(([kind], index) => [kind, index]));

function newest(items: GitItem[]): number {
  return Math.max(...items.map((item) => Date.parse(item.updatedAt) || 0));
}

function worst(items: GitItem[]): number {
  return Math.min(...items.map((item) => SEVERITY_RANK[item.severity]));
}

export function repoGroups(items: GitItem[], usage: RepoUsage[] = [], pinnedRepos: string[] = []): RepoGroup[] {
  const pinnedRank = new Map(pinnedRepos.map((name, index) => [name.toLowerCase(), index]));
  const used = new Map(usage.map((entry) => [entry.repo, entry]));
  const commits = (group: RepoGroup) => used.get(group.repo)?.commits ?? -1;
  const pinned = (group: RepoGroup) => pinnedRank.get((group.repo.split("/").pop() ?? "").toLowerCase()) ?? pinnedRepos.length;
  const pushed = (group: RepoGroup) => Date.parse(used.get(group.repo)?.pushedAt ?? "") || 0;
  const byRepo = new Map<string, GitItem[]>();
  for (const item of items) byRepo.set(item.repo, [...(byRepo.get(item.repo) ?? []), item]);
  const groups = [...byRepo].map(([repo, list]) => {
    const sorted = [...list].sort((a, b) => KIND_RANK.get(a.kind)! - KIND_RANK.get(b.kind)! || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const counts: Partial<Record<GitKind, number>> = {};
    for (const item of sorted) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return { repo, items: sorted, counts };
  });
  const work = (group: RepoGroup) => group.items.filter((item) => item.kind !== "notification").length;
  return groups.sort((a, b) => pinned(a) - pinned(b) || commits(b) - commits(a) || pushed(b) - pushed(a) || worst(a.items) - worst(b.items) || work(b) - work(a) || newest(b.items) - newest(a.items) || a.repo.localeCompare(b.repo));
}

export function shortTitle(item: GitItem): string {
  const name = item.repo.split("/").pop() ?? item.repo;
  return item.title.startsWith(`${name}: `) ? item.title.slice(name.length + 2) : item.title;
}
