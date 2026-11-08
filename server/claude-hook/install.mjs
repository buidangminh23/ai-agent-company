import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENGLISH = process.env.MSC_LANG ? !process.env.MSC_LANG.toLowerCase().startsWith("vi") : !process.env.NODE_TEST_CONTEXT;
const t = (vi, en) => (ENGLISH ? en : vi);
const MARKER = "claude-control-hook.mjs";
const EVENTS = { PermissionRequest: 86400, PreToolUse: 5, UserPromptSubmit: 5 };
const UNMATCHED_EVENTS = new Set(["UserPromptSubmit"]);

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
const ours = (hook) => typeof record(hook)?.command === "string" && hook.command.includes(MARKER);

function parseArgs(argv) {
  const options = { dryRun: false, uninstall: false, status: false, home: os.homedir() };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--uninstall") options.uninstall = true;
    else if (arg === "--status") options.status = true;
    else if (arg === "--home" && argv[index + 1]) options.home = path.resolve(argv[++index]);
    else throw new Error(t(`Tham số không hợp lệ: ${arg}`, `Invalid argument: ${arg}`));
  }
  return options;
}

export function hookCommand(file, node = "node") {
  return `${node === "node" ? node : `"${node}"`} "${process.platform === "win32" || /^[a-z]:\\/i.test(file) ? file.replace(/\\/g, "/") : file}"`;
}

export function stableNode(home, exists = existsSync) {
  const alias = path.join(home, ".local", "share", "fnm", "aliases", "default", "bin", "node");
  return process.platform !== "win32" && exists(alias) ? alias : "node";
}

function withoutOurs(groups) {
  return (Array.isArray(groups) ? groups : []).flatMap((group) => {
    const value = record(group);
    if (!value || !Array.isArray(value.hooks) || !value.hooks.some(ours)) return [group];
    const hooks = value.hooks.filter((hook) => !ours(hook));
    return hooks.length ? [{ ...value, hooks }] : [];
  });
}

export function mergeSettings(settings, command, uninstall = false) {
  const next = structuredClone(record(settings) ?? {});
  if (next.hooks !== undefined && !record(next.hooks)) throw new Error(t("Khoá hooks trong settings.json không phải đối tượng; không sửa", "The hooks key in settings.json is not an object; not changing it"));
  const hooks = record(next.hooks) ?? {};
  for (const [event, timeout] of Object.entries(EVENTS)) {
    const desired = UNMATCHED_EVENTS.has(event) ? { hooks: [{ type: "command", command, timeout }] } : { matcher: "*", hooks: [{ type: "command", command, timeout }] };
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error(t(`Khoá hooks.${event} trong settings.json không phải mảng; không sửa`, `The hooks.${event} key in settings.json is not an array; not changing it`));
    const current = hooks[event] ?? [];
    const matching = current.filter((group) => Array.isArray(record(group)?.hooks) && group.hooks.some(ours));
    if (!uninstall && matching.length === 1 && JSON.stringify(matching[0]) === JSON.stringify(desired)) continue;
    const cleaned = withoutOurs(current);
    if (!uninstall) hooks[event] = [...cleaned, desired];
    else if (cleaned.length) hooks[event] = cleaned;
    else delete hooks[event];
  }
  if (uninstall && !Object.keys(hooks).length) delete next.hooks;
  else if (Object.keys(hooks).length || next.hooks !== undefined) next.hooks = hooks;
  return next;
}

export function installedState(settings) {
  const hooks = record(record(settings)?.hooks) ?? {};
  const has = (event) => Array.isArray(hooks[event]) && hooks[event].some((group) => Array.isArray(record(group)?.hooks) && group.hooks.some(ours));
  return { permission: has("PermissionRequest"), stop: has("PreToolUse") && has("UserPromptSubmit") };
}

function readSettings(file) {
  if (!existsSync(file)) return { exists: false, raw: "", value: {} };
  const raw = readFileSync(file, "utf8");
  const value = record(JSON.parse(raw));
  if (!value) throw new Error(t(`${file} không phải một đối tượng JSON`, `${file} is not a JSON object`));
  return { exists: true, raw, value };
}

function writeSettings(file, previous, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = previous.exists ? `${file}.bak-msc-${stamp}` : null;
  if (backup) copyFileSync(file, backup);
  const temp = `${file}.msc-${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: previous.exists ? statSync(file).mode & 0o777 : 0o600 });
    if (previous.exists && process.platform !== "win32") chmodSync(temp, statSync(file).mode & 0o777);
    renameSync(temp, file);
    if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== JSON.stringify(value)) throw new Error("verify");
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    if (backup) copyFileSync(backup, file);
    else try { unlinkSync(file); } catch {}
    throw new Error(t(`Ghi ${file} thất bại, đã khôi phục bản cũ: `, `Writing ${file} failed; restored the previous copy: `) + (error instanceof Error ? error.message : String(error)));
  }
  return backup;
}

export function run(argv, log = console.log) {
  const options = parseArgs(argv);
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.mjs");
  const binDir = path.join(options.home, ".msc-company", "bin");
  const target = path.join(binDir, MARKER);
  const settingsFile = path.join(options.home, ".claude", "settings.json");
  const command = hookCommand(target, stableNode(options.home));
  const current = readSettings(settingsFile);
  if (options.status) {
    const state = installedState(current.value);
    const present = existsSync(target);
    const yes = t("đã cài", "installed");
    const no = t("chưa cài", "not installed");
    log(t(`Hook duyệt quyền: ${state.permission ? yes : no} · Hook dừng lượt: ${state.stop ? yes : no} · Tệp hook: ${present ? target : "chưa có"}`, `Permission hook: ${state.permission ? yes : no} · Stop hook: ${state.stop ? yes : no} · Hook file: ${present ? target : "missing"}`));
    return state.permission && state.stop && present ? 0 : 1;
  }
  const next = mergeSettings(current.value, command, options.uninstall);
  const changed = JSON.stringify(next) !== JSON.stringify(current.value);
  const hookChanged = options.uninstall ? existsSync(target) : !existsSync(target) || readFileSync(target, "utf8") !== readFileSync(source, "utf8");
  if (options.dryRun) {
    const same = t("không đổi", "unchanged");
    log(`${t("[thử]", "[dry run]")} ${settingsFile}: ${changed ? t("sẽ cập nhật", "will update") : same} · ${target}: ${hookChanged ? options.uninstall ? t("sẽ xoá", "will delete") : t("sẽ chép", "will copy") : same}`);
    if (changed) log(JSON.stringify(next.hooks ?? {}, null, 2));
    return 0;
  }
  if (!options.uninstall && hookChanged) {
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path.dirname(binDir), 0o700);
    writeFileSync(`${target}.tmp`, readFileSync(source), { mode: 0o600 });
    renameSync(`${target}.tmp`, target);
  }
  const backup = changed ? writeSettings(settingsFile, current, next) : null;
  if (options.uninstall && hookChanged) unlinkSync(target);
  log(t(`${options.uninstall ? "Đã gỡ" : "Đã cài"} hook điều khiển Claude${changed ? "" : " (cấu hình không đổi)"}${backup ? `; bản sao lưu: ${backup}` : ""}`, `${options.uninstall ? "Removed" : "Installed"} the Claude control hook${changed ? "" : " (settings unchanged)"}${backup ? `; backup: ${backup}` : ""}`));
  if (changed) log(t("Phiên Claude đang mở cần mở lại để nạp hook mới.", "Reopen running Claude sessions to load the new hook."));
  return 0;
}

function realPath(file) {
  try { return realpathSync.native(file); } catch {}
  try { return realpathSync(file); } catch { return path.resolve(file); }
}

export function isMainModule(argv1, moduleUrl, main) {
  if (main === true) return true;
  if (typeof argv1 !== "string" || !argv1) return false;
  const [given, own] = [realPath(argv1), realPath(fileURLToPath(moduleUrl))];
  return process.platform === "win32" ? given.toLowerCase() === own.toLowerCase() : given === own;
}

if (isMainModule(process.argv[1], import.meta.url, import.meta.main)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
