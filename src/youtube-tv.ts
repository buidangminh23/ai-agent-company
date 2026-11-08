import "./youtube-tv.css";
import { PlayerControls, type ControlPlayer, type VideoInfo } from "./youtube-controls.ts";
import { formatDuration, type YouTubeFeed, type YtChannel, type YtFeedKind, type YtFeedResult, type YtPlaylist, type YtStatus, type YtVideo } from "../shared/youtube.ts";

export const TV_WIDTH = 2400;
const PLAYER_WIDTH = 3840;
const PLAYER_HEIGHT = 2160;
const MINI_WIDTH = 600;
const MINI_MARGIN = 36;
const MINI_BAR = 108;
const GUIDE_CHANNELS = 7;
const CHIPS: [string, string][] = [["", "Tất cả"], ["10", "Âm nhạc"], ["20", "Trò chơi"], ["24", "Giải trí"], ["17", "Thể thao"], ["0", "Thịnh hành"]];
const API_SRC = "https://www.youtube.com/iframe_api";
const PLAYER_HOST = "https://www.youtube-nocookie.com";
const STATUS_POLL_MS = 3_000;
const STATE_PLAYING = 1;
const EMBED_BLOCKED = new Set([101, 150]);

const PATH = {
  menu: "M21 6H3V5h18v1zm0 5H3v1h18v-1zm0 6H3v1h18v-1z",
  search: "M16.296 16.996a8 8 0 11.707-.708l3.909 3.91-.707.707-3.909-3.909zM18 11a7 7 0 00-14 0 7 7 0 1014 0z",
  home: "M4 21V10.08l8-6.96 8 6.96V21h-6v-6h-4v6H4z",
  subs: "M10 18v-6l5 3-5 3zm7-15H7v1h10V3zm3 3H4v1h16V6zm2 3H2v12h20V9zM3 10h18v10H3V10z",
  you: "M4 20h14v1H3V6h1v14zM6 3v15h15V3H6zm2.02 14c.36-2.13 1.93-4.1 5.48-4.1s5.12 1.97 5.48 4.1H8.02zM11 8.5a2.5 2.5 0 015 0 2.5 2.5 0 01-5 0zm3.21 3.43A3.507 3.507 0 0017 8.5C17 6.57 15.43 5 13.5 5S10 6.57 10 8.5c0 1.69 1.2 3.1 2.79 3.43-3.48.26-5.4 2.42-5.78 5.07H7V4h13v13h-.01c-.38-2.65-2.31-4.81-5.78-5.07z",
  playlists: "M22 7H2v1h20V7zm-9 5H2v-1h11v1zm0 4H2v-1h11v1zm2 3v-8l7 4-7 4z",
  liked: "M18.77 11h-4.23l1.52-4.94C16.38 5.03 15.54 4 14.38 4c-.58 0-1.14.24-1.52.65L7 11H3v10h14.43c1.06 0 1.98-.67 2.19-1.61l1.34-6C21.23 12.15 20.18 11 18.77 11zM7 20H4v-8h3v8zm12.98-6.83-1.34 6c-.1.48-.61.83-1.21.83H8v-8.61l5.6-6.06c.19-.21.48-.33.78-.33.26 0 .5.11.63.3.07.1.15.26.09.47l-1.52 4.94-.4 1.29h5.58c.41 0 .8.17 1.03.46.13.15.26.4.19.74z",
  trending: "M14 2 7.36 9.25C6.1 10.62 5.5 12.3 5.5 14a6.5 6.5 0 0013 0c0-1.9-.86-3.73-2.32-5.04l-.71 1.6A3.99 3.99 0 0112 13a4 4 0 01-1.7-.38L14 8.5V2zm-2 18.5a5.5 5.5 0 01-5.5-5.5c0-1.45.52-2.88 1.6-4.06L13 5.6v2.5l-4.1 4.43.75.67A5 5 0 0016 11.05l.15-.35A5.95 5.95 0 0117.5 14a5.5 5.5 0 01-5.5 6.5z",
  chevron: "m9.4 18.4-.7-.7 5.6-5.6-5.7-5.7.7-.7 6.4 6.4-6.3 6.3z",
  expandMore: "m18 9.28-6.35 6.35-6.37-6.35.72-.71 5.64 5.65 5.65-5.65z",
  expandLess: "M18.4 14.6 12 8.3l-6.4 6.3.8.8L12 9.7l5.6 5.7z",
  fit: "M4 4h6v1H5v5H4V4zm10 0h6v6h-1V5h-5V4zM4 14h1v5h5v1H4v-6zm15 0h1v6h-6v-1h5v-5z",
  close: "m12.71 12 8.15 8.15-.71.71L12 12.71l-8.15 8.15-.71-.71L11.29 12 3.15 3.85l.71-.71L12 11.29l8.15-8.15.71.71L12.71 12z",
  play: "m7 4 12 8-12 8V4z",
  pause: "M9 19H7V5h2v14zm8-14h-2v14h2V5z",
  yourChannel: "M4 20h14v1H3V6h1v14zM6 3v15h15V3H6zm2.02 14c.36-2.13 1.93-4.1 5.48-4.1s5.12 1.97 5.48 4.1H8.02zM11 8.5a2.5 2.5 0 015 0 2.5 2.5 0 01-5 0zM20 17h-.01c-.38-2.65-2.31-4.81-5.78-5.07A3.507 3.507 0 0017 8.5C17 6.57 15.43 5 13.5 5S10 6.57 10 8.5c0 1.69 1.2 3.1 2.79 3.43-3.48.26-5.4 2.42-5.78 5.07H7V4h13v13z",
  person: "M12 2.5c-2.2 0-4 1.8-4 4s1.8 4 4 4 4-1.8 4-4-1.8-4-4-4zm0 7c-1.65 0-3-1.35-3-3s1.35-3 3-3 3 1.35 3 3-1.35 3-3 3zm0 3c-4.4 0-8 2.2-8 5v3h16v-3c0-2.8-3.6-5-8-5zm7 7H5v-2c0-2.15 3.13-4 7-4s7 1.85 7 4v2z",
};

type Mode = "browse" | "watch" | "mini";

interface YtPlayer extends ControlPlayer {
  loadPlaylist(playlist: string[], index?: number): void;
  setPlaybackQuality?(quality: string): void;
  getAvailableQualityLevels?(): string[];
  getVideoData(): { video_id?: string; title?: string; author?: string; isLive?: boolean };
}

interface YtNamespace {
  Player: new (el: HTMLElement, options: Record<string, unknown>) => YtPlayer;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

interface View {
  kind: YtFeedKind;
  arg: string;
}

let apiPromise: Promise<YtNamespace> | null = null;

function loadApi(): Promise<YtNamespace> {
  apiPromise ??= new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement("script");
    script.src = API_SRC;
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      reject(new Error("Không tải được trình phát YouTube."));
    };
    document.head.append(script);
  });
  return apiPromise;
}

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const compact = new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 });
const relative = new Intl.RelativeTimeFormat("vi", { numeric: "always" });
const AGES: [number, Intl.RelativeTimeFormatUnit][] = [[31_536_000, "year"], [2_592_000, "month"], [604_800, "week"], [86_400, "day"], [3_600, "hour"], [60, "minute"]];

function ago(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(seconds)) return "";
  const [size, unit] = AGES.find(([size]) => seconds >= size) ?? [1, "second" as const];
  return relative.format(-Math.floor(seconds / size), unit);
}

function stats(video: YtVideo): string {
  const count = video.views !== null ? compact.format(video.views) : "";
  const views = !count ? "" : video.live ? `${count} người đang xem` : `${count} lượt xem`;
  return [views, !video.live && video.published ? ago(video.published) : ""].filter(Boolean).join(" • ");
}

function badge(video: YtVideo): string {
  if (video.live) return '<span class="yt-badge yt-live">TRỰC TIẾP</span>';
  return video.durationSec ? `<span class="yt-badge">${formatDuration(video.durationSec)}</span>` : "";
}

function avatar(url: string, title: string, cls: string): string {
  return url ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy">` : `<span class="${cls} yt-avatar-letter" aria-hidden="true">${esc(title.slice(0, 1).toUpperCase())}</span>`;
}

function channelAttr(video: YtVideo): string {
  return video.channelId ? `data-channel="${esc(video.channelId)}"` : "disabled";
}

function videoCard(video: YtVideo, index: number): string {
  return `<div class="yt-card">
    <button type="button" class="yt-thumb" data-play="${index}" aria-label="${esc(video.title)}"><img src="${esc(video.thumbnail)}" alt="" loading="lazy">${badge(video)}</button>
    <div class="yt-details">
      <button type="button" class="yt-avatar-btn" ${channelAttr(video)} aria-label="${esc(video.channelTitle)}">${avatar(video.channelThumbnail, video.channelTitle, "yt-avatar")}</button>
      <div class="yt-text">
        <button type="button" class="yt-title" data-play="${index}" title="${esc(video.title)}">${esc(video.title)}</button>
        <button type="button" class="yt-byline" ${channelAttr(video)}>${esc(video.channelTitle)}</button>
        <span class="yt-stats">${esc(stats(video))}</span>
      </div>
    </div>
  </div>`;
}

function resultRow(video: YtVideo, index: number): string {
  return `<div class="yt-result">
    <button type="button" class="yt-thumb" data-play="${index}" aria-label="${esc(video.title)}"><img src="${esc(video.thumbnail)}" alt="" loading="lazy">${badge(video)}</button>
    <div class="yt-result-text">
      <button type="button" class="yt-title" data-play="${index}" title="${esc(video.title)}">${esc(video.title)}</button>
      <span class="yt-stats">${esc(stats(video))}</span>
      <button type="button" class="yt-result-channel" ${channelAttr(video)}>${avatar(video.channelThumbnail, video.channelTitle, "yt-avatar-sm")}<span>${esc(video.channelTitle)}</span></button>
      ${video.description ? `<p class="yt-snippet">${esc(video.description)}</p>` : ""}
    </div>
  </div>`;
}

function channelTile(channel: YtChannel): string {
  return `<button type="button" class="yt-channel-tile" data-channel="${esc(channel.id)}">${avatar(channel.thumbnail, channel.title, "yt-channel-avatar")}<strong>${esc(channel.title)}</strong></button>`;
}

function playlistTile(playlist: YtPlaylist): string {
  return `<button type="button" class="yt-playlist-tile" data-playlist="${esc(playlist.id)}"><span class="yt-thumb yt-stack"><img src="${esc(playlist.thumbnail)}" alt="" loading="lazy"><span class="yt-badge">${icon(PATH.playlists)}${playlist.count} video</span></span><strong>${esc(playlist.title)}</strong><span class="yt-stats">Xem toàn bộ danh sách phát</span></button>`;
}

export class YouTubeTv {
  readonly element = document.createElement("section");
  private readonly onFocus: () => void;
  private readonly playerBox = document.createElement("div");
  private player: YtPlayer | null = null;
  private playerReady: Promise<YtPlayer> | null = null;
  private status: YtStatus | null = null;
  private channels: YtChannel[] = [];
  private showAllChannels = false;
  private miniGuide = false;
  private view: View = { kind: "home", arg: "" };
  private videos: YtVideo[] = [];
  private queue: YtVideo[] = [];
  private mode: Mode = "browse";
  private loadSeq = 0;
  private statusTimer = 0;
  private notice = "";
  private readonly controls: PlayerControls;

  constructor(onFocus: () => void) {
    this.onFocus = onFocus;
    this.element.className = "yt-tv";
    this.element.setAttribute("aria-label", "YouTube");
    this.element.innerHTML = `
      <header class="yt-masthead">
        <div class="yt-start">
          <button type="button" class="yt-icon-btn" data-act="guide" aria-label="Hướng dẫn">${icon(PATH.menu)}</button>
          <button type="button" class="yt-logo" data-nav="home" aria-label="Trang chủ YouTube"><span class="yt-logo-mark" aria-hidden="true"></span><span class="yt-logo-word">YouTube</span><span class="yt-logo-premium">Premium</span><sup>VN</sup></button>
        </div>
        <form class="yt-search" role="search"><input name="q" type="search" placeholder="Tìm kiếm" aria-label="Tìm kiếm" autocomplete="off"><button type="submit" aria-label="Tìm kiếm">${icon(PATH.search)}</button></form>
        <div class="yt-end">
          <button type="button" class="yt-icon-btn" data-act="focus" aria-label="Phóng to màn YouTube" title="Phóng to màn YouTube">${icon(PATH.fit)}</button>
          <div class="yt-me" data-yt="me"></div>
        </div>
      </header>
      <div class="yt-page">
        <nav class="yt-guide" aria-label="Hướng dẫn" data-yt="guide"></nav>
        <main class="yt-browse" data-yt="content" tabindex="-1"></main>
      </div>
      <div class="yt-player" data-mode="browse">
        <div class="yt-player-host"></div>
        <button type="button" class="yt-mini-hit" data-act="expand" aria-label="Mở lớn trình phát"></button>
      </div>
      <div class="yt-mini-bar" hidden>
        <div class="yt-mini-text"><strong data-yt="mini-title"></strong><span data-yt="mini-channel"></span></div>
        <button type="button" class="yt-icon-btn" data-act="toggle" aria-label="Phát hoặc tạm dừng" data-yt="mini-toggle">${icon(PATH.pause)}</button>
        <button type="button" class="yt-icon-btn" data-act="close" aria-label="Đóng trình phát">${icon(PATH.close)}</button>
      </div>`;
    this.element.querySelector(".yt-player-host")!.append(this.playerBox);
    this.controls = new PlayerControls(this.element.querySelector<HTMLElement>(".yt-player")!, {
      player: () => this.player,
      video: () => this.videoInfo(),
      minimize: () => this.setMode("mini"),
    });
    this.element.addEventListener("click", (event) => this.onClick(event));
    this.element.querySelector("form")!.addEventListener("submit", (event) => this.onSearch(event));
    this.element.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape" && this.mode === "watch" && !document.fullscreenElement) this.setMode("mini");
      else if (this.mode === "watch" && this.controls.handleKey(event)) event.preventDefault();
    });
    for (const type of ["pointerdown", "wheel"]) this.element.addEventListener(type, (event) => event.stopPropagation(), { passive: true });
    this.setMode("browse");
    this.renderMe();
    this.renderGuide();
    void this.refreshStatus();
  }

  setHeight(height: number): void {
    this.element.style.height = `${Math.round(height)}px`;
    this.layoutPlayer();
  }

  private q(name: string): HTMLElement {
    return this.element.querySelector<HTMLElement>(`[data-yt="${name}"]`)!;
  }

  private async request<T>(path: string, method = "GET"): Promise<T> {
    const res = await fetch(`/api/youtube/${path}`, { method, cache: "no-store", headers: method === "GET" ? undefined : { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
    return body as T;
  }

  private async refreshStatus(): Promise<void> {
    window.clearTimeout(this.statusTimer);
    const wasConnected = this.status?.connected ?? false;
    try {
      this.status = await this.request<YtStatus>("status");
    } catch (error) {
      this.status = { configured: false, connected: false, account: null, pending: null, note: error instanceof Error ? error.message : "Hub không trả trạng thái YouTube." };
    }
    if (this.status.pending) this.statusTimer = window.setTimeout(() => void this.refreshStatus(), STATUS_POLL_MS);
    this.renderMe();
    if (this.status.connected && !wasConnected) {
      void this.loadChannels();
      void this.open({ kind: "home", arg: "" });
    } else if (!this.status.connected) {
      this.channels = [];
      this.renderGuide();
      void this.renderSignedOut();
    }
  }

  private async loadChannels(): Promise<void> {
    try {
      this.channels = (await this.request<YtFeedResult>("feed/subscriptions")).channels;
    } catch {
      this.channels = [];
    }
    this.renderGuide();
  }

  private async open(view: View): Promise<void> {
    if (!this.status?.connected) return this.renderSignedOut();
    this.view = view;
    if (this.mode === "watch") this.setMode("mini");
    this.renderGuide();
    const seq = ++this.loadSeq;
    const content = this.q("content");
    content.innerHTML = `<div class="yt-spinner" role="status" aria-label="Đang tải"></div>`;
    try {
      const query = view.arg ? `?${view.kind === "search" ? "q" : "id"}=${encodeURIComponent(view.arg)}` : "";
      const result = await this.request<YtFeedResult>(`feed/${view.kind}${query}`);
      if (seq === this.loadSeq) this.renderFeed(result);
    } catch (error) {
      if (seq !== this.loadSeq) return;
      if ((error as { status?: number }).status === 401) return void this.refreshStatus();
      content.innerHTML = `<div class="yt-message"><strong>Không tải được</strong><p>${esc(error instanceof Error ? error.message : String(error))}</p><button type="button" class="yt-pill" data-act="retry">Thử lại</button></div>`;
    }
  }

  private renderFeed(result: YtFeedResult): void {
    this.videos = result.videos;
    const content = this.q("content");
    const note = result.note ? `<p class="yt-note">${esc(result.note)}</p>` : "";
    const empty = '<p class="yt-note">Không có video nào.</p>';
    let body: string;
    if (result.kind === "subscriptions") body = `<h1 class="yt-page-title">Tất cả kênh đăng ký</h1><div class="yt-channel-grid">${result.channels.map(channelTile).join("")}</div>`;
    else if (result.kind === "playlists") body = `<h1 class="yt-page-title">Danh sách phát</h1>${note}<div class="yt-grid">${result.playlists.map(playlistTile).join("")}</div>`;
    else if (result.kind === "search") body = `<div class="yt-results">${result.videos.map(resultRow).join("") || '<p class="yt-note">Không tìm thấy kết quả nào.</p>'}</div>`;
    else body = `${this.pageHead(result)}${this.chips(result)}${note}<div class="yt-grid">${result.videos.map(videoCard).join("") || empty}</div>`;
    content.innerHTML = body;
    content.scrollTop = 0;
  }

  private chips(result: YtFeedResult): string {
    if (result.kind !== "home" && !(result.kind === "trending" && this.view.arg)) return "";
    const current = result.kind === "home" ? "" : this.view.arg;
    return `<div class="yt-chips" role="tablist">${CHIPS.map(([id, label]) => `<button type="button" class="yt-chip" role="tab" data-chip="${id}" aria-selected="${id === current}">${label}</button>`).join("")}</div>`;
  }

  private pageHead(result: YtFeedResult): string {
    if (result.kind === "trending" && this.view.arg) return "";
    if (result.kind === "home") return "";
    if (result.kind === "channel" && result.channels[0]) {
      const channel = result.channels[0];
      return `<header class="yt-channel-head">${avatar(channel.thumbnail, channel.title, "yt-channel-avatar")}<div><h1>${esc(channel.title)}</h1><span class="yt-stats">${result.videos.length} video gần đây</span></div></header><div class="yt-tabs"><span aria-current="true">Video</span></div>`;
    }
    const iconPath = result.kind === "trending" ? PATH.trending : result.kind === "liked" ? PATH.liked : PATH.playlists;
    return `<h1 class="yt-page-title yt-with-icon">${icon(iconPath)}${esc(result.title)}</h1>`;
  }

  private guideItem(kind: YtFeedKind, label: string, path: string): string {
    const current = (this.status?.connected ?? false) && this.view.kind === kind && !this.view.arg;
    return `<button type="button" class="yt-guide-item" data-nav="${kind}" aria-current="${current}">${icon(path)}<span>${label}</span></button>`;
  }

  private ownChannel(): string {
    const id = this.status?.account?.id ?? "";
    if (!id) return "";
    return `<button type="button" class="yt-guide-item" data-channel="${esc(id)}" aria-current="${this.view.kind === "channel" && this.view.arg === id}">${icon(PATH.yourChannel)}<span>Kênh của bạn</span></button>`;
  }

  private guideChannels(): string {
    const head = `<hr><button type="button" class="yt-guide-head yt-guide-link" data-nav="subscriptions">Kênh đăng ký${icon(PATH.chevron)}</button>`;
    if (!this.channels.length) return head;
    const shown = this.showAllChannels ? this.channels : this.channels.slice(0, GUIDE_CHANNELS);
    const rows = shown.map((channel) => `<button type="button" class="yt-guide-item yt-guide-channel" data-channel="${esc(channel.id)}" aria-current="${this.view.kind === "channel" && this.view.arg === channel.id}">${avatar(channel.thumbnail, channel.title, "yt-avatar-xs")}<span>${esc(channel.title)}</span></button>`).join("");
    const more = this.channels.length > GUIDE_CHANNELS ? `<button type="button" class="yt-guide-item" data-act="more">${icon(this.showAllChannels ? PATH.expandLess : PATH.expandMore)}<span>${this.showAllChannels ? "Ẩn bớt" : "Thêm"}</span></button>` : "";
    return `${head}${rows}${more}`;
  }

  private renderGuide(): void {
    const guide = this.q("guide");
    guide.dataset.mini = String(this.miniGuide);
    guide.innerHTML = this.miniGuide
      ? `${this.guideItem("home", "Trang chủ", PATH.home)}${this.guideItem("subscriptions", "Kênh đăng ký", PATH.subs)}${this.guideItem("playlists", "Bạn", PATH.you)}${this.guideItem("trending", "Thịnh hành", PATH.trending)}`
      : `${this.guideItem("home", "Trang chủ", PATH.home)}
        ${this.guideChannels()}
        <hr><button type="button" class="yt-guide-head yt-guide-link" data-nav="playlists">Bạn${icon(PATH.chevron)}</button>
        ${this.ownChannel()}${this.guideItem("playlists", "Danh sách phát", PATH.playlists)}${this.guideItem("liked", "Video đã thích", PATH.liked)}
        <hr><p class="yt-guide-head">Khám phá</p>${this.guideItem("trending", "Thịnh hành", PATH.trending)}`;
    if (!this.status?.connected) for (const button of guide.querySelectorAll<HTMLButtonElement>("[data-nav]")) button.disabled = true;
  }

  private renderMe(): void {
    const status = this.status;
    const me = this.q("me");
    this.element.dataset.premium = String(status?.connected ?? false);
    if (status?.connected) {
      const account = status.account;
      const title = account?.title ?? "Tài khoản YouTube";
      me.innerHTML = `<button type="button" class="yt-me-btn" data-act="account" aria-haspopup="true" aria-label="${esc(title)}">${avatar(account?.thumbnail ?? "", title, "yt-avatar-me")}</button>
        <div class="yt-menu" hidden><div class="yt-menu-head">${avatar(account?.thumbnail ?? "", title, "yt-avatar")}<strong>${esc(title)}</strong></div><hr><button type="button" data-act="logout">Đăng xuất</button></div>`;
    } else {
      me.innerHTML = status?.configured && !status.pending ? `<button type="button" class="yt-signin" data-act="connect">${icon(PATH.person)}Đăng nhập</button>` : "";
    }
  }

  private async renderSignedOut(): Promise<void> {
    const status = this.status;
    const content = this.q("content");
    let panel: string;
    if (!status?.configured) {
      panel = `<strong>Chưa cài kết nối YouTube cho hub</strong><p>${esc(status?.note ?? "")}</p>`;
    } else if (status.pending) {
      const url = status.pending.verificationUrl.replace(/^https?:\/\//, "");
      panel = `<strong>Đăng nhập YouTube trên điện thoại hoặc máy tính</strong><p>Mở <b>${esc(url)}</b> rồi nhập mã</p><span class="yt-code">${esc(status.pending.userCode)}</span><p>Mã hết hạn lúc ${new Date(status.pending.expiresAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}. Màn này tự chuyển khi đăng nhập xong.</p><button type="button" class="yt-pill" data-act="cancel">Huỷ</button>`;
    } else {
      panel = `<strong>Hãy đăng nhập để xem video từ các kênh sếp đăng ký</strong><p>Trang chủ theo kênh đăng ký, tìm kiếm, video đã thích và danh sách phát.</p>${status.note ? `<p>${esc(status.note)}</p>` : ""}<button type="button" class="yt-signin" data-act="connect">${icon(PATH.person)}Đăng nhập</button>`;
    }
    const notice = this.notice ? `<p class="yt-error" role="alert">${esc(this.notice)}</p>` : "";
    content.innerHTML = `<div class="yt-message">${panel}${notice}</div><h1 class="yt-page-title">Video của kênh</h1><div class="yt-grid" data-yt="own"></div>`;
    try {
      const feed = (await (await fetch("/api/youtube", { cache: "no-store" })).json()) as YouTubeFeed;
      if (this.status?.connected) return;
      this.videos = feed.videos.map((video) => ({ id: video.id, title: video.title, channelId: "", channelTitle: feed.channelTitle, channelThumbnail: "", published: video.published, thumbnail: `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`, description: "", durationSec: null, views: null, live: false }));
      const own = this.element.querySelector<HTMLElement>('[data-yt="own"]');
      if (own) own.innerHTML = this.videos.map(videoCard).join("") || `<p class="yt-note">${esc(feed.note)}</p>`;
    } catch {
      return;
    }
  }

  private onClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!target || target.disabled) return;
    const { nav, channel, playlist, play, act, chip } = target.dataset;
    if (act !== "account") this.element.querySelector<HTMLElement>(".yt-menu")?.setAttribute("hidden", "");
    if (nav) return void this.open({ kind: nav as YtFeedKind, arg: "" });
    if (chip !== undefined) return void this.open(chip ? { kind: "trending", arg: chip } : { kind: "home", arg: "" });
    if (channel) return void this.open({ kind: "channel", arg: channel });
    if (playlist) return void this.open({ kind: "playlist", arg: playlist });
    if (play !== undefined) return void this.play(Number(play));
    this.onAction(act ?? "");
  }

  private onAction(act: string): void {
    const menu = this.element.querySelector<HTMLElement>(".yt-menu");
    switch (act) {
      case "guide": this.miniGuide = !this.miniGuide; return this.renderGuide();
      case "more": this.showAllChannels = !this.showAllChannels; return this.renderGuide();
      case "account": if (menu) menu.hidden = !menu.hidden; return;
      case "focus": return this.onFocus();
      case "expand": return this.setMode("watch");
      case "close": return this.stop();
      case "toggle": return this.togglePlay();
      case "retry": return void this.open(this.view);
      case "connect": case "cancel": case "logout": return void this.account(act);
    }
  }

  private async account(action: "connect" | "cancel" | "logout"): Promise<void> {
    this.notice = "";
    try {
      await this.request<YtStatus>(action, "POST");
    } catch (error) {
      this.notice = error instanceof Error ? error.message : String(error);
    }
    if (action === "logout") this.stop();
    if (this.status) this.status = { ...this.status, connected: false };
    await this.refreshStatus();
  }

  private onSearch(event: Event): void {
    event.preventDefault();
    const input = this.element.querySelector<HTMLInputElement>(".yt-search input")!;
    const q = input.value.trim();
    if (!q) return input.focus();
    void this.open({ kind: "search", arg: q });
  }

  private ensurePlayer(): Promise<YtPlayer> {
    this.playerReady ??= loadApi().then((YT) => new Promise<YtPlayer>((resolve) => {
      new YT.Player(this.playerBox, {
        width: PLAYER_WIDTH,
        height: PLAYER_HEIGHT,
        host: PLAYER_HOST,
        playerVars: { autoplay: 1, playsinline: 1, rel: 0, controls: 0, fs: 0, disablekb: 1, iv_load_policy: 3, vq: "highres", origin: location.origin },
        events: {
          onReady: (ready: { target: YtPlayer }) => resolve((this.player = ready.target)),
          onStateChange: (change: { data: number }) => this.onPlayerState(change.data),
          onPlaybackQualityChange: () => this.recordQuality(),
          onError: (error: { data: number }) => this.onPlayerError(error.data),
        },
      });
    }));
    this.playerReady.catch(() => (this.playerReady = null));
    return this.playerReady;
  }

  private async play(index: number): Promise<void> {
    const ids = this.videos.map((video) => video.id);
    if (!ids[index]) return;
    this.queue = this.videos;
    this.setMode("watch");
    try {
      const player = await this.ensurePlayer();
      player.loadPlaylist(ids, index);
      player.unMute();
      this.preferHighest();
    } catch (error) {
      this.stop();
      this.q("content").insertAdjacentHTML("afterbegin", `<p class="yt-error">${esc(error instanceof Error ? error.message : String(error))}</p>`);
    }
  }

  private preferHighest(): void {
    const player = this.player;
    if (!player) return;
    player.setPlaybackQuality?.(player.getAvailableQualityLevels?.()?.[0] ?? "highres");
    this.recordQuality();
  }

  private recordQuality(): void {
    this.element.dataset.quality = this.player?.getPlaybackQuality?.() ?? "";
  }

  private onPlayerState(state: number): void {
    if (state === STATE_PLAYING) this.preferHighest();
    this.renderMiniBar();
    this.controls.refresh();
  }

  private onPlayerError(code: number): void {
    if (EMBED_BLOCKED.has(code) && (this.player?.getPlaylist()?.length ?? 0) > 1) this.player!.nextVideo();
  }

  private togglePlay(): void {
    const player = this.player;
    if (!player) return;
    if (player.getPlayerState() === STATE_PLAYING) player.pauseVideo();
    else player.playVideo();
  }

  private stop(): void {
    this.player?.pauseVideo();
    this.setMode("browse");
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.element.querySelector<HTMLElement>(".yt-player")!.dataset.mode = mode;
    this.element.querySelector<HTMLElement>(".yt-mini-bar")!.hidden = mode !== "mini";
    this.controls.setActive(mode === "watch");
    this.layoutPlayer();
    this.renderMiniBar();
  }

  private layoutPlayer(): void {
    const box = this.element.querySelector<HTMLElement>(".yt-player")!;
    const height = parseFloat(this.element.style.height) || (TV_WIDTH * 9) / 16;
    const bar = this.element.querySelector<HTMLElement>(".yt-mini-bar")!;
    if (this.mode === "mini") {
      const scale = MINI_WIDTH / PLAYER_WIDTH;
      const top = height - MINI_MARGIN - MINI_BAR - PLAYER_HEIGHT * scale;
      box.style.transform = `translate(${TV_WIDTH - MINI_MARGIN - MINI_WIDTH}px, ${top}px) scale(${scale})`;
      bar.style.transform = `translate(${TV_WIDTH - MINI_MARGIN - MINI_WIDTH}px, ${height - MINI_MARGIN - MINI_BAR}px)`;
      return;
    }
    const scale = Math.min(TV_WIDTH / PLAYER_WIDTH, height / PLAYER_HEIGHT);
    box.style.transform = `translate(${(TV_WIDTH - PLAYER_WIDTH * scale) / 2}px, ${(height - PLAYER_HEIGHT * scale) / 2}px) scale(${scale})`;
  }

  private videoInfo(): VideoInfo {
    const data = this.player?.getVideoData();
    const known = this.queue.find((video) => video.id === data?.video_id);
    return {
      id: data?.video_id || known?.id || "",
      title: data?.title || known?.title || "",
      channel: data?.author || known?.channelTitle || "",
      live: Boolean(data?.isLive ?? known?.live),
    };
  }

  private renderMiniBar(): void {
    if (this.mode !== "mini") return;
    const data = this.player?.getVideoData();
    const known = this.queue.find((video) => video.id === data?.video_id);
    this.q("mini-title").textContent = data?.title || known?.title || "";
    this.q("mini-channel").textContent = data?.author || known?.channelTitle || "";
    const playing = this.player?.getPlayerState() === STATE_PLAYING;
    this.q("mini-toggle").innerHTML = icon(playing ? PATH.pause : PATH.play);
  }
}
