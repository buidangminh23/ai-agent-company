const reducedQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;

export function reducedMotion(): boolean {
  return reducedQuery?.matches ?? false;
}

const GLANCE_HOLD_S = 3.4;

function unitHash(x: number): number {
  const v = Math.sin(x * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

export function glance(t: number, phase: number, reach: number, forward: number): number {
  const slot = Math.floor(t / GLANCE_HOLD_S + phase * 1.7);
  const pick = unitHash(slot + phase * 31.4);
  if (pick < forward) return 0;
  const side = pick < forward + (1 - forward) / 2 ? -1 : 1;
  return side * reach * (0.55 + 0.45 * unitHash(slot * 1.3 + phase * 7.1));
}

export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

export function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + shortestAngle(current, target) * (1 - Math.exp(-lambda * dt));
}

export interface Spring {
  x: number;
  v: number;
}

export function stepSpring(s: Spring, target: number, dt: number, stiffness = 260, damping = 18): void {
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    s.v += (stiffness * (target - s.x) - damping * s.v) * h;
    s.x += s.v * h;
  }
}

export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (u: number) => ((ax * u + bx) * u + cx) * u;
  const sampleY = (u: number) => ((ay * u + by) * u + cy) * u;
  const slopeX = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 6; i++) {
      const err = sampleX(u) - t;
      const d = slopeX(u);
      if (Math.abs(err) < 1e-5 || Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 20 && Math.abs(sampleX(u) - t) > 1e-5; i++) {
      if (sampleX(u) < t) lo = u;
      else hi = u;
      u = (lo + hi) / 2;
    }
    return sampleY(u);
  };
}

export const easeOut = cubicBezier(0.23, 1, 0.32, 1);
export const easeInOut = cubicBezier(0.77, 0, 0.175, 1);
