import { L } from "../../shared/i18n.ts";
import type http from "node:http";

const QUOTA_ORIGIN = new URL(process.env.MSC_QUOTA_URL ?? "http://127.0.0.1:6736/v1/limits").origin;
const TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 60_000;
const BODY_LIMIT = 64 * 1024;
const WRITE_HEADER = "x-quota-control";
const WRITE_VALUE = "write";
const COMMANDS = new Set([
  "app_info",
  "catalog",
  "engine_state",
  "load_document",
  "list_accounts",
  "list_services",
  "list_removed_logins",
  "login_results",
  "pending_logins",
  "system_time_zone",
  "usage_summary",
  "usage_ledger_info",
  "exchange_rate",
  "context_windows",
  "model_quality",
  "public_feed",
  "prices",
]);
const ACTIONS = new Set([
  "begin_account_login",
  "complete_account_login",
  "cancel_account_login",
  "remove_account",
  "restore_removed_logins",
  "add_api_key",
  "remove_api_key",
  "dismiss_detected_card",
  "restore_dismissed_cards",
  "redeem_limit_reset",
  "refresh",
]);

export const QUOTA_PREFIX = "/quota/";

function parts(pathname: string): string[] | null {
  if (!pathname.startsWith(QUOTA_PREFIX)) return null;
  const list = pathname.slice(QUOTA_PREFIX.length).split("/");
  return list.some((part) => part === ".." || part.includes("\\")) ? null : list;
}

export function quotaTarget(pathname: string, search: string): string | null {
  const list = parts(pathname);
  if (!list) return null;
  const rest = list.join("/");
  if (list[0] === "web") return `${QUOTA_ORIGIN}/${rest}`;
  if (list.length === 3 && list[0] === "v1" && list[1] === "app" && COMMANDS.has(list[2])) return `${QUOTA_ORIGIN}/${rest}${search}`;
  return null;
}

export function quotaAction(pathname: string): string | null {
  const list = parts(pathname);
  if (!list || list.length !== 3 || list[0] !== "v1" || list[1] !== "app" || !ACTIONS.has(list[2])) return null;
  return `${QUOTA_ORIGIN}/v1/app/${list[2]}`;
}

export function actionAllowed(headers: http.IncomingHttpHeaders): boolean {
  if (headers[WRITE_HEADER] !== WRITE_VALUE) return false;
  const origin = headers.origin;
  if (!origin || !headers.host) return false;
  try {
    return new URL(origin).host === headers.host;
  } catch {
    return false;
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

async function forward(res: http.ServerResponse, target: string, init: RequestInit, cacheable: boolean): Promise<void> {
  try {
    const upstream = await fetch(target, init);
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": cacheable ? "public, max-age=86400, immutable" : "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify({ error: L("Quota Control trên máy chủ không phản hồi.") }));
  }
}

export async function proxyQuota(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith(QUOTA_PREFIX) && url.pathname !== "/quota") return false;
  if (url.pathname === "/quota" || url.pathname === "/quota/web") {
    res.writeHead(308, { location: "/quota/web/", "cache-control": "no-store" }).end();
    return true;
  }
  if (req.method === "POST") {
    const action = quotaAction(url.pathname);
    if (!action) {
      res.writeHead(404).end();
      return true;
    }
    if (!actionAllowed(req.headers)) {
      res.writeHead(403).end();
      return true;
    }
    const body = await readBody(req);
    if (!body) {
      res.writeHead(413).end();
      return true;
    }
    await forward(res, action, { method: "POST", headers: { [WRITE_HEADER]: WRITE_VALUE, "content-type": "application/json" }, body: body.toString("utf8"), signal: AbortSignal.timeout(ACTION_TIMEOUT_MS) }, false);
    return true;
  }
  const target = quotaTarget(url.pathname, url.search);
  if (!target || req.method !== "GET") {
    res.writeHead(target ? 405 : 404).end();
    return true;
  }
  await forward(res, target, { signal: AbortSignal.timeout(TIMEOUT_MS) }, /\/web\/assets\//.test(url.pathname));
  return true;
}
