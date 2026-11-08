import assert from "node:assert/strict";
import test from "node:test";
import { serviceAttention, systemFresh, SYSTEM_STALE_MS, type BackgroundService, type MachineSystem } from "./system.ts";

test("system health requires a connected machine and a recent inventory", () => {
  const now = Date.parse("2026-11-01T08:00:00Z");
  const machine = { online: true, inventory: { checkedAt: new Date(now).toISOString() } } as MachineSystem;
  assert.equal(systemFresh(machine, now), true);
  assert.equal(systemFresh({ ...machine, online: false }, now), false);
  assert.equal(systemFresh({ ...machine, inventory: null }, now), false);
  assert.equal(systemFresh(machine, now + SYSTEM_STALE_MS + 1), false);
  assert.equal(systemFresh(machine, now - 31_000), false);
  assert.equal(systemFresh({ ...machine, inventory: { ...machine.inventory!, checkedAt: "invalid" } }, now), false);
});

test("stopped and unknown services do not produce false failure alerts", () => {
  for (const state of ["running", "stopped", "unknown"] as const) {
    assert.equal(serviceAttention({ state } as BackgroundService), false);
  }
  assert.equal(serviceAttention({ state: "error" } as BackgroundService), true);
});
