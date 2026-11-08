import type { AgentApp, AgentInfo, RoleId } from "./types.ts";
import { classifyRole } from "./roles.ts";

const APP_DEFAULT_ROLE: Record<AgentApp, RoleId> = { claude: "frontend", codex: "backend", antigravity: "ai" };
const PERSONAL_DIRS = [/^[a-z]:\/?$/, /\/users\/[^/]+\/?$/, /\/downloads(\/|$)/, /\/documents(\/|$)/, /\/desktop(\/|$)/, /^~\/?$/, /^\/users\/[^/]+$/];
const PERSONAL_WORDS = ["việc cá nhân", "cá nhân của t", "memory", "rules.md", "lịch học", "bài tập", "assignment"];

function normalPath(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
}

function stableText(a: AgentInfo): string {
  return [a.title, a.task, a.branch].filter(Boolean).join(" ");
}

function liveText(a: AgentInfo): string {
  return [a.progress, a.recap, a.outcome?.summary, a.detail].filter(Boolean).join(" ");
}

export function isPersonalWork(a: AgentInfo): boolean {
  const dir = normalPath(a.cwd);
  if (dir && PERSONAL_DIRS.some((re) => re.test(dir))) return true;
  const text = stableText(a).toLowerCase();
  return PERSONAL_WORDS.some((word) => text.includes(word));
}

function projectRoles(agents: AgentInfo[]): Map<string, RoleId> {
  const counts = new Map<string, Map<RoleId, number>>();
  for (const a of agents) {
    if (!a.role) continue;
    const byRole = counts.get(a.project) ?? new Map<RoleId, number>();
    byRole.set(a.role, (byRole.get(a.role) ?? 0) + 1);
    counts.set(a.project, byRole);
  }
  const out = new Map<string, RoleId>();
  for (const [project, byRole] of counts) out.set(project, [...byRole.entries()].sort((x, y) => y[1] - x[1])[0][0]);
  return out;
}

function guessRole(a: AgentInfo, parent: RoleId | null | undefined, byProject: Map<string, RoleId>, firm: Map<string, RoleId>): RoleId {
  const kept = firm.get(a.id);
  if (kept) return kept;
  const files = (a.files ?? []).map((f) => f.path);
  const confident = classifyRole(stableText(a), files) ?? a.role ?? classifyRole(liveText(a), files);
  if (confident) {
    firm.set(a.id, confident);
    return confident;
  }
  return parent ?? byProject.get(a.project) ?? APP_DEFAULT_ROLE[a.app];
}

export function resolveAgentRoles(agents: AgentInfo[], firm: Map<string, RoleId> = new Map()): AgentInfo[] {
  const byProject = projectRoles(agents);
  const out = new Map<string, AgentInfo>();
  const ordered = [...agents].sort((x, y) => Number(x.parentId !== null) - Number(y.parentId !== null));
  for (const a of ordered) {
    const parent = a.parentId ? out.get(a.parentId)?.role : undefined;
    const role = isPersonalWork(a) ? null : guessRole(a, parent, byProject, firm);
    out.set(a.id, role === a.role ? a : { ...a, role });
  }
  return agents.map((a) => out.get(a.id)!);
}
