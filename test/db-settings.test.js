/**
 * db-settings.test.js — Per-account settings client (src/db.js
 * getSetting/setSetting/deleteSetting). These small config keys (aiConfig,
 * aiModelList, fbSelectors, crawlSettings, uiPrefs, autoCrawlConfig,
 * autoSyncConfig, watchRepliesConfig, deletedPriceSeedIds) used to live in
 * chrome.storage.local; now they go through /api/settings/:key per user.
 *
 * db.js is a thin client here, so we assert the CLIENT CONTRACT: the request
 * shape each wrapper sends, how it unwraps the server payload, and the
 * important resilience rule — getSetting must fall back to its default (never
 * throw) on a network/server error, because settings reads happen on UI init
 * where a transient failure must not break the popup/dashboard.
 *
 * Same fetch-mock pattern as api-client.test.js: runs under plain Node, no
 * chrome, no backend.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setBaseUrl, setToken } from "../src/api.js";
import { getSetting, setSetting, deleteSetting } from "../src/db.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

let lastCall = null;
function mockFetch(status, body) {
  lastCall = null;
  global.fetch = async (url, init) => {
    lastCall = { url, init };
    return jsonResponse(status, body);
  };
}

function sentBody() {
  const raw = lastCall && lastCall.init && lastCall.init.body;
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");
  lastCall = null;
});

test("getSetting GETs /api/settings/:key and unwraps the server value", async () => {
  const cfg = { apiBase: "https://x", model: "gpt-5.5" };
  mockFetch(200, { key: "aiConfig", value: cfg });

  const out = await getSetting("aiConfig");

  assert.equal(lastCall.url, "http://localhost:3300/api/settings/aiConfig");
  assert.equal((lastCall.init && lastCall.init.method) || "GET", "GET");
  assert.deepEqual(out, cfg);
});

test("getSetting url-encodes the key", async () => {
  mockFetch(200, { value: null });
  await getSetting("a/b");
  assert.equal(lastCall.url, "http://localhost:3300/api/settings/a%2Fb");
});

test("getSetting returns the provided default when the server value is null (unset key)", async () => {
  mockFetch(200, { key: "uiPrefs", value: null });
  const out = await getSetting("uiPrefs", { theme: "dark" });
  assert.deepEqual(out, { theme: "dark" }, "null value must fall back to default");
});

test("getSetting returns default null when no default is given and value is absent", async () => {
  mockFetch(200, {});
  const out = await getSetting("aiModelList");
  assert.equal(out, null);
});

test("getSetting swallows a server error and returns the default (UI init resilience)", async () => {
  mockFetch(500, { error: "boom" });
  const out = await getSetting("crawlSettings", { safe: true });
  assert.deepEqual(
    out,
    { safe: true },
    "a failed read must fall back to default, never throw on UI init"
  );
});

test("getSetting swallows a network rejection and returns the default", async () => {
  global.fetch = async () => {
    throw new Error("network down");
  };
  const out = await getSetting("deletedPriceSeedIds", []);
  assert.deepEqual(out, []);
});

test("setSetting PUTs /api/settings/:key with { value } and returns the saved value", async () => {
  const cfg = { apiBase: "https://y", model: "gpt-5.5" };
  mockFetch(200, { key: "aiConfig", value: cfg });

  const out = await setSetting("aiConfig", cfg);

  assert.equal(lastCall.url, "http://localhost:3300/api/settings/aiConfig");
  assert.equal(lastCall.init.method, "PUT");
  assert.deepEqual(sentBody(), { value: cfg });
  assert.deepEqual(out, cfg);
});

test("setSetting sends { value: null } when value is undefined", async () => {
  mockFetch(200, { key: "uiPrefs", value: null });
  await setSetting("uiPrefs", undefined);
  assert.deepEqual(sentBody(), { value: null });
});

test("setSetting falls back to the input value when the server omits value", async () => {
  mockFetch(200, {});
  const out = await setSetting("aiModelList", ["gpt-5.5"]);
  assert.deepEqual(out, ["gpt-5.5"]);
});

test("setSetting rejects on a server error (writes must not fake success)", async () => {
  mockFetch(400, { error: "Khoá không hợp lệ." });
  await assert.rejects(() => setSetting("aiConfig", {}), /400/);
});

test("deleteSetting DELETEs /api/settings/:key", async () => {
  mockFetch(200, { ok: true });
  const out = await deleteSetting("fbSelectors");
  assert.equal(lastCall.url, "http://localhost:3300/api/settings/fbSelectors");
  assert.equal(lastCall.init.method, "DELETE");
  assert.deepEqual(out, { ok: true });
});
