/**
 * api-client.test.js — Tests for the extension-side API client (src/api.js).
 *
 * Runs under plain Node via `node --test test/` (NOT in an extension), so there
 * is no `chrome` global here. The client must fall back to an in-memory token
 * store in that case. We mock the global `fetch` to assert request shape and
 * 401 handling without hitting a real backend.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setBaseUrl,
  setToken,
  getToken,
  onUnauthorized,
  apiFetch,
} from "../src/api.js";

// Helper: build a minimal Response-like object the client can consume.
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("apiFetch attaches Authorization: Bearer <token> header when a token is set", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-123");

  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse(200, { ok: true });
  };

  await apiFetch("/api/groups");

  assert.ok(captured, "fetch should have been called");
  const auth =
    captured.init &&
    captured.init.headers &&
    captured.init.headers.Authorization;
  assert.equal(auth, "Bearer tok-123");
  assert.equal(captured.url, "http://localhost:3300/api/groups");
});

test("apiFetch omits Authorization header when no token is set", async () => {
  setBaseUrl("http://localhost:3300");
  setToken(null);

  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse(200, { ok: true });
  };

  await apiFetch("/api/health");

  const headers = (captured.init && captured.init.headers) || {};
  assert.equal(headers.Authorization, undefined);
});

test("apiFetch on 401 invokes onUnauthorized and clears the token before throwing", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-expired");

  let unauthorizedCalled = false;
  let tokenAtCallback = "unset";
  onUnauthorized(() => {
    unauthorizedCalled = true;
    // Token must already be cleared by the time the handler runs.
    tokenAtCallback = getToken();
  });

  global.fetch = async () => jsonResponse(401, { error: "invalid token" });

  await assert.rejects(
    () => apiFetch("/api/groups"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(String(err.message), /401/);
      return true;
    }
  );

  assert.equal(unauthorizedCalled, true, "onUnauthorized handler must run");
  assert.equal(tokenAtCallback, null, "token must be cleared before handler runs");
  assert.equal(getToken(), null, "token must remain cleared after 401");
});

test("apiFetch throws on non-2xx including the status and server error body", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-ok");
  onUnauthorized(() => {});

  global.fetch = async () => jsonResponse(500, { error: "boom" });

  await assert.rejects(
    () => apiFetch("/api/groups"),
    (err) => {
      assert.match(String(err.message), /500/);
      assert.match(String(err.message), /boom/);
      return true;
    }
  );
});
