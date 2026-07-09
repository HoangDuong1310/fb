/**
 * db-jobs.test.js — Job queue is now SERVER-SIDE per user. src/db.js is a thin
 * API client: every job function just issues the right HTTP method + path +
 * body to /api/jobs and returns the parsed server response verbatim.
 *
 * Previously this suite exercised an in-memory `_memJobs` fallback (seq
 * integrity, mutation semantics). That local store no longer exists — all the
 * queue logic (id assignment, dedupe, stuck-job recovery, daily message cap)
 * lives in web/routes/jobs.js. So this suite now asserts the CLIENT CONTRACT:
 * the exact request shape each function sends, and that it faithfully returns
 * (or unwraps) the server payload.
 *
 * Runs under plain Node via `node --test test/` (no `chrome`, no backend). We
 * mock the global `fetch` — same pattern as api-client.test.js.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setBaseUrl, setToken } from "../src/api.js";
import * as DB from "../src/db.js";

// Minimal Response-like object the api client can consume.
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Capture the most recent fetch call and let each test decide the response.
let lastCall = null;
function mockFetch(status, body) {
  lastCall = null;
  global.fetch = async (url, init) => {
    lastCall = { url, init };
    return jsonResponse(status, body);
  };
}

// Parse the JSON body the client sent (or null if none).
function sentBody() {
  const raw = lastCall && lastCall.init && lastCall.init.body;
  return raw ? JSON.parse(raw) : null;
}

beforeEach(() => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");
  lastCall = null;
});

test("createJob POSTs to /api/jobs with { job } and returns the server record", async () => {
  const server = { id: 7, type: "post", status: "pending" };
  mockFetch(200, server);

  const out = await DB.createJob({ type: "post", content: "x" });

  assert.equal(lastCall.url, "http://localhost:3300/api/jobs");
  assert.equal(lastCall.init.method, "POST");
  assert.deepEqual(sentBody(), { job: { type: "post", content: "x" } });
  assert.deepEqual(out, server, "returns the server record verbatim");
});

test("createJob sends { job: {} } when given no job", async () => {
  mockFetch(200, { id: 1 });
  await DB.createJob();
  assert.deepEqual(sentBody(), { job: {} });
});

test("createJobs POSTs to /api/jobs/batch with { jobs } array", async () => {
  const jobs = [
    { type: "post", content: "a" },
    { type: "post", content: "b" },
  ];
  mockFetch(200, jobs.map((j, i) => ({ id: i + 1, ...j })));

  const out = await DB.createJobs(jobs);

  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/batch");
  assert.equal(lastCall.init.method, "POST");
  assert.deepEqual(sentBody(), { jobs });
  assert.equal(out.length, 2, "returns the server array");
});

test("createJobs coerces a non-array argument to an empty jobs array", async () => {
  mockFetch(200, []);
  await DB.createJobs(undefined);
  assert.deepEqual(sentBody(), { jobs: [] });
});

test("updateJob PATCHes /api/jobs/:id with { patch } and returns the merged record", async () => {
  const merged = { id: 42, status: "done", result: { ok: true } };
  mockFetch(200, merged);

  const out = await DB.updateJob(42, { status: "done", result: { ok: true } });

  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/42");
  assert.equal(lastCall.init.method, "PATCH");
  assert.deepEqual(sentBody(), {
    patch: { status: "done", result: { ok: true } },
  });
  assert.deepEqual(out, merged);
});

test("updateJob url-encodes the id", async () => {
  mockFetch(200, {});
  await DB.updateJob("a/b id", { status: "done" });
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/a%2Fb%20id");
});

test("updateJob returns null on a 404 instead of throwing (missing job)", async () => {
  mockFetch(404, { error: "not found" });
  const out = await DB.updateJob(999, { status: "done" });
  assert.equal(out, null, "404 must resolve to null, preserving the old contract");
});

test("updateJob rethrows non-404 errors", async () => {
  mockFetch(500, { error: "boom" });
  await assert.rejects(() => DB.updateJob(1, { status: "done" }), /500/);
});

test("getJobs GETs /api/jobs with no query when no type is given", async () => {
  mockFetch(200, [{ id: 1 }]);
  const out = await DB.getJobs();
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs");
  assert.equal(out.length, 1);
});

test("getJobs appends ?type= when a type filter is given", async () => {
  mockFetch(200, []);
  await DB.getJobs("post");
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs?type=post");
});

test("getDueJobs GETs /api/jobs/due?now=<ts>", async () => {
  mockFetch(200, []);
  await DB.getDueJobs(1234);
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/due?now=1234");
});

test("recoverStuckJobs POSTs /api/jobs/recover-stuck and unwraps { changed }", async () => {
  mockFetch(200, { changed: 3 });
  const changed = await DB.recoverStuckJobs(5000);
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/recover-stuck");
  assert.equal(lastCall.init.method, "POST");
  assert.deepEqual(sentBody(), { now: 5000 });
  assert.equal(changed, 3);
});

test("recoverStuckJobs returns 0 when server omits changed", async () => {
  mockFetch(200, {});
  assert.equal(await DB.recoverStuckJobs(1), 0);
});

test("deleteJob DELETEs /api/jobs/:id and returns true", async () => {
  mockFetch(200, { ok: true });
  const ok = await DB.deleteJob(8);
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/8");
  assert.equal(lastCall.init.method, "DELETE");
  assert.equal(ok, true);
});

test("clearFinishedJobs POSTs /api/jobs/clear-finished and unwraps { deleted }", async () => {
  mockFetch(200, { deleted: 2 });
  const n = await DB.clearFinishedJobs();
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/clear-finished");
  assert.equal(lastCall.init.method, "POST");
  assert.equal(n, 2);
});

test("clearAllJobs POSTs /api/jobs/clear-all and unwraps { deleted }", async () => {
  mockFetch(200, { deleted: 5 });
  const n = await DB.clearAllJobs();
  assert.equal(lastCall.url, "http://localhost:3300/api/jobs/clear-all");
  assert.equal(lastCall.init.method, "POST");
  assert.equal(n, 5);
});

test("countMessageJobsToday GETs /api/jobs/message-count-today?now= and unwraps { count }", async () => {
  mockFetch(200, { count: 4 });
  const n = await DB.countMessageJobsToday(9999);
  assert.equal(
    lastCall.url,
    "http://localhost:3300/api/jobs/message-count-today?now=9999"
  );
  assert.equal(n, 4);
});

test("findLiveMessageJobByProfile GETs /api/jobs/live-message?authorProfile= and unwraps { job }", async () => {
  const job = { id: 3, type: "message" };
  mockFetch(200, { job });
  const out = await DB.findLiveMessageJobByProfile("https://fb.com/u/1");
  assert.equal(
    lastCall.url,
    "http://localhost:3300/api/jobs/live-message?authorProfile=https%3A%2F%2Ffb.com%2Fu%2F1"
  );
  assert.deepEqual(out, job);
});

test("findLiveMessageJobByProfile short-circuits to null on empty input (no request)", async () => {
  mockFetch(200, { job: { id: 1 } });
  const out = await DB.findLiveMessageJobByProfile("   ");
  assert.equal(out, null);
  assert.equal(lastCall, null, "must NOT hit the network for an empty profile");
});
