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

test("apiFetch with skipAuthHandler on 401 does NOT clear token or call onUnauthorized, but still throws", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-login");

  let unauthorizedCalled = false;
  onUnauthorized(() => {
    unauthorizedCalled = true;
  });

  global.fetch = async () => jsonResponse(401, { error: "invalid credentials" });

  await assert.rejects(
    () => apiFetch("/api/auth/login", { method: "POST", skipAuthHandler: true }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(String(err.message), /401/);
      return true;
    }
  );

  assert.equal(
    unauthorizedCalled,
    false,
    "onUnauthorized must NOT run when skipAuthHandler is set"
  );
  assert.equal(
    getToken(),
    "tok-login",
    "token must NOT be cleared when skipAuthHandler is set"
  );
});

test("apiFetch on 403 ACCOUNT_INACTIVE clears the token and calls onUnauthorized with reason", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-locked");

  let unauthorizedCalled = false;
  let reasonAtCallback = "unset";
  let tokenAtCallback = "unset";
  onUnauthorized((reason) => {
    unauthorizedCalled = true;
    reasonAtCallback = reason;
    tokenAtCallback = getToken();
  });

  global.fetch = async () =>
    jsonResponse(403, {
      error: "account locked",
      code: "ACCOUNT_INACTIVE",
      status: "locked",
    });

  await assert.rejects(
    () => apiFetch("/api/groups"),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(String(err.message), /403/);
      return true;
    }
  );

  assert.equal(unauthorizedCalled, true, "onUnauthorized handler must run on 403 ACCOUNT_INACTIVE");
  assert.equal(reasonAtCallback, "locked", "handler must receive the 'locked' reason");
  assert.equal(tokenAtCallback, null, "token must be cleared before handler runs");
  assert.equal(getToken(), null, "token must remain cleared after 403 ACCOUNT_INACTIVE");
});

test("apiFetch on a plain 403 (not ACCOUNT_INACTIVE) does NOT clear token or call onUnauthorized", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-forbidden");

  let unauthorizedCalled = false;
  onUnauthorized(() => {
    unauthorizedCalled = true;
  });

  global.fetch = async () => jsonResponse(403, { error: "admin only" });

  await assert.rejects(
    () => apiFetch("/api/admin/users"),
    (err) => {
      assert.match(String(err.message), /403/);
      return true;
    }
  );

  assert.equal(
    unauthorizedCalled,
    false,
    "onUnauthorized must NOT run for a permission-only 403"
  );
  assert.equal(
    getToken(),
    "tok-forbidden",
    "token must NOT be cleared for a permission-only 403"
  );
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
