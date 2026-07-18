/**
 * warming-settings-failsafe.test.js — RISK-BE-04 fail-safe for warming.
 *
 * processWarming / getWarmingConfigResult must NOT treat Backend failures as
 * "enabled:false" or invent a fresh warmingState. Missing settings remain valid.
 *
 * crawl.js touches chrome at module load, so stub chrome before import.
 */

import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

const createdAlarms = [];

globalThis.chrome = {
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: {
      get: (_k, cb) => cb && cb({}),
      set: (_o, cb) => cb && cb(),
      remove: (_k, cb) => cb && cb(),
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
    create(name, info) {
      createdAlarms.push({ name, info });
    },
    clear: async () => true,
    get: async () => null,
    onAlarm: { addListener() {} },
  },
};

import { setBaseUrl, setToken } from "../src/api.js";
import {
  WARMING_ALARM,
  processWarming,
  getWarmingConfigResult,
  getWarmingStateResult,
  applyWarmingConfig,
  scheduleNextWarming,
} from "../src/crawl.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Map URL path endings to response factories. */
function mockSettingsMap(map) {
  global.fetch = async (url) => {
    const u = String(url);
    for (const [key, resp] of Object.entries(map)) {
      if (u.includes("/api/settings/" + encodeURIComponent(key)) || u.endsWith("/api/settings/" + key)) {
        const r = typeof resp === "function" ? resp() : resp;
        return jsonResponse(r.status, r.body);
      }
    }
    // Default: missing
    return jsonResponse(200, { value: null });
  };
}

beforeEach(() => {
  createdAlarms.length = 0;
  setBaseUrl("http://localhost:3300");
  setToken("tok-warm");
});

test("getWarmingConfigResult found uses server config", async () => {
  mockSettingsMap({
    warmingConfig: {
      status: 200,
      body: {
        key: "warmingConfig",
        value: { enabled: true, intervalMinutes: 45, actionsPerRun: 2 },
      },
    },
  });
  const r = await getWarmingConfigResult();
  assert.equal(r.ok, true);
  assert.equal(r.status, "found");
  assert.equal(r.stale, false);
  assert.equal(r.source, "server");
  assert.equal(r.config.enabled, true);
  assert.equal(r.config.intervalMinutes, 45);
});

test("getWarmingConfigResult missing uses default enabled:false without error", async () => {
  mockSettingsMap({
    warmingConfig: { status: 200, body: { key: "warmingConfig", value: null } },
  });
  const r = await getWarmingConfigResult();
  assert.equal(r.ok, true);
  assert.equal(r.status, "missing");
  assert.equal(r.stale, false);
  assert.equal(r.source, "default");
  assert.equal(r.config.enabled, false);
});

test("getWarmingConfigResult network failure is stale and not ok", async () => {
  global.fetch = async () => {
    throw new Error("network down");
  };
  const r = await getWarmingConfigResult();
  assert.equal(r.ok, false);
  assert.equal(r.status, "network_error");
  assert.equal(r.stale, true);
  assert.equal(r.retryable, true);
  // Default config is provided for display only.
  assert.equal(r.config.enabled, false);
});

test("getWarmingStateResult missing initializes fresh state", async () => {
  mockSettingsMap({
    warmingState: { status: 200, body: { key: "warmingState", value: null } },
  });
  const r = await getWarmingStateResult();
  assert.equal(r.ok, true);
  assert.equal(r.status, "missing");
  assert.ok(r.state);
  assert.equal(r.state.sessionsToday, 0);
});

test("getWarmingStateResult server_error does not invent state for automation", async () => {
  mockSettingsMap({
    warmingState: { status: 500, body: { error: "db" } },
  });
  const r = await getWarmingStateResult();
  assert.equal(r.ok, false);
  assert.equal(r.status, "server_error");
  assert.equal(r.state, null);
  assert.equal(r.stale, true);
  assert.equal(r.retryable, true);
});

test("processWarming auto defers on config network error (not false disabled)", async () => {
  global.fetch = async (url) => {
    if (String(url).includes("warmingConfig")) {
      throw new Error("offline");
    }
    return jsonResponse(200, { value: null });
  };
  const r = await processWarming({ manual: false });
  assert.equal(r.ok, false);
  assert.equal(r.deferred, true);
  assert.equal(r.status, "network_error");
  assert.match(String(r.code), /SETTINGS_/i);
  assert.equal(
    /đang tắt/i.test(String(r.error || "")),
    false,
    "must not report false-disabled when Backend is unreachable"
  );
});

test("processWarming auto defers on state 500 (does not invent quota state)", async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("warmingConfig")) {
      return jsonResponse(200, {
        key: "warmingConfig",
        value: { enabled: true, intervalMinutes: 90, actionsPerRun: 2 },
      });
    }
    if (u.includes("warmingState")) {
      return jsonResponse(500, { error: "boom" });
    }
    return jsonResponse(200, { value: null });
  };
  const r = await processWarming({ manual: false });
  assert.equal(r.ok, false);
  assert.equal(r.deferred, true);
  assert.equal(r.status, "server_error");
  assert.match(String(r.code), /SETTINGS_/i);
});

test("processWarming manual also defers when state is unavailable", async () => {
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes("warmingConfig")) {
      return jsonResponse(200, {
        key: "warmingConfig",
        value: { enabled: false, intervalMinutes: 90 },
      });
    }
    if (u.includes("warmingState")) {
      throw new Error("offline");
    }
    return jsonResponse(200, { value: null });
  };
  const r = await processWarming({ manual: true });
  assert.equal(r.ok, false);
  assert.equal(r.deferred, true);
  assert.equal(r.status, "network_error");
});

test("processWarming missing config with enabled false returns disabled (not deferred)", async () => {
  mockSettingsMap({
    warmingConfig: { status: 200, body: { key: "warmingConfig", value: null } },
    warmingState: { status: 200, body: { key: "warmingState", value: null } },
  });
  const r = await processWarming({ manual: false });
  assert.equal(r.ok, false);
  assert.equal(r.deferred, undefined);
  assert.match(String(r.error || ""), /đang tắt/i);
});

test("applyWarmingConfig rejects when persistence fails instead of reporting enabled without an alarm", async () => {
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("warmingConfig") && (!init.method || init.method === "GET")) {
      return jsonResponse(200, {
        key: "warmingConfig",
        value: { enabled: false, intervalMinutes: 90 },
      });
    }
    if (u.includes("warmingConfig") && init.method === "PUT") {
      return jsonResponse(500, { error: "write failed" });
    }
    return jsonResponse(200, { value: null });
  };

  await assert.rejects(
    () => applyWarmingConfig({ enabled: true, intervalMinutes: 30 }),
    /API 500|write failed/i,
  );
  assert.equal(
    createdAlarms.some((entry) => entry.name === WARMING_ALARM),
    false,
    "must not claim success or create a schedule when the config was not persisted",
  );
});

test("applyWarmingConfig schedules from the just-persisted config without a second GET", async () => {
  let configGets = 0;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("warmingConfig") && (!init.method || init.method === "GET")) {
      configGets += 1;
      if (configGets === 1) {
        return jsonResponse(200, {
          key: "warmingConfig",
          value: { enabled: false, intervalMinutes: 90 },
        });
      }
      throw new Error("transient read failure after successful write");
    }
    if (u.includes("warmingConfig") && init.method === "PUT") {
      return jsonResponse(200, {
        key: "warmingConfig",
        value: JSON.parse(init.body),
      });
    }
    if (u.includes("warmingState")) {
      return jsonResponse(200, { key: "warmingState", value: null });
    }
    return jsonResponse(200, { value: null });
  };

  const config = await applyWarmingConfig({ enabled: true, intervalMinutes: 30 });
  assert.equal(config.enabled, true);
  assert.equal(configGets, 1, "scheduling should reuse the config that was just persisted");
  assert.equal(
    createdAlarms.some((entry) => entry.name === WARMING_ALARM),
    true,
    "enabled warming must have an alarm after a successful save",
  );
});

test("scheduleNextWarming creates a recovery alarm when an expired one-shot alarm cannot read settings", async () => {
  global.fetch = async () => {
    throw new Error("temporary backend outage");
  };

  const result = await scheduleNextWarming({ retryOnFailure: true });
  const recovery = createdAlarms.find((entry) => entry.name === WARMING_ALARM);
  assert.equal(result.deferred, true);
  assert.ok(recovery, "the one-shot schedule must not disappear permanently");
  assert.ok(recovery.info.delayInMinutes >= 1);
});
