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

import { setBaseUrl, setToken, getToken, onUnauthorized } from "../src/api.js";
import { getSetting, getSettingResult, setSetting, deleteSetting } from "../src/db.js";

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

/* -------------------- RISK-BE-04: getSettingResult taxonomy ------------- */

test("getSettingResult found keeps the server value", async () => {
  const cfg = { enabled: true, intervalMinutes: 60 };
  mockFetch(200, { key: "warmingConfig", value: cfg });
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, true);
  assert.equal(out.status, "found");
  assert.equal(out.found, true);
  assert.deepEqual(out.value, cfg);
});

test("getSettingResult missing when value is null (unset key)", async () => {
  mockFetch(200, { key: "warmingState", value: null });
  const out = await getSettingResult("warmingState");
  assert.equal(out.ok, true);
  assert.equal(out.status, "missing");
  assert.equal(out.found, false);
  assert.equal(out.value, null);
});

test("getSettingResult invalid_response when body lacks value field", async () => {
  mockFetch(200, {});
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, false);
  assert.equal(out.status, "invalid_response");
  assert.notEqual(out.status, "missing");
  assert.equal(out.retryable, true);
});

test("getSettingResult invalid_response when body is null", async () => {
  mockFetch(200, null);
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, false);
  assert.equal(out.status, "invalid_response");
});

test("getSettingResult unauthorized on 401 and auth handler still runs", async () => {
  setToken("tok-expired");
  let unauthorizedCalled = false;
  onUnauthorized(() => {
    unauthorizedCalled = true;
  });
  mockFetch(401, { error: "invalid token" });
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, false);
  assert.equal(out.status, "unauthorized");
  assert.equal(out.httpStatus, 401);
  assert.equal(out.retryable, false);
  assert.equal(unauthorizedCalled, true);
  assert.equal(getToken(), null);
});

test("getSettingResult account_inactive on 403 ACCOUNT_INACTIVE", async () => {
  setToken("tok-locked");
  let reason = "unset";
  onUnauthorized((r) => {
    reason = r;
  });
  mockFetch(403, { error: "locked", code: "ACCOUNT_INACTIVE", status: "locked" });
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, false);
  assert.equal(out.status, "account_inactive");
  assert.equal(out.httpStatus, 403);
  assert.equal(out.retryable, false);
  assert.equal(reason, "locked");
  assert.equal(getToken(), null);
});

test("getSettingResult forbidden on plain 403 does not clear token", async () => {
  setToken("tok-forbidden");
  let unauthorizedCalled = false;
  onUnauthorized(() => {
    unauthorizedCalled = true;
  });
  mockFetch(403, { error: "admin only" });
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, false);
  assert.equal(out.status, "forbidden");
  assert.equal(out.httpStatus, 403);
  assert.equal(unauthorizedCalled, false);
  assert.equal(getToken(), "tok-forbidden");
});

test("getSettingResult invalid_request on 400", async () => {
  mockFetch(400, { error: "invalid key" });
  const out = await getSettingResult("bad key!!");
  assert.equal(out.ok, false);
  assert.equal(out.status, "invalid_request");
  assert.equal(out.httpStatus, 400);
  assert.equal(out.retryable, false);
});

test("getSettingResult server_error on 500 is retryable", async () => {
  mockFetch(500, { error: "boom" });
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, false);
  assert.equal(out.status, "server_error");
  assert.equal(out.httpStatus, 500);
  assert.equal(out.retryable, true);
});

test("getSettingResult network_error on fetch reject is retryable", async () => {
  global.fetch = async () => {
    throw new Error("network down");
  };
  const out = await getSettingResult("warmingConfig");
  assert.equal(out.ok, false);
  assert.equal(out.status, "network_error");
  assert.equal(out.httpStatus, null);
  assert.equal(out.retryable, true);
});

test("legacy getSetting still returns def for missing and failure", async () => {
  mockFetch(200, { key: "uiPrefs", value: null });
  assert.deepEqual(await getSetting("uiPrefs", { theme: "dark" }), { theme: "dark" });

  mockFetch(500, { error: "boom" });
  assert.deepEqual(await getSetting("crawlSettings", { safe: true }), { safe: true });

  global.fetch = async () => {
    throw new Error("offline");
  };
  assert.deepEqual(await getSetting("deletedPriceSeedIds", []), []);
});
