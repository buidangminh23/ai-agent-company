import { L } from "../../shared/i18n.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { ProjectsSnapshot, RepoInfo } from "../../shared/types.ts";

const run = promisify(execFile);
const GH_TIMEOUT_MS = 20000;
const REPO_LIMIT = 40;
const GH_CANDIDATES = [process.env.MSC_GH, "/opt/homebrew/bin/gh", "/usr/local/bin/gh", "C:\\Program Files\\GitHub CLI\\gh.exe"];

const QUERY = `query {
  viewer {
    repositories(first: ${REPO_LIMIT}, ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }) {
      nodes {
        name url isPrivate isArchived pushedAt
        latestRelease { tagName publishedAt }
        deployments(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
          nodes { environment createdAt latestStatus { state } }
        }
        defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

export function ghPath(): string {
  return GH_CANDIDATES.find((p): p is string => Boolean(p) && existsSync(p!)) ?? "gh";
}

function toRepo(node: any): RepoInfo {
  const deploy = node.deployments?.nodes?.[0];
  return {
    name: node.name,
    url: node.url,
    isPrivate: Boolean(node.isPrivate),
    isArchived: Boolean(node.isArchived),
    pushedAt: node.pushedAt,
    release: node.latestRelease ? { tag: node.latestRelease.tagName, publishedAt: node.latestRelease.publishedAt } : null,
    deploy: deploy
      ? { environment: deploy.environment ?? "", state: String(deploy.latestStatus?.state ?? "PENDING").toLowerCase(), at: deploy.createdAt }
      : null,
    ci: node.defaultBranchRef?.target?.statusCheckRollup?.state?.toLowerCase() ?? null,
  };
}

export async function readProjects(): Promise<ProjectsSnapshot> {
  try {
    const { stdout } = await run(ghPath(), ["api", "graphql", "-f", `query=${QUERY}`], {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    const nodes: any[] = JSON.parse(stdout).data?.viewer?.repositories?.nodes ?? [];
    return { connected: true, note: "", repos: nodes.map(toRepo), fetchedAt: new Date().toISOString() };
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr || (err as Error).message).split("\n")[0];
    return { connected: false, note: L("GitHub CLI lỗi: {0}", msg.slice(0, 120)), repos: [], fetchedAt: null };
  }
}
