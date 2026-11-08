import assert from "node:assert/strict";
import { test } from "node:test";
import { type JobSpec, parseJobConfig, parseCacheCleanup, parseChangeLog, parseDailyUpdateState, parseGithubSync, parseMacUpdate, parseRepoSync, parseSkillSync, stamp, toJob } from "./automation.ts";

const NOW = Date.parse("2026-11-01T03:20:00Z");

test("local log stamps are read as Vietnam time and ISO stamps as UTC", () => {
  assert.equal(stamp("2026-11-01 10:17:22 | ok | x"), Date.parse("2026-11-01T03:17:22Z"));
  assert.equal(stamp("[2026-11-01 08:23:38] SUMMARY"), Date.parse("2026-11-01T01:23:38Z"));
  assert.equal(stamp("2026-11-01T03:18:24.366Z SKIP"), Date.parse("2026-11-01T03:18:24.366Z"));
  assert.equal(stamp("fatal: repository not found"), null);
});

test("repo sync counts today's pulls and keeps the error text that contains a pipe", () => {
  const log = [
    "2026-10-31 23:59:00 | ok    | PC | Old [main] : keo ve 5",
    "2026-11-01 09:00:00 | ok    | PC | Demo App [main] : keo ve 2",
    "2026-11-01 10:00:00 | ok    | PC | Demo App [main] : keo ve 1",
    "2026-11-01 10:17:20 | error | PC | equipman [work] : behind 1 - CAN NGUOI XU LY | ahead 1 - chua day",
    "2026-11-01 10:17:22 | ok    | PC | quet 45 repo, 7 repo co thay doi",
  ].join("\n");
  const result = parseRepoSync(log, NOW);
  assert.equal(result.status, "error");
  assert.equal(result.figures.pulled, 2);
  assert.match(result.summary, /3 commit ở 1 repo/);
  assert.match(result.summary, /quét 45 repo, 7 repo có thay đổi/);
  assert.ok(result.details.includes("Lỗi: equipman [work] : behind 1 - CAN NGUOI XU LY | ahead 1 - chua day"));
});

test("repo sync errors from an earlier run do not mark the latest run as failed", () => {
  const log = ["2026-11-01 08:00:00 | error | PC | x : broken", "2026-11-01 10:17:22 | ok    | PC | quet 45 repo, 0 repo co thay doi"].join("\n");
  assert.equal(parseRepoSync(log, NOW).status, "ok");
});

test("Mac project sync reports per-repo updates and the last failure count", () => {
  const log = ["2026-11-01T02:41:01.522Z SYNCED demo-app 074f96a7e05", "2026-11-01T03:02:55.944Z SYNCED docs-site c5446b61167", "2026-11-01T03:02:56.000Z SYNCED demo-app a659856af2", "2026-11-01T03:03:11.807Z DONE { updated: 3, skipped: 2, failed: 0 }"].join("\n");
  const result = parseGithubSync(log, NOW);
  assert.equal(result.status, "ok");
  assert.equal(result.figures.pulled, 3);
  assert.deepEqual(result.details, ["Cập nhật demo-app: 2 lần", "Cập nhật docs-site: 1 lần"]);
});

test("DailyUpdate state lists today's winget packages and pending steps", () => {
  const state = JSON.stringify({ status: "Pending", steps: {
    "winget:scan": { status: "Success", time: "2026-11-01T08:17:00+07:00", message: "" },
    "winget:Microsoft.OpenJDK.21": { status: "Success", time: "2026-11-01T08:17:48+07:00", message: "exit=0" },
    "winget:Kingsoft.WPSOffice": { status: "Pending", time: "2026-11-01T08:18:00+07:00", message: "Application is running" },
    npm: { status: "Success", time: "2026-11-01T08:21:55+07:00", message: "exit=0" },
  } });
  const result = parseDailyUpdateState(`﻿${state}`, NOW);
  assert.equal(result.status, "warn");
  assert.equal(result.lastRun, Date.parse("2026-11-01T01:21:55Z"));
  assert.equal(result.figures.updated, 1);
  assert.match(result.summary, /^3\/4 bước thành công, 1 chờ/);
  assert.equal(parseDailyUpdateState("not json", NOW).status, "warn");
});

test("Mac updater reads only the latest run", () => {
  const log = ["[2026-10-31 00:00:00] START auto-update platform=Darwin", "[2026-10-31 00:01:00] FAILED brew upgrade", "[2026-10-31 00:02:00] SUMMARY failures=1 pending=0", "[2026-11-01 06:00:00] START auto-update platform=Darwin", "[2026-11-01 06:00:30] SUCCESS brew update", "[2026-11-01 06:01:08] SUMMARY failures=0 pending=0"].join("\n");
  const result = parseMacUpdate(log, NOW);
  assert.equal(result.status, "ok");
  assert.equal(result.figures.updated, 1);
});

test("cache cleanup understands comma and dot decimals", () => {
  const result = parseCacheCleanup("[2026-11-01 08:23:38] SUMMARY reclaimed=681,8 MB free=214,6 GB failures=0", NOW);
  assert.equal(result.summary, "Lượt gần nhất dọn 682 MB, ổ còn trống 214,6 GB");
  assert.equal(parseCacheCleanup("[2026-11-01 00:30:40] SUMMARY reclaimed=912MB free=47570MB failures=2", NOW).status, "warn");
});

test("skill sync counts today's updates and flags errors in the latest run", () => {
  const log = ["2026-11-01 08:19:55 INSTALLED plugin a 1.0", "2026-11-01 09:30:36 ERROR owner/repo: git ls-remote failed", "fatal: repository not found", "2026-11-01 09:30:50 UPDATED docs-site v2.19.0"].join("\n");
  const result = parseSkillSync(log, NOW);
  assert.equal(result.figures.updated, 2);
  assert.equal(result.status, "warn");
  assert.ok(result.details.includes("Nguồn lỗi: owner/repo"));
});

test("change logs count one install for the Claude and Codex copies", () => {
  const parse = parseChangeLog("bản skill mới");
  const result = parse("2026-11-01 09:30:16 INSTALLED s v1 -> v2 in claude\n2026-11-01 09:30:17 INSTALLED s v1 -> v2 in codex", NOW);
  assert.equal(result.figures.updated, 1);
  assert.equal(result.summary, "Hôm nay có 1 bản skill mới");
});

test("a job that has not run within its window is reported stale, a missing log as missing", () => {
  const spec: JobSpec = { id: "x", name: "X", group: "sync", schedule: "mỗi 15 phút", lastRunLabel: "Chạy gần nhất", staleMs: 3_600_000, file: "", bytes: 1, parse: parseRepoSync };
  assert.equal(toJob(spec, "2026-11-01 07:00:00 | ok | PC | quet 1 repo, 0 repo co thay doi", NOW).status, "stale");
  assert.equal(toJob(spec, null, NOW).status, "missing");
});

test("job config keeps valid entries for the current platform and rejects unknown formats", () => {
  const config = { linux: [
    { id: "backup", name: "Sao lưu", group: "sync", schedule: "02:00", file: "~/logs/backup.log", format: "cache-cleanup", staleHours: 30, maxKb: 64 },
    { id: "notes", name: "Ghi chú", file: "/var/log/notes.log", noun: "ghi chú mới" },
    { id: "bad", name: "Sai định dạng", file: "/x.log", format: "unknown" },
    { name: "Thiếu id", file: "/y.log" },
  ] };
  const specs = parseJobConfig(config, "linux");
  assert.deepEqual(specs.map((spec) => spec.id), ["backup", "notes"]);
  assert.equal(specs[0].staleMs, 30 * 3_600_000);
  assert.equal(specs[0].bytes, 64 * 1024);
  assert.ok(!specs[0].file.startsWith("~"));
  assert.equal(specs[1].group, "update");
  assert.equal(specs[1].staleMs, null);
  assert.deepEqual(parseJobConfig(config, "win32"), []);
  assert.deepEqual(parseJobConfig(null, "linux"), []);
});
