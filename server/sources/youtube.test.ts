import assert from "node:assert/strict";
import test from "node:test";
import { parseYouTubeFeed } from "./youtube.ts";

const FEED = `<?xml version="1.0"?><feed><title>Demo Channel</title>
<entry><yt:videoId>AAAAAAAAAAA</yt:videoId><title>Cũ &amp; hay</title><published>2026-01-01T00:00:00+00:00</published></entry>
<entry><yt:videoId>BBBBBBBBBBB</yt:videoId><title>Mới &#39;nhất&#39;</title><published>2026-09-15T16:16:41+00:00</published></entry>
<entry><yt:videoId>bad</yt:videoId><title>Hỏng</title></entry></feed>`;

test("parseYouTubeFeed keeps valid entries newest first and decodes entities", () => {
  const { channelTitle, videos } = parseYouTubeFeed(FEED);
  assert.equal(channelTitle, "Demo Channel");
  assert.deepEqual(videos.map((v) => v.id), ["BBBBBBBBBBB", "AAAAAAAAAAA"]);
  assert.equal(videos[0].title, "Mới 'nhất'");
  assert.equal(videos[1].title, "Cũ & hay");
});

test("parseYouTubeFeed returns no videos for an empty channel", () => {
  assert.deepEqual(parseYouTubeFeed("<feed><title>X</title></feed>").videos, []);
});
