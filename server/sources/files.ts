import { open, stat } from "node:fs/promises";
import path from "node:path";

export async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await fh.close();
  }
}

export async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const cut = text.lastIndexOf("\n");
    return cut > 0 && bytesRead === bytes ? text.slice(0, cut) : text;
  } finally {
    await fh.close();
  }
}

export function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export async function mtimeMs(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

export function projectName(cwd: string): string {
  const norm = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/");
  const wt = parts.indexOf(".claude");
  const base = wt > 0 ? parts[wt - 1] : parts[parts.length - 1];
  return base && !/^[A-Za-z]:$/.test(base) ? base : path.parse(cwd).root || cwd;
}

export function clipLines(text: string, max: number): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd());
  const joined = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
