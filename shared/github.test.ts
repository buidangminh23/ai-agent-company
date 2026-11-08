import assert from "node:assert/strict";
import test from "node:test";
import { actionArgs } from "../server/sources/github-items.ts";
import { actionable, buildGitHub, htmlUrl, repoGroups, shortTitle, type GitItem, type RawGitHub, type RawNotification } from "./github.ts";

const NOW = Date.parse("2026-11-01T08:00:00Z");

const raw: RawGitHub = {
  viewer: {
    login: "me",
    repositories: {
      nodes: [
        {
          name: "app", nameWithOwner: "me/app", url: "https://github.com/me/app", pushedAt: "2026-11-01T07:00:00Z",
          defaultBranchRef: { name: "main", target: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [
            { name: "build (3.8)", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 77, url: "https://github.com/me/app/actions/runs/77", workflow: { name: "Pylint" } } } },
            { name: "build (3.9)", conclusion: "FAILURE", checkSuite: { workflowRun: { databaseId: 77, url: "https://github.com/me/app/actions/runs/77", workflow: { name: "Pylint" } } } },
            { name: "lint", conclusion: "SUCCESS", checkSuite: { workflowRun: { databaseId: 78, workflow: { name: "Lint" } } } },
            { name: "skipped", conclusion: "CANCELLED", checkSuite: { workflowRun: { databaseId: 79, workflow: { name: "Old" } } } },
            { context: "Vercel", state: "ERROR", targetUrl: "https://vercel.com/x" },
          ] } } } },
          pullRequests: { nodes: [
            { number: 5, title: "Ready", url: "u5", updatedAt: "2026-10-31T00:00:00Z", mergeable: "MERGEABLE", reviewDecision: null, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } },
            { number: 6, title: "Draft", url: "u6", isDraft: true, updatedAt: "2026-10-30T00:00:00Z", mergeable: "MERGEABLE" },
            { number: 8, title: "Running", url: "u8", updatedAt: "2026-10-29T12:00:00Z", mergeable: "MERGEABLE", commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] } },
            { number: 7, title: "Broken", url: "u7", updatedAt: "2026-10-29T00:00:00Z", mergeable: "CONFLICTING", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } },
          ] },
          issues: { nodes: [{ number: 1, title: "Bug", url: "i1", author: { login: "bot" }, updatedAt: "2026-10-28T00:00:00Z", comments: { totalCount: 2 } }] },
          vulnerabilityAlerts: { totalCount: 3, nodes: [
            { number: 1, createdAt: "2026-10-01T00:00:00Z", securityVulnerability: { severity: "HIGH", package: { name: "qs" } } },
            { number: 2, createdAt: "2026-10-02T00:00:00Z", securityVulnerability: { severity: "LOW", package: { name: "qs" } } },
            { number: 3, createdAt: "2026-10-03T00:00:00Z", securityVulnerability: { severity: "MODERATE", package: { name: "nanoid" } } },
          ] },
        },
        { name: "old", nameWithOwner: "me/old", url: "https://github.com/me/old", isArchived: true, issues: { nodes: [{ number: 9, title: "Hidden", url: "x", updatedAt: "2026-10-01T00:00:00Z" }] } },
      ],
    },
  },
  reviews: { nodes: [{ number: 3, title: "Team PR", url: "t3", updatedAt: "2026-10-31T12:00:00Z", mergeable: "MERGEABLE", repository: { nameWithOwner: "team/lib", owner: { login: "team" } }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } }] },
  authored: { nodes: [{ number: 5, title: "Ready", url: "u5", updatedAt: "2026-10-31T00:00:00Z", mergeable: "MERGEABLE", repository: { nameWithOwner: "me/app", owner: { login: "me" } } }] },
};

const notes: RawNotification[] = [
  { id: "123", reason: "ci_activity", updated_at: "2026-11-01T06:00:00Z", subject: { title: "CI failed", type: "CheckSuite", url: null }, repository: { full_name: "me/app", html_url: "https://github.com/me/app" } },
];

test("failing checks on the default branch group by workflow run and keep cancelled or green runs out", () => {
  const snap = buildGitHub(raw, notes, new Map(), NOW);
  const ci = snap.items.filter((item) => item.kind === "ci");
  assert.deepEqual(ci.map((item) => [item.title, item.detail[1], item.actions]), [
    ["app: Pylint lỗi", "Job lỗi: build (3.8), build (3.9)", ["rerun"]],
    ["app: Vercel lỗi", "Job lỗi: Vercel", []],
  ]);
  assert.equal(ci[0].url, "https://github.com/me/app/actions/runs/77");
  assert.equal(snap.repos, 1);
  assert.equal(snap.items.some((item) => item.title === "Hidden"), false);
});

test("pull requests only offer merge when owned, not draft, mergeable and green; foreign review requests stay view-only", () => {
  const snap = buildGitHub(raw, [], new Map(), NOW);
  const pr = (id: string) => snap.items.find((item) => item.id === id)!;
  assert.deepEqual(pr("pr:me/app#5").actions, ["merge"]);
  assert.ok(pr("pr:me/app#5").tags.some((tag) => tag.label === "Sẵn sàng merge"));
  assert.equal(pr("pr:me/app#5").tags.some((tag) => tag.label === "Sếp mở"), false);
  assert.deepEqual(pr("pr:me/app#6").actions, []);
  assert.deepEqual(pr("pr:me/app#8").actions, []);
  assert.deepEqual(pr("pr:me/app#8").tags.map((tag) => tag.label), ["CI đang chạy"]);
  assert.deepEqual(pr("pr:me/app#7").actions, []);
  assert.equal(pr("pr:me/app#6").severity, "info");
  assert.equal(pr("pr:me/app#7").severity, "error");
  assert.deepEqual(pr("pr:me/app#7").tags.map((tag) => tag.label), ["CI lỗi", "Xung đột"]);
  assert.deepEqual(pr("pr:team/lib#3").actions, []);
  assert.equal(pr("pr:team/lib#3").tags[0].label, "Nhờ sếp review");
});

test("security alerts fold into one item per repo with severity counts and code scanning", () => {
  const snap = buildGitHub(raw, [], new Map([["me/app", 2]]), NOW);
  const item = snap.items.find((entry) => entry.kind === "security")!;
  assert.equal(item.title, "app: 5 cảnh báo bảo mật");
  assert.deepEqual(item.tags.map((tag) => tag.label), ["1 cao", "1 trung bình", "1 thấp", "2 code scanning"]);
  assert.equal(item.severity, "error");
  assert.equal(item.detail[1], "Gói bị ảnh hưởng: qs, nanoid");
});

test("notifications link to a browsable page and count as information only", () => {
  const snap = buildGitHub(raw, notes, new Map(), NOW);
  const note = snap.items.find((item) => item.kind === "notification")!;
  assert.equal(note.url, "https://github.com/me/app/actions");
  assert.equal(htmlUrl("https://api.github.com/repos/me/app/pulls/5", "https://github.com/me/app", "PullRequest"), "https://github.com/me/app/pull/5");
  assert.equal(htmlUrl("https://api.github.com/repos/me/app/issues/1", "https://github.com/me/app", "Issue"), "https://github.com/me/app/issues/1");
  assert.equal(actionable(snap), snap.items.filter((item) => item.kind !== "notification" && item.severity !== "info").length);
});

test("actions map to fixed gh arguments and refuse actions the item does not offer", () => {
  const snap = buildGitHub(raw, notes, new Map(), NOW);
  const find = (id: string) => snap.items.find((item) => item.id === id)!;
  assert.deepEqual(actionArgs(find("ci:me/app:run:77"), "rerun"), ["run", "rerun", "77", "--failed", "-R", "me/app"]);
  assert.deepEqual(actionArgs(find("pr:me/app#5"), "merge"), ["pr", "merge", "5", "-R", "me/app", "--squash", "--delete-branch"]);
  assert.deepEqual(actionArgs(find("issue:me/app#1"), "close"), ["issue", "close", "1", "-R", "me/app"]);
  assert.deepEqual(actionArgs(find("notification:123"), "read"), ["api", "-X", "PATCH", "notifications/threads/123"]);
  assert.throws(() => actionArgs(find("pr:team/lib#3"), "merge"));
  assert.throws(() => actionArgs(find("pr:me/app#6"), "merge"));
});

function gitItem(id: string, repo: string, kind: GitItem["kind"], severity: GitItem["severity"], updatedAt: string, title = id): GitItem {
  return { id, kind, repo, project: repo.split("/")[1], title, detail: [], url: "", updatedAt, severity, tags: [], actions: [] };
}

test("repo groups put failing repos first and sort each repo by kind then recency", () => {
  const groups = repoGroups([
    gitItem("n1", "o/Quiet", "notification", "info", "2026-11-01T09:00:00Z"),
    gitItem("p1", "o/Busy", "pr", "warning", "2026-10-20T00:00:00Z"),
    gitItem("p2", "o/Busy", "pr", "warning", "2026-10-30T00:00:00Z"),
    gitItem("c1", "o/Broken", "ci", "error", "2026-10-01T00:00:00Z"),
    gitItem("i1", "o/Broken", "issue", "warning", "2026-11-01T00:00:00Z"),
    gitItem("n2", "o/Broken", "notification", "info", "2026-11-01T08:00:00Z"),
  ]);
  assert.deepEqual(groups.map((group) => group.repo), ["o/Broken", "o/Busy", "o/Quiet"]);
  assert.deepEqual(groups[0].items.map((item) => item.id), ["c1", "i1", "n2"]);
  assert.deepEqual(groups[1].items.map((item) => item.id), ["p2", "p1"]);
  assert.deepEqual(groups[0].counts, { ci: 1, issue: 1, notification: 1 });
});

test("row titles drop the repo prefix that the group heading already shows", () => {
  assert.equal(shortTitle(gitItem("c", "acme/Windows", "ci", "error", "2026-11-01T00:00:00Z", "Windows: Pylint lỗi")), "Pylint lỗi");
  assert.equal(shortTitle(gitItem("p", "acme/Windows", "pr", "warning", "2026-11-01T00:00:00Z", "fix: Windows: tidy")), "fix: Windows: tidy");
});

test("unpinned repos sort by commit activity, then the most recently pushed", () => {
  const items = [gitItem("c1", "o/Broken", "ci", "error", "2026-10-01T00:00:00Z"), gitItem("p1", "o/Daily", "pr", "warning", "2026-10-01T00:00:00Z"), gitItem("n1", "o/Fresh", "notification", "info", "2026-10-01T00:00:00Z"), gitItem("n2", "x/Foreign", "notification", "info", "2026-11-01T00:00:00Z")];
  const usage = [{ repo: "o/Daily", commits: 40, pushedAt: "2026-10-31T00:00:00Z" }, { repo: "o/Broken", commits: 2, pushedAt: "2026-10-01T00:00:00Z" }, { repo: "o/Fresh", commits: 2, pushedAt: "2026-10-30T00:00:00Z" }];
  assert.deepEqual(repoGroups(items, usage).map((group) => group.repo), ["o/Daily", "o/Fresh", "o/Broken", "x/Foreign"]);
});

test("pinned repos keep the owner's order ahead of commit activity", () => {
  const at = "2026-10-01T00:00:00Z";
  const items = ["Windows", "Website", "Busy", "Backend", "Bot"].map((name) => gitItem(name, `acme/${name}`, "pr", "warning", at));
  const usage = [{ repo: "acme/Windows", commits: 699, pushedAt: at }, { repo: "acme/Busy", commits: 900, pushedAt: at }, { repo: "acme/Website", commits: 1, pushedAt: at }];
  assert.deepEqual(repoGroups(items, usage, ["Website", "Docs", "Backend", "Bot", "Windows"]).map((group) => group.repo.split("/")[1]), ["Website", "Backend", "Bot", "Windows", "Busy"]);
});
