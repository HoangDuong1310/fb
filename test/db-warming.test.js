/**
 * db-warming.test.js — Client contract for warming activity log wrappers in
 * src/db.js (recordWarmingActivity / getWarmingActivity).
 *
 * Backend contract (server/web/routes.js):
 *   POST /api/warming/log body { type, status, data } -> { id, createdAt }
 *   GET  /api/warming/log?limit -> { entries: [...] }
 *
 * These tests run under plain Node with a mocked fetch (same pattern as
 * test/db-settings.test.js). They lock the request shape and response
 * passthrough so UI/background adapters do not drift.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setBaseUrl, setToken } from "../src/api.js";
import { recordWarmingActivity, getWarmingActivity } from "../src/db.js";

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
  setToken("tok-warm");
  lastCall = null;
});

test("recordWarmingActivity POSTs /api/warming/log with type/status/data", async () => {
  mockFetch(200, { id: 42, createdAt: 1700000000000 });

  const out = await recordWarmingActivity({
    type: "scrollFeed",
    status: "done",
    data: { watchedMs: 1200 },
  });

  assert.equal(lastCall.url, "http://localhost:3300/api/warming/log");
  assert.equal(lastCall.init.method, "POST");
  assert.deepEqual(sentBody(), {
    type: "scrollFeed",
    status: "done",
    data: { watchedMs: 1200 },
  });
  assert.deepEqual(out, { id: 42, createdAt: 1700000000000 });
});

test("recordWarmingActivity redacts secrets before persistence", async () => {
  mockFetch(200, { id: 43, createdAt: 1700000000001 });

  await recordWarmingActivity({
    type: "openNotifications",
    status: "error",
    data: {
      error: "Bearer abc access_token=secret",
      headers: "Authorization: Basic abc123",
      cookie: "Cookie: c_user=12345; xs=topsecret",
      nested: { apiKey: "private-key", url: "https://facebook.com/x?token=hidden" },
    },
  });

  assert.deepEqual(sentBody().data, {
    error: "Bearer [redacted] access_token=[redacted]",
    headers: "Authorization: [redacted]",
    cookie: "[redacted]",
    nested: { apiKey: "[redacted]", url: "https://facebook.com/x" },
  });
});

test("recordWarmingActivity defaults type/status/data when omitted", async () => {
  mockFetch(200, { id: 1, createdAt: 1 });
  await recordWarmingActivity({});
  assert.deepEqual(sentBody(), {
    type: "action",
    status: "done",
    data: {},
  });
});

test("recordWarmingActivity stringifies type and rejects unsupported status", async () => {
  mockFetch(200, { id: 2, createdAt: 2 });
  await recordWarmingActivity({ type: 7, status: 0, data: { ok: true } });
  assert.deepEqual(sentBody(), {
    type: "7",
    status: "error",
    data: { ok: true },
  });
});

test("recordWarmingActivity rejects on server error", async () => {
  mockFetch(500, { error: "boom" });
  await assert.rejects(() => recordWarmingActivity({ type: "x" }), /500/);
});

test("getWarmingActivity GETs /api/warming/log and returns { entries }", async () => {
  const payload = {
    entries: [
      {
        id: 9,
        type: "scrollFeed",
        status: "done",
        createdAt: 1700000000000,
        data: { n: 1 },
      },
    ],
  };
  mockFetch(200, payload);

  const out = await getWarmingActivity({ limit: 30 });

  assert.equal(lastCall.url, "http://localhost:3300/api/warming/log?limit=30");
  assert.equal((lastCall.init && lastCall.init.method) || "GET", "GET");
  // Client must pass the backend body through unchanged so background can unwrap.
  assert.deepEqual(out, payload);
  assert.ok(Array.isArray(out.entries));
});

test("getWarmingActivity omits limit when not a positive number", async () => {
  mockFetch(200, { entries: [] });
  await getWarmingActivity({});
  assert.equal(lastCall.url, "http://localhost:3300/api/warming/log");

  await getWarmingActivity({ limit: 0 });
  assert.equal(lastCall.url, "http://localhost:3300/api/warming/log");

  await getWarmingActivity({ limit: -3 });
  assert.equal(lastCall.url, "http://localhost:3300/api/warming/log");
});

test("getWarmingActivity rejects on server error (reads are not silently empty)", async () => {
  mockFetch(401, { error: "unauthorized" });
  await assert.rejects(() => getWarmingActivity({ limit: 10 }), /401/);
});

/**
 * Documents the background adapter contract for GET_WARMING_ACTIVITY.
 * Background must unwrap DB.getWarmingActivity()'s { entries } so the UI
 * receives a plain array under { ok: true, entries }.
 */
function adaptGetWarmingActivityResponse(result) {
  return {
    ok: true,
    entries: Array.isArray(result?.entries) ? result.entries : [],
  };
}

test("background adapter unwraps { entries } for the UI (no nested object)", () => {
  const backendBody = {
    entries: [{ id: 1, type: "watchVideo", status: "done", data: {} }],
  };
  const adapted = adaptGetWarmingActivityResponse(backendBody);
  assert.equal(adapted.ok, true);
  assert.ok(Array.isArray(adapted.entries), "UI requires Array.isArray(res.entries)");
  assert.equal(adapted.entries.length, 1);
  assert.equal(adapted.entries[0].type, "watchVideo");
});

test("background adapter falls back to [] when backend shape is wrong", () => {
  // Simulates the old bug: treating the whole body as entries and re-wrapping.
  const nestedBug = { entries: { entries: [{ id: 1 }] } };
  // Correct adapter sees nestedBug.entries is not an array -> [].
  assert.deepEqual(adaptGetWarmingActivityResponse(nestedBug).entries, []);
  assert.deepEqual(adaptGetWarmingActivityResponse(null).entries, []);
  assert.deepEqual(adaptGetWarmingActivityResponse(undefined).entries, []);
  assert.deepEqual(adaptGetWarmingActivityResponse({}).entries, []);
});
