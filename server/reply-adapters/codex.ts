import { REPLY_DESCRIPTION_LIMIT, REPLY_HEADER_LIMIT } from "../../shared/replies.ts";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { AgentInfo, MachineId } from "../../shared/types.ts";
import type { NativeReplyAdapter, NativeReplyQuestion } from "../replies.ts";

type Data = Record<string, unknown>;
export interface CodexReplyWire {
  version: string;
  instanceId: string;
  send(message: Data): void;
  listen(listener: (message: Data) => void): () => void;
  close(): void;
}
export interface CodexAccountEvidence { fingerprint: string; generation: string }
export interface CodexReplyOptions {
  machine: MachineId;
  open?: (signal: AbortSignal) => Promise<CodexReplyWire>;
  account?: () => CodexAccountEvidence;
  now?: () => number;
  decisionPollMs?: number;
}

const MAX_FRAME = 16 * 1024 * 1024;
const QUESTION_METHOD = "item/tool/requestUserInput";
const COMMAND_APPROVAL_METHOD = "item/commandExecution/requestApproval";
const FILE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const SUBMIT_METHOD = "thread-follower-submit-user-input";
const COMMAND_DECISION_METHOD = "thread-follower-command-approval-decision";
const FILE_DECISION_METHOD = "thread-follower-file-approval-decision";
export const CODEX_WINDOWS_VERSIONS: readonly string[] = ["26.1027.3384.0"];
export const CODEX_MAC_VERSIONS: readonly { version: string; build: string }[] = [{ version: "26.1027.51404", build: "23880" }];
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const DECISION_POLL_MS = 500;
const DECISION_SNAPSHOTS = 8;
const DECISION_WINDOW_MS = 4000;
const COMMAND_LABELS: Record<string, string> = { accept: "Cho phép", acceptForSession: "Cho phép cả phiên", acceptWithExecpolicyAmendment: "Luôn cho phép lệnh tương tự", decline: "Từ chối, Codex làm tiếp", cancel: "Từ chối và dừng lượt" };
const FILE_LABELS: Record<string, string> = { accept: "Cho phép", acceptForSession: "Cho phép mọi sửa file trong phiên", decline: "Từ chối, Codex làm tiếp", cancel: "Từ chối và dừng lượt" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const execute = promisify(execFile);
export const codexData = (value: unknown): Data => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Data : {};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const codexNormalizedPath = (value: string) => /^[a-z]:[\\/]/i.test(value) ? path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase() : path.posix.normalize(value).replace(/\/+$/, "") || "/";
export const codexFail = () => new Error("Kênh trả lời Codex chưa xác minh được danh tính hoặc phiên bản");

function stableFile(file: string, limit: number): string {
  const entry = lstatSync(file, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > BigInt(limit)) throw codexFail();
  const descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw codexFail();
    for (const field of ["ino", "dev", "size", "mtimeNs", "ctimeNs"] as const) if (before[field] !== entry[field]) throw codexFail();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw codexFail();
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(file, { bigint: true });
    for (const field of ["ino", "dev", "size", "mtimeNs", "ctimeNs"] as const) if (before[field] !== after[field] || after[field] !== current[field]) throw codexFail();
    if (!current.isFile() || current.isSymbolicLink()) throw codexFail();
    return bytes.toString("utf8");
  } finally { closeSync(descriptor); }
}

export function readCodexReplyAccount(): CodexAccountEvidence {
  try {
    const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
    if (!path.isAbsolute(home)) throw codexFail();
    let config = "";
    try { config = stableFile(path.join(home, "config.toml"), 2 * 1024 * 1024); }
    catch (error) { if (codexData(error).code !== "ENOENT") throw codexFail(); }
    for (const line of config.split(/\r?\n/)) {
      const content = line.trim();
      if (content.startsWith("#") || !content.includes("cli_auth_credentials_store")) continue;
      if (!/^cli_auth_credentials_store\s*=\s*["']file["']\s*(?:#.*)?$/.test(content)) throw codexFail();
    }
    const file = path.join(home, "auth.json");
    const raw = stableFile(file, 1024 * 1024);
    const auth = codexData(JSON.parse(raw));
    const tokens = codexData(auth.tokens);
    if (auth.auth_mode !== "chatgpt" || typeof tokens.account_id !== "string" || typeof tokens.id_token !== "string") throw codexFail();
    const parts = tokens.id_token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw codexFail();
    const claims = codexData(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    const identity = codexData(claims["https://api.openai.com/auth"]);
    const user = identity.chatgpt_user_id ?? claims.sub;
    if (typeof user !== "string" || !user || !tokens.account_id || identity.chatgpt_account_id && identity.chatgpt_account_id !== tokens.account_id) throw codexFail();
    if (stableFile(file, 1024 * 1024) !== raw) throw codexFail();
    try { if (stableFile(path.join(home, "config.toml"), 2 * 1024 * 1024) !== config) throw codexFail(); }
    catch (error) { if (config || codexData(error).code !== "ENOENT") throw codexFail(); }
    return { fingerprint: hash(["codex", tokens.account_id, user]), generation: hash(raw) };
  } catch { throw codexFail(); }
}

const WINDOWS_PIPE_HELPER = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;
public static class CompanyCodexPipe {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid);
  public static NamedPipeClientStream Pipe;
  public static uint Open() {
    Pipe = new NamedPipeClientStream(".", "codex-ipc", PipeDirection.InOut, PipeOptions.Asynchronous);
    Pipe.Connect(3000);
    uint pid;
    if (!GetNamedPipeServerProcessId(Pipe.SafePipeHandle, out pid)) throw new IOException("unverified pipe");
    return pid;
  }
  static byte[] Read(int length) {
    var result = new byte[length]; int offset = 0;
    while (offset < length) { int count = Pipe.Read(result, offset, length-offset); if (count == 0) throw new EndOfStreamException(); offset += count; }
    return result;
  }
  public static void Run() {
    Task.Run(() => {
      try {
        while (true) {
          uint size = BitConverter.ToUInt32(Read(4), 0);
          if (size == 0 || size > 16777216) throw new IOException("frame limit");
          Console.WriteLine(Convert.ToBase64String(Read((int)size)));
        }
      } catch { Environment.Exit(2); }
    });
    string line;
    while ((line = Console.ReadLine()) != null) {
      var payload = Convert.FromBase64String(line);
      if (payload.Length == 0 || payload.Length > 16777216) throw new IOException("frame limit");
      var header = BitConverter.GetBytes(payload.Length);
      Pipe.Write(header, 0, 4); Pipe.Write(payload, 0, payload.Length); Pipe.Flush();
    }
    Pipe.Dispose();
  }
}
'@
$serverPid = [CompanyCodexPipe]::Open()
$server = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid"
$owner = Invoke-CimMethod -InputObject $server -MethodName GetOwnerSid
if ($owner.ReturnValue -ne 0 -or $owner.Sid -ne [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'owner mismatch' }
$package = Get-AppxPackage OpenAI.Codex
if (@($package).Count -ne 1 -or @(${CODEX_WINDOWS_VERSIONS.map((version) => `'${version}'`).join(",")}) -notcontains $package.Version.ToString()) { throw 'unsupported version' }
$expected = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
if (-not [string]::Equals($server.ExecutablePath, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'image mismatch' }
$signature = Get-AuthenticodeSignature -LiteralPath $expected
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O="?OpenAI OpCo, LLC"?(,|$)') { throw 'signature mismatch' }
$verified = @{ verified = $true; version = $package.Version.ToString(); instanceId = "$serverPid/$($server.CreationDate.ToUniversalTime().Ticks)" } | ConvertTo-Json -Compress
[Console]::WriteLine($verified)
[CompanyCodexPipe]::Run()
`;

async function openWindowsWire(signal: AbortSignal): Promise<CodexReplyWire> {
  const executable = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_PIPE_HELPER, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const listeners = new Set<(message: Data) => void>();
  const lines = createInterface({ input: child.stdout });
  let closed = false;
  const close = () => { if (closed) return; closed = true; signal.removeEventListener("abort", close); lines.close(); child.stdin.end(); child.kill(); };
  signal.addEventListener("abort", close, { once: true });
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => { close(); reject(codexFail()); }, 6500);
    child.on("error", () => { close(); clearTimeout(timeout); reject(codexFail()); });
    child.on("exit", () => { close(); clearTimeout(timeout); if (!ready) reject(codexFail()); for (const listener of listeners) listener({ type: "disconnected" }); });
    lines.on("line", (line) => {
      try {
        if (line.length > MAX_FRAME * 1.4) throw codexFail();
        if (!ready) {
          const verified = codexData(JSON.parse(line));
          if (verified.verified !== true || typeof verified.version !== "string" || !CODEX_WINDOWS_VERSIONS.includes(verified.version) || typeof verified.instanceId !== "string") throw codexFail();
          ready = true;
          clearTimeout(timeout);
          resolve({ version: verified.version, instanceId: verified.instanceId, close, listen(listener) { listeners.add(listener); return () => listeners.delete(listener); }, send(message) {
            if (closed || signal.aborted) throw codexFail();
            const bytes = Buffer.from(JSON.stringify(message));
            if (bytes.length > MAX_FRAME) throw codexFail();
            child.stdin.write(`${bytes.toString("base64")}\n`);
          } });
        } else {
          const message = codexData(JSON.parse(Buffer.from(line, "base64").toString("utf8")));
          for (const listener of listeners) listener(message);
        }
      } catch { close(); clearTimeout(timeout); reject(codexFail()); }
    });
    if (signal.aborted) { close(); clearTimeout(timeout); reject(codexFail()); }
  });
}

async function openMacWire(signal: AbortSignal): Promise<CodexReplyWire> {
  const home = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  if (!path.isAbsolute(home) || !process.getuid) throw codexFail();
  const endpoint = path.join(home, "ipc", "ipc.sock");
  const app = "/Applications/ChatGPT.app";
  const uid = process.getuid();
  const inspectSocket = () => {
    const directory = lstatSync(path.dirname(endpoint), { bigint: true });
    const socket = lstatSync(endpoint, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== BigInt(uid) || (directory.mode & 0o777n) !== 0o700n || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== BigInt(uid) || (socket.mode & 0o777n) !== 0o600n) throw codexFail();
    return [socket.ino, socket.dev, socket.ctimeNs].map(String).join("/");
  };
  const run = (file: string, args: string[]) => execute(file, args, { signal, timeout: 4000, maxBuffer: 64 * 1024, encoding: "utf8" });
  const socketIdentity = inspectSocket();
  const [info, owner] = await Promise.all([
    run("/usr/bin/plutil", ["-convert", "json", "-o", "-", `${app}/Contents/Info.plist`]),
    run("/usr/sbin/lsof", ["-n", "-a", "-U", "-Fpu", endpoint]),
  ]);
  const plist = codexData(JSON.parse(info.stdout));
  if (plist.CFBundleIdentifier !== "com.openai.codex" || !CODEX_MAC_VERSIONS.some((pin) => pin.version === plist.CFBundleShortVersionString && pin.build === String(plist.CFBundleVersion)) || typeof plist.CFBundleExecutable !== "string" || !/^[A-Za-z0-9_-]+$/.test(plist.CFBundleExecutable)) throw codexFail();
  const pids = [...owner.stdout.matchAll(/^p(\d+)$/gm)].map((match) => match[1]);
  const owners = [...owner.stdout.matchAll(/^u(\d+)$/gm)].map((match) => Number(match[1]));
  if (pids.length !== 1 || owners.length !== 1 || owners[0] !== uid) throw codexFail();
  const [processInfo, signature] = await Promise.all([
    run("/bin/ps", ["-p", pids[0], "-o", "uid=", "-o", "comm=", "-o", "lstart="]),
    run("/usr/bin/codesign", ["-d", "--verbose=4", app]),
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]),
  ]);
  const expectedExecutable = `${app}/Contents/MacOS/${plist.CFBundleExecutable}`;
  const processLine = processInfo.stdout.trim();
  const processPrefix = `${uid} ${expectedExecutable}`;
  if (!processLine.replace(/\s+/g, " ").startsWith(`${processPrefix} `) || !/^TeamIdentifier=2DC432GLL2$/m.test(signature.stderr) || !/^Identifier=com\.openai\.codex$/m.test(signature.stderr)) throw codexFail();
  if (socketIdentity !== inspectSocket()) throw codexFail();
  const socket = createConnection(endpoint);
  const listeners = new Set<(message: Data) => void>();
  let closed = false;
  const close = () => { if (closed) return; closed = true; signal.removeEventListener("abort", close); socket.destroy(); };
  signal.addEventListener("abort", close, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(codexFail()); }, 2500);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.once("error", () => { clearTimeout(timer); reject(codexFail()); });
      socket.once("close", () => { clearTimeout(timer); reject(codexFail()); });
      if (signal.aborted) { clearTimeout(timer); close(); reject(codexFail()); }
    });
    const afterOwner = await run("/usr/sbin/lsof", ["-n", "-a", "-U", "-Fpu", endpoint]);
    const afterPids = [...afterOwner.stdout.matchAll(/^p(\d+)$/gm)].map((match) => match[1]);
    const afterOwners = [...afterOwner.stdout.matchAll(/^u(\d+)$/gm)].map((match) => Number(match[1]));
    if (socketIdentity !== inspectSocket() || !equal(afterPids, pids) || !equal(afterOwners, owners) || signal.aborted) throw codexFail();
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        while (buffer.length >= 4) {
          const size = buffer.readUInt32LE(0);
          if (!size || size > MAX_FRAME) throw codexFail();
          if (buffer.length < size + 4) break;
          const message = codexData(JSON.parse(buffer.subarray(4, size + 4).toString("utf8")));
          buffer = buffer.subarray(size + 4);
          for (const listener of listeners) listener(message);
        }
      } catch { close(); }
    });
    socket.on("close", () => { close(); for (const listener of listeners) listener({ type: "disconnected" }); });
    socket.on("error", close);
    return { version: String(plist.CFBundleShortVersionString), instanceId: `${pids[0]}/${hash(processLine)}/${socketIdentity}`, close, listen(listener) { listeners.add(listener); return () => listeners.delete(listener); }, send(message) {
      if (closed || signal.aborted) throw codexFail();
      const bytes = Buffer.from(JSON.stringify(message));
      if (bytes.length > MAX_FRAME) throw codexFail();
      const frame = Buffer.alloc(4 + bytes.length);
      frame.writeUInt32LE(bytes.length, 0);
      bytes.copy(frame, 4);
      socket.write(frame);
    } };
  } catch { close(); throw codexFail(); }
}

export async function openCodexReplyWire(signal: AbortSignal): Promise<CodexReplyWire> {
  if (process.platform === "win32") return openWindowsWire(signal);
  if (process.platform === "darwin") return openMacWire(signal);
  throw codexFail();
}

export class CodexFollowerClient {
  readonly wire: CodexReplyWire;
  readonly signal: AbortSignal;
  private clientId = "initializing-client";
  private owner = "";
  private thread = "";
  private sequence = 0;
  private snapshots: { sequence: number; state: Data }[] = [];
  private pending = new Map<string, { resolve: (message: Data) => void; reject: (error: Error) => void }>();
  private detach: () => void;
  private disconnected = false;
  constructor(wire: CodexReplyWire, signal: AbortSignal) {
    this.wire = wire;
    this.signal = signal;
    this.detach = wire.listen((message) => {
      if (message.type === "disconnected") {
        this.disconnected = true;
        for (const waiter of this.pending.values()) waiter.reject(codexFail());
      }
      if (message.type === "response" && typeof message.requestId === "string") this.pending.get(message.requestId)?.resolve(message);
      const params = codexData(message.params);
      const change = codexData(params.change);
      if (message.type === "broadcast" && message.method === "thread-stream-state-changed" && message.version === 11 && message.sourceClientId === this.owner && params.conversationId === this.thread && params.hostId === "local" && change.type === "snapshot" && Array.isArray(message.targetClientIds) && message.targetClientIds.includes(this.clientId)) {
        this.snapshots.push({ sequence: ++this.sequence, state: codexData(change.conversationState) });
        this.snapshots = this.snapshots.slice(-2);
      }
      if (message.type === "client-discovery-request") this.wire.send({ type: "client-discovery-response", requestId: message.requestId, response: { canHandle: false } });
    });
  }
  async request(method: string, params: Data, version: number, targeted = true, timeoutMs = 3500): Promise<Data> {
    if (this.signal.aborted || this.disconnected) throw codexFail();
    const requestId = randomUUID();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = () => this.pending.get(requestId)?.reject(codexFail());
    try {
      const response = await new Promise<Data>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        timeout = setTimeout(() => reject(codexFail()), timeoutMs);
        this.signal.addEventListener("abort", abort, { once: true });
        this.wire.send({ type: "request", requestId, sourceClientId: this.clientId, method, version, params, ...(targeted ? { targetClientId: this.owner } : {}) });
      });
      if (response.resultType !== "success" || response.method !== method || targeted && response.handledByClientId !== this.owner) throw codexFail();
      return response;
    } finally { clearTimeout(timeout); this.signal.removeEventListener("abort", abort); this.pending.delete(requestId); }
  }
  async initialize(thread: string): Promise<void> {
    const response = await this.request("initialize", { clientType: "minh-spark-company-human-web" }, 0, false);
    const id = codexData(response.result).clientId;
    if (typeof id !== "string" || !UUID.test(id)) throw codexFail();
    this.clientId = id;
    this.thread = thread;
    const discovery = await this.request("thread-owner-discovery", { hostId: "local", conversationId: thread }, 1, false);
    if (typeof discovery.handledByClientId !== "string" || !UUID.test(discovery.handledByClientId)) throw codexFail();
    this.owner = discovery.handledByClientId;
  }
  identity(): string { return `${this.wire.version}/${this.wire.instanceId}/${this.owner}`; }
  private following(value: boolean): void {
    this.wire.send({ type: "broadcast", method: "thread-stream-following-changed", version: 1, sourceClientId: this.clientId, targetClientIds: [this.owner], params: { hostId: "local", conversationId: this.thread, following: value } });
  }
  async snapshot(): Promise<Data> {
    const before = this.sequence;
    this.following(true);
    const end = Date.now() + 2500;
    while (Date.now() < end) {
      if (this.signal.aborted || this.disconnected) throw codexFail();
      const snapshot = this.snapshots.find((entry) => entry.sequence > before);
      if (snapshot) return snapshot.state;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw codexFail();
  }
  close(): void { try { if (this.owner && !this.disconnected) this.following(false); } catch {} this.detach(); this.wire.close(); }
}

interface Pending { request: Data; question: NativeReplyQuestion }

const clip = (value: string, max = 2000) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const line = (label: string, value: unknown) => typeof value === "string" && value.trim() ? [`${label}: ${clip(value.trim())}`] : [];

export function codexAmendment(params: Data): string[] | null {
  const value = params.proposedExecpolicyAmendment;
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every((part) => typeof part === "string" && part.length > 0 && part.length <= 1000 && !part.includes("\0")) ? [...value as string[]] : null;
}

function approvalField(method: string, params: Data): NativeReplyQuestion["fields"][number] {
  const labels = method === COMMAND_APPROVAL_METHOD ? COMMAND_LABELS : FILE_LABELS;
  const options = Object.keys(labels).filter((option) => option !== "acceptWithExecpolicyAmendment" || codexAmendment(params));
  return { id: "decision", text: "Quyết định của sếp", options, multiSelect: false, allowFreeText: false, labels: Object.fromEntries(options.map((option) => [option, labels[option]])) };
}

function approvalDetail(method: string, params: Data): string {
  if (method === FILE_APPROVAL_METHOD) return [...line("Thư mục xin quyền ghi", params.grantRoot), ...line("Lý do", params.reason)].join("\n") || "Codex xin sửa file trong lượt đang chạy";
  const network = codexData(params.networkApprovalContext);
  const amendment = codexAmendment(params);
  return [...params.kind === "writeStdin" ? ["Gửi dữ liệu vào terminal đang chạy"] : [], ...line("Lệnh", params.command), ...line("Thư mục", params.cwd), ...typeof network.host === "string" ? line("Mạng", `${network.host}${typeof network.protocol === "string" ? ` (${network.protocol})` : ""}`) : [], ...line("Lý do", params.reason), ...amendment ? line("Quy tắc đề xuất", amendment.join(" ")) : []].join("\n").slice(0, 7000) || "Codex xin chạy lệnh";
}

function questionFields(params: Data): NativeReplyQuestion["fields"] | null {
  if (!Array.isArray(params.questions) || !params.questions.length || params.questions.length > 8) return null;
  return params.questions.map((item) => {
    const question = codexData(item);
    if (typeof question.id !== "string" || typeof question.question !== "string" || question.isSecret === true) throw codexFail();
    const options = Array.isArray(question.options) ? question.options.map((option) => codexData(option).label) : [];
    if (options.some((option) => typeof option !== "string")) throw codexFail();
    const descriptions = (Array.isArray(question.options) ? question.options : []).map((option) => [String(codexData(option).label), codexData(option).description]).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0).map(([label, description]) => [label, description.slice(0, REPLY_DESCRIPTION_LIMIT)]);
    return { id: question.id, text: question.question, options: options as string[], multiSelect: false, allowFreeText: question.isOther === true || !options.length, ...(descriptions.length ? { descriptions: Object.fromEntries(descriptions) } : {}), ...(typeof question.header === "string" && question.header ? { header: question.header.slice(0, REPLY_HEADER_LIMIT) } : {}) };
  });
}

export function codexApprovalDecision(method: string, params: Data, option: string): unknown {
  const labels = method === COMMAND_APPROVAL_METHOD ? COMMAND_LABELS : method === FILE_APPROVAL_METHOD ? FILE_LABELS : {};
  if (!Object.hasOwn(labels, option)) return null;
  if (option !== "acceptWithExecpolicyAmendment") return option;
  const amendment = codexAmendment(params);
  return amendment ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } : null;
}

export function codexThreadState(state: Data, agent: AgentInfo): Data {
  if (state.id !== agent.sessionId || typeof state.cwd !== "string" || !agent.cwd || codexNormalizedPath(state.cwd) !== codexNormalizedPath(agent.cwd) || state.hostId !== "local") throw codexFail();
  return state;
}

export class CodexReplyAdapter implements NativeReplyAdapter {
  readonly app = "codex" as const;
  private readonly open: NonNullable<CodexReplyOptions["open"]>;
  private readonly account: NonNullable<CodexReplyOptions["account"]>;
  private readonly now: () => number;
  private readonly seen = new Map<string, string>();
  private readonly options: CodexReplyOptions;
  constructor(options: CodexReplyOptions) { this.options = options; this.open = options.open ?? openCodexReplyWire; this.account = options.account ?? readCodexReplyAccount; this.now = options.now ?? Date.now; }
  private parse(state: Data, agent: AgentInfo, account: CodexAccountEvidence, client: CodexFollowerClient): Pending[] {
    codexThreadState(state, agent);
    if (!Array.isArray(state.requests)) throw codexFail();
    const result: Pending[] = [];
    for (const value of state.requests.slice(0, 32)) {
      const request = codexData(value);
      const params = codexData(request.params);
      const method = request.method;
      if (typeof method !== "string" || ![QUESTION_METHOD, COMMAND_APPROVAL_METHOD, FILE_APPROVAL_METHOD].includes(method) || !["string", "number"].includes(typeof request.id) || params.threadId !== agent.sessionId) continue;
      const question = method === QUESTION_METHOD;
      const fields = question ? questionFields(params) : typeof params.turnId === "string" && typeof params.itemId === "string" ? [approvalField(method, params)] : null;
      if (!fields) continue;
      const version = hash([client.identity(), account.generation, request]);
      const identity = { accountId: account.fingerprint, cwd: state.cwd as string, sessionId: agent.sessionId!, threadId: agent.sessionId!, nativeRequestId: JSON.stringify([request.id, params.turnId ?? null, params.itemId ?? null]), version };
      const key = hash(identity);
      let askedAt = this.seen.get(key);
      if (!askedAt) {
        askedAt = new Date(this.now()).toISOString();
        if (this.seen.size >= 512) this.seen.delete(this.seen.keys().next().value!);
        this.seen.set(key, askedAt);
      }
      const title = question ? "Codex hỏi" : method === COMMAND_APPROVAL_METHOD ? "Codex xin chạy lệnh" : "Codex xin sửa file";
      result.push({ request, question: { kind: question ? "question" : "approval", title, detail: question ? "" : approvalDetail(method, params), agentId: agent.id, app: "codex", machine: agent.machine, identity, askedAt, fields } });
    }
    return result;
  }
  private checkAgent(agent: AgentInfo): void { if (agent.app !== "codex" || agent.machine !== this.options.machine || !agent.sessionId || !UUID.test(agent.sessionId) || !agent.cwd) throw codexFail(); }
  private probe(agent: AgentInfo): boolean {
    if (agent.pending) return true;
    if (!["working", "thinking", "waiting"].includes(agent.state)) return false;
    const updated = Date.parse(agent.updatedAt);
    return Number.isFinite(updated) && this.now() - updated <= ACTIVE_WINDOW_MS;
  }
  async list(agent: AgentInfo, signal: AbortSignal): Promise<NativeReplyQuestion[]> {
    this.checkAgent(agent);
    if (!this.probe(agent)) return [];
    const account = this.account();
    const client = new CodexFollowerClient(await this.open(signal), signal);
    try {
      await client.initialize(agent.sessionId!);
      const result = this.parse(await client.snapshot(), agent, account, client);
      if (!equal(account, this.account())) throw codexFail();
      return result.map((entry) => entry.question);
    } finally { client.close(); }
  }
  private async confirmDecision(client: CodexFollowerClient, agent: AgentInfo, account: CodexAccountEvidence, pending: Pending, option: string, signal: AbortSignal): Promise<"answered" | "unknown"> {
    const interval = Math.max(0, this.options.decisionPollMs ?? DECISION_POLL_MS);
    const end = Date.now() + DECISION_WINDOW_MS;
    for (let attempt = 0; attempt < DECISION_SNAPSHOTS; attempt++) {
      if (attempt) await pause(Math.min(interval, Math.max(0, end - Date.now())), signal);
      const state = await client.snapshot();
      if (!equal(account, this.account()) || state.id !== agent.sessionId || state.cwd !== pending.question.identity.cwd) return "unknown";
      const outcome = codexDecisionOutcome(state, pending.request, option);
      if (outcome !== "pending") return outcome === "answered" ? "answered" : "unknown";
      if (Date.now() >= end) break;
    }
    return "unknown";
  }
  async submit(question: NativeReplyQuestion, answers: Record<string, string[]>, context: { author: "human-web"; requestId: string; signal: AbortSignal }): Promise<{ status: "answered" | "stale" | "unknown" }> {
    let sent = false;
    let client: CodexFollowerClient | undefined;
    try {
      if (context.author !== "human-web" || question.app !== "codex" || question.machine !== this.options.machine || context.signal.aborted || !["question", "approval"].includes(question.kind)) return { status: "stale" };
      const agent = { id: question.agentId, app: "codex", machine: question.machine, cwd: question.identity.cwd, sessionId: question.identity.sessionId } as AgentInfo;
      this.checkAgent(agent);
      const account = this.account();
      if (account.fingerprint !== question.identity.accountId) return { status: "stale" };
      client = new CodexFollowerClient(await this.open(context.signal), context.signal);
      await client.initialize(agent.sessionId!);
      const pending = this.parse(await client.snapshot(), agent, account, client).find((entry) => entry.question.kind === question.kind && entry.question.title === question.title && entry.question.detail === question.detail && equal(entry.question.identity, question.identity) && equal(entry.question.fields, question.fields));
      if (!pending || !equal(account, this.account()) || Object.keys(answers).length !== question.fields.length) return { status: "stale" };
      for (const field of question.fields) {
        const values = answers[field.id];
        if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== "string" || !values[0].trim() || values[0].length > 4000 || !field.allowFreeText && !field.options.includes(values[0])) return { status: "stale" };
      }
      if (pending.question.kind === "approval") {
        const method = String(pending.request.method);
        const decision = codexApprovalDecision(method, codexData(pending.request.params), answers.decision?.[0] ?? "");
        if (decision === null || question.fields.length !== 1 || question.fields[0].id !== "decision") return { status: "stale" };
        sent = true;
        await client.request(method === COMMAND_APPROVAL_METHOD ? COMMAND_DECISION_METHOD : FILE_DECISION_METHOD, { conversationId: agent.sessionId, requestId: pending.request.id, decision }, 1);
        return { status: await this.confirmDecision(client, agent, account, pending, answers.decision?.[0] ?? "", context.signal) };
      }
      const response = { answers: Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: [...values] }])) };
      sent = true;
      await client.request(SUBMIT_METHOD, { conversationId: agent.sessionId, requestId: pending.request.id, response }, 1);
      const state = await client.snapshot();
      if (!equal(account, this.account()) || state.id !== agent.sessionId || state.cwd !== pending.question.identity.cwd) return { status: "unknown" };
      if (Array.isArray(state.requests) && state.requests.some((value) => codexData(value).id === pending.request.id)) return { status: "unknown" };
      return { status: hasNativeAnswer(state, pending.request.id, answers) ? "answered" : "unknown" };
    } catch { return { status: sent ? "unknown" : "stale" }; }
    finally { client?.close(); }
  }
}

function findEntries(state: Data, match: (entry: Data) => boolean): Data[] {
  const queue: unknown[] = [state];
  const found: Data[] = [];
  let count = 0;
  while (queue.length && ++count < 100000) {
    const item = queue.pop();
    if (!item || typeof item !== "object") continue;
    const entry = codexData(item);
    if (match(entry)) found.push(entry);
    queue.push(...Object.values(item));
  }
  return found;
}

function hasNativeAnswer(state: Data, requestId: unknown, answers: Record<string, string[]>): boolean {
  const [entry] = findEntries(state, (candidate) => candidate.type === "userInputResponse" && candidate.requestId === requestId && candidate.completed === true);
  if (!entry) return false;
  const recorded = codexData(entry.answers);
  return Object.keys(recorded).length === Object.keys(answers).length && Object.entries(answers).every(([id, values]) => equal(recorded[id], values));
}

const DECLINED_DECISIONS = ["decline", "cancel"];
const ACCEPTED_DECISIONS = ["accept", "acceptForSession", "acceptWithExecpolicyAmendment"];
const FINISHED_STATUSES = ["completed", "failed"];

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(codexFail());
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", stop); };
  const stop = () => { done(); reject(codexFail()); };
  const timer = setTimeout(() => { done(); resolve(); }, ms);
  signal.addEventListener("abort", stop, { once: true });
});

export function codexActiveTurn(state: Data): string | null {
  if (!Array.isArray(state.turns)) return null;
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = codexData(state.turns[index]);
    if (turn.turnId == null) continue;
    return typeof turn.turnId === "string" && turn.turnId && turn.status === "inProgress" ? turn.turnId : null;
  }
  return null;
}

export type CodexDecisionOutcome = "answered" | "pending" | "mismatch";

export function codexDecisionOutcome(state: Data, request: Data, option: string): CodexDecisionOutcome {
  const params = codexData(request.params);
  const type = request.method === COMMAND_APPROVAL_METHOD ? "commandExecution" : request.method === FILE_APPROVAL_METHOD ? "fileChange" : "";
  const declined = DECLINED_DECISIONS.includes(option);
  if (!type || !declined && !ACCEPTED_DECISIONS.includes(option) || typeof params.itemId !== "string" || !params.itemId || typeof params.turnId !== "string" || !params.turnId || !Array.isArray(state.requests) || !Array.isArray(state.turns)) return "mismatch";
  if (state.requests.some((value) => codexData(value).id === request.id)) return "pending";
  const turns = state.turns.filter((value) => codexData(value).turnId === params.turnId);
  const items = turns.flatMap((turn) => findEntries(codexData(turn), (entry) => entry.type === type && entry.id === params.itemId));
  if (!items.length) return "pending";
  const statuses = new Set(items.map((item) => item.status));
  if (statuses.size !== 1) return "mismatch";
  const [status] = statuses;
  if (declined) return status === "declined" ? "answered" : status === "inProgress" ? "pending" : "mismatch";
  if (typeof status === "string" && FINISHED_STATUSES.includes(status)) return "answered";
  if (status === "inProgress") return codexActiveTurn(state) === params.turnId ? "answered" : "mismatch";
  return "mismatch";
}

export const createCodexReplyAdapter = (machine: MachineId): NativeReplyAdapter => new CodexReplyAdapter({ machine });
