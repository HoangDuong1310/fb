/**
 * db-jobs.test.js — Task 7: job queue is the one piece of real LOCAL logic in
 * src/db.js (seq integrity, in-memory fallback, mutation semantics). Everything
 * else is a thin API client. This suite exercises the `_memJobs` in-memory
 * fallback path: it runs under plain Node via `node --test test/*.test.js` with
 * NO `chrome` defined, so db.js falls back to the in-memory job store.
 *
 * The in-memory store is process-global mutable state. To keep tests isolated
 * we wipe it in a beforeEach using ONLY the public API (getJobs + deleteJob) —
 * no production-only reset hook.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as DB from "../src/db.js";

// Reset the shared in-memory job store between tests via the public API so the
// process-global `_memJobs` does not bleed across tests.
beforeEach(async () => {
  const jobs = await DB.getJobs();
  for (const j of jobs) {
    await DB.deleteJob(j.id);
  }
});

test("createJob returns a record with a generated id and seq increments across creates", async () => {
  const a = await DB.createJob({ type: "post" });
  const b = await DB.createJob({ type: "comment" });

  assert.ok(a.id != null, "createJob must assign an id");
  assert.ok(b.id != null, "createJob must assign an id");
  assert.notEqual(a.id, b.id, "ids must be unique across creates");
  assert.equal(
    b.id,
    a.id + 1,
    "seq must increment by one across successive creates"
  );
});

test("updateJob applies a patch (status/result)", async () => {
  const job = await DB.createJob({ type: "post" });

  const updated = await DB.updateJob(job.id, {
    status: "done",
    result: { ok: true },
  });

  assert.equal(updated.status, "done", "status patch must apply");
  assert.deepEqual(updated.result, { ok: true }, "result patch must apply");
  assert.ok(updated.updatedAt, "updateJob must stamp updatedAt");
});

test("updateJob does NOT let a malicious { id } patch change the primary key", async () => {
  const job = await DB.createJob({ type: "post" });
  const originalId = job.id;

  const updated = await DB.updateJob(originalId, {
    id: "hacked",
    status: "done",
  });

  assert.equal(
    updated.id,
    originalId,
    "updateJob must pin id last — the primary key is immutable"
  );

  // And the record is still addressable by its original id.
  const all = await DB.getJobs();
  assert.ok(
    all.some((j) => j.id === originalId),
    "job must still be findable by its original id after a malicious patch"
  );
});

test("getJobs returns newest-first by createdAt, with optional type filter", async () => {
  const first = await DB.createJob({ type: "post" });
  // Force a strictly increasing createdAt so ordering is deterministic.
  await DB.updateJob(first.id, { createdAt: 1000 });
  const second = await DB.createJob({ type: "comment" });
  await DB.updateJob(second.id, { createdAt: 2000 });

  const all = await DB.getJobs();
  assert.equal(all.length, 2, "getJobs returns all jobs");
  assert.equal(all[0].id, second.id, "newest createdAt must come first");
  assert.equal(all[1].id, first.id, "oldest createdAt must come last");

  const onlyPosts = await DB.getJobs("post");
  assert.equal(onlyPosts.length, 1, "type filter must narrow results");
  assert.equal(onlyPosts[0].id, first.id);
});

test("getDueJobs(now) returns only pending jobs with scheduledAt <= now, sorted ascending", async () => {
  const due1 = await DB.createJob({ type: "post", scheduledAt: 100 });
  const due2 = await DB.createJob({ type: "post", scheduledAt: 50 });
  const future = await DB.createJob({ type: "post", scheduledAt: 5000 });
  const doneNow = await DB.createJob({ type: "post", scheduledAt: 10 });
  await DB.updateJob(doneNow.id, { status: "done" });

  const due = await DB.getDueJobs(1000);

  const ids = due.map((j) => j.id);
  assert.deepEqual(
    ids,
    [due2.id, due1.id],
    "only pending jobs at or before now, sorted ascending by scheduledAt"
  );
  assert.ok(!ids.includes(future.id), "future jobs are excluded");
  assert.ok(!ids.includes(doneNow.id), "non-pending jobs are excluded");
});

test("clearFinishedJobs removes done/error jobs and returns the deleted count", async () => {
  const pending = await DB.createJob({ type: "post" });
  const done = await DB.createJob({ type: "post" });
  const errored = await DB.createJob({ type: "post" });
  await DB.updateJob(done.id, { status: "done" });
  await DB.updateJob(errored.id, { status: "error" });

  const deleted = await DB.clearFinishedJobs();

  assert.equal(deleted, 2, "clearFinishedJobs returns the number removed");
  const remaining = await DB.getJobs();
  assert.equal(remaining.length, 1, "only unfinished jobs remain");
  assert.equal(remaining[0].id, pending.id, "the pending job survives");
});

test("deleteJob removes by id", async () => {
  const a = await DB.createJob({ type: "post" });
  const b = await DB.createJob({ type: "post" });

  const ok = await DB.deleteJob(a.id);
  assert.equal(ok, true, "deleteJob returns true");

  const remaining = await DB.getJobs();
  const ids = remaining.map((j) => j.id);
  assert.ok(!ids.includes(a.id), "deleted job is gone");
  assert.ok(ids.includes(b.id), "other jobs are untouched");
});
