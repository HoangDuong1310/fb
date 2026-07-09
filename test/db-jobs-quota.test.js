/**
 * db-jobs-quota.test.js — The job queue is now SERVER-SIDE per user, so the
 * safety cap for outreach messages (MESSAGE_DAILY_CAP) and all write validation
 * are enforced in web/routes/jobs.js, not in the client.
 *
 * The ORIGINAL bug this suite guarded: the old local writeJobs() swallowed
 * chrome.storage's lastError and always resolved, so createJobs() reported
 * "success" even though NOTHING was saved (an empty queue despite creating many
 * jobs). The invariant survives the migration in a new form: when the SERVER
 * rejects a write (quota/cap exceeded, or any non-2xx), the thin client MUST
 * propagate that failure — never fake success.
 *
 * apiFetch() throws on non-2xx including the status + server error body, so we
 * assert createJob/createJobs reject (and surface the reason) on a 429 cap and
 * on a 500, and resolve normally on 200. Same fetch-mock pattern as
 * api-client.test.js — runs under plain Node, no chrome, no backend.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setBaseUrl, setToken } from "../src/api.js";
import { MESSAGE_DAILY_CAP, createJob, createJobs } from "../src/db.js";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");
});

test("MESSAGE_DAILY_CAP stays exported for UI estimates (kept in sync with server)", () => {
  assert.equal(typeof MESSAGE_DAILY_CAP, "number");
  assert.ok(MESSAGE_DAILY_CAP > 0, "cap must be a positive number");
});

test("createJob rejects (does NOT fake success) when the server refuses the write with 429 cap", async () => {
  global.fetch = async () =>
    jsonResponse(429, { error: "message daily cap exceeded" });

  await assert.rejects(
    () => createJob({ type: "message", content: "hi" }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(String(err.message), /429/);
      assert.match(String(err.message), /cap/i);
      return true;
    },
    "createJob must surface the server rejection, not swallow it"
  );
});

test("createJobs (batch) rejects when the server refuses the write, no phantom success", async () => {
  global.fetch = async () => jsonResponse(429, { error: "quota exceeded" });

  await assert.rejects(
    () =>
      createJobs([
        { type: "post", content: "a" },
        { type: "post", content: "b" },
      ]),
    /429/,
    "a failed batch write must reject so the failure reaches background.js -> UI"
  );
});

test("createJob rethrows a generic server 500 (no silent swallow)", async () => {
  global.fetch = async () => jsonResponse(500, { error: "boom" });

  await assert.rejects(() => createJob({ type: "post" }), /500/);
});

test("createJob resolves with the saved record when the server accepts the write (control)", async () => {
  const saved = { id: 11, type: "post", status: "pending" };
  global.fetch = async () => jsonResponse(200, saved);

  const out = await createJob({ type: "post", content: "ok" });
  assert.deepEqual(out, saved, "a successful write returns the server record");
});
