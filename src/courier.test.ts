import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Courier } from "./courier.ts";
import type { AgentInfo, AgentMessage } from "../shared/types.ts";
import type { SeatTarget } from "./agents.ts";
import type { LoungeCue } from "./scene/lounge.ts";
const NOW = Date.parse("2026-11-02T03:00:00Z");
const base: AgentMessage = { id: "m1", fromId: "a", toId: "b", at: new Date(NOW).toISOString(), via: "codex-bridge", summary: "Review task", status: "accepted" };
function stage() {
  return {
    ready: false,
    lines: new Map<string, string>(), cues: new Map<string, LoungeCue>(),
    offset: 10,
    get: (id: string) => ({ id, machine: id === "a" ? "WORKSTATION" : "LAPTOP", role: "backend" } as AgentInfo),
    position: (id: string) => id ? new THREE.Vector3(id === "a" ? 0 : 10, 0, 0) : null,
    meetSpot(id: string, key: string): SeatTarget | null { return id ? { key, x: this.offset, z: 0, facing: 0, pose: "stand", approach: null } : null; },
    arrived() { return this.ready; },
    communicate(cues: Map<string, LoungeCue>, lines: Map<string, string>) { this.cues = cues; this.lines = lines; },
  };
}
test("accepted message visits recipient without inventing an acknowledgement", () => {
  const courier = new Courier(); const actors = stage();
  courier.observe([base], NOW, true);
  assert.equal(courier.pins(actors, NOW).size, 1);
  actors.ready = true;
  courier.pins(actors, NOW + 1000);
  courier.pins(actors, NOW + 5000);
  assert.match(actors.lines.get("a")!, /Đã tiếp nhận/);
  assert.equal(actors.lines.has("b"), false);
});
test("new receipt for same message drives two-way gestures and releases both actors", () => {
  const courier = new Courier(); const actors = stage(); actors.ready = true;
  courier.observe([base], NOW, true); courier.pins(actors, NOW);
  courier.observe([{ ...base, status: "delivered", updatedAt: new Date(NOW + 1000).toISOString() }], NOW + 1000, true);
  courier.pins(actors, NOW + 1000); courier.pins(actors, NOW + 5000);
  assert.equal(actors.cues.get("b")?.speaking, true);
  assert.match(actors.lines.get("b")!, /xác nhận nhận/);
  assert.equal(courier.pins(actors, NOW + 9000).size, 0);
  assert.equal(actors.lines.size, 0);
});
test("offline and failed messages never walk to recipient or show receipt", () => {
  for (const status of ["failed", "sending"] as const) {
    const courier = new Courier(); const actors = stage();
    courier.observe([{ ...base, status }], NOW, true);
    assert.equal(courier.pins(actors, NOW, new Set(), new Set(["LAPTOP"])).size, 0);
    assert.match(actors.lines.get("a")!, /mất kết nối/);
    assert.equal(actors.lines.has("b"), false);
  }
});
test("meeting reservations, replay reset and stale events do not leave stuck visitors", () => {
  const courier = new Courier(); const actors = stage();
  courier.observe([base], NOW, true);
  assert.equal(courier.pins(actors, NOW, new Set(["b"])).size, 0);
  assert.equal(courier.pins(actors, NOW + 1000).size, 1);
  courier.reset(actors);
  courier.observe([base], NOW + 2000, false);
  assert.equal(courier.pins(actors, NOW + 2000).size, 0);
  courier.observe([{ ...base, id: "old" }], NOW + 100000, true);
  assert.equal(courier.pins(actors, NOW + 100000).size, 0);
});
test("a moving recipient updates the destination without holding a stale position", () => {
  const courier = new Courier(); const actors = stage();
  courier.observe([base], NOW, true);
  const first = courier.pins(actors, NOW).get("a")!;
  actors.offset = 20;
  const next = courier.pins(actors, NOW + 1000).get("a")!;
  assert.equal(next.x, 20);
  assert.notEqual(next.key, first.key);
});

test("sender disconnect releases an active visit and clears receiver acknowledgement", () => {
  const courier = new Courier(); const actors = stage(); actors.ready = true;
  courier.observe([{ ...base, status: "delivered" }], NOW, true);
  courier.pins(actors, NOW);
  courier.pins(actors, NOW + 4000);
  assert.equal(actors.cues.get("b")?.speaking, true);
  assert.equal(courier.pins(actors, NOW + 4500, new Set(), new Set(["WORKSTATION"])).size, 0);
  assert.equal(actors.cues.has("b"), false);
  assert.equal(actors.lines.has("b"), false);
  assert.match(actors.lines.get("a")!, /Máy gửi mất kết nối/);
});

test("reset clears delivery gestures and passive observations never replay on reconnect", () => {
  const courier = new Courier(); const actors = stage(); actors.ready = true;
  courier.observe([{ ...base, status: "delivered" }], NOW, true);
  courier.pins(actors, NOW);
  courier.reset(actors);
  assert.equal(actors.cues.size, 0);
  assert.equal(actors.lines.size, 0);
  const reply = { ...base, status: "replied" as const, updatedAt: new Date(NOW + 1000).toISOString() };
  courier.observe([reply], NOW + 1000, false);
  courier.observe([reply], NOW + 2000, true);
  assert.equal(courier.pins(actors, NOW + 2000).size, 0);
  assert.equal(actors.cues.size, 0);
});
