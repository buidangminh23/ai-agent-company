import type { AgentApp, AgentInfo, AgentState, MachineHealth, MachineId, ProjectsSnapshot, QuotaSnapshot, RoleId, SiteStatus, SkillsSnapshot } from "../shared/types.ts";

interface DemoSeat {
  app: AgentApp;
  machine: MachineId;
  project: string;
  role: RoleId;
  title: string;
  steps: string[];
  question?: { text: string; options: string[] };
}

const SEATS: DemoSeat[] = [
  { app: "claude", machine: "WORKSTATION", project: "storefront", role: "frontend", title: "Checkout page redesign", steps: ["Editing src/checkout/Summary.tsx", "Running npm test", "Reading src/cart/store.ts"] },
  { app: "codex", machine: "WORKSTATION", project: "storefront", role: "backend", title: "Payment webhook retries", steps: ["Editing api/webhooks/payment.ts", "Running pnpm vitest webhooks", "Searching for idempotency keys"] },
  { app: "claude", machine: "WORKSTATION", project: "storefront", role: "test", title: "End-to-end checkout tests", steps: ["Running playwright test checkout", "Editing e2e/checkout.spec.ts"], question: { text: "Two flaky tests depend on a live payment sandbox. How should I proceed?", options: ["Mock the sandbox", "Keep live tests, mark them slow", "Skip them for now"] } },
  { app: "antigravity", machine: "WORKSTATION", project: "storefront", role: "uiux", title: "Mobile navigation polish", steps: ["Adjusting spacing tokens", "Reviewing contrast ratios"] },
  { app: "codex", machine: "LAPTOP", project: "mobile-app", role: "frontend", title: "Offline sync screen", steps: ["Editing app/sync/Queue.tsx", "Running expo lint"] },
  { app: "claude", machine: "LAPTOP", project: "docs-site", role: "content", title: "Release notes for v2.4", steps: ["Writing docs/releases/2.4.md", "Checking links"] },
  { app: "claude", machine: "LAPTOP", project: "mobile-app", role: "ai", title: "Smart reply prompts", steps: ["Evaluating prompt variants", "Editing prompts/reply.md"], question: { text: "Allow running the evaluation script that calls the API 200 times?", options: ["Allow", "Deny"] } },
  { app: "codex", machine: "SERVER", project: "platform", role: "devops", title: "Zero-downtime deploy pipeline", steps: ["Editing .github/workflows/deploy.yml", "Running docker compose build"] },
  { app: "claude", machine: "SERVER", project: "platform", role: "data", title: "Nightly analytics rollup", steps: ["Writing sql/rollup_daily.sql", "Running the migration dry run"] },
  { app: "antigravity", machine: "SERVER", project: "platform", role: "system", title: "Log retention policy", steps: ["Reading logrotate config", "Updating retention to 30 days"] },
  { app: "codex", machine: "SERVER", project: "platform", role: "backend", title: "Rate limiter for public API", steps: ["Editing src/limits/bucket.ts", "Running go test ./limits"] },
];

const MACHINES: { id: MachineId; os: string; cpuModel: string; cores: number; memTotal: number; diskTotal: number; lanIp: string; tailscaleIp: string }[] = [
  { id: "WORKSTATION", os: "Windows 11 Pro", cpuModel: "16-core desktop CPU", cores: 32, memTotal: 64 * 2 ** 30, diskTotal: 2000 * 2 ** 30, lanIp: "192.168.1.20", tailscaleIp: "100.64.0.10" },
  { id: "LAPTOP", os: "macOS 26", cpuModel: "8-core laptop CPU", cores: 8, memTotal: 16 * 2 ** 30, diskTotal: 512 * 2 ** 30, lanIp: "192.168.1.30", tailscaleIp: "100.64.0.11" },
  { id: "SERVER", os: "Ubuntu 26.04", cpuModel: "6-core server CPU", cores: 12, memTotal: 32 * 2 ** 30, diskTotal: 1000 * 2 ** 30, lanIp: "192.168.1.40", tailscaleIp: "100.64.0.12" },
];

function wave(now: number, periodMs: number, offset: number): number {
  return (Math.sin((now / periodMs + offset) * Math.PI * 2) + 1) / 2;
}

function stateOf(seat: DemoSeat, index: number, now: number): AgentState {
  if (seat.question) return "waiting";
  const phase = Math.floor(now / 45_000 + index * 1.7) % 6;
  return phase === 5 ? "idle" : phase % 2 === 0 ? "working" : "thinking";
}

export function demoAgents(now = Date.now()): AgentInfo[] {
  return SEATS.map((seat, index) => {
    const state = stateOf(seat, index, now);
    const step = seat.steps[Math.floor(now / 20_000 + index) % seat.steps.length];
    const at = new Date(now - (index % 4) * 40_000).toISOString();
    return {
      id: `${seat.app}:${seat.machine}:demo-${index}`,
      app: seat.app,
      machine: seat.machine,
      title: seat.title,
      project: seat.project,
      role: seat.role,
      state,
      detail: state === "idle" ? "Turn finished" : step,
      task: seat.title,
      cwd: `/work/${seat.project}`,
      sessionId: `demo-${index}`,
      parentId: null,
      updatedAt: at,
      lastActivityAt: at,
      files: [{ path: `/work/${seat.project}/${step.split(" ").pop() ?? "README.md"}`, at }],
      pending: state === "waiting" && seat.question ? { question: seat.question.text, options: seat.question.options, askedAt: new Date(now - 90_000 - index * 30_000).toISOString(), kind: "question" } : null,
    };
  });
}

export function demoHealth(now = Date.now()): MachineHealth[] {
  return MACHINES.map((machine, index) => ({
    id: machine.id,
    online: true,
    source: index === 0 ? "local" : "collector",
    cpu: Math.round(18 + 50 * wave(now, 90_000, index / 3)),
    cpuModel: machine.cpuModel,
    cores: machine.cores,
    memUsed: Math.round(machine.memTotal * (0.42 + 0.2 * wave(now, 120_000, index / 5))),
    memTotal: machine.memTotal,
    netRxBps: Math.round(2_000_000 * wave(now, 30_000, index / 2)),
    netTxBps: Math.round(600_000 * wave(now, 40_000, index / 4)),
    diskUsed: Math.round(machine.diskTotal * (0.38 + index * 0.12)),
    diskTotal: machine.diskTotal,
    gpu: null,
    os: machine.os,
    lanIp: machine.lanIp,
    tailscaleIp: machine.tailscaleIp,
    uptimeSec: 86_400 * (3 + index * 5) + 3_600 * index,
    checkedAt: new Date(now).toISOString(),
  }));
}

export function demoQuota(now = Date.now()): QuotaSnapshot {
  const reset = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  return {
    connected: true,
    fetchedAt: new Date(now).toISOString(),
    rows: [
      { app: "claude", account: "team@example.com", window: "5h", remaining: 64, resetsAt: reset(2) },
      { app: "claude", account: "team@example.com", window: "Week", remaining: 81, resetsAt: reset(80) },
      { app: "codex", account: "dev@example.com", window: "5h", remaining: 47, resetsAt: reset(3) },
      { app: "codex", account: "dev@example.com", window: "Week", remaining: 72, resetsAt: reset(96) },
    ],
  };
}

export function demoSites(now = Date.now()): SiteStatus[] {
  const checkedAt = new Date(now).toISOString();
  return [
    { url: "https://shop.example.com/", label: "shop.example.com", status: 200, ok: true, latencyMs: 140, checkedAt, note: "" },
    { url: "https://docs.example.com/", label: "docs.example.com", status: 200, ok: true, latencyMs: 92, checkedAt, note: "" },
    { url: "https://api.example.com/health", label: "api.example.com", status: 200, ok: true, latencyMs: 61, checkedAt, note: "" },
  ];
}

export function demoSkills(): SkillsSnapshot {
  const groups = [
    { source: "Claude skills", count: 18, names: ["frontend-design", "code-review", "testing-patterns", "api-design", "release-notes"] },
    { source: "Codex skills", count: 11, names: ["refactor", "migrations", "ci-fixes", "security-review"] },
    { source: "Team skills", count: 7, names: ["brand-voice", "spacing", "onboarding"] },
  ];
  return { connected: true, note: "", total: groups.reduce((sum, group) => sum + group.count, 0), groups };
}

export function demoProjects(now = Date.now()): ProjectsSnapshot {
  const day = (days: number) => new Date(now - days * 86_400_000).toISOString();
  return {
    connected: true,
    note: "",
    fetchedAt: new Date(now).toISOString(),
    repos: [
      { name: "storefront", url: "https://github.com/example/storefront", isPrivate: false, isArchived: false, pushedAt: day(0), release: { tag: "v2.4.0", publishedAt: day(2) }, deploy: { environment: "production", state: "success", at: day(0) }, ci: "success" },
      { name: "mobile-app", url: "https://github.com/example/mobile-app", isPrivate: false, isArchived: false, pushedAt: day(1), release: { tag: "v1.9.3", publishedAt: day(6) }, deploy: null, ci: "success" },
      { name: "platform", url: "https://github.com/example/platform", isPrivate: false, isArchived: false, pushedAt: day(0), release: { tag: "v5.1.0", publishedAt: day(4) }, deploy: { environment: "production", state: "success", at: day(1) }, ci: "in_progress" },
      { name: "docs-site", url: "https://github.com/example/docs-site", isPrivate: false, isArchived: false, pushedAt: day(3), release: null, deploy: null, ci: "success" },
    ],
  };
}
