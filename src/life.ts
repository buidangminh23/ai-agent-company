import type { AgentApp, AgentInfo, MachineId } from "../shared/types.ts";
import type { SeatTarget } from "./agents.ts";
import type { WorkTask } from "./scene/work.ts";
import {
  GENERAL_SEATS, LOUNGE_SPOTS, RACK_FRONT, ROUND_CHAIR_ANGLES, ROUND_CHAIR_R, ROUND_TABLE_X, ROUND_TABLE_Z, STORAGE_SCREEN_DX, SX, TRAINING_CHAIR_DZ, TRAINING_DESK_DX, TRAINING_HOST_Z, TRAINING_ROWS_Z, ZONE_BY_ID,
  serverGapX, serverRackSlots, type LoungeActivity, type ZoneId,
} from "./scene/layout.ts";
import { RACK_REACH } from "./scene/rackwork.ts";

export const LIFE_PREFIX = "life:";
const VISITOR_PREFIX = `${LIFE_PREFIX}reception:`;
const STAFF_PREFIX = `${LIFE_PREFIX}staff:`;
const STAFF_SESSION_S = 15 * 60;
const STAFF_LEAVE_GAP_S = 6;

export function isVisitor(id: string): boolean {
  return id.startsWith(VISITOR_PREFIX) && !id.endsWith(":host");
}

interface StaffSeat {
  key: string;
  spot: Spot;
  title: string;
  project: string;
  extra: Partial<SeatTarget>;
}
const LIFE_APPS: AgentApp[] = ["claude", "codex", "antigravity"];
const LIFE_MACHINE: MachineId = "LAPTOP";
const LIFE_DETAIL = "Hoạt động minh hoạ trong văn phòng, không phải phiên agent thật";
const SEAT_BACK = 0.85;
const SOFA_FRONT = 0.7;
const GUEST_STAY_S = 7 * 60;
const ROUND_STOP_S = 45;
const CARRY_STOP_S = 25;
const COMMON_LOUNGE_INDICES = [2, 3, 4, 5, 6];
const STORAGE_LANE_DX = 4.6;
const STORAGE_LANE_MIN_Z = 8.4;
const RACK_STOP_S = 75;
const TECH_RACKS: [number, -1 | 1, number][] = [[0, -1, 3], [1, 1, 3], [0, 1, 0], [1, -1, 0]];
const CEO_FRONT_Z = -16.4;
const PERSONAL_PROJECT = "Văn phòng chung";
const PERSONAL_TASK_S = 140;
const PERSONAL_DESK_BACK = 0.85;
const PERSONAL_TASKS = [
  "Sắp lịch học tuần này", "Dọn hộp thư cá nhân", "Theo dõi chi tiêu tháng", "Ôn bài môn học",
  "Ghi chú ý tưởng mới", "Đặt lịch hẹn", "Sắp xếp tài liệu cá nhân", "Cập nhật việc cần làm",
];
const PERSONAL_TABLE_SEATS = [0, 1];
const STAFF_TRAINING_SEATS = [0, 3, 4, 7, 9, 10, 13, 16];

type Pose = SeatTarget["pose"];

interface Spot {
  x: number;
  z: number;
  facing: number;
  pose: Pose;
  approach: { x: number; z: number } | null;
}

interface Member {
  id: string;
  app?: AgentApp;
  title: string;
  project: string;
  target: SeatTarget;
}

export interface LifeCrew {
  agents: AgentInfo[];
  pins: Map<string, SeatTarget>;
}

function hashOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

function zone(id: ZoneId) {
  return ZONE_BY_ID.get(id)!;
}

function centerX(id: ZoneId): number {
  const z = zone(id);
  return (z.x0 + z.x1) / 2;
}

function chair(x: number, z: number, facing: number): Spot {
  return { x, z, facing, pose: "sit", approach: { x: x - Math.sin(facing) * SEAT_BACK, z: z - Math.cos(facing) * SEAT_BACK } };
}

function couch(x: number, z: number, facing: number): Spot {
  return { x, z, facing, pose: "lounge", approach: { x: x + Math.sin(facing) * SOFA_FRONT, z: z + Math.cos(facing) * SOFA_FRONT } };
}

function stand(x: number, z: number, facing: number, approach: { x: number; z: number } | null = null): Spot {
  return { x, z, facing, pose: "stand", approach };
}

function tenure(nowS: number, period: number, seed: string): number {
  return Math.floor(nowS / period + (hashOf(seed) % 1000) / 1000);
}

function target(key: string, spot: Spot, extra: Partial<SeatTarget> = {}): SeatTarget {
  return { key, ...spot, ...extra };
}

function talk(id: string): { circle: { id: string; activity: LoungeActivity } } {
  return { circle: { id, activity: "chat" } };
}

function rotatingSeats(prefix: string, project: string, title: string, seats: Spot[], used: number[], stayS: number, nowS: number, extra: (i: number) => Partial<SeatTarget>): Member[] {
  return used.map((seatIndex) => {
    const seed = `${prefix}:${seatIndex}`;
    const visit = tenure(nowS, stayS, seed);
    return { id: `${LIFE_PREFIX}${seed}:${visit}`, title, project, target: target(`${prefix}:${seatIndex}`, seats[seatIndex], extra(seatIndex)) };
  });
}

function patrol(id: string, project: string, title: string, stops: Spot[], stopS: number, nowS: number, task: WorkTask): Member {
  const step = tenure(nowS, stopS, id) % stops.length;
  return { id: `${LIFE_PREFIX}${id}`, title, project, target: target(`${id}:${step}`, stops[step], { task }) };
}

function trainingChairs(): Spot[] {
  const cx = centerX("training") + TRAINING_DESK_DX;
  const seats: Spot[] = [];
  for (const dz of TRAINING_ROWS_Z) for (const dx of [-2.2, 0, 2.2]) for (const side of [-0.4, 0.4]) seats.push(chair(cx + dx + side, dz + TRAINING_CHAIR_DZ, Math.PI));
  return seats;
}

function trainingSeats(): StaffSeat[] {
  const seats = trainingChairs();
  return STAFF_TRAINING_SEATS.map((i) => ({ key: `training:${i}`, spot: seats[i], title: "Học skill mới", project: "Phòng đào tạo", extra: { task: "learn" as const } }));
}

export function traineeSeats(): SeatTarget[] {
  return trainingChairs().flatMap((spot, i) => (STAFF_TRAINING_SEATS.includes(i) ? [] : [target(`training:${i}`, spot, { task: "learn" })]));
}

function rotatingStaff(nowS: number): Member[] {
  const seats = trainingSeats();
  const slots = seats.length;
  const people = slots - 1;
  const members: Member[] = [];
  for (let k = 0; k < people; k++) {
    const moves = Math.floor((nowS + k * STAFF_LEAVE_GAP_S) / STAFF_SESSION_S);
    const seat = seats[(k + moves) % slots];
    members.push({ id: `${STAFF_PREFIX}${k}`, title: seat.title, project: seat.project, target: target(seat.key, seat.spot, seat.extra) });
  }
  return members;
}

function training(): Member[] {
  const cx = centerX("training") + TRAINING_DESK_DX;
  return [{ id: `${LIFE_PREFIX}training:host`, app: "claude", title: "Giảng bài về skill", project: "Phòng đào tạo", target: target("training:host", stand(cx, TRAINING_HOST_Z, 0), { task: "teach" }) }];
}

function reception(nowS: number): Member[] {
  const cx = centerX("reception");
  const seats: Spot[] = [
    couch(cx - 0.675, -20.35, 0), couch(cx + 0.075, -20.35, 0), couch(cx + 0.825, -20.35, 0),
    couch(cx - 3.25, -18.0, Math.PI / 2), couch(cx - 3.25, -18.75, Math.PI / 2),
    couch(cx + 3.25, -18.6, -Math.PI / 2), couch(cx + 3.25, -17.85, -Math.PI / 2),
  ];
  const people = rotatingSeats("reception", "Phòng tiếp khách", "Khách tới làm việc", seats, [0, 2, 3, 6], GUEST_STAY_S, nowS, () => talk("reception"));
  people.push({ id: `${LIFE_PREFIX}reception:host`, title: "Tiếp khách", project: "Phòng tiếp khách", target: target("reception:host", stand(cx + 0.2, -16.7, Math.PI), talk("reception")) });
  return people;
}

function personal(nowS: number, taken: Set<string>): Member[] {
  const busy = new Set([...taken].flatMap((key) => {
    const match = /^general:(\d+)$/.exec(key);
    return match ? [Number(match[1]) % GENERAL_SEATS.length] : [];
  }));
  const desks = GENERAL_SEATS.flatMap((seat, i) => {
    if (busy.has(i)) return [];
    const task = PERSONAL_TASKS[(tenure(nowS, PERSONAL_TASK_S, `personal:${i}`) + i) % PERSONAL_TASKS.length];
    const spot: Spot = { x: seat.x, z: seat.z, facing: Math.PI, pose: "sit", approach: { x: seat.x, z: seat.z + PERSONAL_DESK_BACK } };
    return [{ id: `${LIFE_PREFIX}personal:${i}`, title: task, project: PERSONAL_PROJECT, target: target(`personal:${i}`, spot, { task: "type" as const }) }];
  });
  const tables = ROUND_TABLE_X.flatMap((tx, t) => PERSONAL_TABLE_SEATS.map((k) => {
    const a = ROUND_CHAIR_ANGLES[k];
    const spot = chair(tx + Math.cos(a) * ROUND_CHAIR_R, ROUND_TABLE_Z + Math.sin(a) * ROUND_CHAIR_R, -a - Math.PI / 2);
    return { id: `${LIFE_PREFIX}personal:table:${t}:${k}`, title: "Bàn kế hoạch cá nhân", project: PERSONAL_PROJECT, target: target(`personal:table:${t}:${k}`, spot, talk(`personal:table:${t}`)) };
  }));
  return [...desks, ...tables];
}

function common(): Member[] {
  const z = zone("common");
  return COMMON_LOUNGE_INDICES.filter((i) => i < LOUNGE_SPOTS.length).map((index, k) => {
    const spot = LOUNGE_SPOTS[index];
    const alt = target(`common:alt:${k}`, stand(z.x0 + 1.2 + k * 0.85, 13, Math.PI), talk("common:standing"));
    return {
      id: `${LIFE_PREFIX}common:${index}`,
      title: spot.activity === "pool" ? "Chơi bi-a giải lao" : spot.activity === "bar" ? "Pha cà phê" : "Nghỉ giải lao",
      project: "Khu sinh hoạt chung",
      target: { key: `lounge:${index}`, x: spot.x, z: spot.z, facing: spot.facing, pose: spot.pose, approach: spot.approach, alt },
    };
  });
}

function storage(nowS: number): Member[] {
  const z = zone("storage");
  const x0 = z.x0;
  const lane = (x: number, zz: number, facing: number) => stand(x, zz, facing, { x: x0 + STORAGE_LANE_DX, z: Math.max(zz, STORAGE_LANE_MIN_Z) });
  const routeA = [lane(x0 + 1.6, 7.3, Math.PI), lane(x0 + 2.4, 14.4, Math.PI), lane(x0 + STORAGE_SCREEN_DX + 1.6, 11.6, 0), lane(x0 + 4.8, 12.7, Math.PI / 2)];
  const routeB = [lane(x0 + 6.2, 14.6, 0), lane(z.x1 - 1.3, 11.0, Math.PI / 2), lane(x0 + 6.8, 7.3, Math.PI), lane(x0 + 3.2, 14.4, Math.PI)];
  return [
    patrol("storage:a", "Kho & thiết bị", "Xếp thiết bị lên kệ", routeA, CARRY_STOP_S, nowS, "carry"),
    patrol("storage:b", "Kho & thiết bị", "Kiểm kê thùng hàng", routeB, CARRY_STOP_S + 7, nowS, "carry"),
  ];
}

function server(nowS: number): Member[] {
  const cx = serverGapX();
  const slots = serverRackSlots();
  const stops = TECH_RACKS.map(([row, side, index]) => {
    const slot = slots.find((s) => s.row === row && s.side === side && s.index === index)!;
    const z = slot.z + RACK_FRONT + RACK_REACH;
    return stand(slot.x, z, Math.PI, { x: cx, z });
  });
  return [patrol("server:tech", "Phòng máy chủ", "Bảo trì tủ rack", stops, RACK_STOP_S, nowS, "rack")];
}

function lobby(): Member[] {
  return [{ id: `${LIFE_PREFIX}lobby:guard`, title: "Trực cổng sảnh", project: "Sảnh", target: target("lobby:guard", stand(4.4, 19.8, -Math.PI / 2), { task: "inspect" }) }];
}

function ceo(nowS: number): Member[] {
  const shelf = 12.5 * SX - 0.4;
  const front = (x: number, zz: number, facing: number) => stand(x, zz, facing, { x, z: CEO_FRONT_Z });
  const stops = [front(-shelf + 0.8, -19.6, -Math.PI / 2), front(3.6, -18.2, -Math.PI / 2), front(shelf - 0.8, -19.6, Math.PI / 2), front(-3.6, -18.2, Math.PI / 2)];
  return [{ ...patrol("ceo:assistant", "Văn phòng CEO", "Chuẩn bị hồ sơ cho sếp", stops, ROUND_STOP_S + 15, nowS, "inspect"), app: "claude" }];
}

function toAgent(m: Member, at: string): AgentInfo {
  const app = m.app ?? LIFE_APPS[hashOf(m.id) % LIFE_APPS.length];
  return { id: m.id, app, machine: LIFE_MACHINE, title: m.title, project: m.project, role: null, state: "working", detail: LIFE_DETAIL, parentId: null, updatedAt: at, pending: null };
}

export function buildLife(nowMs: number, at: string, taken: Set<string> = new Set()): LifeCrew {
  const nowS = nowMs / 1000;
  const members = [...rotatingStaff(nowS), ...training(), ...reception(nowS), ...personal(nowS, taken), ...common(), ...storage(nowS), ...server(nowS), ...lobby(), ...ceo(nowS)];
  return { agents: members.map((m) => toAgent(m, at)), pins: new Map(members.map((m) => [m.id, m.target])) };
}
