import type { AgentInfo, RoleId } from "../shared/types.ts";
import { ROLE_BY_ID } from "../shared/roles.ts";
import { resolveAgentRoles } from "../shared/role-resolve.ts";

export const PERSONAL_LABEL = "Việc cá nhân";

const firm = new Map<string, RoleId>();
const resolved = new Map<string, RoleId | null>();

export function resolveRoles(agents: AgentInfo[]): AgentInfo[] {
  const out = resolveAgentRoles(agents, firm);
  for (const a of out) resolved.set(a.id, a.role);
  return out;
}

export function roleLabel(info: AgentInfo): string {
  const role = info.role ?? resolved.get(info.id) ?? null;
  return role ? ROLE_BY_ID.get(role)?.label ?? PERSONAL_LABEL : PERSONAL_LABEL;
}
