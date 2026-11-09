#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [command, ...rest] = process.argv.slice(2);

const usage = `Usage: ai-agent-company [command]

Commands:
  (none)                 Start the hub (reads .env from the current folder)
  demo                   Start the hub with sample agents (MSC_DEMO=1)
  install-claude-hook    Install the Claude approval hook (--dry-run, --status, --uninstall)
  --version              Print the version
  --help                 Show this help`;

if (command === "--help" || command === "-h" || command === "help") {
  console.log(usage);
} else if (command === "--version" || command === "-v") {
  console.log(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version);
} else if (command === "install-claude-hook") {
  const installer = await import(pathToFileURL(path.join(root, "server", "claude-hook", "install.mjs")).href);
  try { process.exitCode = installer.run(rest); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
} else if (command === undefined || command === "demo") {
  if (command === "demo") process.env.MSC_DEMO = "1";
  process.env.MSC_DIST ??= path.join(root, "dist");
  await import(pathToFileURL(path.join(root, "dist-server", "hub.mjs")).href);
} else {
  console.error(`Unknown command: ${command}\n\n${usage}`);
  process.exitCode = 2;
}
