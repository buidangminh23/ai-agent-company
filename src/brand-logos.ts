import { L } from "../shared/i18n.ts";
import { escapeHtml } from "./markdown.ts";

type Brand = "claudecode" | "claude" | "codex" | "openai" | "github" | "gemini" | "grok" | "kimi" | "qwen" | "deepseek" | "zhipu" | "meta";

const BRANDS: [Brand, string, RegExp][] = [
  ["claudecode", "Claude Code", /claude[\s-]?code/],
  ["claude", "Claude", /claude/],
  ["codex", "Codex", /codex/],
  ["openai", "ChatGPT", /chatgpt|openai|\bgpt/],
  ["github", "GitHub", /github|copilot/],
  ["gemini", "Gemini", /gemini/],
  ["grok", "Grok", /grok/],
  ["kimi", "Kimi", /kimi/],
  ["qwen", "Qwen", /qwen/],
  ["deepseek", "DeepSeek", /deepseek/],
  ["zhipu", "GLM", /zhipu|\bglm|z\.ai/],
  ["meta", "Meta", /\bmeta\b|llama/],
];
const LABELS = new Map(BRANDS.map(([key, label]) => [key, label]));
const PACKAGE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2.5 4.8 8 2l5.5 2.8v6.4L8 14l-5.5-2.8V4.8Z"/><path d="M2.5 4.8 8 7.6l5.5-2.8M8 7.6V14"/></svg>';

export function brandsOf(...texts: (string | null | undefined)[]): Brand[] {
  const found: Brand[] = [];
  for (const raw of texts) {
    let source = (raw ?? "").toLowerCase().replace(/openai[\s-]+codex/g, "codex");
    for (const [key, , pattern] of BRANDS) {
      if (!pattern.test(source)) continue;
      if (!found.includes(key)) found.push(key);
      source = source.replace(new RegExp(pattern.source, "g"), " ");
    }
  }
  return found;
}

function mark(brand: Brand | null, size: number): string {
  if (!brand) return L("<span class=\"pw-brand pw-brand-none\" style=\"--s:{0}px\" title=\"Sản phẩm khác\">{1}</span>", size, PACKAGE);
  return `<img class="pw-brand" src="/brands/${brand}.svg" alt="" width="${size}" height="${size}" style="--s:${size}px" loading="lazy" decoding="async" title="${escapeHtml(LABELS.get(brand) ?? brand)}">`;
}

export function brandSlot(brands: Brand[]): string {
  const extra = brands.length > 1 ? `<span class="pw-brand-more">+${brands.length - 1}</span>` : "";
  return `<span class="pw-brand-slot" aria-hidden="true">${mark(brands[0] ?? null, 20)}${extra}</span>`;
}

export function brandChips(brands: Brand[]): string {
  if (!brands.length) return "";
  return L("<ul class=\"pw-brand-chips\" aria-label=\"Thương hiệu trong đơn\">{0}</ul>", brands.map((brand) => `<li>${mark(brand, 18)}<span>${escapeHtml(LABELS.get(brand) ?? brand)}</span></li>`).join(""));
}

export function brandIcon(brands: Brand[], size = 16): string {
  return mark(brands[0] ?? null, size);
}
