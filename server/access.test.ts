import assert from "node:assert/strict";
import { test } from "node:test";
import { httpsRedirect, isHttps, isLoopback, isProxied, tokenCookie } from "./access.ts";

const req = (remoteAddress: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress }, headers }) as any;
const PUBLIC = "https://laptop.example.ts.net";

test("only direct local requests count as loopback", () => {
  assert.equal(isLoopback(req("127.0.0.1")), true);
  assert.equal(isLoopback(req("::ffff:127.0.0.1")), true);
  assert.equal(isLoopback(req("100.101.102.103")), false);
  assert.equal(isLoopback(req("127.0.0.1", { "x-forwarded-for": "100.101.102.103" })), false);
  assert.equal(isLoopback(req("127.0.0.1", { "tailscale-user-login": "a@b.c" })), false);
  assert.equal(isProxied(req("127.0.0.1", { forwarded: "for=1.2.3.4" })), true);
});

test("https is read from the proxy headers", () => {
  assert.equal(isHttps(req("127.0.0.1", { "x-forwarded-proto": "https" })), true);
  assert.equal(isHttps(req("127.0.0.1", { forwarded: "for=1.2.3.4;proto=https" })), true);
  assert.equal(isHttps(req("100.1.1.1")), false);
});

test("direct http viewers are sent to the https address, machine paths are not", () => {
  assert.equal(httpsRedirect(req("100.101.102.103"), "/?x=1", PUBLIC), `${PUBLIC}/?x=1`);
  assert.equal(httpsRedirect(req("100.101.102.103"), "/api/snapshot", `${PUBLIC}/`), `${PUBLIC}/api/snapshot`);
  assert.equal(httpsRedirect(req("100.101.102.103"), "/collector", PUBLIC), null);
  assert.equal(httpsRedirect(req("100.101.102.103"), "/collector/replies", PUBLIC), null);
  assert.equal(httpsRedirect(req("100.101.102.103"), "/healthz", PUBLIC), null);
  assert.equal(httpsRedirect(req("127.0.0.1"), "/", PUBLIC), null);
  assert.equal(httpsRedirect(req("127.0.0.1", { "x-forwarded-proto": "https" }), "/", PUBLIC), null);
  assert.equal(httpsRedirect(req("100.101.102.103"), "/", ""), null);
});

test("the login cookie is Secure only over https", () => {
  assert.match(tokenCookie("msc_token", "a b", 60, true), /^msc_token=a%20b; Max-Age=60; Path=\/; HttpOnly; SameSite=Strict; Secure$/);
  assert.doesNotMatch(tokenCookie("msc_token", "x", 60, false), /Secure/);
});
