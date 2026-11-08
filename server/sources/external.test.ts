import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaRows } from "./external.ts";

const providers = {
  "claude@a": { displayName: "Claude · a@x.com", resources: { session: { remaining: 10 }, weekly: { remaining: 20 } } },
  "claude@b": { displayName: "Claude · b@x.com", resources: { fable: { remaining: 30 }, weekly: { remaining: 40 } } },
  "codex@c": { displayName: "Codex · c@x.com", resources: { credits: { remaining: 5 }, session: { remaining: 50 }, weekly: { remaining: 60 } } },
};

const labels = (rows: ReturnType<typeof quotaRows>) => rows.map((row) => `${row.app}:${row.account}:${row.window}`);

test("quotaRows follows the app's provider and metric order", () => {
  const layout = {
    providerOrder: ["codex@c", "claude@b", "claude@a"],
    metricOrder: { "claude@b": ["claude@b.weekly", "claude@b.fable"], "codex@c": ["codex@c.weekly", "codex@c.session"] },
  };
  assert.deepEqual(labels(quotaRows(providers, layout)), [
    "codex:c@x.com:Tuần",
    "codex:c@x.com:5h",
    "claude:b@x.com:Tuần",
    "claude:b@x.com:Fable",
    "claude:a@x.com:5h",
    "claude:a@x.com:Tuần",
  ]);
});

test("quotaRows keeps the source order when the layout is missing or partial", () => {
  assert.deepEqual(labels(quotaRows(providers, null)), [
    "claude:a@x.com:5h",
    "claude:a@x.com:Tuần",
    "claude:b@x.com:Fable",
    "claude:b@x.com:Tuần",
    "codex:c@x.com:5h",
    "codex:c@x.com:Tuần",
  ]);
  assert.deepEqual(labels(quotaRows(providers, { providerOrder: ["codex@c"] })).slice(0, 3), ["codex:c@x.com:5h", "codex:c@x.com:Tuần", "claude:a@x.com:5h"]);
});
