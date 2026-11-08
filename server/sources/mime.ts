import { parseHeaders } from "./imap.ts";

export interface MimeContent {
  headers: Record<string, string>;
  html: string | null;
  text: string | null;
  attachments: string[];
}

interface Leaf {
  type: string;
  charset: string;
  disposition: string;
  name: string;
  body: string;
  encoding: string;
}

const MAX_DEPTH = 8;

function splitHead(raw: string): [string, string] {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match) return [raw, ""];
  return [raw.slice(0, match.index), raw.slice(match.index + match[0].length)];
}

export function headerParams(value: string): { value: string; params: Record<string, string> } {
  const [first, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase().replace(/\*$/, "");
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in params)) params[key] = val.replace(/^utf-8''/i, "");
  }
  return { value: first.trim().toLowerCase(), params };
}

function decodeTransfer(body: string, encoding: string): Buffer {
  if (encoding === "base64") return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (encoding === "quoted-printable") {
    const joined = body.replace(/=\r?\n/g, "");
    const out: number[] = [];
    for (let i = 0; i < joined.length; i++) {
      const hex = joined.slice(i + 1, i + 3);
      if (joined[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(joined.charCodeAt(i) & 0xff);
    }
    return Buffer.from(out);
  }
  return Buffer.from(body, "latin1");
}

function decodeText(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function collect(raw: string, depth: number, leaves: Leaf[]): void {
  const [head, body] = splitHead(raw);
  const headers = parseHeaders(Buffer.from(head, "latin1").toString("utf8"));
  const type = headerParams(headers["content-type"] ?? "text/plain");
  const disposition = headerParams(headers["content-disposition"] ?? "");
  const encoding = (headers["content-transfer-encoding"] ?? "").trim().toLowerCase();
  if (type.value.startsWith("multipart/") && type.params.boundary && depth < MAX_DEPTH) {
    const marker = `--${type.params.boundary}`;
    const sections = body.split(marker).slice(1);
    for (const section of sections) {
      if (section.startsWith("--")) break;
      collect(section.replace(/^\r?\n/, "").replace(/\r?\n$/, ""), depth + 1, leaves);
    }
    return;
  }
  if (type.value === "message/rfc822" && depth < MAX_DEPTH) {
    collect(decodeTransfer(body, encoding).toString("latin1"), depth + 1, leaves);
    return;
  }
  leaves.push({ type: type.value, charset: type.params.charset ?? "", disposition: disposition.value, name: disposition.params.filename ?? type.params.name ?? "", body, encoding });
}

export function parseMime(raw: Buffer): MimeContent {
  const source = raw.toString("latin1");
  const [head] = splitHead(source);
  const headers = parseHeaders(Buffer.from(head, "latin1").toString("utf8"));
  const leaves: Leaf[] = [];
  collect(source, 0, leaves);
  const inline = leaves.filter((leaf) => leaf.disposition !== "attachment" && !leaf.name);
  const pick = (type: string) => {
    const leaf = inline.find((entry) => entry.type === type);
    return leaf ? decodeText(decodeTransfer(leaf.body, leaf.encoding), leaf.charset) : null;
  };
  const attachments = leaves.filter((leaf) => leaf.name && !(leaf.type.startsWith("image/") && leaf.disposition !== "attachment")).map((leaf) => leaf.name);
  return { headers, html: pick("text/html"), text: pick("text/plain"), attachments };
}
