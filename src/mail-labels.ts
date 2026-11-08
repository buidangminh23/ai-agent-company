import type { MailAccount, MailMessage } from "../shared/inbox.ts";

export const LABEL_PREFIX = "label:";

const LABEL_COLORS = ["#16a765", "#4986e7", "#8e63ce", "#e66550", "#2da2bb", "#d06b64", "#cf8933", "#3dc789", "#b65775", "#5c6bc0", "#a46a21", "#41236d"];
const MAX_CHIPS = 2;

export interface LabelNode {
  key: string;
  path: string;
  name: string;
  depth: number;
  unread: number;
  total: number;
  color: string;
  url: string;
}

export interface LabelRow {
  message: MailMessage;
  account: number;
}

export interface Chip {
  name: string;
  color: string;
  suggested: boolean;
}

export function labelKey(path: string): string {
  return path.trim().toLocaleLowerCase("vi");
}

export function labelColor(path: string): string {
  let hash = 0;
  for (const char of labelKey(path)) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return LABEL_COLORS[hash % LABEL_COLORS.length];
}

export function labelUrl(accountUrl: string | undefined, path: string): string {
  const base = (accountUrl ?? "https://mail.google.com/mail/").replace(/#.*$/, "");
  return `${base}#label/${encodeURIComponent(path).replace(/%20/g, "+")}`;
}

export function mergeLabels(accounts: MailAccount[]): LabelNode[] {
  const merged = new Map<string, LabelNode>();
  for (const account of accounts) {
    for (const label of account.labels ?? []) {
      const key = labelKey(label.path);
      const known = merged.get(key);
      if (known) {
        known.unread += label.unread;
        known.total += label.total;
        continue;
      }
      const parts = label.path.split("/");
      merged.set(key, { key, path: label.path, name: parts[parts.length - 1], depth: parts.length - 1, unread: label.unread, total: label.total, color: labelColor(label.path), url: labelUrl(account.url, label.path) });
    }
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path, "vi", { sensitivity: "base" }));
}

export function labelRows(accounts: MailAccount[], key: string): LabelRow[] {
  const seen = new Set<string>();
  const rows: LabelRow[] = [];
  accounts.forEach((account, index) => {
    for (const label of account.labels ?? []) {
      if (labelKey(label.path) !== key) continue;
      for (const message of label.recent) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        rows.push({ message, account: index });
      }
    }
  });
  return rows.sort((a, b) => Date.parse(b.message.at) - Date.parse(a.message.at));
}

export function messageChips(message: MailMessage, currentKey: string | null): { chips: Chip[]; more: number } {
  const own = (message.labels ?? []).filter((path) => labelKey(path) !== currentKey);
  if (!own.length && message.suggested) return { chips: [{ name: message.suggested, color: labelColor(message.suggested), suggested: true }], more: 0 };
  return { chips: own.slice(0, MAX_CHIPS).map((name) => ({ name, color: labelColor(name), suggested: false })), more: Math.max(0, own.length - MAX_CHIPS) };
}
