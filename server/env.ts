import { readFileSync } from "node:fs";
import path from "node:path";

const ENV_FILE = path.resolve(process.env.MSC_ENV_FILE ?? ".env");

function loadEnvFile(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2").trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(ENV_FILE);
