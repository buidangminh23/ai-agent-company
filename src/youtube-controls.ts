import { formatDuration } from "../shared/youtube.ts";

const QUALITY: Record<string, string> = {
  highres: "4320p 8K",
  hd2160: "2160p 4K",
  hd1440: "1440p",
  hd1080: "1080p",
  hd720: "720p",
  large: "480p",
  medium: "360p",
  small: "240p",
  tiny: "144p",
};

export function qualityLabel(quality: string | undefined): string {
  return (quality && QUALITY[quality]) || "Tự động";
}

export function rateLabel(rate: number): string {
  return rate === 1 ? "Bình thường" : `${String(rate).replace(".", ",")}×`;
}

export function seekFraction(offset: number, width: number): number {
  if (!(width > 0) || !Number.isFinite(offset)) return 0;
  return Math.min(1, Math.max(0, offset / width));
}

export function clockText(current: number, duration: number): string {
  const now = formatDuration(Math.max(0, current || 0));
  return duration > 0 ? `${now} / ${formatDuration(duration)}` : now;
}

export function stepVolume(volume: number, delta: number): number {
  return Math.min(100, Math.max(0, Math.round((volume || 0) + delta)));
}

const ICON = {
  play: "M8 5v14l11-7z",
  pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
  next: "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z",
  prev: "M6 6h2v12H6zm3.5 6 8.5 6V6z",
  volume: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
  muted: "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z",
  captions: "M19 4H5c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1c0 .55-.45 1-1 1H7c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1zm7 0h-1.5v-.5h-2v3h2V13H18v1c0 .55-.45 1-1 1h-3c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1z",
  settings: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  minimize: "M18 8.3 12 14.3 6 8.3l.7-.7 5.3 5.3 5.3-5.3.7.7z",
  fullscreen: "M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z",
  exitFullscreen: "M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z",
  quality: "M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-8 12H9.5v-2h-2v2H6V9h1.5v2.5h2V9H11v6zm7-1c0 .55-.45 1-1 1h-.75v1.5h-1.5V15H14c-.55 0-1-.45-1-1v-4c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v4zm-3.5-.5h2v-3h-2v3z",
  speed: "M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z",
  chevron: "M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z",
  back: "M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z",
  check: "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z",
  external: "M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
};

const PLAYER_WIDTH = 3840;
const STATE_PLAYING = 1;
const TICK_MS = 250;
const IDLE_MS = 3_000;
const CLICK_DELAY_MS = 250;
const SEEK_STEP = 5;
const SEEK_JUMP = 10;
const VOLUME_STEP = 5;
const UNMUTE_VOLUME = 50;
const FULLSCREEN_BOOST = 1.25;

const svg = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const escText = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ControlPlayer {
  playVideo(): void;
  pauseVideo(): void;
  nextVideo(): void;
  previousVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoLoadedFraction(): number;
  getPlayerState(): number;
  getPlaylist(): string[] | null;
  getPlaylistIndex(): number;
  getVolume(): number;
  setVolume(volume: number): void;
  isMuted(): boolean;
  mute(): void;
  unMute(): void;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  getPlaybackQuality?(): string;
  loadModule?(name: string): void;
  unloadModule?(name: string): void;
  setOption?(module: string, option: string, value: unknown): void;
  getOption?(module: string, option: string): unknown;
}

export interface VideoInfo {
  id: string;
  title: string;
  channel: string;
  live: boolean;
}

export interface ControlHost {
  player(): ControlPlayer | null;
  video(): VideoInfo;
  minimize(): void;
}

type Panel = "closed" | "main" | "speed";

const MARKUP = `
  <div class="yt-shield" data-ctl="shield"></div>
  <div class="yt-chrome">
    <div class="yt-scrim-top"></div>
    <div class="yt-scrim-bottom"></div>
    <div class="yt-top"><strong data-c="title"></strong><span data-c="channel"></span></div>
    <div class="yt-center">
      <button type="button" class="yt-round" data-ctl="prev" aria-label="Video trước">${svg(ICON.prev)}</button>
      <button type="button" class="yt-round yt-round-big" data-ctl="toggle" data-c="center-toggle" aria-label="Phát">${svg(ICON.play)}</button>
      <button type="button" class="yt-round" data-ctl="next" aria-label="Video tiếp theo">${svg(ICON.next)}</button>
    </div>
    <div class="yt-controls">
      <div class="yt-seek" data-c="seek" role="slider" tabindex="0" aria-label="Tua video" aria-valuemin="0">
        <div class="yt-seek-track"><div class="yt-seek-buffer"></div><div class="yt-seek-fill"></div></div>
        <div class="yt-seek-knob"></div>
        <div class="yt-seek-tip" data-c="tip" hidden></div>
      </div>
      <div class="yt-ctrl-row">
        <button type="button" class="yt-ctrl" data-ctl="toggle" data-c="toggle" aria-label="Phát">${svg(ICON.play)}</button>
        <button type="button" class="yt-ctrl" data-ctl="next" aria-label="Video tiếp theo">${svg(ICON.next)}</button>
        <button type="button" class="yt-ctrl" data-ctl="mute" data-c="mute" aria-label="Tắt tiếng">${svg(ICON.volume)}</button>
        <input type="range" class="yt-volume" data-c="volume" min="0" max="100" step="1" aria-label="Âm lượng">
        <span class="yt-time" data-c="time">0:00</span>
        <span class="yt-spacer"></span>
        <button type="button" class="yt-ctrl" data-ctl="captions" data-c="captions" aria-pressed="false" aria-label="Phụ đề">${svg(ICON.captions)}</button>
        <button type="button" class="yt-ctrl" data-ctl="settings" data-c="settings-btn" aria-expanded="false" aria-label="Cài đặt">${svg(ICON.settings)}</button>
        <button type="button" class="yt-ctrl" data-ctl="minimize" aria-label="Thu nhỏ, vẫn phát tiếp">${svg(ICON.minimize)}</button>
        <button type="button" class="yt-ctrl" data-ctl="fullscreen" data-c="fullscreen" aria-label="Toàn màn hình">${svg(ICON.fullscreen)}</button>
      </div>
    </div>
    <div class="yt-settings" data-c="settings" role="menu" hidden></div>
  </div>`;

export class PlayerControls {
  readonly element = document.createElement("div");
  private readonly box: HTMLElement;
  private readonly host: ControlHost;
  private active = false;
  private panel: Panel = "closed";
  private captionsOn = false;
  private dragging = false;
  private revealTap = false;
  private tickTimer = 0;
  private idleTimer = 0;
  private clickTimer = 0;

  constructor(box: HTMLElement, host: ControlHost) {
    this.box = box;
    this.host = host;
    this.element.className = "yt-overlay";
    this.element.innerHTML = MARKUP;
    box.append(this.element);
    this.element.addEventListener("click", (event) => this.onClick(event));
    this.element.addEventListener("dblclick", (event) => this.onDoubleClick(event));
    this.element.addEventListener("pointermove", () => this.wake());
    this.element.addEventListener("pointerdown", (event) => {
      this.revealTap = event.pointerType !== "mouse" && this.element.hasAttribute("data-idle");
      this.wake();
    }, { capture: true });
    this.c<HTMLInputElement>("volume").addEventListener("input", (event) => this.setVolume(Number((event.target as HTMLInputElement).value)));
    this.bindSeek(this.c("seek"));
    document.addEventListener("fullscreenchange", () => this.fitFullscreen());
  }

  setActive(active: boolean): void {
    this.active = active;
    window.clearInterval(this.tickTimer);
    if (!active) {
      this.setPanel("closed");
      if (document.fullscreenElement === this.box) void document.exitFullscreen();
      return;
    }
    this.tickTimer = window.setInterval(() => this.tick(), TICK_MS);
    this.refresh();
    this.wake();
  }

  refresh(): void {
    if (!this.active) return;
    const player = this.host.player();
    const info = this.host.video();
    const playing = player?.getPlayerState() === STATE_PLAYING;
    for (const name of ["toggle", "center-toggle"]) {
      const button = this.c(name);
      button.innerHTML = svg(playing ? ICON.pause : ICON.play);
      button.setAttribute("aria-label", playing ? "Tạm dừng" : "Phát");
    }
    this.c("title").textContent = info.title;
    this.c("channel").textContent = info.channel;
    this.renderQueueButtons(player);
    this.renderVolume(player);
    this.c("captions").setAttribute("aria-pressed", String(this.captionsOn));
    this.element.toggleAttribute("data-paused", !playing);
    this.tick();
    if (this.panel !== "closed") this.renderPanel();
    this.wake();
  }

  handleKey(event: KeyboardEvent): boolean {
    const player = this.host.player();
    if (!this.active || !player || event.ctrlKey || event.metaKey || event.altKey) return false;
    const tag = (event.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return false;
    const action = this.keyAction(event, player);
    if (!action) return false;
    action();
    this.wake();
    return true;
  }

  private keyAction(event: KeyboardEvent, player: ControlPlayer): (() => void) | null {
    switch (event.key) {
      case " ": case "k": case "K": return () => this.toggle();
      case "ArrowLeft": return () => this.seekBy(-SEEK_STEP);
      case "ArrowRight": return () => this.seekBy(SEEK_STEP);
      case "j": case "J": return () => this.seekBy(-SEEK_JUMP);
      case "l": case "L": return () => this.seekBy(SEEK_JUMP);
      case "ArrowUp": return () => this.setVolume(stepVolume(player.getVolume(), VOLUME_STEP));
      case "ArrowDown": return () => this.setVolume(stepVolume(player.getVolume(), -VOLUME_STEP));
      case "m": case "M": return () => this.toggleMute();
      case "f": case "F": return () => this.toggleFullscreen();
      case "c": case "C": return () => this.toggleCaptions();
      case "N": return event.shiftKey ? () => player.nextVideo() : null;
      case "P": return event.shiftKey ? () => player.previousVideo() : null;
      default: return null;
    }
  }

  private c<T extends HTMLElement = HTMLElement>(name: string): T {
    return this.element.querySelector<T>(`[data-c="${name}"]`)!;
  }

  private onClick(event: Event): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-ctl], [data-rate]");
    if (!target || (target as HTMLButtonElement).disabled) return;
    if (target.dataset.rate) return this.chooseRate(Number(target.dataset.rate));
    const ctl = target.dataset.ctl ?? "";
    if (ctl === "shield") return this.onShieldClick();
    if (ctl !== "settings" && ctl !== "speed" && ctl !== "back" && ctl !== "captions") this.setPanel("closed");
    this.runControl(ctl);
    this.wake();
  }

  private runControl(ctl: string): void {
    const player = this.host.player();
    switch (ctl) {
      case "toggle": return this.toggle();
      case "prev": return player?.previousVideo();
      case "next": return player?.nextVideo();
      case "mute": return this.toggleMute();
      case "captions": return this.toggleCaptions();
      case "settings": return this.setPanel(this.panel === "closed" ? "main" : "closed");
      case "speed": return this.setPanel("speed");
      case "back": return this.setPanel("main");
      case "open-youtube": return this.openOnYouTube();
      case "minimize": return this.host.minimize();
      case "fullscreen": return this.toggleFullscreen();
    }
  }

  private onShieldClick(): void {
    if (this.panel !== "closed") return this.setPanel("closed");
    if (this.revealTap) return;
    window.clearTimeout(this.clickTimer);
    this.clickTimer = window.setTimeout(() => this.toggle(), CLICK_DELAY_MS);
  }

  private onDoubleClick(event: Event): void {
    if ((event.target as HTMLElement).dataset.ctl !== "shield") return;
    window.clearTimeout(this.clickTimer);
    this.toggleFullscreen();
  }

  private toggle(): void {
    const player = this.host.player();
    if (!player) return;
    if (player.getPlayerState() === STATE_PLAYING) player.pauseVideo();
    else player.playVideo();
  }

  private seekBy(delta: number): void {
    const player = this.host.player();
    if (!player) return;
    player.seekTo(Math.max(0, player.getCurrentTime() + delta), true);
    this.tick();
  }

  private toggleMute(): void {
    const player = this.host.player();
    if (!player) return;
    if (player.isMuted() || player.getVolume() === 0) {
      player.unMute();
      if (player.getVolume() === 0) player.setVolume(UNMUTE_VOLUME);
      this.paintVolume(player.getVolume() || UNMUTE_VOLUME, false);
    } else {
      player.mute();
      this.paintVolume(0, true);
    }
  }

  private setVolume(volume: number): void {
    const player = this.host.player();
    if (!player) return;
    player.setVolume(volume);
    if (volume > 0) player.unMute();
    else player.mute();
    this.paintVolume(volume, volume === 0);
  }

  private renderVolume(player: ControlPlayer | null): void {
    if (player) this.paintVolume(player.getVolume(), player.isMuted());
  }

  private paintVolume(volume: number, muted: boolean): void {
    const level = muted ? 0 : volume;
    const slider = this.c<HTMLInputElement>("volume");
    slider.value = String(level);
    slider.style.setProperty("--level", `${level}%`);
    const mute = this.c("mute");
    mute.innerHTML = svg(level === 0 ? ICON.muted : ICON.volume);
    mute.setAttribute("aria-label", level === 0 ? "Bật tiếng" : "Tắt tiếng");
  }

  private toggleCaptions(): void {
    const player = this.host.player();
    if (!player?.loadModule) return;
    this.captionsOn = !this.captionsOn;
    if (this.captionsOn) {
      player.loadModule("captions");
      window.setTimeout(() => this.pickCaptionTrack(player), TICK_MS * 2);
    } else {
      player.setOption?.("captions", "track", {});
      player.unloadModule?.("captions");
    }
    this.refresh();
  }

  private pickCaptionTrack(player: ControlPlayer): void {
    const current = player.getOption?.("captions", "track") as { languageCode?: string } | undefined;
    if (current?.languageCode) return;
    const list = player.getOption?.("captions", "tracklist") as { languageCode?: string }[] | undefined;
    const first = Array.isArray(list) ? list.find((track) => track.languageCode) : undefined;
    if (first) player.setOption?.("captions", "track", { languageCode: first.languageCode });
  }

  private chooseRate(rate: number): void {
    this.host.player()?.setPlaybackRate(rate);
    this.setPanel("main");
    window.setTimeout(() => this.panel === "main" && this.renderPanel(), TICK_MS);
  }

  private openOnYouTube(): void {
    const player = this.host.player();
    const id = this.host.video().id;
    if (!id) return;
    const at = Math.floor(player?.getCurrentTime() ?? 0);
    player?.pauseVideo();
    window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}${at > 0 ? `&t=${at}s` : ""}`, "_blank", "noopener");
  }

  private renderQueueButtons(player: ControlPlayer | null): void {
    const index = player?.getPlaylistIndex() ?? -1;
    const length = player?.getPlaylist()?.length ?? 0;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-ctl="prev"]')) button.disabled = index <= 0;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-ctl="next"]')) button.disabled = index < 0 || index >= length - 1;
  }

  private tick(): void {
    const player = this.host.player();
    if (!player || this.dragging) return;
    const duration = player.getDuration() || 0;
    const current = player.getCurrentTime() || 0;
    this.paintProgress(duration > 0 ? current / duration : 0, player.getVideoLoadedFraction() || 0);
    const live = this.host.video().live;
    const time = this.c("time");
    time.classList.toggle("yt-time-live", live);
    time.textContent = live ? "TRỰC TIẾP" : clockText(current, duration);
    const seek = this.c("seek");
    seek.setAttribute("aria-valuemax", String(Math.round(duration)));
    seek.setAttribute("aria-valuenow", String(Math.round(current)));
    seek.setAttribute("aria-valuetext", clockText(current, duration));
  }

  private paintProgress(played: number, buffered: number): void {
    const seek = this.c("seek");
    seek.style.setProperty("--played", `${played * 100}%`);
    seek.style.setProperty("--buffered", `${Math.max(played, buffered) * 100}%`);
  }

  private bindSeek(seek: HTMLElement): void {
    seek.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      seek.setPointerCapture(event.pointerId);
      this.dragging = true;
      this.scrub(event, false);
    });
    seek.addEventListener("pointermove", (event) => this.scrub(event, false));
    seek.addEventListener("pointerup", (event) => {
      if (!this.dragging) return;
      this.scrub(event, true);
      this.dragging = false;
    });
    seek.addEventListener("pointercancel", () => (this.dragging = false));
    seek.addEventListener("pointerleave", () => {
      if (!this.dragging) this.c("tip").hidden = true;
    });
    seek.addEventListener("keydown", (event) => this.onSeekKey(event));
  }

  private onSeekKey(event: KeyboardEvent): void {
    const player = this.host.player();
    if (!player) return;
    if (event.key === "Home") player.seekTo(0, true);
    else if (event.key === "End") player.seekTo(Math.max(0, player.getDuration() - 1), true);
  }

  private scrub(event: PointerEvent, commit: boolean): void {
    const player = this.host.player();
    const duration = player?.getDuration() || 0;
    if (!player || duration <= 0) return;
    const fraction = seekFraction(event.offsetX, this.c("seek").clientWidth);
    const tip = this.c("tip");
    tip.hidden = false;
    tip.textContent = clockText(fraction * duration, 0);
    tip.style.left = `${fraction * 100}%`;
    if (!this.dragging) return;
    this.paintProgress(fraction, player.getVideoLoadedFraction() || 0);
    player.seekTo(fraction * duration, commit);
    if (commit) tip.hidden = true;
  }

  private setPanel(panel: Panel): void {
    this.panel = panel;
    this.c("settings").hidden = panel === "closed";
    this.c("settings-btn").setAttribute("aria-expanded", String(panel !== "closed"));
    this.element.toggleAttribute("data-menu", panel !== "closed");
    if (panel !== "closed") this.renderPanel();
  }

  private renderPanel(): void {
    const player = this.host.player();
    const rate = player?.getPlaybackRate() ?? 1;
    this.c("settings").innerHTML = this.panel === "speed" ? this.speedMenu(player, rate) : this.mainMenu(player, rate);
  }

  private speedMenu(player: ControlPlayer | null, rate: number): string {
    const rates = player?.getAvailablePlaybackRates() ?? [1];
    const rows = rates.map((option) => `<button type="button" class="yt-set-row" role="menuitemradio" aria-checked="${option === rate}" data-rate="${option}"><span class="yt-set-check">${option === rate ? svg(ICON.check) : ""}</span><span>${escText(rateLabel(option))}</span></button>`);
    return `<button type="button" class="yt-set-row yt-set-head" data-ctl="back">${svg(ICON.back)}<span>Tốc độ phát</span></button>${rows.join("")}`;
  }

  private mainMenu(player: ControlPlayer | null, rate: number): string {
    return `
      <div class="yt-set-row yt-set-static">${svg(ICON.quality)}<span>Chất lượng</span><span class="yt-set-value">${escText(qualityLabel(player?.getPlaybackQuality?.()))}</span></div>
      <button type="button" class="yt-set-row" role="menuitem" data-ctl="speed">${svg(ICON.speed)}<span>Tốc độ</span><span class="yt-set-value">${escText(rateLabel(rate))}</span>${svg(ICON.chevron)}</button>
      <button type="button" class="yt-set-row" role="menuitemcheckbox" aria-checked="${this.captionsOn}" data-ctl="captions">${svg(ICON.captions)}<span>Phụ đề</span><span class="yt-set-value">${this.captionsOn ? "Bật" : "Tắt"}</span></button>
      <button type="button" class="yt-set-row" role="menuitem" data-ctl="open-youtube">${svg(ICON.external)}<span>Mở trên YouTube</span></button>`;
  }

  private toggleFullscreen(): void {
    if (document.fullscreenElement === this.box) void document.exitFullscreen();
    else void this.box.requestFullscreen?.().catch(() => undefined);
  }

  private fitFullscreen(): void {
    const full = document.fullscreenElement === this.box;
    const button = this.c("fullscreen");
    button.innerHTML = svg(full ? ICON.exitFullscreen : ICON.fullscreen);
    button.setAttribute("aria-label", full ? "Thoát toàn màn hình" : "Toàn màn hình");
    const style = this.element.style;
    if (!full) {
      for (const prop of ["zoom", "width", "height"]) style.removeProperty(prop);
      return;
    }
    const zoom = (this.box.clientWidth / PLAYER_WIDTH) * FULLSCREEN_BOOST;
    style.zoom = String(zoom);
    style.width = `${this.box.clientWidth / zoom}px`;
    style.height = `${this.box.clientHeight / zoom}px`;
  }

  private wake(): void {
    this.element.removeAttribute("data-idle");
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.sleep(), IDLE_MS);
  }

  private sleep(): void {
    const playing = this.host.player()?.getPlayerState() === STATE_PLAYING;
    const busy = this.dragging || this.panel !== "closed" || this.element.querySelector(":focus-visible");
    if (!this.active || !playing) return;
    if (busy) return this.wake();
    this.element.setAttribute("data-idle", "");
  }
}
