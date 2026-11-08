import { L } from "../../shared/i18n.ts";
export const CEO_TIMELINE = [
  { state: "typing", duration: 28, label: L("Làm việc trên ba màn hình") },
  { state: "reviewing", duration: 12, label: L("Kiểm tra số liệu") },
  { state: "reading", duration: 16, label: L("Đọc và duyệt hồ sơ") },
  { state: "coffee", duration: 16, label: L("Uống cà phê") },
  { state: "phone", duration: 14, label: L("Trao đổi qua điện thoại") },
  { state: "briefing", duration: 14, label: L("Trao đổi với trợ lý Claude") },
  { state: "stretching", duration: 10, label: L("Giãn vai và cổ tay") },
  { state: "standing", duration: 4, label: L("Đứng dậy kiểm tra") },
  { state: "walking", duration: 20, label: L("Đi kiểm tra văn phòng") },
  { state: "inspecting", duration: 14, label: L("Kiểm tra và ghi chú") },
  { state: "returning", duration: 20, label: L("Quay về bàn làm việc") },
  { state: "massageWalking", duration: 18, label: L("Đi đến ghế massage") },
  { state: "massageSitting", duration: 8, label: L("Ngồi vào ghế massage") },
  { state: "massaging", duration: 24, label: L("Thư giãn trên ghế massage") },
  { state: "massageStanding", duration: 8, label: L("Rời ghế massage") },
  { state: "massageReturning", duration: 18, label: L("Trở lại bàn làm việc") },
  { state: "sitting", duration: 4, label: L("Trở lại ghế") },
  { state: "resting", duration: 14, label: L("Ngả lưng nghỉ ngơi") },
] as const;

export type CeoState = typeof CEO_TIMELINE[number]["state"];
export const CEO_CYCLE_SECONDS = CEO_TIMELINE.reduce((sum, entry) => sum + entry.duration, 0);

export interface CeoTimelineSample {
  state: CeoState;
  label: string;
  time: number;
  duration: number;
  progress: number;
  index: number;
}

export function sampleCeoTimeline(elapsed: number): CeoTimelineSample {
  let time = Number.isFinite(elapsed) ? Math.max(0, elapsed) % CEO_CYCLE_SECONDS : 0;
  for (let index = 0; index < CEO_TIMELINE.length; index++) {
    const entry = CEO_TIMELINE[index];
    if (time < entry.duration || index === CEO_TIMELINE.length - 1) {
      return { ...entry, time, progress: time / entry.duration, index };
    }
    time -= entry.duration;
  }
  return { ...CEO_TIMELINE[0], time: 0, progress: 0, index: 0 };
}

export interface CeoRouteSample {
  x: number;
  z: number;
  yaw: number;
  speed: number;
}

const ROUTE = [[0, -0.45], [3.4, -0.45], [3.4, 2.52], [0, 2.52]] as const;
const MASSAGE_ROUTE = [[0, -0.45], [-3.4, -0.45], [-3.4, 1.1], [-4.35, 1.1]] as const;

function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function angleMix(a: number, b: number, t: number): number {
  return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
}

function sampleRoute(route: readonly (readonly [number, number])[], routeLength: number, progress: number, returning: boolean, endYaw: number): CeoRouteSample {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  let distance = p * routeLength;
  for (let index = 0; index < route.length - 1; index++) {
    const from = route[returning ? route.length - 1 - index : index];
    const to = route[returning ? route.length - 2 - index : index + 1];
    const dx = to[0] - from[0];
    const dz = to[1] - from[1];
    const length = Math.hypot(dx, dz);
    if (distance <= length || index === route.length - 2) {
      const k = Math.max(0, Math.min(1, distance / length));
      const eased = smooth(k);
      const direction = Math.atan2(dx, dz);
      const last = index === route.length - 2;
      const previous = index ? route[returning ? route.length - index : index - 1] : null;
      const previousYaw = previous ? Math.atan2(from[0] - previous[0], from[1] - previous[1]) : returning ? endYaw : 0;
      let yaw = angleMix(previousYaw, direction, smooth(Math.min(1, k / 0.2)));
      if (last && k > 0.8) yaw = angleMix(direction, returning ? 0 : endYaw, smooth((k - 0.8) / 0.2));
      return { x: from[0] + dx * eased, z: from[1] + dz * eased, yaw, speed: Math.min(1, 30 * k * k * (1 - k) * (1 - k)) };
    }
    distance -= length;
  }
  const end = route[returning ? 0 : route.length - 1];
  return { x: end[0], z: end[1], yaw: returning ? 0 : endYaw, speed: 0 };
}

export function sampleCeoRoute(progress: number, returning = false): CeoRouteSample {
  return sampleRoute(ROUTE, 9.77, progress, returning, Math.PI);
}

export function sampleMassageRoute(progress: number, returning = false): CeoRouteSample {
  return sampleRoute(MASSAGE_ROUTE, 5.9, progress, returning, 0);
}

export const MEETING_STEPS = [
  { state: "meetRise", duration: 3.2, label: L("Đứng dậy đi họp") },
  { state: "meetWalk", duration: 0, label: L("Sang phòng họp") },
  { state: "meetSit", duration: 3.2, label: L("Ngồi vào ghế chủ trì") },
  { state: "meetOpen", duration: 6, label: L("Khai mạc cuộc họp") },
  { state: "meetOrder", duration: 12, label: L("Ra lệnh giao việc") },
  { state: "meetListen", duration: 14, label: L("Nghe đội trình bày kế hoạch") },
  { state: "meetApprove", duration: 5, label: L("Duyệt kế hoạch") },
  { state: "meetStand", duration: 3, label: L("Kết thúc cuộc họp") },
  { state: "meetReturn", duration: 0, label: L("Trở lại bàn làm việc") },
] as const;

export type MeetingState = typeof MEETING_STEPS[number]["state"];

export interface MeetingStep {
  state: MeetingState;
  duration: number;
  label: string;
}

export interface MeetingSample extends MeetingStep {
  time: number;
  progress: number;
  index: number;
}

export function meetingSteps(rise: boolean, walk: number, back: number): MeetingStep[] {
  const fixed: Partial<Record<MeetingState, number>> = { meetRise: rise ? MEETING_STEPS[0].duration : 0, meetWalk: walk, meetReturn: back };
  return MEETING_STEPS.map((step) => ({ state: step.state, label: step.label, duration: Math.max(0, fixed[step.state] ?? step.duration) })).filter((step) => step.duration > 0);
}

export function sampleMeeting(steps: MeetingStep[], elapsed: number): MeetingSample | null {
  let time = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (time < step.duration) return { ...step, time, progress: time / step.duration, index };
    time -= step.duration;
  }
  return null;
}

export interface PathPoint {
  x: number;
  z: number;
}

export interface WalkPath {
  points: PathPoint[];
  starts: number[];
  total: number;
  duration: number;
  startYaw: number;
  endYaw: number;
}

export const CEO_WALK_SPEED = 1.5;
const WALK_RAMP_S = 0.8;
const WALK_ACCEL = CEO_WALK_SPEED / WALK_RAMP_S;
const CORNER_BLEND = 0.45;
const END_TURN = 0.6;

function rampOf(total: number): number {
  return Math.min(WALK_RAMP_S, Math.sqrt(total / WALK_ACCEL));
}

export function walkPath(points: PathPoint[], startYaw: number, endYaw: number): WalkPath {
  const clean = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) > 1e-6);
  const starts = [0];
  for (let i = 1; i < clean.length; i++) starts.push(starts[i - 1] + Math.hypot(clean[i].x - clean[i - 1].x, clean[i].z - clean[i - 1].z));
  const total = starts[starts.length - 1];
  const ramp = rampOf(total);
  const peak = WALK_ACCEL * ramp;
  const cruise = peak > 0 ? (total - WALK_ACCEL * ramp * ramp) / peak : 0;
  return { points: clean, starts, total, duration: 2 * ramp + Math.max(0, cruise), startYaw, endYaw };
}

function walkDistance(path: WalkPath, time: number): { distance: number; speed: number } {
  const t = Math.max(0, Math.min(path.duration, time));
  const ramp = rampOf(path.total);
  const peak = WALK_ACCEL * ramp;
  if (t < ramp) return { distance: 0.5 * WALK_ACCEL * t * t, speed: (WALK_ACCEL * t) / CEO_WALK_SPEED };
  const left = path.duration - t;
  if (left < ramp) return { distance: path.total - 0.5 * WALK_ACCEL * left * left, speed: (WALK_ACCEL * left) / CEO_WALK_SPEED };
  return { distance: 0.5 * WALK_ACCEL * ramp * ramp + peak * (t - ramp), speed: peak / CEO_WALK_SPEED };
}

function segmentYaw(path: WalkPath, index: number): number {
  const a = path.points[index];
  const b = path.points[index + 1];
  return Math.atan2(b.x - a.x, b.z - a.z);
}

function travelYaw(path: WalkPath, distance: number, index: number): number {
  const last = path.points.length - 2;
  let yaw = segmentYaw(path, index);
  for (let corner = 1; corner <= last; corner++) {
    const at = path.starts[corner];
    const blend = Math.min(CORNER_BLEND, (at - path.starts[corner - 1]) / 2, (path.starts[corner + 1] - at) / 2);
    if (blend > 0 && Math.abs(distance - at) < blend) yaw = angleMix(segmentYaw(path, corner - 1), segmentYaw(path, corner), smooth((distance - at + blend) / (2 * blend)));
  }
  const startTurn = Math.min(END_TURN, path.starts[1] / 2);
  if (distance < startTurn) yaw = angleMix(path.startYaw, yaw, smooth(distance / startTurn));
  const endTurn = Math.min(END_TURN, (path.total - path.starts[last]) / 2);
  if (path.total - distance < endTurn) yaw = angleMix(yaw, path.endYaw, smooth(1 - (path.total - distance) / endTurn));
  return yaw;
}

export function sampleWalk(path: WalkPath, time: number): CeoRouteSample {
  const first = path.points[0];
  if (path.points.length < 2 || path.total <= 0) return { x: first?.x ?? 0, z: first?.z ?? 0, yaw: path.endYaw, speed: 0 };
  const { distance, speed } = walkDistance(path, Number.isFinite(time) ? time : 0);
  const last = path.points.length - 2;
  let index = 0;
  while (index < last && distance > path.starts[index + 1]) index++;
  const length = path.starts[index + 1] - path.starts[index];
  const k = length > 0 ? Math.max(0, Math.min(1, (distance - path.starts[index]) / length)) : 1;
  const a = path.points[index];
  const b = path.points[index + 1];
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw: travelYaw(path, distance, index), speed: Math.max(0, Math.min(1, speed)) };
}
