import assert from "node:assert/strict";
import { test } from "node:test";
import { describeTool } from "./tools.ts";

test("shell summaries never return command arguments or credentials", () => {
  const detail = describeTool("functions.exec_command", { cmd: "curl https://example.com/private?token=my-secret -H 'Authorization: Bearer abc'", title: "password=secret" });
  assert.equal(detail, "Chạy lệnh");
});

test("safe summaries retain testing and type checking signals", () => {
  assert.equal(describeTool("Bash", { command: "npm run test -- --token=secret" }), "Chạy test");
  assert.equal(describeTool("exec_command", { cmd: "node --test tests/a.test.ts" }), "Chạy test");
  assert.equal(describeTool("exec_command", { cmd: "node node_modules/typescript/bin/tsc --noEmit" }), "Kiểm tra TypeScript (tsc)");
});

test("exec wrappers expose tool labels without source text", () => {
  assert.equal(describeTool("functions.exec", { command: "text(await tools.exec_command({cmd: 'npm test --token=secret'}));" }), "Chạy test");
  assert.equal(describeTool("functions.exec", { command: "text(await tools.exec_command({cmd: 'curl --password secret'}));" }), "Chạy lệnh");
});

test("tool queries are not copied into activity summaries", () => {
  assert.equal(describeTool("mcp__supabase__execute_sql", { query: "select 'secret'" }), "Truy vấn Supabase");
});

test("display titles redact assignment values and access-bearing URLs", () => {
  const detail = describeTool("fetch", { title: "password='multi word secret' token=abc https://user:password@example.com/path-secret?token=abc" });
  assert.equal(detail.includes("multi word"), false);
  assert.equal(detail.includes("path-secret"), false);
  assert.equal(detail.includes("token=abc"), false);
  assert.equal(detail.includes("user:password"), false);
});
