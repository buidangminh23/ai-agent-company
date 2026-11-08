import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, statSync, unlinkSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ENGLISH = process.env.MSC_LANG ? !process.env.MSC_LANG.toLowerCase().startsWith("vi") : !process.env.NODE_TEST_CONTEXT;
const STOP_MESSAGE = ENGLISH ? "You stopped this turn from the company dashboard" : "Sếp đã dừng lượt này từ web công ty";
const STOP_MAX_AGE_MS = 3 * 60 * 1000;
const RETRY_MS = Number(process.env.MSC_HOOK_RETRY_MS) > 0 ? Number(process.env.MSC_HOOK_RETRY_MS) : 3000;
const RETRY_WINDOW_MS = Number(process.env.MSC_HOOK_RETRY_WINDOW_MS) > 0 ? Number(process.env.MSC_HOOK_RETRY_WINDOW_MS) : 10 * 60 * 1000;
const INPUT_LIMIT = 4 * 1024 * 1024;
const HUB_BODY_LIMIT = 256 * 1024;
const WATCH_MS = Number(process.env.MSC_HOOK_WATCH_MS) > 0 ? Number(process.env.MSC_HOOK_WATCH_MS) : 2000;
const TRANSCRIPT_TAIL = 2 * 1024 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,200}$/;
const HOOK_PATH = "/hook/claude/permission";
const SECRET = /^[a-f0-9]{64}$/;

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const home = () => os.homedir();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(output) {
  if (output === undefined) process.exit(0);
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => { size += chunk.length; if (size <= INPUT_LIMIT) chunks.push(chunk); });
    process.stdin.once("end", () => resolve(size <= INPUT_LIMIT ? Buffer.concat(chunks).toString("utf8") : ""));
    process.stdin.once("error", () => resolve(""));
  });
}

const flagFile = (sessionId) => path.join(home(), ".msc-company", "claude-control", "stop", sessionId);
const endpointFile = () => process.env.MSC_CLAUDE_HOOK_FILE && path.isAbsolute(process.env.MSC_CLAUDE_HOOK_FILE) ? process.env.MSC_CLAUDE_HOOK_FILE : path.join(home(), ".msc-company", "claude-hook.json");

function clearFlag(sessionId) {
  if (!SESSION.test(sessionId)) return;
  try { if (!lstatSync(flagFile(sessionId)).isDirectory()) unlinkSync(flagFile(sessionId)); } catch {}
}

function gone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
}

function stopFlag(sessionId) {
  if (!SESSION.test(sessionId)) return false;
  const file = flagFile(sessionId);
  let entry;
  try { entry = lstatSync(file); } catch { return false; }
  const fresh = entry.isFile() && Date.now() - entry.mtimeMs <= STOP_MAX_AGE_MS && entry.mtimeMs - Date.now() <= 60 * 1000;
  try { unlinkSync(file); } catch { return false; }
  return fresh;
}

function endpoint() {
  try {
    const value = record(JSON.parse(readFileSync(endpointFile(), "utf8")));
    if (!value || typeof value.url !== "string" || typeof value.token !== "string" || !SECRET.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    const url = new URL(value.url);
    if (url.protocol !== "http:" || url.pathname !== HOOK_PATH || url.username || url.password) return null;
    const key = typeof value.key === "string" && SECRET.test(value.key) && value.key !== value.token ? value.key : null;
    return { url, token: value.token, key, down: !key || gone(value.pid) };
  } catch { return null; }
}

function validDecision(value) {
  const decision = record(value);
  if (!decision) return false;
  if (decision.behavior === "allow") return Object.keys(decision).every((key) => ["behavior", "updatedInput", "updatedPermissions"].includes(key)) && (decision.updatedInput === undefined || record(decision.updatedInput) !== null) && (decision.updatedPermissions === undefined || Array.isArray(decision.updatedPermissions));
  if (decision.behavior === "deny") return Object.keys(decision).every((key) => ["behavior", "message", "interrupt"].includes(key)) && typeof decision.message === "string" && decision.message.length > 0 && (decision.interrupt === undefined || typeof decision.interrupt === "boolean");
  return false;
}

function signed(key, nonce, body, signature) {
  if (typeof key !== "string" || !SECRET.test(key) || typeof signature !== "string" || !SECRET.test(signature)) return false;
  const expected = createHmac("sha256", key).update(`${nonce}\n`).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function hubOutput(text) {
  try {
    const value = record(JSON.parse(text));
    const specific = record(value?.hookSpecificOutput);
    if (!value || Object.keys(value).length !== 1 || !specific || specific.hookEventName !== "PermissionRequest" || Object.keys(specific).length !== 2 || !validDecision(specific.decision)) return undefined;
    return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: specific.decision } };
  } catch { return undefined; }
}

function post(target, body) {
  const nonce = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    const request = http.request(target.url, { method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-msc-hook-token": target.token, "x-msc-hook-nonce": nonce } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size <= RESPONSE_LIMIT) chunks.push(chunk); });
      response.once("end", () => {
        const raw = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 0, text: size <= RESPONSE_LIMIT && signed(target.key, nonce, raw, response.headers["x-msc-hook-signature"]) ? raw.toString("utf8") : "" });
      });
      response.once("error", () => resolve({ status: 0, text: "" }));
      response.once("aborted", () => resolve({ status: 0, text: "" }));
    });
    request.once("error", () => resolve({ status: 0, text: "" }));
    request.end(body);
  });
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const item = record(value);
  return item ? `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stable(item[key])}`).join(",")}}` : JSON.stringify(value) ?? "null";
}

function readRange(file, start, end) {
  const buffer = Buffer.alloc(Math.max(0, end - start));
  const fd = openSync(file, "r");
  try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
  return buffer.toString("utf8");
}

function callIdIn(text, toolName, wanted) {
  const ids = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes(toolName) || !line.includes('"tool_use"')) continue;
    let content;
    try { content = record(record(JSON.parse(line))?.message)?.content; } catch { continue; }
    for (const part of Array.isArray(content) ? content : []) if (part?.type === "tool_use" && part.name === toolName && typeof part.id === "string" && stable(part.input) === wanted) ids.push(part.id);
  }
  return ids.reverse().find((id) => !text.includes(`"tool_use_id":"${id}"`)) ?? null;
}

function answeredInApp(input) {
  const file = typeof input?.transcript_path === "string" && path.isAbsolute(input.transcript_path) ? input.transcript_path : "";
  if (!file || typeof input.tool_name !== "string") return () => false;
  const wanted = stable(input.tool_input);
  let id = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : null;
  let offset = -1;
  return () => {
    const size = statSync(file).size;
    const start = offset < 0 ? Math.max(0, size - TRANSCRIPT_TAIL) : offset;
    const text = readRange(file, start, size);
    if (!id) {
      id = callIdIn(text, input.tool_name, wanted);
      if (!id) return false;
      offset = Math.max(start, size - 256);
      return false;
    }
    offset = Math.max(start, size - 256);
    return text.includes(`"tool_use_id":"${id}"`);
  };
}

async function permission(body, input) {
  if (Buffer.byteLength(body) > HUB_BODY_LIMIT) return undefined;
  const answered = answeredInApp(input);
  setInterval(() => { try { if (answered()) finish(undefined); } catch {} }, WATCH_MS);
  let failingSince = 0;
  for (;;) {
    const target = endpoint();
    if (!target && !failingSince) return undefined;
    const result = target && !target.down ? await post(target, body) : { status: 0, text: "" };
    if (result.status === 200) return hubOutput(result.text);
    if (result.status >= 200 && result.status < 500) return undefined;
    failingSince ||= Date.now();
    if (Date.now() - failingSince >= RETRY_WINDOW_MS) return undefined;
    await wait(RETRY_MS);
  }
}

async function main() {
  const text = await readStdin();
  let input;
  try { input = record(JSON.parse(text)); } catch { input = null; }
  if (!input || typeof input.session_id !== "string") return undefined;
  if (input.hook_event_name === "PreToolUse") return stopFlag(input.session_id) ? { continue: false, stopReason: STOP_MESSAGE, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: STOP_MESSAGE } } : undefined;
  if (input.hook_event_name === "PermissionRequest") return permission(text, input);
  if (input.hook_event_name === "UserPromptSubmit") clearFlag(input.session_id);
  return undefined;
}

process.on("uncaughtException", () => process.exit(0));
process.on("unhandledRejection", () => process.exit(0));
main().then(finish, () => process.exit(0));
