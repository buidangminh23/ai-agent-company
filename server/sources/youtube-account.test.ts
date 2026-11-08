import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { YouTubeAccount, YouTubeError, toVideo } from "./youtube-account.ts";
import { formatDuration, parseIsoDuration } from "../../shared/youtube.ts";

const CONFIG = { clientId: "client", clientSecret: "secret", region: "VN" };

type Handler = (url: URL, init: RequestInit | undefined) => { status?: number; json?: unknown; text?: string };

function fakeFetch(handler: Handler, calls: string[] = []): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.hostname}${url.pathname}`);
    const out = handler(url, init);
    const body = out.text ?? JSON.stringify(out.json ?? {});
    return new Response(body, { status: out.status ?? 200 });
  }) as typeof fetch;
}

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yt-")), "session.json");
}

function form(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

function video(id: string, published = "2026-11-01T00:00:00Z"): Record<string, unknown> {
  return { id, snippet: { title: `Video ${id}`, channelId: "UCaaaaaaaaaaaaaaaaaaaaaa", channelTitle: "Kênh", publishedAt: published, thumbnails: { medium: { url: `https://i.ytimg.com/${id}.jpg` } } }, contentDetails: { duration: "PT1H2M3S" }, statistics: { viewCount: "1234" } };
}

test("device flow keeps polling while pending, then stores the session and account", async () => {
  const file = tempFile();
  let polls = 0;
  const account = new YouTubeAccount(file, fakeFetch((url, init) => {
    if (url.pathname === "/device/code") return { json: { device_code: "dev", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 5 } };
    if (url.pathname === "/token") {
      assert.equal(form(init).get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      polls++;
      return polls === 1 ? { status: 428, json: { error: "authorization_pending" } } : { json: { access_token: "at", refresh_token: "rt", expires_in: 3600 } };
    }
    if (url.pathname.endsWith("/channels")) return { json: { items: [{ id: "UCme", snippet: { title: "Demo Channel", thumbnails: { default: { url: "a.jpg" } } } }] } };
    throw new Error(`unexpected ${url}`);
  }), CONFIG);
  const started = await account.startDeviceFlow();
  account.cancelDeviceFlow();
  assert.equal(started.pending?.userCode, "ABCD-EFGH");
  await account.startDeviceFlow();
  await account.pollOnce();
  assert.equal(account.status().connected, false);
  await account.pollOnce();
  account.cancelDeviceFlow();
  const status = account.status();
  assert.equal(status.connected, true);
  assert.deepEqual(status.account, { id: "UCme", title: "Demo Channel", thumbnail: "a.jpg" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).refreshToken, "rt");
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("status reports a missing client without throwing", () => {
  const account = new YouTubeAccount(tempFile(), fakeFetch(() => ({})), { clientId: "", clientSecret: "", region: "VN" });
  assert.equal(account.status().configured, false);
  assert.match(account.status().note, /setup-youtube/);
});

test("an expired access token is refreshed once before calling the API", async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "rt", accessToken: "old", expiresAt: 0, account: null }));
  const calls: string[] = [];
  const account = new YouTubeAccount(file, fakeFetch((url, init) => {
    if (url.pathname === "/token") return { json: { access_token: "new", expires_in: 3600 } };
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer new");
    return { json: { items: [video("aaaaaaaaaaa")] } };
  }, calls), CONFIG);
  const [a, b] = await Promise.all([account.feed("trending"), account.feed("liked")]);
  assert.equal(a.videos[0].id, "aaaaaaaaaaa");
  assert.equal(b.videos.length, 1);
  assert.equal(calls.filter((call) => call.endsWith("/token")).length, 1);
});

test("a revoked refresh token clears the session", async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "rt", accessToken: "old", expiresAt: 0, account: null }));
  const account = new YouTubeAccount(file, fakeFetch(() => ({ status: 400, json: { error: "invalid_grant" } })), CONFIG);
  await assert.rejects(account.feed("trending"), (error: unknown) => error instanceof YouTubeError && error.status === 401);
  assert.equal(account.status().connected, false);
  assert.equal(fs.existsSync(file), false);
});

test("quota errors become a 429 with the reset time", async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000, account: null }));
  const account = new YouTubeAccount(file, fakeFetch(() => ({ status: 403, json: { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } } })), CONFIG);
  await assert.rejects(account.feed("search", "lego"), (error: unknown) => error instanceof YouTubeError && error.status === 429 && /14–15 giờ/.test(error.message));
});

test("home merges the newest uploads of subscribed channels and keeps their order", async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000, account: null }));
  const rss = (id: string, published: string) => `<feed><title>c</title><entry><yt:videoId>${id}</yt:videoId><title>t</title><published>${published}</published></entry></feed>`;
  const account = new YouTubeAccount(file, fakeFetch((url) => {
    if (url.pathname.endsWith("/subscriptions")) return { json: { items: [{ snippet: { title: "A", resourceId: { channelId: "UC1" } } }, { snippet: { title: "B", resourceId: { channelId: "UC2" } } }] } };
    if (url.pathname === "/feeds/videos.xml") return { text: url.searchParams.get("channel_id") === "UC1" ? rss("olderxxxxxx", "2026-10-01T00:00:00Z") : rss("newerxxxxxx", "2026-11-01T00:00:00Z") };
    if (url.pathname.endsWith("/videos")) return { json: { items: url.searchParams.get("id")!.split(",").reverse().map((id) => video(id)) } };
    throw new Error(`unexpected ${url}`);
  }), CONFIG);
  const home = await account.feed("home");
  assert.deepEqual(home.videos.map((v) => v.id), ["newerxxxxxx", "olderxxxxxx"]);
  assert.deepEqual(home.channels.map((c) => c.title), ["A", "B"]);
});

test("feeds reject invalid ids before calling YouTube", async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000, account: null }));
  const calls: string[] = [];
  const account = new YouTubeAccount(file, fakeFetch(() => ({ json: {} }), calls), CONFIG);
  await assert.rejects(account.feed("channel", "../x"), (error: unknown) => error instanceof YouTubeError && error.status === 400);
  await assert.rejects(account.feed("search", "  "), (error: unknown) => error instanceof YouTubeError && error.status === 400);
  assert.deepEqual(calls, []);
});

test("videos carry channel avatars, looked up once per channel", async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000, account: null }));
  const calls: string[] = [];
  const account = new YouTubeAccount(file, fakeFetch((url) => {
    if (url.pathname.endsWith("/channels")) return { json: { items: [{ id: "UCaaaaaaaaaaaaaaaaaaaaaa", snippet: { thumbnails: { medium: { url: "avatar.jpg" } } } }] } };
    return { json: { items: [video("ccccccccccc")] } };
  }, calls), CONFIG);
  const trending = await account.feed("trending");
  const liked = await account.feed("liked");
  assert.equal(trending.videos[0].channelThumbnail, "avatar.jpg");
  assert.equal(liked.videos[0].channelThumbnail, "avatar.jpg");
  assert.equal(calls.filter((call) => call.endsWith("/channels")).length, 1);
});

test("trending chips filter by category and reject odd ids", async () => {
  const file = tempFile();
  fs.writeFileSync(file, JSON.stringify({ refreshToken: "rt", accessToken: "at", expiresAt: Date.now() + 3_600_000, account: null }));
  const categories: (string | null)[] = [];
  const account = new YouTubeAccount(file, fakeFetch((url) => {
    if (url.pathname.endsWith("/videos")) categories.push(url.searchParams.get("videoCategoryId"));
    return { json: { items: [] } };
  }), CONFIG);
  await account.feed("trending", "10");
  await account.feed("trending", "0");
  await assert.rejects(account.feed("trending", "music"), (error: unknown) => error instanceof YouTubeError && error.status === 400);
  assert.deepEqual(categories, ["10", null]);
});

test("toVideo picks the sharpest thumbnail and keeps a short description", () => {
  const v = toVideo({ id: "ddddddddddd", snippet: { description: "  một\n\nhai  ", thumbnails: { medium: { url: "m.jpg" }, maxres: { url: "max.jpg" } } } });
  assert.equal(v.thumbnail, "max.jpg");
  assert.equal(v.description, "một hai");
});

test("toVideo and duration helpers map API items", () => {
  const v = toVideo(video("bbbbbbbbbbb"));
  assert.equal(v.durationSec, 3723);
  assert.equal(v.views, 1234);
  assert.equal(formatDuration(3723), "1:02:03");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(parseIsoDuration("P0D"), 0);
  assert.equal(parseIsoDuration("garbage"), null);
});
