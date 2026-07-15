/**
 * fb-identity.test.js — Kiểm thử logic so khớp tài khoản Facebook (hàm thuần).
 *
 * Chỉ test `evaluateMatch` và `normalizeFbId` vì đây là các hàm THUẦN, không phụ
 * thuộc chrome/DB. Các nhánh có side-effect (readActiveFbId, getBinding, ...) phụ
 * thuộc chrome.cookies/chrome.storage nên không kiểm thử ở tầng unit này.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateMatch,
  normalizeFbId,
  MATCH_OK,
  MATCH_UNBOUND,
  MATCH_FB_ABSENT,
  MATCH_MISMATCH,
} from "../src/fb-identity.js";

/* ----------------------------- normalizeFbId ---------------------------- */

test("normalizeFbId: giữ chuỗi chữ số hợp lệ (>= 5 chữ số)", () => {
  assert.equal(normalizeFbId("100000123456789"), "100000123456789");
  assert.equal(normalizeFbId("12345"), "12345");
});

test("normalizeFbId: cắt khoảng trắng đầu/cuối", () => {
  assert.equal(normalizeFbId("  100000123456789  "), "100000123456789");
});

test("normalizeFbId: ép kiểu số -> chuỗi", () => {
  assert.equal(normalizeFbId(100000123456789), "100000123456789");
});

test("normalizeFbId: trả null cho giá trị không hợp lệ", () => {
  assert.equal(normalizeFbId(null), null);
  assert.equal(normalizeFbId(undefined), null);
  assert.equal(normalizeFbId(""), null);
  assert.equal(normalizeFbId("   "), null);
  assert.equal(normalizeFbId("1234"), null); // ít hơn 5 chữ số
  assert.equal(normalizeFbId("abc"), null);
  assert.equal(normalizeFbId("123abc"), null);
  assert.equal(normalizeFbId("100 000"), null); // có khoảng trắng ở giữa
  assert.equal(normalizeFbId("100.000"), null);
});

/* ----------------------------- evaluateMatch ---------------------------- */

test("evaluateMatch: chưa bind -> UNBOUND, cho chạy", () => {
  const r = evaluateMatch({ bound: null, current: "100000123456789" });
  assert.equal(r.ok, true);
  assert.equal(r.code, MATCH_UNBOUND);
  assert.equal(r.bound, null);
  assert.equal(r.current, "100000123456789");
});

test("evaluateMatch: bound không hợp lệ coi như chưa bind -> UNBOUND", () => {
  const r = evaluateMatch({ bound: "abc", current: "100000123456789" });
  assert.equal(r.ok, true);
  assert.equal(r.code, MATCH_UNBOUND);
  assert.equal(r.bound, null);
});

test("evaluateMatch: đã bind nhưng không thấy FB đăng nhập -> FB_ABSENT, chặn", () => {
  const r = evaluateMatch({ bound: "100000123456789", current: null });
  assert.equal(r.ok, false);
  assert.equal(r.code, MATCH_FB_ABSENT);
  assert.equal(r.bound, "100000123456789");
  assert.equal(r.current, null);
});

test("evaluateMatch: current không hợp lệ coi như vắng mặt -> FB_ABSENT", () => {
  const r = evaluateMatch({ bound: "100000123456789", current: "xxx" });
  assert.equal(r.ok, false);
  assert.equal(r.code, MATCH_FB_ABSENT);
  assert.equal(r.current, null);
});

test("evaluateMatch: bound == active -> OK, cho chạy", () => {
  const r = evaluateMatch({
    bound: "100000123456789",
    current: "100000123456789",
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, MATCH_OK);
  assert.equal(r.bound, "100000123456789");
  assert.equal(r.current, "100000123456789");
});

test("evaluateMatch: bound == active sau khi chuẩn hoá khoảng trắng -> OK", () => {
  const r = evaluateMatch({
    bound: "  100000123456789  ",
    current: "100000123456789",
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, MATCH_OK);
});

test("evaluateMatch: bound != active -> MISMATCH, CHẶN", () => {
  const r = evaluateMatch({
    bound: "100000123456789",
    current: "999999888877776",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, MATCH_MISMATCH);
  assert.equal(r.bound, "100000123456789");
  assert.equal(r.current, "999999888877776");
});

test("evaluateMatch: gọi không tham số -> UNBOUND (an toàn, không ném lỗi)", () => {
  const r = evaluateMatch();
  assert.equal(r.ok, true);
  assert.equal(r.code, MATCH_UNBOUND);
  assert.equal(r.bound, null);
  assert.equal(r.current, null);
});
