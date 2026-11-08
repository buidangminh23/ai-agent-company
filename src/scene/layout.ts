import { L } from "../../shared/i18n.ts";
import type { MachineId, RoleId } from "../../shared/types.ts";
import { ROLES } from "../../shared/roles.ts";

export const DRINK_BAR_SEATS = [-Math.PI / 3, Math.PI / 3, -Math.PI * 2 / 3, Math.PI * 2 / 3].map(angle => ({
  x: Math.sin(angle) * 1.85, z: Math.cos(angle) * 1.85, yaw: angle + Math.PI,
}));

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export type ZoneId =
  | "reception" | "ceo" | "meeting"
  | "room1" | "room2" | "room3"
  | "server" | "training" | "general" | "common" | "storage" | "lobby";

export interface Zone extends Rect {
  id: ZoneId;
  label: string;
  floor: number;
  door: { x: number; side: "front" | "back" };
}

export const CORRIDOR_TOP_Z = -12;
export const CORRIDOR_BOTTOM_Z = 5;
export const BASE_HALF_WIDTH = 30;
export const DOOR_W = 2.2;
export let SX = 1;
export let AISLE_X: number[] = [];
export let ZONES: Zone[] = [];
export let ZONE_BY_ID = new Map<ZoneId, Zone>();

type ZoneSpec = Omit<Zone, "x0" | "x1" | "door"> & { x0: number; x1: number; doorX: number; side: "front" | "back" };

const ZONE_SPECS: ZoneSpec[] = [
  { id: "reception", label: L("Phòng tiếp khách"), x0: -30, x1: -13, z0: -24, z1: -13, floor: 0x6f5641, doorX: -16, side: "front" },
  { id: "ceo", label: "", x0: -12.5, x1: 12.5, z0: -24, z1: -13, floor: 0x8b6a4c, doorX: 0, side: "front" },
  { id: "meeting", label: L("Phòng họp"), x0: 13, x1: 30, z0: -24, z1: -13, floor: 0x6f5641, doorX: 16, side: "front" },
  { id: "room1", label: "SERVER", x0: -30, x1: -12, z0: -11, z1: 4, floor: 0xd8cfc0, doorX: -21, side: "front" },
  { id: "room2", label: "WORKSTATION", x0: -9, x1: 9, z0: -11, z1: 4, floor: 0xd8cfc0, doorX: 0, side: "front" },
  { id: "room3", label: "LAPTOP", x0: 12, x1: 30, z0: -11, z1: 4, floor: 0xd8cfc0, doorX: 21, side: "front" },
  { id: "server", label: L("Phòng máy chủ"), x0: -30, x1: -19.5, z0: 6, z1: 17, floor: 0x2a313c, doorX: -28.75, side: "back" },
  { id: "training", label: L("Phòng đào tạo"), x0: -19, x1: -10.5, z0: 6, z1: 17, floor: 0xc6b8a2, doorX: -17.75, side: "back" },
  { id: "general", label: L("Văn phòng chung"), x0: -10, x1: 10, z0: 6, z1: 17, floor: 0xd9d1c4, doorX: 0, side: "back" },
  { id: "common", label: L("Khu sinh hoạt chung"), x0: 10.5, x1: 19.5, z0: 6, z1: 23.5, floor: 0xc6b8a2, doorX: 15, side: "back" },
  { id: "storage", label: L("Kho & thiết bị"), x0: 20, x1: 30, z0: 6, z1: 17, floor: 0xbdb3a3, doorX: 25, side: "back" },
  { id: "lobby", label: "", x0: -6, x1: 6, z0: 17.5, z1: 23.5, floor: 0xe7e2da, doorX: 0, side: "back" },
];

export const MACHINE_ROOMS: { machine: MachineId; zone: ZoneId; accent: number; accentCss: string }[] = [
  { machine: "WORKSTATION", zone: "room2", accent: 0x2f8bff, accentCss: "#2f8bff" },
  { machine: "SERVER", zone: "room1", accent: 0x2fd46b, accentCss: "#2fd46b" },
  { machine: "LAPTOP", zone: "room3", accent: 0xff7a2f, accentCss: "#ff7a2f" },
];

export const OFFICE_DESK_Z = -7.5;
export const TECH_DESK_Z = -2.6;
const NOOK_Z0 = 0.5;
export const SEAT_OFFSET = 0.58;

export interface Seat {
  key: string;
  x: number;
  z: number;
  facing: number;
  lane: { x: number; z: number };
  zone: ZoneId;
}

export function serverNook(room: Rect): Rect {
  const width = Math.max(4.8, Math.min(7.2, (room.x1 - room.x0) * 0.3));
  return { x0: room.x0 + 0.12, x1: room.x0 + width, z0: NOOK_Z0, z1: room.z1 - 0.06 };
}

export function deskX(room: Rect, index: number): number {
  const margin = 1.05;
  const step = (room.x1 - room.x0 - margin * 2) / 7;
  return room.x0 + margin + step * index;
}

export function roleSeat(machine: MachineId, role: RoleId): Seat {
  const roomDef = MACHINE_ROOMS.find((r) => r.machine === machine)!;
  const room = ZONE_BY_ID.get(roomDef.zone)!;
  const def = ROLES.find((r) => r.id === role)!;
  const index = ROLES.filter((r) => r.row === def.row).indexOf(def);
  const deskZ = def.row === "office" ? OFFICE_DESK_Z : TECH_DESK_Z;
  const x = deskX(room, index);
  const z = deskZ + SEAT_OFFSET;
  return { key: `${machine}:${role}`, x, z, facing: Math.PI, lane: { x, z: z + 0.85 }, zone: roomDef.zone };
}

export const SERVER_ROWS_Z = [10.4, 13.6];
export const RACKS_PER_BLOCK = 4;
export const SERVER_WALKWAY = 1.9;
export const SERVER_RIGHT_MARGIN = 0.4;
export const RACK_WIDTH = 0.7;
export const RACK_FRONT = 0.5;
const SERVER_GAP_HALF = 0.7;

export function serverGapX(): number {
  const zone = ZONE_BY_ID.get("server")!;
  return (zone.x0 + SERVER_WALKWAY + zone.x1 - SERVER_RIGHT_MARGIN) / 2;
}
export const TRAINING_ROWS_Z = [10.0, 12.0, 14.0];
export const TRAINING_HOST_Z = 8.3;
export const TRAINING_DESK_DX = 0.6;
export const TRAINING_CHAIR_DZ = 0.7;
export const STORAGE_SCREEN_DX = 4.2;

export interface RackSlot {
  x: number;
  z: number;
  row: number;
  side: -1 | 1;
  index: number;
}

export function serverRackSlots(): RackSlot[] {
  const cx = serverGapX();
  const slots: RackSlot[] = [];
  SERVER_ROWS_Z.forEach((z, row) => {
    for (const side of [-1, 1] as const) {
      for (let index = 0; index < RACKS_PER_BLOCK; index++) slots.push({ x: cx + side * (SERVER_GAP_HALF + RACK_WIDTH / 2 + index * RACK_WIDTH), z, row, side, index });
    }
  });
  return slots;
}

export interface MeetingSpot {
  x: number;
  z: number;
  facing: number;
}

export interface MeetingLayout {
  cx: number;
  tableZ: number;
  len: number;
  chairs: MeetingSpot[];
  head: MeetingSpot;
  presenter: MeetingSpot;
}

export const MEETING_TABLE_Z = -18.6;
const MEETING_CHAIR_DZ = 1.15;
const MEETING_HEAD_GAP = 0.46;
const PRESENTER_DX = 3.5;
const PRESENTER_Z = -21.35;

export function meetingLayout(): MeetingLayout {
  const zone = ZONE_BY_ID.get("meeting")!;
  const cx = (zone.x0 + zone.x1) / 2;
  const len = 8.2 * Math.min(SX, 1.6);
  const n = Math.floor(len / 0.9);
  const chairs: MeetingSpot[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const x = cx - len / 2 + 0.45 + i * (len / n);
    chairs.push({ x, z: MEETING_TABLE_Z - MEETING_CHAIR_DZ, facing: 0 }, { x, z: MEETING_TABLE_Z + MEETING_CHAIR_DZ, facing: Math.PI });
  }
  const head = { x: cx + len / 2 + MEETING_HEAD_GAP, z: MEETING_TABLE_Z, facing: -Math.PI / 2 };
  const px = cx + PRESENTER_DX;
  const presenter = { x: px, z: PRESENTER_Z, facing: Math.atan2(cx + len / 4 - px, MEETING_TABLE_Z - PRESENTER_Z) };
  return { cx, tableZ: MEETING_TABLE_Z, len, chairs, head, presenter };
}

export const ROUND_TABLE_X = [-2.8, 2.8];
export const ROUND_TABLE_Z = 15.0;
export const ROUND_CHAIR_R = 0.9;
export const ROUND_CHAIR_ANGLES = [0, 2.1, 4.2];

export let GENERAL_DESKS: { x: number; z: number }[] = [];
export let GENERAL_SEATS: { x: number; z: number }[] = [];
export type LoungeActivity = "sofa" | "bar" | "pool" | "chat";

export interface LoungeSpot {
  x: number;
  z: number;
  facing: number;
  pose: "lounge" | "stand";
  approach: { x: number; z: number } | null;
  activity: LoungeActivity;
}

export let LOUNGE_SPOTS: LoungeSpot[] = [];
export let QUEUE_SPOTS: { x: number; z: number }[] = [];
export const CEO_DESK = { x: 0, z: -18.2 };

function loungeSpots(x0: number, x1: number): LoungeSpot[] {
  const sofaX = x0 + 2.9;
  const seats: LoungeSpot[] = [-0.825, -0.075, 0.675].map((dx) => ({ x: sofaX + dx, z: 21.55, facing: Math.PI, pose: "lounge", approach: { x: sofaX + dx, z: 20.85 }, activity: "sofa" }));
  seats.push({ x: x0 + 1.05, z: 19.4, facing: Math.PI / 2, pose: "lounge", approach: { x: x0 + 1.75, z: 19.4 }, activity: "sofa" });
  const poolX = x1 - 2.0;
  const pool: LoungeSpot[] = [
    { x: poolX - 1.05, z: 11.0, facing: Math.PI / 2, pose: "stand", approach: null, activity: "pool" },
    { x: poolX + 1.05, z: 11.0, facing: -Math.PI / 2, pose: "stand", approach: { x: poolX + 1.05, z: 8.6 }, activity: "pool" },
    { x: poolX, z: 9.2, facing: 0, pose: "stand", approach: null, activity: "pool" },
  ];
  const bar: LoungeSpot[] = [1.4, 2.6, 3.8].map((dx) => ({ x: x0 + dx, z: 7.5, facing: Math.PI, pose: "stand", approach: null, activity: "bar" }));
  return [seats[0], seats[1], bar[0], bar[1], pool[0], pool[1], seats[2], bar[2], pool[2], seats[3]];
}
const QUEUE_BASE: [number, number][] = [
  [0, -15.9], [-1.4, -15.6], [1.4, -15.6], [-2.8, -15.2], [2.8, -15.2], [-4.2, -14.8], [4.2, -14.8], [0, -14.4],
];

export function configureLayout(halfWidth: number): void {
  SX = Math.max(1, halfWidth / BASE_HALF_WIDTH);
  AISLE_X = [-10.5 * SX, 10.5 * SX];
  ZONES = ZONE_SPECS.map(({ doorX, side, x0, x1, ...rest }) => {
    const keepWidth = rest.id === "lobby";
    return { ...rest, x0: keepWidth ? x0 : x0 * SX, x1: keepWidth ? x1 : x1 * SX, door: { x: keepWidth ? doorX : doorX * SX, side } };
  });
  ZONE_BY_ID = new Map(ZONES.map((z) => [z.id, z]));
  GENERAL_DESKS = [];
  for (const cx of [-6.3 * SX, 6.3 * SX]) {
    for (const dz of [7.9, 11.4]) for (const dx of [-1.95, 0, 1.95]) GENERAL_DESKS.push({ x: cx + dx * Math.min(SX, 1.4), z: dz });
  }
  GENERAL_SEATS = GENERAL_DESKS.map((d) => ({ x: d.x, z: d.z + SEAT_OFFSET }));
  const common = ZONE_BY_ID.get("common")!;
  LOUNGE_SPOTS = loungeSpots(common.x0, common.x1);
  QUEUE_SPOTS = QUEUE_BASE.map(([x, z]) => ({ x: x * Math.min(SX, 1.3), z }));
  configureWalkways();
}

export function zoneOf(x: number, z: number): Zone | undefined {
  return ZONES.find((zn) => x >= zn.x0 && x <= zn.x1 && z >= zn.z0 && z <= zn.z1);
}

export function doorPoint(zone: Zone): { inside: { x: number; z: number }; outside: { x: number; z: number } } {
  const front = zone.door.side === "front";
  const edge = front ? zone.z1 : zone.z0;
  return {
    inside: { x: zone.door.x, z: edge + (front ? -0.9 : 0.9) },
    outside: { x: zone.door.x, z: front ? (zone.z1 < -12 ? CORRIDOR_TOP_Z : CORRIDOR_BOTTOM_Z) : CORRIDOR_BOTTOM_Z },
  };
}

function corridorZ(zone: Zone): number {
  return doorPoint(zone).outside.z;
}

const PLANTER_LANE_X = 3.1;
const PLANTER_SOUTH_Z = 13.3;
const PLANTER_NORTH_Z = 7.0;
const LOBBY_EDGE_Z = 17.0;
const TRAINING_AISLE_DX = -0.55;

type Point = { x: number; z: number };

function laneSide(x: number): number {
  return x < 0 ? -1 : 1;
}

function planterLane(side: number): Point[] {
  return [{ x: side * PLANTER_LANE_X, z: PLANTER_SOUTH_Z }, { x: side * PLANTER_LANE_X, z: PLANTER_NORTH_Z }, { x: 0, z: PLANTER_NORTH_Z }];
}

function interiorPath(zone: Zone, point: Point): Point[] | null {
  if (zone.id === "lobby") return [{ x: 0, z: LOBBY_EDGE_Z }, { x: 0, z: PLANTER_SOUTH_Z }, ...planterLane(laneSide(point.x))];
  if (zone.id === "general" && point.z > PLANTER_SOUTH_Z - 0.5) return [{ x: point.x, z: PLANTER_SOUTH_Z }, ...planterLane(laneSide(point.x))];
  if (zone.id === "training") {
    const x = zone.door.x + TRAINING_AISLE_DX;
    return [{ x, z: point.z }, { x, z: doorPoint(zone).inside.z }];
  }
  return null;
}

function leaveZone(zone: Zone, from: Point, toward: Point): Point[] {
  const door = doorPoint(zone);
  const inner = interiorPath(zone, zone.id === "lobby" ? toward : from);
  if (zone.id === "lobby") return [door.inside, ...(inner ?? []), door.outside];
  if (inner) return [...inner, door.inside, door.outside];
  return [{ x: door.inside.x, z: from.z }, door.inside, door.outside];
}

function enterZone(zone: Zone, to: Point, from: Point): Point[] {
  const door = doorPoint(zone);
  const inner = interiorPath(zone, zone.id === "lobby" ? from : to)?.reverse();
  if (zone.id === "lobby") return [door.outside, ...(inner ?? []), door.inside, { x: door.inside.x, z: to.z }, to];
  if (inner) return [door.outside, door.inside, ...inner, to];
  return [door.outside, door.inside, { x: door.inside.x, z: to.z }, to];
}

function plannedRoute(from: Point, to: Point): Point[] {
  const a = zoneOf(from.x, from.z);
  const b = zoneOf(to.x, to.z);
  if (!a || !b) return [to];
  if (a.id === b.id) {
    if (Math.abs(from.z - to.z) < 0.05) return [to];
    if (a.id === "training") {
      const aisle = a.door.x + TRAINING_AISLE_DX;
      return [{ x: aisle, z: from.z }, { x: aisle, z: to.z }, to];
    }
    if (a.id === "server") {
      const aisle = serverGapX();
      return [{ x: aisle, z: from.z }, { x: aisle, z: to.z }, to];
    }
    if (a.id === "meeting") {
      const room = meetingLayout();
      const aisle = room.cx + room.len / 2 + MEETING_HEAD_GAP;
      return [{ x: aisle, z: from.z }, { x: aisle, z: to.z }, to];
    }
    if (a.id === "general") {
      const departure = interiorPath(a, from);
      const arrival = interiorPath(a, to);
      if (departure || arrival) return [...(departure ?? [{ x: from.x, z: PLANTER_NORTH_Z }]), ...(arrival?.reverse() ?? [{ x: to.x, z: PLANTER_NORTH_Z }]), to];
    }
    return [to];
  }
  const da = doorPoint(a);
  const db = doorPoint(b);
  const pts: Point[] = leaveZone(a, from, to);
  const za = corridorZ(a);
  const zb = corridorZ(b);
  if (za !== zb) {
    const aisle = AISLE_X.reduce((best, x) => (Math.abs(x - (da.outside.x + db.outside.x) / 2) < Math.abs(best - (da.outside.x + db.outside.x) / 2) ? x : best));
    pts.push({ x: aisle, z: za }, { x: aisle, z: zb });
  }
  pts.push(...enterZone(b, to, from));
  return pts;
}

const WALK_CLEARANCE = 0.24;
let walkWalls: Rect[] = [];
let walkNodes: Point[] = [];
let walkEdges: { index: number; distance: number }[][] | null = null;

function configureWalkways(): void {
  walkWalls = [];
  const horizontal = (x0: number, x1: number, z: number, thickness: number, gap: number | null = null) => {
    const spans = gap === null ? [[x0, x1]] : [[x0, gap - DOOR_W / 2], [gap + DOOR_W / 2, x1]];
    for (const [a, b] of spans) if (b > a) walkWalls.push({ x0: a - WALK_CLEARANCE, x1: b + WALK_CLEARANCE, z0: z - thickness / 2 - WALK_CLEARANCE, z1: z + thickness / 2 + WALK_CLEARANCE });
  };
  const vertical = (x: number, z0: number, z1: number, thickness: number) => {
    walkWalls.push({ x0: x - thickness / 2 - WALK_CLEARANCE, x1: x + thickness / 2 + WALK_CLEARANCE, z0: z0 - WALK_CLEARANCE, z1: z1 + WALK_CLEARANCE });
  };
  for (const zone of ZONES) {
    const backDoor = zone.door.side === "back";
    if (zone.id !== "ceo") horizontal(zone.x0, zone.x1, zone.z0, 0.22, backDoor ? zone.door.x : null);
    vertical(zone.x0, zone.z0, zone.z1, 0.18);
    vertical(zone.x1, zone.z0, zone.z1, 0.18);
    if (zone.id !== "ceo" && zone.id !== "lobby") horizontal(zone.x0, zone.x1, zone.z1, 0.1, zone.id === "general" ? 0 : backDoor ? null : zone.door.x);
  }
  for (const room of MACHINE_ROOMS) {
    const nook = serverNook(ZONE_BY_ID.get(room.zone)!);
    horizontal(nook.x0, nook.x1, nook.z0, 0.16);
    vertical(nook.x1, nook.z0, nook.z1 - 1.5, 0.12);
  }
  for (const x of [-3.4, 3.4]) vertical(x, 18.2, 20.6, 0.12);
  const common = ZONE_BY_ID.get("common")!;
  const furniture = (x: number, z: number, width: number, depth: number) => {
    walkWalls.push({ x0: x - width / 2 - WALK_CLEARANCE, x1: x + width / 2 + WALK_CLEARANCE, z0: z - depth / 2 - WALK_CLEARANCE, z1: z + depth / 2 + WALK_CLEARANCE });
  };
  const barX = (common.x0 + common.x1) / 2;
  furniture(barX, 15.2, 2.7, 2.7);
  for (const seat of DRINK_BAR_SEATS) furniture(barX + seat.x, 15.2 + seat.z, 0.48, 0.48);
  furniture(barX, 16.95, 0.62, 0.75);
  furniture(common.x0 + 2.2, 11, 3.5, 2.15);
  furniture(common.x1 - 2, 21.1, 3.35, 2.65);
  furniture(common.x1 - 2, 11, 1.4, 2.6);
  const epsilon = 0.01;
  walkNodes = walkWalls.flatMap((wall) => [
    { x: wall.x0 - epsilon, z: wall.z0 - epsilon }, { x: wall.x0 - epsilon, z: wall.z1 + epsilon },
    { x: wall.x1 + epsilon, z: wall.z0 - epsilon }, { x: wall.x1 + epsilon, z: wall.z1 + epsilon },
  ]).filter((point) => !walkWalls.some((wall) => insideWall(point, wall)));
  walkEdges = null;
}

function insideWall(point: Point, wall: Rect): boolean {
  return point.x > wall.x0 && point.x < wall.x1 && point.z > wall.z0 && point.z < wall.z1;
}

function wallEntry(from: Point, to: Point, wall: Rect): number | null {
  if (Math.max(from.x, to.x) <= wall.x0 || Math.min(from.x, to.x) >= wall.x1 || Math.max(from.z, to.z) <= wall.z0 || Math.min(from.z, to.z) >= wall.z1) return null;
  let low = 0;
  let high = 1;
  for (const [start, delta, min, max] of [[from.x, to.x - from.x, wall.x0, wall.x1], [from.z, to.z - from.z, wall.z0, wall.z1]]) {
    if (Math.abs(delta) < 1e-10) {
      if (start <= min || start >= max) return null;
      continue;
    }
    const a = (min - start) / delta;
    const b = (max - start) / delta;
    low = Math.max(low, Math.min(a, b));
    high = Math.min(high, Math.max(a, b));
    if (low >= high) return null;
  }
  return low < 1 && high > 0 ? Math.max(0, low) : null;
}

export function walkSegmentClear(from: Point, to: Point): boolean {
  return walkWalls.every((wall) => wallEntry(from, to, wall) === null);
}

export function constrainWalk(from: Point, to: Point): Point {
  let fraction = 1;
  for (const wall of walkWalls) {
    const entry = wallEntry(from, to, wall);
    if (entry !== null) fraction = Math.min(fraction, Math.max(0, entry - 1e-5));
  }
  return { x: from.x + (to.x - from.x) * fraction, z: from.z + (to.z - from.z) * fraction };
}

function safeRoute(from: Point, to: Point): Point[] {
  if (walkSegmentClear(from, to)) return [to];
  if (!walkEdges) {
    walkEdges = walkNodes.map(() => []);
    for (let i = 0; i < walkNodes.length; i++) for (let j = i + 1; j < walkNodes.length; j++) {
      if (!walkSegmentClear(walkNodes[i], walkNodes[j])) continue;
      const distance = Math.hypot(walkNodes[i].x - walkNodes[j].x, walkNodes[i].z - walkNodes[j].z);
      walkEdges[i].push({ index: j, distance });
      walkEdges[j].push({ index: i, distance });
    }
  }
  const nodes = [...walkNodes, from, to];
  const start = nodes.length - 2;
  const end = nodes.length - 1;
  const edges = walkEdges.map((list) => [...list]);
  edges.push([], []);
  for (const index of [start, end]) for (let i = 0; i < walkNodes.length; i++) {
    if (!walkSegmentClear(nodes[index], nodes[i])) continue;
    const distance = Math.hypot(nodes[index].x - nodes[i].x, nodes[index].z - nodes[i].z);
    edges[index].push({ index: i, distance });
    edges[i].push({ index, distance });
  }
  const distances = nodes.map(() => Infinity);
  const previous = nodes.map(() => -1);
  const visited = new Set<number>();
  distances[start] = 0;
  while (visited.size < nodes.length) {
    let current = -1;
    for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && (current === -1 || distances[i] < distances[current])) current = i;
    if (current === -1 || !Number.isFinite(distances[current])) break;
    if (current === end) {
      const route: Point[] = [];
      for (let at = end; at !== start; at = previous[at]) route.unshift(nodes[at]);
      return route;
    }
    visited.add(current);
    for (const edge of edges[current]) {
      const distance = distances[current] + edge.distance;
      if (distance >= distances[edge.index]) continue;
      distances[edge.index] = distance;
      previous[edge.index] = current;
    }
  }
  return [];
}

export function routeBetween(from: Point, to: Point): Point[] {
  const route: Point[] = [];
  let cursor = from;
  for (const point of plannedRoute(from, to)) {
    const leg = safeRoute(cursor, point);
    if (leg.length === 0) return safeRoute(from, to);
    route.push(...leg);
    cursor = point;
  }
  return route;
}

configureLayout(BASE_HALF_WIDTH);
