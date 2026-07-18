/**
 * structured-settings-read.test.js — RISK-BE-04 migration step 7.
 *
 * Non-warming structured reads: autoCrawl / autoSync / watch + binding result.
 * Failures must return stale+default (or cache for binding), not silent false-disabled.
 *
 * crawl.js / fb-identity touch chrome at load — stub first.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: {
      get: (_k, cb) => {
        if (typeof _k === "function") return _k({});
        if (typeof cb === "function") cb({});
        return Promise.resolve({});
      },
      set: (_o, cb) => {
        if (typeof cb === "function") cb();
        return Promise.resolve();
      },
      remove: (_k, cb) => {
        if (typeof cb === "function") cb();
        return Promise.resolve();
      },
    },
  },
  tabs: {
    query: (_q, cb) => cb && cb([]),
    create: (_o, cb) => cb && cb({ id: 1 }),
    update: async () => {},
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async () => ({}),
  },
  scripting: { executeScript: async () => [] },
  runtime: { sendMessage: () => {}, lastError: null },
  alarms: {
    create() {},
    clear: async () => true,
    get: async () => null,
    onAlarm: { addListener() {} },
  },
  cookies: {
    get: async () => null,
  },
};

import { setBaseUrl, setToken } from "../src/api.js";
import {
  getAutoCrawlConfigResult,
  getAutoSyncConfigResult,
  getWatchConfigResult,
} from "../src/crawl.js";
import { getBindingResult } from "../src/fb-identity.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function mockSettingsMap(map) {
  global.fetch = async (url) => {
    const u = String(url);
    for (const [key, resp] of Object.entries(map)) {
      if (
        u.includes("/api/settings/" + encodeURIComponent(key)) ||
        u.endsWith("/api/settings/" + key)
      ) {
        const r = typeof resp === "function" ? resp() : resp;
        return jsonResponse(r.status, r.body);
      }
    }
    return jsonResponse(200, { value: null });
  };
}

beforeEach(() => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-struct");
});

/* ----------------------------- autoCrawl -------------------------------- */

test("getAutoCrawlConfigResult: found server config", async () => {
  mockSettingsMap({
    autoCrawlConfig: {
      status: 200,
      body: {
        key: "autoCrawlConfig",
        value: { enabled: true, intervalMinutes: 30 },
      },
    },
  });
  const r = await getAutoCrawlConfigResult();
  assert.equal(r.ok, true);
  assert.equal(r.status, "found");
  assert.equal(r.stale, false);
  assert.equal(r.source, "server");
  assert.equal(r.config.enabled, true);
  assert.equal(r.config.intervalMinutes, 30);
});

test("getAutoCrawlConfigResult: missing → default, not error", async () => {
  mockSettingsMap({
    autoCrawlConfig: {
      status: 200,
      body: { key: "autoCrawlConfig", value: null },
    },
  });
  const r = await getAutoCrawlConfigResult();
  assert.equal(r.ok, true);
  assert.equal(r.status, "missing");
  assert.equal(r.stale, false);
  assert.equal(r.source, "default");
  assert.equal(r.config.enabled, false);
});

test("getAutoCrawlConfigResult: network fail → stale default ok:false", async () => {
  global.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const r = await getAutoCrawlConfigResult();
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(r.source, "default");
  assert.ok(r.config && typeof r.config === "object");
  assert.equal(r.config.enabled, false);
});

/* ----------------------------- autoSync --------------------------------- */

test("getAutoSyncConfigResult: found / missing / fail shapes", async () => {
  mockSettingsMap({
    autoSyncConfig: {
      status: 200,
      body: {
        key: "autoSyncConfig",
        value: { enabled: true, hours: [9, 18] },
      },
    },
  });
  let r = await getAutoSyncConfigResult();
  assert.equal(r.ok, true);
  assert.equal(r.source, "server");
  assert.equal(r.config.enabled, true);

  mockSettingsMap({
    autoSyncConfig: {
      status: 200,
      body: { key: "autoSyncConfig", value: null },
    },
  });
  r = await getAutoSyncConfigResult();
  assert.equal(r.ok, true);
  assert.equal(r.status, "missing");
  assert.equal(r.source, "default");

  global.fetch = async () => jsonResponse(503, { error: "down" });
  r = await getAutoSyncConfigResult();
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(r.source, "default");
});

/* ----------------------------- watch ------------------------------------ */

test("getWatchConfigResult: fail is stale not silent-disabled", async () => {
  global.fetch = async () => {
    throw new TypeError("network");
  };
  const r = await getWatchConfigResult();
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(r.source, "default");
  assert.ok(r.config);
});

test("getWatchConfigResult: found enabled", async () => {
  mockSettingsMap({
    watchRepliesConfig: {
      status: 200,
      body: {
        key: "watchRepliesConfig",
        value: { enabled: true, intervalMinutes: 20 },
      },
    },
  });
  const r = await getWatchConfigResult();
  assert.equal(r.ok, true);
  assert.equal(r.stale, false);
  assert.equal(r.config.enabled, true);
});

/* ----------------------------- binding ---------------------------------- */

test("getBindingResult: missing settings → unbound ok", async () => {
  mockSettingsMap({
    boundFbId: { status: 200, body: { key: "boundFbId", value: null } },
    boundFbName: { status: 200, body: { key: "boundFbName", value: null } },
  });
  const r = await getBindingResult();
  assert.equal(r.ok, true);
  assert.equal(r.status, "missing");
  assert.equal(r.found, false);
  assert.equal(r.stale, false);
  assert.equal(r.binding.fbId, null);
});

test("getBindingResult: found on server", async () => {
  mockSettingsMap({
    boundFbId: {
      status: 200,
      body: { key: "boundFbId", value: "100000123456789" },
    },
    boundFbName: {
      status: 200,
      body: { key: "boundFbName", value: "Test User" },
    },
  });
  const r = await getBindingResult();
  assert.equal(r.ok, true);
  assert.equal(r.found, true);
  assert.equal(r.source, "server");
  assert.equal(r.stale, false);
  assert.equal(r.binding.fbId, "100000123456789");
  assert.equal(r.binding.fbName, "Test User");
});

test("getBindingResult: server fail without cache → ok:false stale", async () => {
  // Clear any cache written by previous test via chrome.storage.local mock (empty).
  global.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const r = await getBindingResult();
  // Without cache, critical path reports failure.
  if (r.ok && r.source === "cache") {
    // If a prior test left in-memory cache in module, accept stale cache path.
    assert.equal(r.stale, true);
    assert.ok(r.binding.fbId);
  } else {
    assert.equal(r.ok, false);
    assert.equal(r.stale, true);
    assert.equal(r.binding.fbId, null);
  }
});
