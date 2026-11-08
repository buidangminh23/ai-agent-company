import { L } from "../../shared/i18n.ts";
import type { YouTubeFeed, YouTubeVideo } from "../../shared/youtube.ts";

const CHANNEL_ID = (process.env.MSC_YOUTUBE_CHANNEL_ID ?? "").trim();
const FEED_URL = "https://www.youtube.com/feeds/videos.xml";
const CACHE_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
    const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : whole;
  });
}

function tag(xml: string, name: string): string | null {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decode(match[1].trim()) : null;
}

export function parseYouTubeFeed(xml: string): { channelTitle: string; videos: YouTubeVideo[] } {
  const head = xml.split("<entry>")[0];
  const videos: YouTubeVideo[] = [];
  for (const block of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const id = tag(block, "yt:videoId");
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) continue;
    videos.push({ id, title: tag(block, "title") ?? id, published: tag(block, "published") ?? "" });
  }
  videos.sort((a, b) => Date.parse(b.published || "0") - Date.parse(a.published || "0"));
  return { channelTitle: tag(head, "title") ?? "YouTube", videos };
}

let cached: YouTubeFeed = { connected: false, note: L("Đang đọc kênh YouTube"), channelId: CHANNEL_ID, channelTitle: "YouTube", videos: [], fetchedAt: null };
let nextFetchAt = 0;
let pending: Promise<YouTubeFeed> | null = null;

export async function fetchChannelRss(channelId: string, fetchImpl: typeof fetch = fetch): Promise<{ channelTitle: string; videos: YouTubeVideo[] }> {
  const res = await fetchImpl(`${FEED_URL}?channel_id=${encodeURIComponent(channelId)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseYouTubeFeed(await res.text());
}

async function fetchFeed(): Promise<YouTubeFeed> {
  if (!CHANNEL_ID) {
    cached = { ...cached, connected: false, note: L("Chưa đặt MSC_YOUTUBE_CHANNEL_ID") };
    nextFetchAt = Date.now() + CACHE_MS;
    return cached;
  }
  try {
    const { channelTitle, videos } = await fetchChannelRss(CHANNEL_ID);
    cached = { connected: true, note: L("{0} video công khai", videos.length), channelId: CHANNEL_ID, channelTitle, videos, fetchedAt: new Date().toISOString() };
    nextFetchAt = Date.now() + CACHE_MS;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    cached = { ...cached, connected: cached.videos.length > 0, note: cached.videos.length ? L("Đang dùng danh sách cũ, lỗi đọc lại: {0}", reason) : L("Không đọc được kênh YouTube: {0}", reason) };
    nextFetchAt = Date.now() + RETRY_MS;
  }
  return cached;
}

export function readYouTube(): Promise<YouTubeFeed> {
  if (Date.now() < nextFetchAt) return Promise.resolve(cached);
  pending ??= fetchFeed().finally(() => (pending = null));
  return pending;
}
