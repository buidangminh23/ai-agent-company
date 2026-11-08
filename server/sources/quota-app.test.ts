import assert from "node:assert/strict";
import test from "node:test";
import { actionAllowed, quotaAction, quotaTarget } from "./quota-app.ts";

test("quotaTarget forwards the popup page and its read-only data", () => {
  assert.equal(quotaTarget("/quota/web/", ""), "http://127.0.0.1:6736/web/");
  assert.equal(quotaTarget("/quota/web/assets/index-1.js", ""), "http://127.0.0.1:6736/web/assets/index-1.js");
  assert.equal(quotaTarget("/quota/v1/app/engine_state", ""), "http://127.0.0.1:6736/v1/app/engine_state");
  assert.equal(quotaTarget("/quota/v1/app/public_feed", "?q=%7B%7D"), "http://127.0.0.1:6736/v1/app/public_feed?q=%7B%7D");
});

test("quotaTarget refuses unknown commands and path tricks", () => {
  assert.equal(quotaTarget("/quota/v1/app/redeem_limit_reset", ""), null);
  assert.equal(quotaTarget("/quota/v1/limits", ""), null);
  assert.equal(quotaTarget("/quota/web/../v1/app/x", ""), null);
  assert.equal(quotaTarget("/quota/web/a\\b", ""), null);
  assert.equal(quotaTarget("/api/quota", ""), null);
});

test("quotaAction forwards only the account and reset actions", () => {
  assert.equal(quotaAction("/quota/v1/app/remove_account"), "http://127.0.0.1:6736/v1/app/remove_account");
  assert.equal(quotaAction("/quota/v1/app/redeem_limit_reset"), "http://127.0.0.1:6736/v1/app/redeem_limit_reset");
  assert.equal(quotaAction("/quota/v1/app/engine_state"), null);
  assert.equal(quotaAction("/quota/v1/app/save_document"), null);
  assert.equal(quotaAction("/quota/web/x"), null);
});

test("actionAllowed needs the write header and a same-origin page", () => {
  const ok = { "x-quota-control": "write", origin: "https://hub.example", host: "hub.example" };
  assert.equal(actionAllowed(ok), true);
  assert.equal(actionAllowed({ ...ok, "x-quota-control": undefined }), false);
  assert.equal(actionAllowed({ ...ok, origin: "https://evil.example" }), false);
  assert.equal(actionAllowed({ ...ok, origin: undefined }), false);
  assert.equal(actionAllowed({ ...ok, origin: "null" }), false);
});
