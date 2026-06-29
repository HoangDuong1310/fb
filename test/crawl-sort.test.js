/**
 * crawl-sort.test.js — Xác minh hàm THẬT withNewestSort() trong src/crawl.js
 * (không phải bản chép tay) ép URL nhóm về chế độ "Bài viết mới"
 * (?sorting_setting=CHRONOLOGICAL) đúng trong mọi biến thể input.
 *
 * crawl.js import DB/util/prices vốn chạm tới `chrome` ở mức module, nên ta gắn
 * globalThis.chrome tối thiểu TRƯỚC khi import — giống test/dashboard-core-bg.test.js.
 * Chạy: node --test test/crawl-sort.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// --- Stub chrome tối thiểu để import crawl.js không nổ ở top-level. ---
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

const { withNewestSort } = await import("../src/crawl.js");

const SORT = "sorting_setting=CHRONOLOGICAL";

test("URL nhóm trơn -> thêm sorting_setting=CHRONOLOGICAL", () => {
  const out = withNewestSort("https://www.facebook.com/groups/123/");
  assert.equal(out, "https://www.facebook.com/groups/123/?" + SORT);
});

test("URL đã có query khác -> giữ query cũ, thêm sort (không nhân đôi ?)", () => {
  const out = withNewestSort("https://www.facebook.com/groups/123/?ref=bookmarks");
  const u = new URL(out);
  assert.equal(u.searchParams.get("ref"), "bookmarks");
  assert.equal(u.searchParams.get("sorting_setting"), "CHRONOLOGICAL");
  // chỉ một dấu ? duy nhất
  assert.equal((out.match(/\?/g) || []).length, 1);
});

test("URL đã có sort=CHRONOLOGICAL -> idempotent, không nhân đôi tham số", () => {
  const once = withNewestSort("https://www.facebook.com/groups/123/?" + SORT);
  const twice = withNewestSort(once);
  assert.equal(once, twice);
  const u = new URL(twice);
  assert.deepEqual(u.searchParams.getAll("sorting_setting"), ["CHRONOLOGICAL"]);
});

test("URL có sort cũ khác (ví dụ TOP) -> ghi đè về CHRONOLOGICAL", () => {
  const out = withNewestSort(
    "https://www.facebook.com/groups/123/?sorting_setting=TOP_POSTS"
  );
  const u = new URL(out);
  assert.equal(u.searchParams.get("sorting_setting"), "CHRONOLOGICAL");
  assert.deepEqual(u.searchParams.getAll("sorting_setting"), ["CHRONOLOGICAL"]);
});

test("URL có hash -> hash bị bỏ (tránh anchor làm hỏng điều hướng tab)", () => {
  const out = withNewestSort("https://www.facebook.com/groups/123/#scrollpos");
  assert.equal(out.includes("#"), false);
  assert.ok(out.includes(SORT));
});

test("Nhóm bằng slug chữ -> vẫn gắn đúng tham số", () => {
  const out = withNewestSort("https://www.facebook.com/groups/zalopay/");
  assert.equal(out, "https://www.facebook.com/groups/zalopay/?" + SORT);
});

test("Nhóm theo ID số (đúng nhóm user đưa) -> gắn đúng tham số", () => {
  const out = withNewestSort(
    "https://www.facebook.com/groups/410554027818048"
  );
  const u = new URL(out);
  assert.equal(u.pathname, "/groups/410554027818048");
  assert.equal(u.searchParams.get("sorting_setting"), "CHRONOLOGICAL");
});

test("Chuỗi không parse được thành URL -> fallback nối chuỗi vẫn có tham số", () => {
  const out = withNewestSort("not a url");
  assert.ok(out.includes(SORT));
});
