import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EN } from "./i18n-en.ts";
import { L, setLang } from "./i18n.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIETNAMESE = /[ăâđêôơưạảãấầẩẫậắằẳẵặẹẻẽếềểễệỉĩịọỏõốồổỗộớờởỡợụủũứừửữựỳỷỹỵĂÂĐÊÔƠƯ]/;
const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort().join(",");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

test("every English entry keeps its placeholders and contains no Vietnamese", () => {
  for (const [vi, en] of Object.entries(EN)) {
    assert.equal(placeholders(en), placeholders(vi), vi);
    assert.ok(!VIETNAMESE.test(en), en);
  }
});

test("every translated string used in the code has an English entry", () => {
  const missing: string[] = [];
  for (const file of ["src", "shared", "server"].flatMap((dir) => sourceFiles(path.join(ROOT, dir)))) {
    for (const match of readFileSync(file, "utf8").matchAll(/\bL\(("(?:[^"\\]|\\.)*")/g)) {
      const key = JSON.parse(match[1]) as string;
      if (VIETNAMESE.test(key) && !(key in EN)) missing.push(`${path.relative(ROOT, file)}: ${key.slice(0, 80)}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("L switches language and fills placeholders", () => {
  try {
    setLang("en");
    assert.equal(L("{0} phút trước", 5), "5 min ago");
    assert.equal(L("Chuỗi chưa dịch {0}", 1), "Chuỗi chưa dịch 1");
    setLang("vi");
    assert.equal(L("{0} phút trước", 5), "5 phút trước");
  } finally {
    setLang(null);
  }
});
