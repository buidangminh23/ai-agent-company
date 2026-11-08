import type { IncomingMessage } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "forwarded", "tailscale-user-login"];
const DIRECT_PATHS = ["/healthz", "/collector"];

type RequestLike = Pick<IncomingMessage, "headers" | "socket">;

export function isProxied(req: RequestLike): boolean {
  return PROXY_HEADERS.some((name) => req.headers[name] !== undefined);
}

export function isLoopback(req: RequestLike): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "") && !isProxied(req);
}

export function isHttps(req: RequestLike): boolean {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase();
  return proto === "https" || /(?:^|;)\s*proto=https\b/i.test(String(req.headers.forwarded ?? ""));
}

export function httpsRedirect(req: RequestLike, path: string, publicUrl: string): string | null {
  if (!publicUrl || isLoopback(req) || isProxied(req)) return null;
  if (DIRECT_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return null;
  return `${publicUrl.replace(/\/+$/, "")}${path}`;
}

export function tokenCookie(name: string, value: string, maxAgeS: number, secure: boolean): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAgeS}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}
