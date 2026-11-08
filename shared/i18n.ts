import { EN } from "./i18n-en.ts";

export type Lang = "vi" | "en";
export const LANGS: readonly Lang[] = ["en", "vi"];
export const LANG_STORAGE_KEY = "msc-lang";

let forced: Lang | null = null;
let browserLang: Lang | null = null;

function normalize(value: unknown): Lang | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (text.startsWith("vi")) return "vi";
  if (text.startsWith("en")) return "en";
  return null;
}

function detectBrowser(): Lang {
  if (browserLang) return browserLang;
  let stored: Lang | null = null;
  try { stored = normalize(globalThis.localStorage?.getItem(LANG_STORAGE_KEY)); } catch {}
  const query = normalize(new URLSearchParams(globalThis.location?.search ?? "").get("lang"));
  const languages = (globalThis.navigator?.languages ?? [globalThis.navigator?.language]).map(normalize).filter((lang): lang is Lang => lang !== null);
  browserLang = query ?? stored ?? languages[0] ?? "en";
  return browserLang;
}

export function getLang(): Lang {
  if (forced) return forced;
  if (typeof window !== "undefined" && typeof document !== "undefined") return detectBrowser();
  const env = globalThis.process?.env;
  return normalize(env?.MSC_LANG) ?? (env?.NODE_TEST_CONTEXT ? "vi" : "en");
}

export function setLang(lang: Lang | null): void {
  forced = lang;
}

export function storeLang(lang: Lang): void {
  try { globalThis.localStorage?.setItem(LANG_STORAGE_KEY, lang); } catch {}
  browserLang = lang;
}

export function locale(): string {
  return getLang() === "en" ? "en-GB" : "vi-VN";
}

export function L(text: string, ...args: unknown[]): string {
  const base = getLang() === "en" ? EN[text] ?? text : text;
  return args.length ? base.replace(/\{(\d+)\}/g, (match, index: string) => (Number(index) < args.length ? String(args[Number(index)]) : match)) : base;
}
