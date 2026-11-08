import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalPath, collectActivity, writePaths } from "./activity.ts";

const NOW = Date.parse("2026-10-30T12:00:00Z");
const at = (seconds: number) => new Date(NOW + seconds * 1000).toISOString();

test("canonical paths preserve POSIX case and normalize Windows aliases", () => {
  assert.equal(canonicalPath("src/../Main.ts", "C:\\Work Space\\App"), "c:/work space/app/main.ts");
  assert.equal(canonicalPath("src/../Main.ts", "/Users/dev/App"), "/Users/dev/App/Main.ts");
  assert.equal(canonicalPath("/Users/dev/Other.ts", "/Users/dev/App"), "/Users/dev/Other.ts");
  assert.equal(canonicalPath("file.ts", ""), undefined);
});

test("read tools and arbitrary shell commands do not assert file writes", () => {
  assert.deepEqual(writePaths("Read", { file_path: "/work/a.ts" }, "/work"), []);
  assert.deepEqual(writePaths("exec_command", { cmd: "Get-Content a.ts" }, "/work"), []);
  assert.deepEqual(writePaths("Write", "null", "/work"), []);
});

test("structured edits and patch moves include exact paths with spaces", () => {
  assert.deepEqual(writePaths("mcp__filesystem__edit_file", { path: "src/a.ts" }, "/work"), ["/work/src/a.ts"]);
  assert.deepEqual(writePaths("functions.apply_patch", "*** Begin Patch\n*** Update File: folder with space/a.ts\n*** Move to: folder with space/b.ts\n*** End Patch", "/work"), ["/work/folder with space/a.ts", "/work/folder with space/b.ts"]);
});

test("literal exec wrapper patches are parsed without executing code", () => {
  const patch = "*** Begin Patch\n*** Add File: a.ts\n+value\n*** End Patch";
  assert.deepEqual(writePaths("functions.exec", `text(await tools.apply_patch(${JSON.stringify(patch)}));`, "/work"), ["/work/a.ts"]);
  assert.deepEqual(writePaths("functions.exec", "await tools.apply_patch(getUntrustedPatch())", "/work"), []);
});

test("Codex writes reset on a new turn and ignore reads", () => {
  const records = [
    { timestamp: at(-80), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input: "*** Update File: previous.ts" } },
    { timestamp: at(-60), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(-20), type: "response_item", payload: { type: "function_call", name: "Write", arguments: JSON.stringify({ file_path: "current.ts" }) } },
    { timestamp: at(-10), type: "response_item", payload: { type: "function_call", name: "Read", arguments: JSON.stringify({ file_path: "read.ts" }) } },
  ];
  const activity = collectActivity(records, "/work", "codex", NOW);
  assert.deepEqual(activity.files, [{ path: "/work/current.ts", at: at(-20) }]);
  assert.equal(activity.lastActivityAt, at(-10));
});

test("Claude tool results do not clear current writes", () => {
  const records = [
    { timestamp: at(-30), type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] } },
    { timestamp: at(-20), type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
  ];
  assert.deepEqual(collectActivity(records, "/work", "claude", NOW).files, [{ path: "/work/a.ts", at: at(-30) }]);
});

test("old and future file writes do not enter conflict telemetry", () => {
  const records = [-700, 90].map((seconds) => ({ timestamp: at(seconds), type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "a.ts" } }] } }));
  assert.deepEqual(collectActivity(records, "/work", "claude", NOW).files, []);
});

test("native terminal marker is evidence of a turn end, not verified success", () => {
  const records = [{ timestamp: at(-10), type: "event_msg", payload: { type: "task_complete", last_agent_message: "sk-secret-not-to-copy" } }];
  const activity = collectActivity(records, "/work", "codex", NOW);
  assert.equal(activity.outcome?.status, "completed");
  assert.equal(activity.outcome?.verified, false);
  assert.ok(!activity.outcome?.summary.includes("sk-secret"));
  records.push({ timestamp: at(0), type: "event_msg", payload: { type: "task_started", last_agent_message: "" } });
  assert.equal(collectActivity(records, "/work", "codex", NOW).outcome, undefined);
});

test("abort markers do not become completed outcomes", () => {
  const activity = collectActivity([{ timestamp: at(-10), type: "event_msg", payload: { type: "task_aborted" } }], "/work", "codex", NOW);
  assert.equal(activity.outcome?.status, "aborted");
});

test("repeated errors require three distinct explicit failed tool results", () => {
  const result = (id: string) => ({ timestamp: at(-10), type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ exit_code: 1, output: "private stderr" }) } });
  assert.equal(collectActivity([result("a"), result("a"), result("b")], "/work", "codex", NOW).repeatedError, undefined);
  const records = [result("a"), result("b"), result("c")];
  const error = collectActivity(records, "/work", "codex", NOW).repeatedError;
  assert.equal(error?.count, 3);
  assert.equal(error?.summary.includes("private stderr"), false);
  const started = { timestamp: at(0), type: "event_msg", payload: { type: "task_started" } };
  assert.equal(collectActivity([...records, started], "/work", "codex", NOW).repeatedError, undefined);
});

test("error prose does not become structured failure evidence", () => {
  const records = ["a", "b", "c"].map((id) => ({ timestamp: at(-10), type: "response_item", payload: { type: "function_call_output", call_id: id, output: "error function source code" } }));
  assert.equal(collectActivity(records, "/work", "codex", NOW).repeatedError, undefined);
});

test("Claude explicit error results count without retaining output", () => {
  const records = ["a", "b", "c"].map((id) => ({ timestamp: at(-10), type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "private stderr" }] } }));
  assert.equal(collectActivity(records, "/work", "claude", NOW).repeatedError?.count, 3);
});
