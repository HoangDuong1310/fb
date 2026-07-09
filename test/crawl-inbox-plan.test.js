/**
 * crawl-inbox-plan.test.js — Xác minh hàm THẬT planInboxReads()/inboxBackoffMs()
 * trong src/crawl.js: lịch đọc hộp thư THÔNG MINH giúp acc lâu năm (hàng trăm
 * hội thoại) KHÔNG "load mãi không xong".
 *
 * Các case phủ:
 *  - Quét lần đầu acc lâu năm: tất cả thread là backfill -> chỉ đọc trong BUDGET.
 *  - Ưu tiên: tin mới (unread/preview đổi) đọc TRƯỚC backfill.
 *  - Thread đã đọc & không đổi -> bỏ qua (unchanged), không mở lại.
 *  - Backoff: thread trong cửa sổ nextReadAt -> hoãn (deferred).
 *  - Trần số lần hụt: đọc hụt quá maxAttempts & không có tin mới -> thôi thử.
 *  - Tin mới GHI ĐÈ backoff/trần: luôn được đọc dù đang bị hoãn.
 *  - inboxBackoffMs tăng dần và chặn trên.
 *
 * crawl.js chạm `chrome` ở mức module nên phải stub TRƯỚC khi import.
 * Chạy: node --test test/crawl-inbox-plan.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  storage: { session: { get: async () => ({}), set: async () => {} } },
  tabs: {
    query: (_q, cb) => cb && cb([]),
    create: (_o, cb) => cb && cb({ id: 1 }),
    update: async () => {},
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async () => ({}),
  },
  scripting: { executeScript: async () => [] },
  runtime: { sendMessage: () => {}, lastError: null },
  alarms: { create() {}, onAlarm: { addListener() {} }, clear() {} },
};

const { planInboxReads, inboxBackoffMs } = await import("../src/crawl.js");

const NOW = 1_000_000_000_000;

// Tạo list-thread (kết quả quét danh sách, chưa có messages).
function th(id, extra = {}) {
  return {
    threadId: String(id),
    name: "Người " + id,
    threadUrl: "https://www.facebook.com/messages/t/" + id,
    preview: extra.preview || "xin chào",
    unread: !!extra.unread,
  };
}
// Tạo bản ghi ĐÃ LƯU (stored) cho storedById map.
function stored(id, extra = {}) {
  return {
    threadId: String(id),
    preview: extra.preview !== undefined ? extra.preview : "xin chào",
    messages: extra.messages || [],
    readAt: extra.readAt !== undefined ? extra.readAt : null,
    readAttempts: extra.readAttempts || 0,
    emptyReads: extra.emptyReads || 0,
    nextReadAt: extra.nextReadAt || 0,
  };
}
function mapOf(list) {
  const m = new Map();
  for (const s of list) m.set(String(s.threadId), s);
  return m;
}

test("quét lần đầu acc lâu năm: 100 thread mới -> chỉ đọc trong BUDGET, phần còn lại pending", () => {
  const list = [];
  for (let i = 0; i < 100; i++) list.push(th(i, { preview: "p" + i }));
  // storedById RỖNG (chưa từng đọc gì) => tất cả là backfill.
  const plan = planInboxReads(list, new Map(), { budget: 8 }, NOW);
  assert.equal(plan.toRead.length, 8, "không mở quá budget");
  assert.equal(plan.counts.backfill, 100);
  assert.equal(plan.counts.fresh, 0);
  assert.equal(plan.skipped, 92, "phần còn lại để lượt sau");
});

test("ưu tiên: tin mới (unread) đọc TRƯỚC backfill", () => {
  const list = [
    th("old1", { preview: "cũ" }),
    th("new1", { unread: true, preview: "tin mới" }),
    th("old2", { preview: "cũ" }),
  ];
  // old1/old2 chưa từng đọc (backfill); new1 unread (fresh).
  const plan = planInboxReads(list, new Map(), { budget: 1 }, NOW);
  assert.equal(plan.toRead.length, 1);
  assert.equal(plan.toRead[0].threadId, "new1", "fresh phải đứng đầu hàng");
  assert.equal(plan.counts.fresh, 1);
  assert.equal(plan.counts.backfill, 2);
});

test("preview đổi so với bản đã lưu -> coi là tin mới (fresh)", () => {
  const list = [th("t1", { preview: "TIN NHẮN MỚI HOÀN TOÀN" })];
  const prev = mapOf([
    stored("t1", { preview: "tin cũ", readAt: NOW - 1000, messages: [{ text: "x" }] }),
  ]);
  const plan = planInboxReads(list, prev, { budget: 8 }, NOW);
  assert.equal(plan.counts.fresh, 1);
  assert.equal(plan.toRead[0].threadId, "t1");
});

test("đã đọc & không đổi -> unchanged, KHÔNG mở lại", () => {
  const list = [th("t1", { preview: "xin chào" })];
  const prev = mapOf([
    stored("t1", { preview: "xin chào", readAt: NOW - 1000, messages: [{ text: "x" }] }),
  ]);
  const plan = planInboxReads(list, prev, { budget: 8 }, NOW);
  assert.equal(plan.toRead.length, 0);
  assert.equal(plan.counts.unchanged, 1);
});

test("backoff: thread trong cửa sổ nextReadAt & không tin mới -> hoãn (deferred)", () => {
  const list = [th("t1", { preview: "xin chào" })];
  const prev = mapOf([
    stored("t1", {
      preview: "xin chào",
      readAt: NOW - 1000,
      readAttempts: 1,
      emptyReads: 1,
      nextReadAt: NOW + 60_000, // còn trong backoff
    }),
  ]);
  const plan = planInboxReads(list, prev, { budget: 8 }, NOW);
  assert.equal(plan.toRead.length, 0);
  assert.equal(plan.deferred, 1);
});

test("hết cửa sổ backoff & từng rỗng -> retry", () => {
  const list = [th("t1", { preview: "xin chào" })];
  const prev = mapOf([
    stored("t1", {
      preview: "xin chào",
      readAt: NOW - 100_000,
      readAttempts: 1,
      emptyReads: 1,
      nextReadAt: NOW - 1, // đã hết backoff
    }),
  ]);
  const plan = planInboxReads(list, prev, { budget: 8 }, NOW);
  assert.equal(plan.counts.retry, 1);
  assert.equal(plan.toRead[0].threadId, "t1");
});

test("hụt quá maxAttempts & không tin mới -> thôi thử (deferred)", () => {
  const list = [th("t1", { preview: "xin chào" })];
  const prev = mapOf([
    stored("t1", {
      preview: "xin chào",
      readAt: NOW - 100_000,
      readAttempts: 4, // == maxAttempts mặc định
      emptyReads: 4,
      nextReadAt: NOW - 1,
    }),
  ]);
  const plan = planInboxReads(list, prev, { budget: 8, maxAttempts: 4 }, NOW);
  assert.equal(plan.toRead.length, 0);
  assert.equal(plan.deferred, 1);
});

test("tin mới GHI ĐÈ backoff & trần: vẫn đọc dù đang bị hoãn/chịu-thua", () => {
  const list = [th("t1", { unread: true, preview: "khách nhắn lại!" })];
  const prev = mapOf([
    stored("t1", {
      preview: "cũ",
      readAt: NOW - 100_000,
      readAttempts: 9, // đã vượt trần
      emptyReads: 9,
      nextReadAt: NOW + 10_000_000, // còn backoff rất lâu
    }),
  ]);
  const plan = planInboxReads(list, prev, { budget: 8, maxAttempts: 4 }, NOW);
  assert.equal(plan.counts.fresh, 1);
  assert.equal(plan.toRead[0].threadId, "t1", "tin mới luôn được ưu tiên đọc");
  assert.equal(plan.deferred, 0);
});

test("thread không có threadId -> bỏ qua an toàn", () => {
  const list = [{ preview: "x" }, th("t1", { unread: true })];
  const plan = planInboxReads(list, new Map(), { budget: 8 }, NOW);
  assert.equal(plan.toRead.length, 1);
  assert.equal(plan.toRead[0].threadId, "t1");
});

test("input rỗng/không hợp lệ -> trả cấu trúc an toàn", () => {
  const plan = planInboxReads(null, null, null, NOW);
  assert.deepEqual(plan.toRead, []);
  assert.equal(plan.skipped, 0);
  assert.equal(plan.deferred, 0);
  assert.equal(plan.counts.considered, 0);
});

test("inboxBackoffMs tăng dần theo số lần hụt và chặn trên", () => {
  assert.equal(inboxBackoffMs(1), 5 * 60 * 1000);
  assert.equal(inboxBackoffMs(2), 15 * 60 * 1000);
  assert.equal(inboxBackoffMs(3), 45 * 60 * 1000);
  assert.equal(inboxBackoffMs(4), 120 * 60 * 1000);
  // Vượt số bậc -> giữ ở bậc cao nhất (chặn trên).
  assert.equal(inboxBackoffMs(99), 120 * 60 * 1000);
  // attempts <=0 hoặc không hợp lệ -> coi như bậc đầu.
  assert.equal(inboxBackoffMs(0), 5 * 60 * 1000);
  assert.equal(inboxBackoffMs(undefined), 5 * 60 * 1000);
});
