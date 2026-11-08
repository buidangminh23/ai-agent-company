import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundService, MachineSystem, SystemReport } from "../shared/system.ts";
import { formatSystemBytes, systemAlerts, systemOverview, systemView, visibleServices } from "./system-view.ts";
import type { SystemViewState } from "./system-view.ts";

const service: BackgroundService = { id: "sync", name: "Syncthing", description: "Đồng bộ tệp", kind: "service", state: "running", pid: 12, cpuPercent: null, memoryBytes: 1024, uptimeSec: 3600, detail: "", important: true };

function machine(): MachineSystem {
  const checkedAt = new Date().toISOString();
  return {
    id: "WORKSTATION", online: true,
    health: { id: "WORKSTATION", online: true, source: "local", cpu: 21, cpuModel: "Processor", cores: 8, memUsed: 1024, memTotal: 4096, netRxBps: null, netTxBps: null, diskUsed: 1024, diskTotal: 8192, gpu: null, os: "Windows", lanIp: null, tailscaleIp: null, uptimeSec: 100, checkedAt },
    inventory: { checkedAt, services: [service], processes: [], issues: [] },
  };
}

function state(entry = machine()): SystemViewState {
  return { report: { generatedAt: new Date().toISOString(), machines: [entry] }, loading: false, error: "", machine: entry.id, section: "background", query: "", filter: "all", allServices: false, processes: false, processQuery: "", processLimit: 40, serviceLimit: 40, automation: { report: null, loading: false, error: "", machine: entry.id } };
}

test("overview only alerts about errors with fresh online evidence", () => {
  const entry = machine();
  entry.inventory!.services = [{ ...service, state: "stopped" }, { ...service, id: "error", state: "error" }];
  const report: SystemReport = { generatedAt: new Date().toISOString(), machines: [entry] };
  assert.equal(systemAlerts(report)[0].count, 1);
  assert.match(systemOverview(report), /data-sys-open="WORKSTATION"/);
  entry.online = false;
  assert.deepEqual(systemAlerts(report), []);
  entry.online = true;
  entry.inventory!.checkedAt = new Date(Date.now() - 130_000).toISOString();
  assert.deepEqual(systemAlerts(report), []);
});

test("default service view includes unimportant errors but omits ordinary OS services", () => {
  const data = [service, { ...service, id: "os", important: false }, { ...service, id: "failed", important: false, state: "error" as const }];
  assert.deepEqual(visibleServices(data, { query: "", filter: "all", allServices: false }).map((entry) => entry.id), ["failed", "sync"]);
  assert.equal(visibleServices(data, { query: "", filter: "all", allServices: true }).length, 3);
  assert.equal(visibleServices(data, { query: "12", filter: "running", allServices: false }).length, 1);
  assert.equal(visibleServices(data, { query: "missing", filter: "all", allServices: true }).length, 0);
});

test("offline data stays labeled historical and does not become current success", () => {
  const entry = machine();
  entry.online = false;
  const html = systemView(state(entry));
  assert.match(html, /Máy đang mất kết nối/);
  assert.match(html, /có thể đã thay đổi/);
  assert.match(html, /Chưa xác nhận hiện tại/);
  assert.doesNotMatch(html, /<strong>21%<\/strong>/);
});

test("unavailable collector inventory is distinguished from an empty healthy inventory", () => {
  const entry = machine();
  entry.inventory = null;
  const html = systemView(state(entry));
  assert.match(html, /Chưa nhận dữ liệu chạy ngầm/);
  assert.doesNotMatch(html, /Không có dịch vụ phù hợp/);
  assert.match(html, /21%/);
});

test("service names, details, issues and search text are escaped", () => {
  const entry = machine();
  entry.inventory!.services = [{ ...service, name: '<img src=x onerror="bad()">', detail: '<script>bad()</script>' }];
  entry.inventory!.issues = ['<svg onload="bad()">'];
  const view = state(entry);
  const html = systemView(view);
  assert.doesNotMatch(html, /<img|<script>|<svg onload/);
  assert.match(html, /&lt;img/);
  view.query = '"><input autofocus>';
  assert.doesNotMatch(systemView(view), /<input autofocus>/);
});

test("expanded process view limits rows and can expose more without losing results", () => {
  const entry = machine();
  entry.inventory!.processes = Array.from({ length: 65 }, (_, index) => ({ name: `proc-${index}`, pid: index, cpuPercent: null, memoryBytes: index * 1024, uptimeSec: null }));
  const view = state(entry);
  view.processes = true;
  assert.match(systemView(view), /Đang hiện 40\/65 tiến trình/);
  view.processLimit = 80;
  assert.match(systemView(view), /Đang hiện 65\/65 tiến trình/);
  view.processQuery = "proc-64";
  assert.match(systemView(view), /Đang hiện 1\/1 tiến trình/);
});

test("byte formatting preserves unavailable and zero as different values", () => {
  assert.equal(formatSystemBytes(null), "—");
  assert.equal(formatSystemBytes(Number.NaN), "—");
  assert.equal(formatSystemBytes(0), "0 B");
  assert.equal(formatSystemBytes(1024 ** 3), "1 GB");
});

test("future health readings are not presented as current resource usage", () => {
  const entry = machine();
  entry.health.checkedAt = new Date(Date.now() + 3_600_000).toISOString();
  const view = state(entry);
  view.section = "resources";
  const html = systemView(view);
  assert.match(html, /Đang chờ số đo mới/);
  assert.doesNotMatch(html, /<strong>21%<\/strong>/);
});
