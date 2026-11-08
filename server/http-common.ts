import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentInfo, MachineId } from "../shared/types.ts";

export type HttpFail = (statusCode: number, message: string) => Error;

export interface JsonBodyMessages {
  type: string;
  encoding: string;
  tooLarge: string;
  timeout: string;
  invalid: string;
  incomplete: string;
}

export const MACHINES: readonly MachineId[] = ["WORKSTATION", "SERVER", "LAPTOP"];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return typeof value === "string" ? value : "";
}

export function tokenEqual(value: string, expected: string): boolean {
  if (!expected || !value || value.length > 4096) return false;
  const given = Buffer.from(value);
  const target = Buffer.from(expected);
  return given.length === target.length && timingSafeEqual(given, target);
}

export function cookie(req: IncomingMessage): string {
  try {
    const values = header(req, "cookie").split(";").map((part) => part.trim()).filter((part) => part.startsWith("msc_token="));
    return values.length === 1 ? decodeURIComponent(values[0].slice("msc_token=".length)) : "";
  } catch { return ""; }
}

export function authenticated(req: IncomingMessage, token: string, internal: boolean): boolean {
  return tokenEqual(header(req, "x-msc-token"), token) || (!internal && tokenEqual(cookie(req), token));
}

export function authority(value: string): string | null {
  if (!value || /[\s,/@?#\\]/.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    return url.host.toLowerCase();
  } catch { return null; }
}

export function allowedHostSet(hosts: readonly string[]): Set<string> {
  return new Set(hosts.map(authority).filter((host): host is string => Boolean(host)));
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body));
}

export function sameOriginWrite(req: IncomingMessage, host: string, actionHeader: string, actionValue: string): boolean {
  let origin: URL;
  try { origin = new URL(header(req, "origin")); } catch { return false; }
  const fetchSite = header(req, "sec-fetch-site");
  return ["http:", "https:"].includes(origin.protocol) && origin.host.toLowerCase() === host && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash && (!fetchSite || fetchSite === "same-origin") && header(req, actionHeader) === actionValue;
}

export function collectorUrls(collectors: ReadonlyMap<MachineId, string>, self: MachineId): Map<MachineId, URL> {
  const result = new Map<MachineId, URL>();
  for (const [machine, value] of collectors) {
    try {
      const url = new URL(value);
      if (MACHINES.includes(machine) && machine !== self && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/") result.set(machine, url);
    } catch { continue; }
  }
  return result;
}

export async function freshAgents(read: () => Promise<AgentInfo[]>, timeoutMs: number, fail: () => Error): Promise<AgentInfo[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail()), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export function readJsonBody(req: IncomingMessage, limit: number, timeoutMs: number, fail: HttpFail, messages: JsonBodyMessages): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, "content-type"))) return Promise.reject(fail(415, messages.type));
  if (header(req, "content-encoding") && header(req, "content-encoding") !== "identity") return Promise.reject(fail(415, messages.encoding));
  const declared = header(req, "content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) return Promise.reject(fail(413, messages.tooLarge));
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => finish(fail(408, messages.timeout)), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", broken);
      req.off("aborted", broken);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) { req.pause(); reject(error); return; }
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body");
        resolve(parsed as Record<string, unknown>);
      } catch { reject(fail(400, messages.invalid)); }
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish(fail(413, messages.tooLarge));
      else chunks.push(chunk);
    };
    const end = () => finish();
    const broken = () => finish(fail(400, messages.incomplete));
    req.on("data", data);
    req.once("end", end);
    req.once("error", broken);
    req.once("aborted", broken);
  });
}

export async function readRemoteJson(response: Response, limit: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error("response too large");
  }
  if (!response.body) throw new Error("missing response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
