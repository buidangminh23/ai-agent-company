import { L } from "../../shared/i18n.ts";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SkillGroup, SkillsSnapshot } from "../../shared/types.ts";

const HOME = os.homedir();
const SKILL_SOURCES: { source: string; dirs: string[] }[] = [
  { source: "Claude", dirs: [path.join(HOME, ".claude", "skills")] },
  { source: "Codex", dirs: [path.join(HOME, ".codex", "skills"), path.join(HOME, ".agents", "skills")] },
  { source: "Antigravity", dirs: [path.join(HOME, ".gemini", "config", "skills")] },
];

async function hasSkillFile(dir: string): Promise<boolean> {
  try {
    return (await stat(path.join(dir, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}

async function listSkills(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const visible = entries.filter((name) => !name.startsWith("."));
  const checks = await Promise.all(visible.map(async (name) => ((await hasSkillFile(path.join(dir, name))) ? name : null)));
  return checks.filter((name): name is string => name !== null);
}

export async function readSkills(): Promise<SkillsSnapshot> {
  const groups: SkillGroup[] = [];
  for (const { source, dirs } of SKILL_SOURCES) {
    const names = [...new Set((await Promise.all(dirs.map(listSkills))).flat())].sort((a, b) => a.localeCompare(b));
    if (names.length) groups.push({ source, count: names.length, names });
  }
  const total = groups.reduce((n, g) => n + g.count, 0);
  return {
    connected: groups.length > 0,
    note: groups.length ? "" : L("Không tìm thấy thư mục skill trên máy hub"),
    total,
    groups,
  };
}
