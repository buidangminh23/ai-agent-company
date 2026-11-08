export interface YouTubeVideo {
  id: string;
  title: string;
  published: string;
}

export interface YouTubeFeed {
  connected: boolean;
  note: string;
  channelId: string;
  channelTitle: string;
  videos: YouTubeVideo[];
  fetchedAt: string | null;
}

export interface YtVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  channelThumbnail: string;
  published: string;
  thumbnail: string;
  description: string;
  durationSec: number | null;
  views: number | null;
  live: boolean;
}

export interface YtChannel {
  id: string;
  title: string;
  thumbnail: string;
}

export interface YtPlaylist {
  id: string;
  title: string;
  thumbnail: string;
  count: number;
}

export interface YtAccount {
  id: string;
  title: string;
  thumbnail: string;
}

export interface YtDeviceCode {
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface YtStatus {
  configured: boolean;
  connected: boolean;
  account: YtAccount | null;
  pending: YtDeviceCode | null;
  note: string;
}

export const YT_FEEDS = ["home", "trending", "search", "liked", "playlists", "playlist", "subscriptions", "channel"] as const;
export type YtFeedKind = (typeof YT_FEEDS)[number];

export interface YtFeedResult {
  kind: YtFeedKind;
  title: string;
  videos: YtVideo[];
  channels: YtChannel[];
  playlists: YtPlaylist[];
  note: string;
}

export function parseIsoDuration(value: string | undefined): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value ?? "");
  if (!match) return null;
  const [, d, h, m, s] = match.map((part) => Number(part ?? 0));
  return d * 86_400 + h * 3_600 + m * 60 + s;
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
}
