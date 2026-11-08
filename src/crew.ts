import type { AgentApp, AgentInfo, MachineHealth, MachineId, SiteStatus, Snapshot } from "../shared/types.ts";
import { ROLES } from "../shared/roles.ts";
import type { SeatTarget } from "./agents.ts";
import { MACHINE_ROOMS, OFFICE_DESK_Z, RACK_FRONT, TECH_DESK_Z, ZONE_BY_ID, roleSeat, serverNook, serverRackSlots, type Zone } from "./scene/layout.ts";
import { RACK_REACH } from "./scene/rackwork.ts";
import { LIFE_PREFIX, buildLife } from "./life.ts";

export const STAFF_PREFIX = "staff:";
export const OPS_PREFIX = "ops:";
const CREW_APPS: AgentApp[] = ["claude", "codex", "antigravity"];
const SITE_RACKS: [number, -1 | 1, number][] = [[0, -1, 1], [0, 1, 2], [1, -1, 2], [1, 1, 1]];
const NOOK_RACK_Z = 0.62;
const NOOK_RACK_X = -0.2;
const HUDDLE_S = 4 * 60;
const HUDDLE_GAP = 0.5;
const HUDDLE_PICKS = [0, 3, 9, 12];

export interface Crew {
  agents: AgentInfo[];
  pins: Map<string, SeatTarget>;
}

export function crewKind(id: string): "staff" | "ops" | "life" | null {
  if (id.startsWith(STAFF_PREFIX)) return "staff";
  if (id.startsWith(OPS_PREFIX)) return "ops";
  if (id.startsWith(LIFE_PREFIX)) return "life";
  return null;
}

function crewAgent(id: string, app: AgentApp, machine: MachineId, project: string, title: string, detail: string, working: boolean, at: string): AgentInfo {
  return { id, app, machine, title, project, role: null, state: working ? "working" : "idle", detail, parentId: null, updatedAt: at, pending: null };
}

function gb(bytes: number): string {
  return (bytes / 2 ** 30).toFixed(1);
}

function healthText(m: MachineHealth): string {
  if (!m.online) return m.source === "none" ? "Chưa cài collector" : "Mất kết nối máy";
  const parts = [`CPU ${m.cpu ?? "—"}%`];
  if (m.memTotal) parts.push(`RAM ${gb(m.memUsed ?? 0)}/${gb(m.memTotal)} GB`);
  if (m.diskTotal) parts.push(`Ổ ${gb(m.diskUsed ?? 0)}/${gb(m.diskTotal)} GB`);
  return parts.join(" · ");
}

function siteText(s: SiteStatus): string {
  return s.status === null ? s.note : `${s.status} · ${s.latencyMs ?? "—"}ms · ${s.note}`;
}

function occupiedSeats(snap: Snapshot, realSeats: Set<string>): Set<string> {
  const out = new Set(realSeats);
  for (const a of snap.agents) if (a.role && a.state !== "waiting") out.add(`${a.machine}:${a.role}`);
  return out;
}

function huddleSpots(zone: Zone, machine: string): SeatTarget[] {
  const cx = (zone.x0 + zone.x1) / 2;
  const midZ = (OFFICE_DESK_Z + TECH_DESK_Z) / 2 + 0.7;
  const frontX = zone.x1 - 3.0;
  const frontZ = zone.z1 - 1.6;
  const circleA = { id: `huddle:${machine}:a`, activity: "chat" as const };
  const circleB = { id: `huddle:${machine}:b`, activity: "chat" as const };
  return [
    { key: `huddle:${machine}:0`, x: cx - HUDDLE_GAP, z: midZ, facing: Math.PI / 2, pose: "stand", approach: null, circle: circleA },
    { key: `huddle:${machine}:1`, x: cx + HUDDLE_GAP, z: midZ, facing: -Math.PI / 2, pose: "stand", approach: null, circle: circleA },
    { key: `huddle:${machine}:2`, x: frontX - HUDDLE_GAP, z: frontZ, facing: Math.PI / 2, pose: "stand", approach: null, circle: circleB },
    { key: `huddle:${machine}:3`, x: frontX + HUDDLE_GAP, z: frontZ, facing: -Math.PI / 2, pose: "stand", approach: null, circle: circleB },
  ];
}

function huddleMembers(ids: string[], nowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length < 2) return out;
  const slot = Math.floor(nowMs / 1000 / HUDDLE_S);
  HUDDLE_PICKS.forEach((offset, spot) => {
    const id = ids[(slot * 5 + offset) % ids.length];
    if (!out.has(id)) out.set(id, spot);
  });
  return out;
}

function addStaff(snap: Snapshot, crew: Crew, nowMs: number, realSeats: Set<string>): void {
  const taken = occupiedSeats(snap, realSeats);
  for (const room of MACHINE_ROOMS) {
    const zone = ZONE_BY_ID.get(room.zone);
    if (!zone) continue;
    const free = ROLES.filter((role) => !taken.has(`${room.machine}:${role.id}`));
    const ids = free.map((role) => `${STAFF_PREFIX}${room.machine}:${role.id}`);
    const huddles = huddleSpots(zone, room.machine);
    const away = huddleMembers(ids, nowMs);
    free.forEach((role) => {
      const seat = roleSeat(room.machine, role.id);
      const id = `${STAFF_PREFIX}${room.machine}:${role.id}`;
      const index = ROLES.indexOf(role);
      const info = crewAgent(id, CREW_APPS[index % CREW_APPS.length], room.machine, room.machine, "Sẵn sàng nhận việc", "", false, snap.generatedAt);
      crew.agents.push({ ...info, role: role.id });
      const spot = away.get(id);
      crew.pins.set(id, spot !== undefined ? huddles[spot] : { key: seat.key, x: seat.x, z: seat.z, facing: seat.facing, pose: "sit", approach: seat.lane, task: "type" });
    });
  }
}

function addMachineOps(snap: Snapshot, crew: Crew): void {
  MACHINE_ROOMS.forEach((room, i) => {
    const zone = ZONE_BY_ID.get(room.zone);
    const health = snap.machines.find((m) => m.id === room.machine);
    if (!zone || !health) return;
    const nook = serverNook(zone);
    const id = `${OPS_PREFIX}${room.machine}`;
    const rackX = (nook.x0 + nook.x1) / 2 + NOOK_RACK_X;
    crew.agents.push(crewAgent(id, CREW_APPS[i % CREW_APPS.length], room.machine, room.machine, "Bảo trì và vận hành máy chủ", healthText(health), health.online, health.checkedAt));
    crew.pins.set(id, { key: `nook:${room.machine}`, x: rackX, z: nook.z0 + NOOK_RACK_Z + RACK_FRONT + RACK_REACH, facing: Math.PI, pose: "stand", approach: null, task: "rack" });
  });
}

function addSiteOps(snap: Snapshot, crew: Crew): void {
  if (!ZONE_BY_ID.get("server")) return;
  const slots = serverRackSlots();
  snap.sites.slice(0, SITE_RACKS.length).forEach((site, i) => {
    const [row, side, index] = SITE_RACKS[i];
    const slot = slots.find((s) => s.row === row && s.side === side && s.index === index)!;
    const id = `${OPS_PREFIX}site:${site.label}`;
    crew.agents.push(crewAgent(id, CREW_APPS[(i + 1) % CREW_APPS.length], "LAPTOP", site.label, "Giám sát web", siteText(site), site.ok, site.checkedAt));
    crew.pins.set(id, { key: `server:${i}`, x: slot.x, z: slot.z + RACK_FRONT + RACK_REACH, facing: Math.PI, pose: "stand", approach: null, task: "rack" });
  });
}

export function buildCrew(snap: Snapshot, nowMs = Date.now(), realSeats: Set<string> = new Set()): Crew {
  const crew: Crew = { agents: [], pins: new Map() };
  addStaff(snap, crew, nowMs, realSeats);
  addMachineOps(snap, crew);
  addSiteOps(snap, crew);
  const life = buildLife(nowMs, snap.generatedAt, realSeats);
  crew.agents.push(...life.agents);
  for (const [id, pin] of life.pins) crew.pins.set(id, pin);
  return crew;
}
