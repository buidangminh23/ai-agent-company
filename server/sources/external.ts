import type { QuotaRow, QuotaSnapshot, SiteStatus } from "../../shared/types.ts";

const QUOTA_URL = process.env.MSC_QUOTA_URL ?? "http://127.0.0.1:6736/v1/limits";
const FETCH_TIMEOUT_MS = 8000;

export function parseSites(raw: string): { url: string; label: string }[] {
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
    const [url, label] = entry.split("|").map((part) => part.trim());
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? [{ url: parsed.href, label: label || parsed.host }] : [];
    } catch {
      return [];
    }
  });
}

export const SITES = parseSites(process.env.MSC_SITES ?? "");

const WINDOW_LABELS: Record<string, string> = {
  session: "5h",
  weekly: "Tuần",
  claude: "5h",
  claudeWeekly: "Tuần",
  fable: "Fable",
};

export interface QuotaLayout {
  providerOrder?: string[];
  metricOrder?: Record<string, string[]>;
}

function rank(order: readonly string[] | undefined, id: string): number {
  const index = order?.indexOf(id) ?? -1;
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function byRank<T>(entries: [string, T][], order: readonly string[] | undefined, id: (key: string) => string): [string, T][] {
  return entries.map((entry, index) => ({ entry, index, at: rank(order, id(entry[0])) })).sort((a, b) => a.at - b.at || a.index - b.index).map(({ entry }) => entry);
}

export function quotaRows(providers: Record<string, any>, layout: QuotaLayout | null): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const [key, provider] of byRank(Object.entries<any>(providers ?? {}), layout?.providerOrder, (id) => id)) {
    const app = key.split("@")[0];
    const account = String(provider.displayName ?? app).split("·").pop()?.trim() ?? app;
    for (const [name, r] of byRank(Object.entries<any>(provider.resources ?? {}), layout?.metricOrder?.[key], (metric) => `${key}.${metric}`)) {
      if (!(name in WINDOW_LABELS) || typeof r?.remaining !== "number") continue;
      rows.push({ app, account, window: WINDOW_LABELS[name], remaining: r.remaining, resetsAt: r.resetsAt ?? null });
    }
  }
  return rows;
}

async function readQuotaLayout(): Promise<QuotaLayout | null> {
  try {
    const url = new URL("/v1/app/load_document", QUOTA_URL);
    url.searchParams.set("q", JSON.stringify({ name: "layout" }));
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return res.ok ? ((await res.json()) as QuotaLayout) : null;
  } catch {
    return null;
  }
}

export async function readQuota(): Promise<QuotaSnapshot> {
  try {
    const [res, layout] = await Promise.all([fetch(QUOTA_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }), readQuotaLayout()]);
    const json: any = await res.json();
    return { connected: true, rows: quotaRows(json.providers ?? {}, layout), fetchedAt: json.generatedAt ?? new Date().toISOString() };
  } catch {
    return { connected: false, rows: [], fetchedAt: null };
  }
}

function siteNote(status: number | null): string {
  if (status === null) return "Không phản hồi";
  if (status === 530) return "Cloudflare Tunnel không nối được máy chủ";
  if (status >= 500) return "Lỗi máy chủ";
  if (status >= 400) return "Lỗi truy cập";
  return "Hoạt động";
}

export async function checkSite(url: string, label: string): Promise<SiteStatus> {
  const started = performance.now();
  let status: number | null = null;
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    status = res.status;
    await res.body?.cancel();
  } catch {}
  return {
    url,
    label,
    status,
    ok: status !== null && status < 400,
    latencyMs: status === null ? null : Math.round(performance.now() - started),
    checkedAt: new Date().toISOString(),
    note: siteNote(status),
  };
}
