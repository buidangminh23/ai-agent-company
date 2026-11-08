import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationServices, collectSystemInventory, durationSeconds, parseContainers, parseLaunchAgents, parseLinuxServices, parseUnixProcesses, parseWindowsProcesses, parseWindowsServices, ProcessSampler } from "./system.ts";

const NOW = Date.parse("2026-11-01T05:00:00Z");

test("Windows process inventory preserves null counters and excludes PID zero", () => {
  const rows = parseWindowsProcesses(JSON.stringify([{ pid: 0, name: "Idle" }, { pid: 123, name: "C:\\Apps\\node.exe", cpu: null, memory: 1024, start: "2026-11-01T04:00:00Z" }]), NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "node");
  assert.equal(rows[0].cpuSeconds, null);
  assert.equal(rows[0].uptimeSec, 3600);
});

test("CPU uses interval deltas across logical cores and resets on PID reuse", () => {
  const sampler = new ProcessSampler();
  const row = { pid: 8, name: "node", cpuSeconds: 2, memoryBytes: 2048, uptimeSec: 20, identity: "one" };
  assert.equal(sampler.sample([row], NOW, 4)[0].cpuPercent, null);
  assert.equal(sampler.sample([{ ...row, cpuSeconds: 4 }], NOW + 1000, 4)[0].cpuPercent, 50);
  assert.equal(sampler.sample([{ ...row, cpuSeconds: 6, identity: "two" }], NOW + 2000, 4)[0].cpuPercent, null);
  assert.equal(sampler.sample([{ ...row, cpuSeconds: 1, identity: "two" }], NOW + 3000, 4)[0].cpuPercent, null);
});

test("unreadable process start time never guesses CPU from a reused PID", () => {
  const sampler = new ProcessSampler();
  const rows = parseWindowsProcesses('[{"pid":8,"name":"system","cpu":1}]', NOW);
  sampler.sample(rows, NOW, 2);
  assert.equal(sampler.sample([{ ...rows[0], cpuSeconds: 3 }], NOW + 1000, 2)[0].cpuPercent, null);
});

test("Unix parser keeps executable basenames and parses elapsed days and fractional CPU", () => {
  const rows = parseUnixProcesses(" 42 Sun Nov 1 04:00:00 2026 01:00:00 0:00.03 4096 /Applications/Example App.app/Contents/MacOS/Example App\n43 Sat Oct 31 03:00:00 2026 1-02:00:00 01:23:45 20 /usr/bin/python3", NOW);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, "Example App");
  assert.equal(rows[0].memoryBytes, 4194304);
  assert.equal(rows[0].cpuSeconds, 0.03);
  assert.equal(rows[1].uptimeSec, 93600);
  assert.equal(durationSeconds("120"), 120);
});

test("stopped Windows services are normal unless the service reports an exit error", () => {
  const rows = parseWindowsServices(JSON.stringify([
    { Name: "Manual", State: "Stopped", ExitCode: 0, StartMode: "Manual" },
    { Name: "tailscale", DisplayName: "Tailscale", State: "Running", ProcessId: 8 },
    { Name: "failed", State: "Stopped", ExitCode: 5 },
    { Name: "Wecsvc", DisplayName: "Windows Event Collector", State: "Stopped", ExitCode: 1077 },
    { Name: "LGHUBUpdater", DisplayName: "LGHUB Updater Service", State: "Running" },
  ]), [{ pid: 8, name: "tailscale", cpuPercent: 2, memoryBytes: 2048, uptimeSec: 90 }]);
  assert.equal(rows[0].state, "stopped");
  assert.equal(rows[0].important, false);
  assert.equal(rows[1].important, true);
  assert.equal(rows[1].cpuPercent, 2);
  assert.equal(rows[2].state, "error");
  assert.equal(rows[3].state, "stopped");
  assert.equal(rows[3].important, false);
  assert.equal(rows[4].important, false);
});

test("launchctl distinguishes waiting jobs, failed exit and running jobs", () => {
  const signaled = parseLaunchAgents("- -9 com.example.worker\n- -15 com.example.service", []);
  assert.deepEqual(signaled.map((row) => row.state), ["unknown", "unknown"]);
  assert.match(signaled[0].detail, /tín hiệu 9/);
  const rows = parseLaunchAgents("PID Status Label\n- 0 com.example.timer\n- 7 com.ai-agent-company.bad\n22 0 com.ai-agent-company.hub", []);
  assert.deepEqual(rows.map((row) => row.state), ["stopped", "error", "running"]);
  assert.equal(rows[2].important, true);
  const system = parseLaunchAgents("31 0 com.apple.cvmsCompAgent_x86_64\n32 0 com.apple.geodMachServiceBridge\n33 0 com.apple.some.node\n34 0 com.ai-agent-company.codex-mcp-bridge", []);
  assert.deepEqual(system.map((row) => row.important), [false, false, false, true]);
});

test("systemd active, inactive and failed states remain distinct", () => {
  const rows = parseLinuxServices('[{"unit":"tailscaled.service","active":"active","sub":"running"},{"unit":"timer.service","active":"inactive","sub":"dead"},{"unit":"bot.service","active":"failed","sub":"failed"}]', []);
  assert.deepEqual(rows.map((row) => row.state), ["running", "stopped", "error"]);
});

test("Docker errors rely on exit code and health while stopped cleanly stays stopped", () => {
  const create = (status: string, exitCode = 0, health: string | null = null) => JSON.stringify({ id: "a".repeat(64), name: "/my-app", status, exitCode, health, startedAt: "2026-11-01T04:00:00Z" });
  const rows = parseContainers([create("exited"), create("exited", 1), create("running", 0, "unhealthy"), create("running", 0, "healthy"), create("restarting", 1)].join("\n"), NOW);
  assert.deepEqual(rows.map((row) => row.state), ["stopped", "error", "error", "running", "error"]);
  assert.equal(rows[3].name, "my-app");
  assert.equal(rows[3].uptimeSec, 3600);
  assert.equal(rows[0].uptimeSec, null);
});

test("known applications aggregate processes without double counting service PIDs", () => {
  const processes = [1, 2, 3].map((pid) => ({ pid, name: "node", cpuPercent: pid, memoryBytes: 1024, uptimeSec: 40 }));
  const services = parseWindowsServices('[{"Name":"node-service","State":"Running","ProcessId":1}]', processes);
  const apps = applicationServices(processes, services);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].cpuPercent, 5);
  assert.equal(apps[0].memoryBytes, 2048);
  assert.equal(apps[0].pid, null);
  const unrelated = applicationServices(["sshd-session: dev@notty", "XProtectBridgeService", "ViewBridgeAuxiliary", "cvmsCompAgent"].map((name, index) => ({ ...processes[0], pid: index + 20, name })), []);
  assert.equal(unrelated.length, 0);
});

test("failed sources return partial inventory and generic diagnostics without stderr or secrets", async () => {
  const calls: string[] = [];
  const report = await collectSystemInventory("win32", async (file, args) => {
    calls.push(file);
    if (file === "docker") throw Object.assign(new Error("token=secret Docker failure"), { code: 1 });
    if (args.at(-1)?.includes("Get-CimInstance")) throw new Error("secret in service error");
    return '[{"pid":12,"name":"node","cpu":1,"memory":2048,"start":"2026-11-01T04:00:00Z"}]';
  }, new ProcessSampler(), NOW);
  assert.equal(report.processes.length, 1);
  assert.equal(report.services[0].name, "node");
  assert.equal(report.issues.length, 2);
  assert.doesNotMatch(JSON.stringify(report), /token=|secret/);
  assert.equal(calls.length, 3);
});

test("absent Docker is optional and inspect never requests command or environment metadata", async () => {
  const calls: string[][] = [];
  const report = await collectSystemInventory("linux", async (file, args) => {
    calls.push([file, ...args]);
    if (file === "ps") return "12 Sun Nov 1 04:00:00 2026 3600 00:00:01 20 /usr/bin/python3";
    if (file === "systemctl") return "[]";
    if (args[0] === "ps") return "a".repeat(64);
    return JSON.stringify({ id: "a".repeat(64), name: "/app", status: "running", startedAt: "2026-11-01T04:00:00Z", exitCode: 0, health: "healthy" });
  }, new ProcessSampler(), NOW);
  assert.equal(report.issues.length, 0);
  assert.equal(report.services.some((entry) => entry.kind === "container"), true);
  assert.doesNotMatch(calls.find((args) => args[1] === "inspect")!.join(" "), /Config|Env|Cmd|Log|Error/);
  const absent = await collectSystemInventory("linux", async (file) => {
    if (file === "docker") throw Object.assign(new Error("not found"), { code: "ENOENT" });
    return file === "ps" ? "12 Sun Nov 1 04:00:00 2026 3600 00:00:01 20 /usr/bin/python3" : "[]";
  }, new ProcessSampler(), NOW);
  assert.equal(absent.issues.length, 0);
});

test("macOS LaunchAgent resolves Docker outside its minimal PATH and reuses the selected binary", async () => {
  const calls: string[][] = [];
  const report = await collectSystemInventory("darwin", async (file, args) => {
    calls.push([file, ...args]);
    if (file === "ps") return "12 Sun Nov 1 04:00:00 2026 01:00:00 00:00:01 20 /usr/bin/python3";
    if (file === "launchctl") return "PID Status Label";
    if (file !== "/Applications/Docker.app/Contents/Resources/bin/docker") throw Object.assign(new Error("not found"), { code: "ENOENT" });
    if (args[0] === "ps") return "b".repeat(64);
    return JSON.stringify({ id: "b".repeat(64), name: "/mac-app", status: "running", startedAt: "2026-11-01T04:00:00Z", exitCode: 0, health: null });
  }, new ProcessSampler(), NOW);
  assert.equal(report.issues.length, 0);
  assert.equal(report.services.some((entry) => entry.name === "mac-app"), true);
  assert.equal(calls.find((args) => args[1] === "inspect")?.[0], "/Applications/Docker.app/Contents/Resources/bin/docker");
  const absent = await collectSystemInventory("darwin", async (file) => {
    if (file === "ps") return "12 Sun Nov 1 04:00:00 2026 01:00:00 00:00:01 20 /usr/bin/python3";
    if (file === "launchctl") return "PID Status Label";
    throw Object.assign(new Error("not found"), { code: "ENOENT" });
  }, new ProcessSampler(), NOW);
  assert.equal(absent.issues.length, 0);
});
