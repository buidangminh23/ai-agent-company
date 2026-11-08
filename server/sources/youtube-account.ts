import { L } from "../../shared/i18n.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseIsoDuration, type YtAccount, type YtChannel, type YtDeviceCode, type YtFeedKind, type YtFeedResult, type YtPlaylist, type YtStatus, type YtVideo } from "../../shared/youtube.ts";
import { fetchChannelRss } from "./youtube.ts";

const DEVICE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API_URL = "https://www.googleapis.com/youtube/v3/";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const TIMEOUT_MS = 12_000;
const REFRESH_MARGIN_MS = 60_000;
const SLOW_DOWN_MS = 5_000;
const PAGE = 50;
const MAX_SUB_PAGES = 4;
const HOME_CHANNELS = 60;
const HOME_SIZE = 60;
const RSS_CONCURRENCY = 8;
const SEARCH_SIZE = 30;
const CACHE_LIMIT = 200;
const MINUTE = 60_000;
const TTL: Record<YtFeedKind, number> = { home: 10 * MINUTE, trending: 30 * MINUTE, search: 60 * MINUTE, liked: 10 * MINUTE, playlists: 30 * MINUTE, playlist: 15 * MINUTE, subscriptions: 360 * MINUTE, channel: 15 * MINUTE };
const VIDEO_PARTS = "snippet,contentDetails,statistics";
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const CATEGORY_ID = /^\d{1,3}$/;
const QUOTA_NOTE = L("Hết hạn mức API YouTube hôm nay. Google đặt lại lúc 0 giờ giờ Thái Bình Dương (14–15 giờ Việt Nam).");

export class YouTubeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  region: string;
}

interface Session {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  account: YtAccount | null;
}

interface Pending {
  deviceCode: string;
  code: YtDeviceCode;
  intervalMs: number;
  expiresAt: number;
}

type Json = Record<string, any>;

export function youtubeConfigFromEnv(): YouTubeConfig {
  return {
    clientId: (process.env.MSC_YOUTUBE_CLIENT_ID ?? "").trim(),
    clientSecret: (process.env.MSC_YOUTUBE_CLIENT_SECRET ?? "").trim(),
    region: (process.env.MSC_YOUTUBE_REGION ?? "VN").trim().toUpperCase() || "VN",
  };
}

const DESCRIPTION_CHARS = 200;
const AVATAR_LIMIT = 2000;

function thumb(thumbnails: Json | undefined): string {
  return thumbnails?.medium?.url ?? thumbnails?.high?.url ?? thumbnails?.default?.url ?? "";
}

function sharpThumb(thumbnails: Json | undefined): string {
  return thumbnails?.maxres?.url ?? thumbnails?.standard?.url ?? thumbnails?.high?.url ?? thumb(thumbnails);
}

export function toVideo(item: Json): YtVideo {
  const snippet = item.snippet ?? {};
  const views = Number(item.statistics?.viewCount);
  return {
    id: String(item.id),
    title: String(snippet.title ?? ""),
    channelId: String(snippet.channelId ?? ""),
    channelTitle: String(snippet.channelTitle ?? ""),
    channelThumbnail: "",
    published: String(snippet.publishedAt ?? ""),
    thumbnail: sharpThumb(snippet.thumbnails) || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
    description: String(snippet.description ?? "").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_CHARS),
    durationSec: parseIsoDuration(item.contentDetails?.duration),
    views: Number.isFinite(views) ? views : null,
    live: snippet.liveBroadcastContent === "live",
  };
}

function emptyResult(kind: YtFeedKind, title: string, note = ""): YtFeedResult {
  return { kind, title, videos: [], channels: [], playlists: [], note };
}

async function mapLimit<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]).then((value) => ({ status: "fulfilled", value }) as const, (reason) => ({ status: "rejected", reason }) as const);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class YouTubeAccount {
  private session: Session | null;
  private pending: Pending | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private note = "";
  private refreshing: Promise<string> | null = null;
  private readonly cache = new Map<string, { at: number; value: YtFeedResult }>();
  private readonly avatars = new Map<string, string>();
  private readonly file: string;
  private readonly fetchImpl: typeof fetch;
  private readonly config: YouTubeConfig;
  private readonly now: () => number;

  constructor(file = (process.env.MSC_YOUTUBE_SESSION_FILE ?? "").trim() || path.join(os.homedir(), ".msc-company", "youtube-session.json"), fetchImpl: typeof fetch = fetch, config: YouTubeConfig = youtubeConfigFromEnv(), now: () => number = Date.now) {
    this.file = file;
    this.fetchImpl = fetchImpl;
    this.config = config;
    this.now = now;
    this.session = this.load();
  }

  status(): YtStatus {
    const configured = Boolean(this.config.clientId && this.config.clientSecret);
    const pending = this.pending && this.pending.expiresAt > this.now() ? this.pending.code : null;
    const note = !configured ? L("Hub chưa có client OAuth YouTube. Chạy scripts/setup-youtube.ps1 để cài.") : this.note;
    return { configured, connected: Boolean(this.session), account: this.session?.account ?? null, pending, note };
  }

  async startDeviceFlow(): Promise<YtStatus> {
    if (!this.config.clientId || !this.config.clientSecret) throw new YouTubeError(409, L("Hub chưa có client OAuth YouTube."));
    const body = await this.post(DEVICE_URL, { client_id: this.config.clientId, scope: SCOPE });
    if (!body.device_code || !body.user_code) throw new YouTubeError(502, L("Google không cấp mã đăng nhập: {0}", body.error_description ?? body.error ?? L("không rõ lỗi")));
    const expiresAt = this.now() + Number(body.expires_in ?? 1800) * 1000;
    this.pending = {
      deviceCode: String(body.device_code),
      code: { userCode: String(body.user_code), verificationUrl: String(body.verification_url ?? body.verification_uri ?? "https://www.google.com/device"), expiresAt: new Date(expiresAt).toISOString() },
      intervalMs: Math.max(1, Number(body.interval ?? 5)) * 1000,
      expiresAt,
    };
    this.note = "";
    this.schedulePoll();
    return this.status();
  }

  cancelDeviceFlow(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pending = null;
  }

  async pollOnce(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    if (pending.expiresAt <= this.now()) {
      this.note = L("Mã đăng nhập đã hết hạn, bấm kết nối lại.");
      return this.cancelDeviceFlow();
    }
    const body = await this.post(TOKEN_URL, { client_id: this.config.clientId, client_secret: this.config.clientSecret, device_code: pending.deviceCode, grant_type: DEVICE_GRANT });
    if (body.error === "authorization_pending") return this.schedulePoll();
    if (body.error === "slow_down") {
      pending.intervalMs += SLOW_DOWN_MS;
      return this.schedulePoll();
    }
    this.cancelDeviceFlow();
    if (!body.access_token || !body.refresh_token) {
      this.note = body.error === "access_denied" ? L("Sếp đã từ chối quyền truy cập YouTube.") : L("Đăng nhập YouTube không thành công: {0}", body.error_description ?? body.error ?? L("không rõ lỗi"));
      return;
    }
    this.save({ refreshToken: String(body.refresh_token), accessToken: String(body.access_token), expiresAt: this.now() + Number(body.expires_in ?? 3600) * 1000, account: null });
    await this.loadAccount();
  }

  async logout(): Promise<YtStatus> {
    const token = this.session?.refreshToken;
    this.clear("");
    if (token) await this.post(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {}).catch(() => undefined);
    return this.status();
  }

  async feed(kind: YtFeedKind, arg = ""): Promise<YtFeedResult> {
    if (!this.session) throw new YouTubeError(401, L("Chưa kết nối tài khoản YouTube."));
    const key = `${kind}:${arg}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < TTL[kind]) return hit.value;
    const value = await this.build(kind, arg);
    this.remember(key, value);
    return value;
  }

  private build(kind: YtFeedKind, arg: string): Promise<YtFeedResult> {
    switch (kind) {
      case "home": return this.home();
      case "trending": return this.trending(arg);
      case "search": return this.search(arg);
      case "liked": return this.liked();
      case "playlists": return this.playlists();
      case "playlist": return this.playlist(arg);
      case "subscriptions": return this.subscriptionsFeed();
      case "channel": return this.channel(arg);
    }
  }

  private remember(key: string, value: YtFeedResult): void {
    this.cache.delete(key);
    this.cache.set(key, { at: this.now(), value });
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
  }

  private async home(): Promise<YtFeedResult> {
    const channels = (await this.feed("subscriptions")).channels.slice(0, HOME_CHANNELS);
    if (!channels.length) return { ...(await this.feed("trending")), kind: "home", title: L("Trang chủ"), note: L("Tài khoản chưa đăng ký kênh nào, đang hiện video thịnh hành.") };
    const feeds = await mapLimit(channels, RSS_CONCURRENCY, (channel) => fetchChannelRss(channel.id, this.fetchImpl));
    const latest = feeds.flatMap((result) => (result.status === "fulfilled" ? result.value.videos : []));
    latest.sort((a, b) => Date.parse(b.published || "0") - Date.parse(a.published || "0"));
    const failed = feeds.filter((result) => result.status === "rejected").length;
    const videos = await this.details(latest.slice(0, HOME_SIZE).map((video) => video.id));
    return { ...emptyResult("home", L("Trang chủ"), failed ? L("{0} kênh chưa đọc được video mới.", failed) : ""), videos, channels };
  }

  private async trending(category: string): Promise<YtFeedResult> {
    if (category && !CATEGORY_ID.test(category)) throw new YouTubeError(400, L("Mã thể loại không hợp lệ."));
    const body = await this.api("videos", { part: VIDEO_PARTS, chart: "mostPopular", regionCode: this.config.region, maxResults: PAGE, ...(category && category !== "0" ? { videoCategoryId: category } : {}) });
    const videos = (body.items ?? []).map(toVideo);
    await this.fillAvatars(videos);
    return { ...emptyResult("trending", L("Thịnh hành")), videos };
  }

  private async search(query: string): Promise<YtFeedResult> {
    const q = query.trim();
    if (!q || q.length > 200) throw new YouTubeError(400, L("Nhập từ khoá tìm kiếm (tối đa 200 ký tự)."));
    const body = await this.api("search", { part: "id", type: "video", q, maxResults: SEARCH_SIZE, regionCode: this.config.region, relevanceLanguage: "vi" });
    const ids = (body.items ?? []).map((item: Json) => item.id?.videoId).filter(Boolean);
    return { ...emptyResult("search", L("Kết quả cho “{0}”", q)), videos: await this.details(ids) };
  }

  private async liked(): Promise<YtFeedResult> {
    const body = await this.api("videos", { part: VIDEO_PARTS, myRating: "like", maxResults: PAGE });
    const videos = (body.items ?? []).map(toVideo);
    await this.fillAvatars(videos);
    return { ...emptyResult("liked", L("Video đã thích")), videos };
  }

  private async playlists(): Promise<YtFeedResult> {
    const body = await this.api("playlists", { part: "snippet,contentDetails", mine: "true", maxResults: PAGE });
    const playlists: YtPlaylist[] = (body.items ?? []).map((item: Json) => ({ id: String(item.id), title: String(item.snippet?.title ?? ""), thumbnail: thumb(item.snippet?.thumbnails), count: Number(item.contentDetails?.itemCount ?? 0) }));
    return { ...emptyResult("playlists", L("Danh sách phát"), playlists.length ? "" : L("Tài khoản chưa có danh sách phát nào.")), playlists };
  }

  private async playlist(id: string): Promise<YtFeedResult> {
    if (!PLAYLIST_ID.test(id)) throw new YouTubeError(400, L("Mã danh sách phát không hợp lệ."));
    const [items, meta] = await Promise.all([
      this.api("playlistItems", { part: "contentDetails", playlistId: id, maxResults: PAGE }),
      this.api("playlists", { part: "snippet", id }),
    ]);
    const ids = (items.items ?? []).map((item: Json) => item.contentDetails?.videoId).filter(Boolean);
    return { ...emptyResult("playlist", String(meta.items?.[0]?.snippet?.title ?? L("Danh sách phát"))), videos: await this.details(ids) };
  }

  private async subscriptionsFeed(): Promise<YtFeedResult> {
    const channels: YtChannel[] = [];
    let pageToken = "";
    for (let page = 0; page < MAX_SUB_PAGES; page++) {
      const body = await this.api("subscriptions", { part: "snippet", mine: "true", order: "relevance", maxResults: PAGE, ...(pageToken ? { pageToken } : {}) });
      for (const item of body.items ?? []) {
        const id = item.snippet?.resourceId?.channelId;
        if (id) channels.push({ id: String(id), title: String(item.snippet?.title ?? ""), thumbnail: thumb(item.snippet?.thumbnails) });
      }
      pageToken = body.nextPageToken ?? "";
      if (!pageToken) break;
    }
    for (const channel of channels) this.rememberAvatar(channel.id, channel.thumbnail);
    return { ...emptyResult("subscriptions", L("Kênh đăng ký")), channels };
  }

  private async channel(id: string): Promise<YtFeedResult> {
    if (!CHANNEL_ID.test(id)) throw new YouTubeError(400, L("Mã kênh không hợp lệ."));
    const body = await this.api("channels", { part: "snippet,contentDetails", id });
    const channel = body.items?.[0];
    if (!channel) throw new YouTubeError(404, L("Không tìm thấy kênh."));
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    const items = uploads ? await this.api("playlistItems", { part: "contentDetails", playlistId: uploads, maxResults: PAGE }) : { items: [] };
    const ids = (items.items ?? []).map((item: Json) => item.contentDetails?.videoId).filter(Boolean);
    const info: YtChannel = { id, title: String(channel.snippet?.title ?? ""), thumbnail: thumb(channel.snippet?.thumbnails) };
    return { ...emptyResult("channel", info.title), videos: await this.details(ids), channels: [info] };
  }

  private async details(ids: string[]): Promise<YtVideo[]> {
    const unique = [...new Set(ids)];
    const found = new Map<string, YtVideo>();
    for (let i = 0; i < unique.length; i += PAGE) {
      const body = await this.api("videos", { part: VIDEO_PARTS, id: unique.slice(i, i + PAGE).join(","), maxResults: PAGE });
      for (const item of body.items ?? []) found.set(String(item.id), toVideo(item));
    }
    const videos = unique.flatMap((id) => found.get(id) ?? []);
    await this.fillAvatars(videos);
    return videos;
  }

  private rememberAvatar(id: string, url: string): void {
    if (!id || !url) return;
    this.avatars.delete(id);
    this.avatars.set(id, url);
    while (this.avatars.size > AVATAR_LIMIT) this.avatars.delete(this.avatars.keys().next().value!);
  }

  private async fillAvatars(videos: YtVideo[]): Promise<void> {
    const missing = [...new Set(videos.map((video) => video.channelId).filter((id) => id && !this.avatars.has(id)))];
    for (let i = 0; i < missing.length; i += PAGE) {
      const body = await this.api("channels", { part: "snippet", id: missing.slice(i, i + PAGE).join(","), maxResults: PAGE }).catch(() => ({ items: [] }));
      for (const item of body.items ?? []) this.rememberAvatar(String(item.id), thumb(item.snippet?.thumbnails));
    }
    for (const video of videos) video.channelThumbnail = this.avatars.get(video.channelId) ?? "";
  }

  private async api(resource: string, params: Record<string, string | number>, retried = false): Promise<Json> {
    const url = new URL(resource, API_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.accessToken(retried)}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 401 && !retried) return this.api(resource, params, true);
    const body = (await res.json().catch(() => ({}))) as Json;
    if (res.ok) return body;
    const reason = body.error?.errors?.[0]?.reason;
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") throw new YouTubeError(429, QUOTA_NOTE);
    if (res.status === 401) {
      this.clear(L("Phiên YouTube không còn hợp lệ, kết nối lại."));
      throw new YouTubeError(401, this.note);
    }
    throw new YouTubeError(res.status === 404 ? 404 : 502, L("YouTube báo lỗi: {0}", body.error?.message ?? `HTTP ${res.status}`));
  }

  private async accessToken(force: boolean): Promise<string> {
    const session = this.session;
    if (!session) throw new YouTubeError(401, L("Chưa kết nối tài khoản YouTube."));
    if (!force && session.expiresAt - REFRESH_MARGIN_MS > this.now()) return session.accessToken;
    this.refreshing ??= this.refresh(session).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(session: Session): Promise<string> {
    const body = await this.post(TOKEN_URL, { client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: session.refreshToken, grant_type: "refresh_token" });
    if (!body.access_token) {
      if (body.error === "invalid_grant") this.clear(L("Phiên YouTube đã hết hạn hoặc bị thu hồi, kết nối lại."));
      throw new YouTubeError(401, this.note || L("Không làm mới được phiên YouTube: {0}", body.error ?? L("không rõ lỗi")));
    }
    this.save({ ...session, accessToken: String(body.access_token), expiresAt: this.now() + Number(body.expires_in ?? 3600) * 1000, refreshToken: String(body.refresh_token ?? session.refreshToken) });
    return String(body.access_token);
  }

  private async loadAccount(): Promise<void> {
    try {
      const body = await this.api("channels", { part: "snippet", mine: "true" });
      const item = body.items?.[0];
      const account: YtAccount = item ? { id: String(item.id), title: String(item.snippet?.title ?? ""), thumbnail: thumb(item.snippet?.thumbnails) } : { id: "", title: L("Tài khoản Google"), thumbnail: "" };
      if (this.session) this.save({ ...this.session, account });
    } catch (error) {
      this.note = error instanceof Error ? error.message : String(error);
    }
  }

  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const interval = this.pending?.intervalMs ?? SLOW_DOWN_MS;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.pollOnce().catch((error) => {
        this.note = error instanceof Error ? error.message : String(error);
        if (this.pending) this.schedulePoll();
      });
    }, interval);
    this.pollTimer.unref?.();
  }

  private async post(url: string, form: Record<string, string>): Promise<Json> {
    const res = await this.fetchImpl(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return (await res.json().catch(() => ({}))) as Json;
  }

  private clear(note: string): void {
    this.cancelDeviceFlow();
    this.session = null;
    this.cache.clear();
    this.note = note;
    fs.rmSync(this.file, { force: true });
  }

  private load(): Session | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return raw?.refreshToken ? { refreshToken: String(raw.refreshToken), accessToken: String(raw.accessToken ?? ""), expiresAt: Number(raw.expiresAt) || 0, account: raw.account ?? null } : null;
    } catch {
      return null;
    }
  }

  private save(session: Session): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(session), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.session = session;
  }
}
