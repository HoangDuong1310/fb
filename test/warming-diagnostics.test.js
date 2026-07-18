import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWarmingActivityEntries,
  sanitizeWarmingDiagnostic,
  warmingDiagnosticText,
} from "../ui/src/lib/warming-diagnostics.ts";

test("sanitizeWarmingDiagnostic redacts credentials and strips URL details", () => {
  const input =
    "Bearer abc.def c_user=12345; xs=secret https://www.facebook.com/notifications?ref=private#token";

  const output = sanitizeWarmingDiagnostic(input);

  assert.equal(
    output,
    "Bearer [redacted] c_user=[redacted]; xs=[redacted] https://www.facebook.com/notifications",
  );
});

test("sanitizeWarmingDiagnostic redacts complete header-style credential values", () => {
  assert.equal(
    sanitizeWarmingDiagnostic("Cookie: sid=TOPSECRET"),
    "Cookie: [redacted]",
  );
  assert.equal(
    sanitizeWarmingDiagnostic("Authorization: Digest username=u, nonce=TOPSECRET"),
    "Authorization: [redacted]",
  );
  assert.equal(
    sanitizeWarmingDiagnostic("Authorization: Bearer abc\r\n TOPSECRET"),
    "Authorization: [redacted]",
  );
});

test("sanitizeWarmingDiagnostic redacts common token and API key forms", () => {
  const output = sanitizeWarmingDiagnostic(
    "access_token=secret token: hidden api_key=key123 Authorization: Basic abc123",
  );

  assert.equal(
    output,
    "access_token=[redacted] token: [redacted] api_key=[redacted] Authorization: [redacted]",
  );
});

test("warmingDiagnosticText tolerates malformed persisted entries", () => {
  assert.equal(warmingDiagnosticText(null), null);
  assert.equal(warmingDiagnosticText("broken"), null);
  assert.equal(warmingDiagnosticText({ data: { error: "token=secret" } }), "Lỗi: token=[redacted]");
});

test("normalizeWarmingActivityEntries drops malformed rows and normalizes status", () => {
  const output = normalizeWarmingActivityEntries([
    null,
    "broken",
    { id: null, type: "scrollFeed", status: "done" },
    { id: "", type: "scrollFeed", status: "done" },
    { id: 0, type: "scrollFeed", status: "done" },
    { id: true, type: "scrollFeed", status: "done" },
    { id: "01", type: "scrollFeed", status: "done" },
    { id: "1e2", type: "scrollFeed", status: "done" },
    { id: "4.0", type: "scrollFeed", status: "done" },
    { id: 4, type: "reactReels", status: "done", createdAt: 123, data: {} },
    { id: "5", type: 42, status: "mystery", createdAt: "bad", data: { error: "x" } },
    { id: "5", type: "scrollFeed", status: "done" },
  ]);

  assert.deepEqual(output, [
    { id: 4, type: "reactReels", status: "done", createdAt: 123, data: {} },
    { id: 5, type: "unknown", status: "error", createdAt: null, data: { error: "x" } },
  ]);
});

test("normalizeWarmingActivityEntries does not expose secret-bearing unknown types", () => {
  const output = normalizeWarmingActivityEntries([
    { id: 6, type: "token=topsecret", status: "error", data: {} },
  ]);

  assert.equal(output[0].type, "unknown");
  assert.equal(JSON.stringify(output).includes("topsecret"), false);
});

test("warmingDiagnosticText formats structured navigation errors", () => {
  const output = warmingDiagnosticText({
    type: "openNotifications",
    data: {
      stage: "action-injection",
      note: "execute-script-error",
      error: "Cannot access https://www.facebook.com/notifications?token=secret",
      navigation: { note: "hard-navigation-complete", completed: true },
    },
  });

  assert.equal(
    output,
    "Bước: action-injection · Mã: execute-script-error · Lỗi: Cannot access https://www.facebook.com/notifications",
  );
});

test("warmingDiagnosticText reads verified Reels signals from nested diagnostics", () => {
  const output = warmingDiagnosticText({
    type: "reactReels",
    data: {
      status: "done",
      verificationSignals: {
        pressedBefore: "false",
        pressedAfter: "true",
        nodeReplaced: true,
      },
    },
  });

  assert.equal(output, "Trước: false · Sau: true · DOM: nút đã được thay");
});

test("warmingDiagnosticText explains an empty session plan caused by daily write cap", () => {
  const output = warmingDiagnosticText({
    type: "session",
    data: {
      plan: [],
      attempted: 0,
      succeeded: 0,
      skippedWrites: [
        {
          action: "reactReels",
          ok: false,
          code: "write_daily_cap",
          reason: "Đã đạt trần 3 tương tác ghi trong ngày.",
        },
      ],
    },
  });

  assert.equal(
    output,
    "Kế hoạch: không có hành động · Bỏ qua reactReels: write_daily_cap — Đã đạt trần 3 tương tác ghi trong ngày.",
  );
});

test("warmingDiagnosticText explains an empty session plan caused by write cooldown", () => {
  const output = warmingDiagnosticText({
    type: "session",
    data: {
      plan: [],
      attempted: 0,
      skippedWrites: [
        {
          action: "reactReels",
          ok: false,
          code: "write_cooldown",
          reason: "Cooldown reactReels: còn ~80 phút.",
        },
      ],
    },
  });

  assert.equal(
    output,
    "Kế hoạch: không có hành động · Bỏ qua reactReels: write_cooldown — Cooldown reactReels: còn ~80 phút.",
  );
});

test("warmingDiagnosticText leaves entries without known diagnostics neutral", () => {
  assert.equal(warmingDiagnosticText({ type: "scrollFeed", data: null }), null);
  assert.equal(
    warmingDiagnosticText({ type: "scrollFeed", data: { scrolls: 4 } }),
    null,
  );
});
