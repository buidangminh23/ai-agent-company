import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentInfo } from "../shared/types.ts";
import { CLAUDE_STOP_MESSAGE, ClaudeHookRegistry, claudeHookSignature } from "./claude-hook.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, "claude-hook", "hook.mjs");
const INSTALL = path.join(HERE, "claude-hook", "install.mjs");
const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const CWD = "/Users/test/Project";
const TOKEN = "a".repeat(64);
const KEY = "7".repeat(64);
const agent = { id: "claude-a", app: "claude", machine: "LAPTOP", parentId: null, sessionId: SESSION, cwd: CWD, state: "working" } as AgentInfo;
const hookInput = (overrides: Record<string, unknown> = {}) => ({ session_id: SESSION, transcript_path: "/x.jsonl", cwd: CWD, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" }, permission_suggestions: null, ...overrides });
const tempHome = () => mkdtempSync(path.join(os.tmpdir(), "msc-claude-hook-"));
const NONCE = "0123456789abcdef0123456789abcdef";
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timeout"); await new Promise((resolve) => setTimeout(resolve, 10)); } };

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

async function hub(agents: AgentInfo[] = [agent]) {
  const home = tempHome();
  const registry = new ClaudeHookRegistry({ machine: "LAPTOP", getLocalAgents: async () => agents, home });
  const { server, port } = await listen((req, res) => { if (!registry.handle(req, res, new URL(req.url ?? "/", "http://hub"))) { res.writeHead(404); res.end(); } });
  const post = (body: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; text: string; signature: string }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/hook/claude/permission", method: "POST", agent: false, headers: { "content-type": "application/json", "x-msc-hook-token": registry.token, "x-msc-hook-nonce": NONCE, ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), signature: String(response.headers["x-msc-hook-signature"] ?? "") }));
    });
    request.on("error", reject);
    request.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  return { home, registry, server, port, post };
}

function runHook(home: string, input: unknown, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const base = { ...process.env };
    delete base.MSC_CLAUDE_HOOK_FILE;
    const child = spawn(process.execPath, [HOOK], { env: { ...base, HOME: home, USERPROFILE: home, MSC_HOOK_RETRY_MS: "40", MSC_HOOK_RETRY_WINDOW_MS: "400", ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

function endpointFile(home: string, port: number, pid = process.pid, token = TOKEN, key: string | null = KEY, file = path.join(home, ".msc-company", "claude-hook.json")) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}/hook/claude/permission`, token, ...(key === null ? {} : { key }), pid, machine: "LAPTOP" }));
}

function signedReply(res: http.ServerResponse, req: http.IncomingMessage, body: unknown, key = KEY) {
  const text = JSON.stringify(body);
  res.writeHead(200, { "content-type": "application/json", "x-msc-hook-signature": claudeHookSignature(key, String(req.headers["x-msc-hook-nonce"]), text) });
  res.end(text);
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

test("registry holds a matching permission request until resolved", async () => {
  const { registry, server, post } = await hub();
  try {
    const pending = post(hookInput({ permission_suggestions: [{ type: "addRules" }] }));
    await until(() => registry.pending(SESSION).length === 1);
    const [entry] = registry.pending(SESSION);
    assert.equal(entry.toolName, "Bash");
    assert.deepEqual(entry.toolInput, { command: "ls" });
    assert.deepEqual(entry.suggestions, [{ type: "addRules" }]);
    assert.equal(entry.cwd, CWD);
    assert.match(entry.id, /^[0-9a-f-]{36}$/);
    assert.equal(registry.resolve(entry.id, { behavior: "deny", message: "no", interrupt: true }), true);
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.text), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "no", interrupt: true } } });
    assert.equal(response.signature, claudeHookSignature(registry.key, NONCE, response.text));
    assert.notEqual(registry.key, registry.token);
    assert.notEqual(response.signature, claudeHookSignature(registry.token, NONCE, response.text));
    assert.equal(registry.pending(SESSION).length, 0);
    assert.equal(registry.resolve(entry.id, { behavior: "allow" }), false);
  } finally { registry.close(); server.close(); }
});

test("registry rejects bad tokens, content types, oversize bodies and unmatched sessions", async () => {
  const { registry, server, post } = await hub([agent, { ...agent, id: "child", parentId: "claude-a" } as AgentInfo]);
  try {
    assert.equal((await post(hookInput(), { "x-msc-hook-token": "b".repeat(64) })).status, 403);
    assert.equal((await post(hookInput(), { origin: "http://evil" })).status, 403);
    assert.equal((await post(hookInput(), { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(hookInput(), { "x-msc-hook-nonce": "" })).status, 400);
    assert.equal((await post(hookInput(), { "x-msc-hook-nonce": "XYZ".repeat(11) })).status, 400);
    assert.equal((await post(hookInput(), { "x-msc-hook-nonce": "a".repeat(31) })).status, 400);
    const oversize = await post({ ...hookInput(), pad: "x".repeat(300 * 1024) }).catch((error: NodeJS.ErrnoException) => { if (error.code === "ECONNRESET") return { status: 413 }; throw error; });
    assert.equal(oversize.status, 413);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post(hookInput({ session_id: "../etc" }))).status, 400);
    assert.equal((await post(hookInput({ session_id: "bbbbbbbb-1111-4111-8111-111111111111" }))).status, 204);
    assert.equal((await post(hookInput({ cwd: "/Users/test/Other" }))).status, 204);
    assert.equal(registry.pending(SESSION).length, 0);
  } finally { registry.close(); server.close(); }
  const duplicate = await hub([agent, { ...agent, id: "claude-b" } as AgentInfo]);
  try { assert.equal((await duplicate.post(hookInput())).status, 204); } finally { duplicate.registry.close(); duplicate.server.close(); }
  const remote = await hub([{ ...agent, machine: "WORKSTATION" } as AgentInfo]);
  try { assert.equal((await remote.post(hookInput())).status, 204); } finally { remote.registry.close(); remote.server.close(); }
});

test("registry drops a pending entry when the hook disconnects", async () => {
  const { registry, server, port } = await hub();
  try {
    const request = http.request({ host: "127.0.0.1", port, path: "/hook/claude/permission", method: "POST", agent: false, headers: { "content-type": "application/json", "x-msc-hook-token": registry.token, "x-msc-hook-nonce": NONCE } });
    request.on("error", () => {});
    request.end(JSON.stringify(hookInput()));
    await until(() => registry.pending(SESSION).length === 1);
    const [entry] = registry.pending(SESSION);
    request.destroy();
    await until(() => registry.pending(SESSION).length === 0);
    assert.equal(registry.resolve(entry.id, { behavior: "allow" }), false);
  } finally { registry.close(); server.close(); }
});

test("stop interrupts pending prompts without leaving a flag, and writes a flag only when nothing was held", async () => {
  const { home, registry, server, post } = await hub();
  const flag = path.join(home, ".msc-company", "claude-control", "stop", SESSION);
  try {
    assert.equal(registry.stop("../bad"), null);
    assert.deepEqual(registry.stop(SESSION), { interrupted: false });
    assert.equal(existsSync(flag), true);
    if (process.platform !== "win32") assert.equal(statSync(flag).mode & 0o777, 0o600);
    const pending = post(hookInput());
    await until(() => registry.pending(SESSION).length === 1);
    assert.deepEqual(registry.stop(SESSION), { interrupted: true });
    assert.equal(existsSync(flag), false);
    const response = await pending;
    assert.deepEqual(JSON.parse(response.text).hookSpecificOutput.decision, { behavior: "deny", message: CLAUDE_STOP_MESSAGE, interrupt: true });
    assert.equal(registry.pending(SESSION).length, 0);
    assert.deepEqual(registry.stop(SESSION), { interrupted: false });
    registry.clearStop(SESSION);
    assert.equal(existsSync(flag), false);
  } finally { registry.close(); server.close(); }
});

test("close drops held hook connections instead of answering and removes its own endpoint file", async () => {
  const { home, registry, server, post, port } = await hub();
  try {
    const file = registry.writeEndpoint({ host: "127.0.0.1", port });
    const written = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(written, { url: `http://127.0.0.1:${port}/hook/claude/permission`, token: registry.token, key: registry.key, pid: process.pid, machine: "LAPTOP" });
    assert.match(registry.token, /^[a-f0-9]{64}$/);
    assert.match(registry.key, /^[a-f0-9]{64}$/);
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(path.join(home, ".msc-company")).mode & 0o777, 0o700);
    }
    assert.equal(JSON.parse(readFileSync(registry.writeEndpoint({ host: "::", port }), "utf8")).url, `http://[::1]:${port}/hook/claude/permission`);
    const pending = post(hookInput()).then(() => "answered", () => "dropped");
    await until(() => registry.pending(SESSION).length === 1);
    registry.close();
    assert.equal(await pending, "dropped");
    assert.equal(registry.pending(SESSION).length, 0);
    assert.equal(existsSync(file), false);
  } finally { server.close(); }
});

test("installed reads hook commands from Claude settings", async () => {
  const home = tempHome();
  let now = 0;
  const registry = new ClaudeHookRegistry({ machine: "LAPTOP", getLocalAgents: async () => [], home, now: () => now });
  assert.deepEqual(registry.installed(), { permission: false, stop: false });
  mkdirSync(path.join(home, ".claude"));
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command: "node \"/h/.msc-company/bin/claude-control-hook.mjs\"" }] }] } }));
  assert.deepEqual(registry.installed(), { permission: false, stop: false });
  now = 6000;
  assert.deepEqual(registry.installed(), { permission: true, stop: false });
  const hook = [{ type: "command", command: "node \"/h/.msc-company/bin/claude-control-hook.mjs\"" }];
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "*", hooks: hook }], PreToolUse: [{ matcher: "*", hooks: hook }] } }));
  now = 12000;
  assert.deepEqual(registry.installed(), { permission: true, stop: false });
  writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "*", hooks: hook }], PreToolUse: [{ matcher: "*", hooks: hook }], UserPromptSubmit: [{ hooks: hook }] } }));
  now = 18000;
  assert.deepEqual(registry.installed(), { permission: true, stop: true });
});

test("hook prints the hub decision on 200 and nothing on 204 or invalid output", async () => {
  const home = tempHome();
  let mode = "decision";
  const seen: { token: string; body: unknown }[] = [];
  const { server, port } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ token: String(req.headers["x-msc-hook-token"]), body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      const decision = { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "ls" } } } };
      seen[seen.length - 1].token += `|${String(req.headers["x-msc-hook-nonce"])}`;
      if (mode === "decision") signedReply(res, req, decision);
      else if (mode === "unsigned") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(decision)); }
      else if (mode === "wrong-key") signedReply(res, req, decision, "d".repeat(64));
      else if (mode === "wrong-body") { res.writeHead(200, { "x-msc-hook-signature": claudeHookSignature(KEY, String(req.headers["x-msc-hook-nonce"]), "{}") }); res.end(JSON.stringify(decision)); }
      else if (mode === "token-signed") signedReply(res, req, decision, String(req.headers["x-msc-hook-token"]));
      else if (mode === "empty") { res.writeHead(204); res.end(); }
      else if (mode === "garbage") { res.writeHead(200); res.end("{oops"); }
      else if (mode === "forged") signedReply(res, req, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", extra: 1 } } });
      else if (mode === "forbidden") { res.writeHead(403); res.end(); }
      else { mode = "decision"; res.writeHead(503); res.end(); }
    });
  });
  try {
    assert.deepEqual(await runHook(home, hookInput()), { code: 0, stdout: "" });
    endpointFile(home, port);
    const first = await runHook(home, hookInput());
    assert.equal(first.code, 0);
    assert.deepEqual(JSON.parse(first.stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "ls" } } } });
    const [sentToken, sentNonce] = seen[0].token.split("|");
    assert.equal(sentToken, TOKEN);
    assert.match(sentNonce, /^[a-f0-9]{32}$/);
    assert.deepEqual(seen[0].body, hookInput());
    for (const value of ["unsigned", "wrong-key", "token-signed", "wrong-body", "empty", "garbage", "forged", "forbidden"]) {
      mode = value;
      assert.deepEqual(await runHook(home, hookInput()), { code: 0, stdout: "" }, value);
    }
    mode = "retry";
    const retried = await runHook(home, hookInput());
    assert.equal(JSON.parse(retried.stdout).hookSpecificOutput.decision.behavior, "allow");
    const nonces = seen.map((entry) => entry.token.split("|")[1]);
    assert.equal(new Set(nonces).size, nonces.length);
    assert.deepEqual(await runHook(home, "{broken"), { code: 0, stdout: "" });
    const sentBefore = seen.length;
    assert.deepEqual(await runHook(home, { ...hookInput(), pad: "x".repeat(300 * 1024) }, { MSC_HOOK_RETRY_WINDOW_MS: "60000" }), { code: 0, stdout: "" });
    assert.equal(seen.length, sentBefore);
  } finally { server.close(); }
});

test("hook leaves once the transcript shows the same call answered in the app, not an earlier identical call", async () => {
  const home = tempHome();
  const transcript = path.join(home, "session.jsonl");
  const input = hookInput({ transcript_path: transcript });
  const toolUse = (id: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: input.tool_name, input: input.tool_input }] } });
  const toolResult = (id: string) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
  writeFileSync(transcript, `${toolUse("toolu_old")}
${toolResult("toolu_old")}
${toolUse("toolu_new")}
`);
  const closed: boolean[] = [];
  let held = 0;
  const { server, port } = await listen((req, res) => { held++; req.resume(); res.once("close", () => closed.push(true)); });
  endpointFile(home, port);
  try {
    let ended = false;
    const run = runHook(home, input, { MSC_HOOK_WATCH_MS: "30", MSC_HOOK_RETRY_WINDOW_MS: "60000" }).then((result) => { ended = true; return result; });
    await until(() => held === 1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(ended, false);
    appendFileSync(transcript, `${toolResult("toolu_new")}
`);
    assert.deepEqual(await run, { code: 0, stdout: "" });
    await until(() => closed.length === 1);
  } finally { server.closeAllConnections(); server.close(); }
});

test("hook gives up quietly when the hub stays unreachable", async () => {
  const home = tempHome();
  const { server, port } = await listen(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  endpointFile(home, port);
  const started = Date.now();
  assert.deepEqual(await runHook(home, hookInput()), { code: 0, stdout: "" });
  assert.ok(Date.now() - started >= 300);
});

test("hook consumes a fresh stop flag once and ignores stale flags", async () => {
  const home = tempHome();
  const dir = path.join(home, ".msc-company", "claude-control", "stop");
  mkdirSync(dir, { recursive: true });
  const flag = path.join(dir, SESSION);
  const pre = hookInput({ hook_event_name: "PreToolUse", tool_input: { command: "ls" } });
  assert.deepEqual(await runHook(home, pre), { code: 0, stdout: "" });
  writeFileSync(flag, "{}");
  const stopped = await runHook(home, pre);
  assert.deepEqual(JSON.parse(stopped.stdout), { continue: false, stopReason: CLAUDE_STOP_MESSAGE, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: CLAUDE_STOP_MESSAGE } });
  assert.equal(existsSync(flag), false);
  assert.deepEqual(await runHook(home, pre), { code: 0, stdout: "" });
  writeFileSync(flag, "{}");
  const old = new Date(Date.now() - 4 * 60 * 1000);
  utimesSync(flag, old, old);
  assert.deepEqual(await runHook(home, pre), { code: 0, stdout: "" });
  assert.equal(existsSync(flag), false);
});

function install(home: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [INSTALL, "--home", home, ...args], { encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
}

test("installer merges hooks idempotently, backs up and uninstalls cleanly", () => {
  const home = tempHome();
  const settingsFile = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settingsFile));
  const original = { model: "opus", permissions: { defaultMode: "bypassPermissions" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo other" }] }], Stop: [{ hooks: [{ type: "command", command: "notify" }] }] } };
  writeFileSync(settingsFile, JSON.stringify(original));
  assert.equal(install(home, "--status").code, 1);
  assert.equal(install(home, "--dry-run").code, 0);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), original);
  const target = path.join(home, ".msc-company", "bin", "claude-control-hook.mjs");
  assert.equal(existsSync(target), false);
  assert.equal(install(home).code, 0);
  assert.equal(readFileSync(target, "utf8"), readFileSync(HOOK, "utf8"));
  const command = `node "${process.platform === "win32" ? target.replace(/\\/g, "/") : target}"`;
  const installed = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(installed.model, "opus");
  assert.deepEqual(installed.permissions, original.permissions);
  assert.deepEqual(installed.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(installed.hooks.PreToolUse, [original.hooks.PreToolUse[0], { matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] }]);
  assert.deepEqual(installed.hooks.PermissionRequest, [{ matcher: "*", hooks: [{ type: "command", command, timeout: 86400 }] }]);
  assert.deepEqual(installed.hooks.UserPromptSubmit, [{ hooks: [{ type: "command", command, timeout: 5 }] }]);
  const backups = () => readdirSync(path.dirname(settingsFile)).filter((name) => name.startsWith("settings.json.bak-msc-"));
  assert.equal(backups().length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(path.dirname(settingsFile), backups()[0]), "utf8")), original);
  assert.match(install(home).out, /không đổi/);
  assert.equal(backups().length, 1);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), installed);
  assert.equal(install(home, "--status").code, 0);
  assert.equal(install(home, "--uninstall").code, 0);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), original);
  assert.equal(existsSync(target), false);
  assert.equal(install(home, "--status").code, 1);
});

test("installer creates settings when missing and refuses broken JSON", () => {
  const home = tempHome();
  assert.equal(install(home).code, 0);
  const created = JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(Object.keys(created.hooks).sort(), ["PermissionRequest", "PreToolUse", "UserPromptSubmit"]);
  const broken = tempHome();
  mkdirSync(path.join(broken, ".claude"));
  writeFileSync(path.join(broken, ".claude", "settings.json"), "{ nope");
  assert.equal(install(broken).code, 2);
  assert.equal(readFileSync(path.join(broken, ".claude", "settings.json"), "utf8"), "{ nope");
});

test("hook keeps retrying across a hub restart and uses the new token", async () => {
  const home = tempHome();
  const fresh = "c".repeat(64);
  const freshKey = "5".repeat(64);
  const tokens: string[] = [];
  const { server, port } = await listen((req, res) => {
    req.resume();
    req.on("end", () => {
      const token = String(req.headers["x-msc-hook-token"]);
      tokens.push(token);
      if (token !== fresh) {
        unlinkSync(path.join(home, ".msc-company", "claude-hook.json"));
        setTimeout(() => endpointFile(home, port, process.pid, fresh, freshKey), 100);
        res.writeHead(502); res.end(); return;
      }
      signedReply(res, req, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Không", interrupt: true } } }, freshKey);
    });
  });
  try {
    endpointFile(home, port);
    const result = await runHook(home, hookInput());
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).hookSpecificOutput.decision, { behavior: "deny", message: "Không", interrupt: true });
    assert.deepEqual([tokens[0], tokens.at(-1)], [TOKEN, fresh]);
  } finally { server.close(); }
});

test("installer refuses malformed hook arrays and keeps the settings file mode", () => {
  const home = tempHome();
  const settingsFile = path.join(home, ".claude", "settings.json");
  mkdirSync(path.dirname(settingsFile));
  writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: { matcher: "*" } } }));
  assert.equal(install(home).code, 2);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { hooks: { PreToolUse: { matcher: "*" } } });
  writeFileSync(settingsFile, JSON.stringify({ env: { A: "1" } }));
  if (process.platform !== "win32") chmodSync(settingsFile, 0o640);
  assert.equal(install(home).code, 0);
  if (process.platform !== "win32") assert.equal(statSync(settingsFile).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")).env, { A: "1" });
  assert.equal(install(home, "--uninstall").code, 0);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), { env: { A: "1" } });
});

test("hook verifies a real registry decision end to end through an overridden endpoint file", async () => {
  const home = tempHome();
  const file = path.join(tempHome(), "nested", "hook.json");
  const registry = new ClaudeHookRegistry({ machine: "LAPTOP", getLocalAgents: async () => [agent], home, endpointFile: file });
  const { server, port } = await listen((req, res) => { if (!registry.handle(req, res, new URL(req.url ?? "/", "http://hub"))) { res.writeHead(404); res.end(); } });
  try {
    assert.equal(registry.writeEndpoint({ host: "127.0.0.1", port }), file);
    assert.equal(existsSync(path.join(home, ".msc-company", "claude-hook.json")), false);
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
    const result = runHook(home, hookInput(), { MSC_CLAUDE_HOOK_FILE: file });
    await until(() => registry.pending(SESSION).length === 1);
    registry.resolve(registry.pending(SESSION)[0].id, { behavior: "allow" });
    assert.deepEqual(JSON.parse((await result).stdout), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    assert.deepEqual(await runHook(home, hookInput(), { MSC_CLAUDE_HOOK_FILE: "relative/hook.json" }), { code: 0, stdout: "" });
    assert.equal(registry.pending(SESSION).length, 0);
  } finally { registry.close(); server.close(); }
  assert.equal(existsSync(file), false);
});

test("hook prints nothing when an impostor without the token answers on the hub port", async () => {
  const home = tempHome();
  const { server, port } = await listen((req, res) => { req.resume(); req.on("end", () => signedReply(res, req, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }, "e".repeat(64))); });
  try {
    endpointFile(home, port);
    assert.deepEqual(await runHook(home, hookInput()), { code: 0, stdout: "" });
  } finally { server.close(); }
});

test("hook treats an endpoint whose pid is dead as hub-down and waits for a live one", async () => {
  const home = tempHome();
  let hits = 0;
  const { server, port } = await listen((req, res) => { req.resume(); req.on("end", () => { hits++; signedReply(res, req, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "x" } } }); }); });
  try {
    endpointFile(home, port, await deadPid());
    const started = Date.now();
    assert.deepEqual(await runHook(home, hookInput()), { code: 0, stdout: "" });
    assert.ok(Date.now() - started >= 300);
    assert.equal(hits, 0);
    endpointFile(home, port, await deadPid());
    const result = runHook(home, hookInput());
    setTimeout(() => endpointFile(home, port), 120);
    assert.equal(JSON.parse((await result).stdout).hookSpecificOutput.decision.message, "x");
    assert.equal(hits, 1);
  } finally { server.close(); }
});

test("a hook held by a closing hub re-registers with the restarted hub", async () => {
  const home = tempHome();
  const first = new ClaudeHookRegistry({ machine: "LAPTOP", getLocalAgents: async () => [agent], home });
  const one = await listen((req, res) => { if (!first.handle(req, res, new URL(req.url ?? "/", "http://hub"))) { res.writeHead(404); res.end(); } });
  const second = new ClaudeHookRegistry({ machine: "LAPTOP", getLocalAgents: async () => [agent], home });
  const two = await listen((req, res) => { if (!second.handle(req, res, new URL(req.url ?? "/", "http://hub"))) { res.writeHead(404); res.end(); } });
  try {
    first.writeEndpoint({ host: "127.0.0.1", port: one.port });
    const result = runHook(home, hookInput(), { MSC_HOOK_RETRY_WINDOW_MS: "3000" });
    await until(() => first.pending(SESSION).length === 1);
    first.close();
    assert.equal(existsSync(path.join(home, ".msc-company", "claude-hook.json")), false);
    assert.equal(await second.ensureEndpoint({ host: "127.0.0.1", port: two.port }), true);
    await until(() => second.pending(SESSION).length === 1);
    second.resolve(second.pending(SESSION)[0].id, { behavior: "deny", message: "Sau khởi động lại" });
    assert.equal(JSON.parse((await result).stdout).hookSpecificOutput.decision.message, "Sau khởi động lại");
  } finally { first.close(); second.close(); one.server.close(); two.server.close(); }
});

test("ensureEndpoint rewrites missing, corrupt, dead, self-reused, EPERM and unprovable owners but never a live registry's", async () => {
  const home = tempHome();
  const file = path.join(home, ".msc-company", "claude-hook.json");
  const registry = new ClaudeHookRegistry({ machine: "LAPTOP", getLocalAgents: async () => [], home, probeTimeoutMs: 400 });
  const address = { host: "127.0.0.1", port: 1111 };
  const owned = () => { const value = JSON.parse(readFileSync(file, "utf8")); return value.token === registry.token && value.key === registry.key; };
  const other = new ClaudeHookRegistry({ machine: "LAPTOP", getLocalAgents: async () => [], home: tempHome() });
  const live = await listen((req, res) => { if (!other.handle(req, res, new URL(req.url ?? "/", "http://hub"))) { res.writeHead(404); res.end(); } });
  const closed = await listen(() => {});
  await new Promise<void>((resolve) => closed.server.close(() => resolve()));
  const nonces: string[] = [];
  const squatter = await listen((req, res) => { req.resume(); const nonce = String(req.headers["x-msc-hook-nonce"]); nonces.push(nonce); res.writeHead(204, { "x-msc-hook-signature": claudeHookSignature(String(req.headers["x-msc-hook-token"]), nonce, "") }); res.end(); });
  const silent = await listen(() => {});
  try {
    assert.equal(await registry.ensureEndpoint(address), true);
    assert.equal(owned(), true);
    const old = new Date(Date.now() - 60000);
    utimesSync(file, old, old);
    const before = statSync(file).mtimeMs;
    assert.equal(await registry.ensureEndpoint(address), true);
    assert.equal(statSync(file).mtimeMs, before);
    const liveFile = { url: `http://127.0.0.1:${live.port}/hook/claude/permission`, token: other.token, key: other.key, pid: process.ppid, machine: "LAPTOP" };
    writeFileSync(file, JSON.stringify(liveFile));
    assert.equal(await registry.ensureEndpoint(address), false);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), liveFile);
    registry.close();
    assert.equal(existsSync(file), true);
    for (const [label, stale] of [
      ["pid reused by this hub", { ...liveFile, pid: process.pid }],
      ["alive pid, nothing listening", { ...liveFile, url: `http://127.0.0.1:${closed.port}/hook/claude/permission` }],
      ["EPERM pid, nothing listening", { ...liveFile, pid: 1, url: `http://127.0.0.1:${closed.port}/hook/claude/permission` }],
      ["signature from the wrong key", { ...liveFile, key: "d".repeat(64) }],
      ["squatter signing with the token", { ...liveFile, url: `http://127.0.0.1:${squatter.port}/hook/claude/permission` }],
      ["listener that never answers", { ...liveFile, url: `http://127.0.0.1:${silent.port}/hook/claude/permission` }],
      ["file without a key", { ...liveFile, key: undefined }],
      ["dead pid", { ...liveFile, pid: await deadPid() }],
    ] as const) {
      writeFileSync(file, JSON.stringify(stale));
      assert.equal(await registry.ensureEndpoint(address), true, label);
      assert.equal(owned(), true, label);
    }
    assert.equal(nonces.length, 1);
    assert.match(nonces[0], /^[a-f0-9]{32}$/);
    writeFileSync(file, "{broken");
    assert.equal(await registry.ensureEndpoint(address), true);
    assert.equal(owned(), true);
    registry.close();
    assert.equal(existsSync(file), false);
  } finally { registry.close(); other.close(); live.server.close(); squatter.server.close(); silent.server.closeAllConnections(); silent.server.close(); }
});

test("registry answers an authenticated liveness probe signed with its private key only", async () => {
  const { registry, server, port } = await hub();
  const probe = (headers: Record<string, string>, method = "GET") => new Promise<{ status: number; signature: string }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/hook/claude/permission", method, agent: false, headers }, (response) => { response.resume(); response.on("end", () => resolve({ status: response.statusCode ?? 0, signature: String(response.headers["x-msc-hook-signature"] ?? "") })); });
    request.on("error", reject);
    request.end();
  });
  try {
    assert.equal((await probe({ "x-msc-hook-nonce": NONCE })).status, 403);
    assert.equal((await probe({ "x-msc-hook-token": registry.token, "x-msc-hook-nonce": NONCE, origin: "http://evil" })).status, 403);
    assert.equal((await probe({ "x-msc-hook-token": registry.token, "x-msc-hook-nonce": "x" })).status, 400);
    assert.equal((await probe({ "x-msc-hook-token": registry.token, "x-msc-hook-nonce": NONCE }, "PUT")).status, 405);
    const ok = await probe({ "x-msc-hook-token": registry.token, "x-msc-hook-nonce": NONCE });
    assert.equal(ok.status, 204);
    assert.equal(ok.signature, claudeHookSignature(registry.key, NONCE, ""));
    assert.equal(registry.pending(SESSION).length, 0);
  } finally { registry.close(); server.close(); }
});

test("hook treats an endpoint file without a valid private key as hub-down and never posts to it", async () => {
  const home = tempHome();
  let hits = 0;
  const { server, port } = await listen((req, res) => { req.resume(); req.on("end", () => { hits++; signedReply(res, req, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }, TOKEN); }); });
  try {
    for (const key of [null, "short", TOKEN]) {
      endpointFile(home, port, process.pid, TOKEN, key);
      assert.deepEqual(await runHook(home, hookInput(), { MSC_HOOK_RETRY_WINDOW_MS: "150" }), { code: 0, stdout: "" }, String(key));
    }
    assert.equal(hits, 0);
  } finally { server.close(); }
});

test("a new owner prompt clears a leftover stop flag so the next turn is not killed", async () => {
  const home = tempHome();
  const dir = path.join(home, ".msc-company", "claude-control", "stop");
  mkdirSync(dir, { recursive: true });
  const flag = path.join(dir, SESSION);
  writeFileSync(flag, "{}");
  assert.deepEqual(await runHook(home, hookInput({ hook_event_name: "UserPromptSubmit", prompt: "tiếp tục" })), { code: 0, stdout: "" });
  assert.equal(existsSync(flag), false);
  assert.deepEqual(await runHook(home, hookInput({ hook_event_name: "PreToolUse", tool_input: { command: "ls" } })), { code: 0, stdout: "" });
  assert.deepEqual(await runHook(home, hookInput({ hook_event_name: "UserPromptSubmit", prompt: "x" })), { code: 0, stdout: "" });
});

test("installer runs when launched through a symlink to its file", { skip: process.platform === "win32" }, () => {
  const home = tempHome();
  const link = path.join(tempHome(), "install-link.mjs");
  symlinkSync(INSTALL, link);
  const result = spawnSync(process.execPath, [link, "--home", home], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Đã cài/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).hooks).sort(), ["PermissionRequest", "PreToolUse", "UserPromptSubmit"]);
});

test("installer upgrades a two-event install and status needs the prompt hook for stop", () => {
  const home = tempHome();
  assert.equal(install(home).code, 0);
  const settingsFile = path.join(home, ".claude", "settings.json");
  const full = JSON.parse(readFileSync(settingsFile, "utf8"));
  const old = structuredClone(full);
  delete old.hooks.UserPromptSubmit;
  writeFileSync(settingsFile, JSON.stringify(old));
  const status = install(home, "--status");
  assert.equal(status.code, 1);
  assert.match(status.out, /Hook dừng lượt: chưa cài/);
  assert.equal(install(home).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, "utf8")), full);
  assert.equal(install(home, "--status").code, 0);
  assert.equal(install(home, "--uninstall").code, 0);
  assert.equal(JSON.parse(readFileSync(settingsFile, "utf8")).hooks, undefined);
});
