import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type http from "node:http";
import path from "node:path";

const DIST = path.resolve(process.env.MSC_DIST ?? "dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function fileIfExists(file: string): Promise<string | null> {
  try {
    return (await stat(file)).isFile() ? file : null;
  } catch {
    return null;
  }
}

export async function serveStatic(pathname: string, res: http.ServerResponse): Promise<boolean> {
  const decoded = decodeURIComponent(pathname);
  const target = path.resolve(DIST, `.${decoded}`);
  if (target !== DIST && !target.startsWith(DIST + path.sep)) return false;
  const file = (await fileIfExists(target)) ?? (await fileIfExists(path.join(DIST, "index.html")));
  if (!file) return false;
  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
  });
  createReadStream(file).pipe(res);
  return true;
}
