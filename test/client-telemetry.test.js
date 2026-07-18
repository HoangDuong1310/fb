/**
 * client-telemetry.test.js — pure + in-memory storage tests.
 *
 * Covers redaction, fingerprint, prune, dedupe, record/list/clear.
 * Uses memory fallback (no chrome.storage).
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  redactString,
  redactValue,
  fingerprintEvent,
  pruneEvents,
  shouldAcceptEvent,
  recordTelemetry,
  listTelemetry,
  clearTelemetry,
  _resetTelemetryMemoryForTests,
  TELEMETRY_MAX_EVENTS,
  TELEMETRY_DEDUPE_WINDOW_MS,
} from "../src/client-telemetry.js";

beforeEach(() => {
  _resetTelemetryMemoryForTests();
});

/* ----------------------------- redaction -------------------------------- */

test("redactString: strips JWT, Bearer, long digit ids", () => {
  const jwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.equal(redactString(jwt), "[redacted-jwt]");
  assert.equal(redactString("Bearer abc.def.ghi-token"), "Bearer [redacted]");
  assert.equal(redactString("user 100000123456789 ok"), "user [redacted-id] ok");
});

test("redactString: strips header-style Authorization and Cookie values", () => {
  assert.equal(
    redactString("Authorization: Basic abc123"),
    "Authorization: [redacted]",
  );
  assert.equal(
    redactString("Cookie: c_user=12345; xs=topsecret"),
    "Cookie: [redacted]",
  );
  assert.equal(
    redactString("Authorization: Bearer abc\r\n TOPSECRET"),
    "Authorization: [redacted]",
  );
});

test("redactValue: redacts sensitive keys and nested values", () => {
  const out = redactValue({
    token: "secret-value",
    apiKey: "k",
    authorization: "Bearer x",
    nested: { password: "p", note: "ok" },
    id: "100000123456789",
    count: 3,
  });
  assert.equal(out.token, "[redacted]");
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out.nested.password, "[redacted]");
  assert.equal(out.nested.note, "ok");
  assert.equal(out.id, "[redacted-id]");
  assert.equal(out.count, 3);
});

test("fingerprintEvent: stable for same name+data, differs otherwise", () => {
  const a = fingerprintEvent("warming.x", { status: "network_error" });
  const b = fingerprintEvent("warming.x", { status: "network_error" });
  const c = fingerprintEvent("warming.x", { status: "server_error" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

/* ----------------------------- prune / dedupe --------------------------- */

test("pruneEvents: drops old and caps max length (newest last)", () => {
  const now = 1_000_000;
  const events = [
    { ts: now - 10, id: "old" },
    { ts: now - 5, id: "mid" },
    { ts: now - 1, id: "new" },
  ];
  const prunedAge = pruneEvents(events, {
    now,
    maxAgeMs: 7,
    maxEvents: 100,
  });
  assert.equal(prunedAge.length, 2);
  assert.equal(prunedAge[0].id, "mid");

  const many = Array.from({ length: 10 }, (_, i) => ({
    ts: now - (10 - i),
    id: String(i),
  }));
  const capped = pruneEvents(many, { now, maxAgeMs: 1e9, maxEvents: 3 });
  assert.equal(capped.length, 3);
  assert.equal(capped[0].id, "7");
  assert.equal(capped[2].id, "9");
});

test("shouldAcceptEvent: rejects same fingerprint inside window", () => {
  const now = 10_000;
  const fp = "e|{}";
  const events = [{ fp, ts: now - 100 }];
  assert.equal(shouldAcceptEvent(events, fp, now, TELEMETRY_DEDUPE_WINDOW_MS), false);
  assert.equal(
    shouldAcceptEvent(events, fp, now + TELEMETRY_DEDUPE_WINDOW_MS + 1, TELEMETRY_DEDUPE_WINDOW_MS),
    true
  );
  assert.equal(shouldAcceptEvent(events, "other", now), true);
});

/* ----------------------------- record / list / clear -------------------- */

test("recordTelemetry: records, redacts, dedupes, lists, clears", async () => {
  const t0 = 2_000_000;
  const r1 = await recordTelemetry(
    "settings.autoCrawl.fail",
    { status: "network_error", token: "super-secret", fbId: "100000123456789" },
    { now: t0, level: "warn" }
  );
  assert.equal(r1.ok, true);
  assert.equal(r1.recorded, true);
  assert.equal(r1.event.data.token, "[redacted]");
  assert.equal(r1.event.data.fbId, "[redacted-id]");
  assert.equal(r1.event.data.status, "network_error");

  const r2 = await recordTelemetry(
    "settings.autoCrawl.fail",
    { status: "network_error", token: "super-secret", fbId: "100000123456789" },
    { now: t0 + 100 }
  );
  assert.equal(r2.ok, true);
  assert.equal(r2.recorded, false);
  assert.equal(r2.reason, "deduped");

  const r3 = await recordTelemetry(
    "settings.autoCrawl.fail",
    { status: "server_error" },
    { now: t0 + 200 }
  );
  assert.equal(r3.recorded, true);

  const listed = await listTelemetry({ now: t0 + 300, limit: 50 });
  assert.equal(listed.ok, true);
  assert.equal(listed.events.length, 2);

  const cleared = await clearTelemetry();
  assert.equal(cleared.ok, true);
  const empty = await listTelemetry({ now: t0 + 400 });
  assert.equal(empty.events.length, 0);
});

test("recordTelemetry: never throws on bad input", async () => {
  const r = await recordTelemetry(null, undefined, { now: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.recorded, true);
  assert.equal(r.event.name, "event");
});

test("TELEMETRY_MAX_EVENTS is positive bound", () => {
  assert.ok(TELEMETRY_MAX_EVENTS >= 50);
});
