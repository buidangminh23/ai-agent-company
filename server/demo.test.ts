import assert from "node:assert/strict";
import { test } from "node:test";
import { demoAgents, demoHealth, demoProjects, demoQuota, demoSites, demoSkills } from "./demo.ts";

test("demo data covers every machine and shows two agents waiting for a decision", () => {
  const agents = demoAgents(Date.UTC(2026, 0, 1));
  assert.equal(agents.length, 11);
  assert.deepEqual([...new Set(agents.map((agent) => agent.machine))].sort(), ["LAPTOP", "SERVER", "WORKSTATION"]);
  assert.equal(agents.filter((agent) => agent.pending).length, 2);
  assert.equal(new Set(agents.map((agent) => agent.id)).size, agents.length);
});

test("demo data uses only example accounts and documentation addresses", () => {
  const text = JSON.stringify([demoAgents(), demoHealth(), demoQuota(), demoSites(), demoSkills(), demoProjects()]);
  for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) assert.match(email, /@example\.com$/);
  for (const url of text.match(/https?:\/\/[^"\s]+/g) ?? []) assert.match(url, /^https:\/\/([\w-]+\.)?(example\.com|github\.com\/example)\//);
  for (const ip of text.match(/\b\d+\.\d+\.\d+\.\d+\b/g) ?? []) assert.match(ip, /^(192\.168\.1|100\.64\.0)\./);
});
