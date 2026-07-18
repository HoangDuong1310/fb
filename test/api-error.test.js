/**
 * api-error.test.js — RISK-BE-04 metadata on ApiError from apiFetch.
 * Locks kind/status/retryable classification and preserves auth side effects.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  setBaseUrl,
  setToken,
  getToken,
  onUnauthorized,
  apiFetch,
  ApiError,
} from "../src/api.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test("apiFetch throws ApiError with kind=unauthorized on 401", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok");
  onUnauthorized(() => {});
  global.fetch = async () => jsonResponse(401, { error: "invalid token" });

  await assert.rejects(
    () => apiFetch("/api/settings/x"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "unauthorized");
      assert.equal(err.status, 401);
      assert.equal(err.retryable, false);
      assert.match(String(err.message), /401/);
      return true;
    }
  );
  assert.equal(getToken(), null);
});

test("apiFetch throws ApiError with kind=account_inactive on 403 ACCOUNT_INACTIVE", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok");
  let reason = null;
  onUnauthorized((r) => {
    reason = r;
  });
  global.fetch = async () =>
    jsonResponse(403, {
      error: "locked",
      code: "ACCOUNT_INACTIVE",
      status: "locked",
    });

  await assert.rejects(
    () => apiFetch("/api/settings/x"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "account_inactive");
      assert.equal(err.status, 403);
      assert.equal(err.code, "ACCOUNT_INACTIVE");
      assert.equal(err.reason, "locked");
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(reason, "locked");
  assert.equal(getToken(), null);
});

test("apiFetch throws ApiError kind=forbidden on plain 403 without clearing token", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-keep");
  let unauthorizedCalled = false;
  onUnauthorized(() => {
    unauthorizedCalled = true;
  });
  global.fetch = async () => jsonResponse(403, { error: "admin only" });

  await assert.rejects(
    () => apiFetch("/api/admin/users"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "forbidden");
      assert.equal(err.status, 403);
      assert.equal(err.retryable, false);
      return true;
    }
  );
  assert.equal(unauthorizedCalled, false);
  assert.equal(getToken(), "tok-keep");
});

test("apiFetch throws ApiError kind=server_error retryable on 500", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok");
  global.fetch = async () => jsonResponse(500, { error: "boom" });

  await assert.rejects(
    () => apiFetch("/api/settings/x"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "server_error");
      assert.equal(err.status, 500);
      assert.equal(err.retryable, true);
      return true;
    }
  );
});

test("apiFetch throws ApiError kind=network_error when fetch rejects", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok");
  global.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };

  await assert.rejects(
    () => apiFetch("/api/settings/x"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "network_error");
      assert.equal(err.status, null);
      assert.equal(err.retryable, true);
      assert.match(String(err.message), /ECONNREFUSED/);
      return true;
    }
  );
});

test("apiFetch throws ApiError kind=invalid_request on 400", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok");
  global.fetch = async () => jsonResponse(400, { error: "invalid key" });

  await assert.rejects(
    () => apiFetch("/api/settings/bad"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "invalid_request");
      assert.equal(err.status, 400);
      assert.equal(err.retryable, false);
      return true;
    }
  );
});
