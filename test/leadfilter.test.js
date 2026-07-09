/**
 * leadfilter.test.js — Pure-logic tests for the on-device lead classifier
 * (src/dashboard/leadfilter.js) and the shared matcher (src/keyword-match.js).
 *
 * These run under plain Node via `node --test` (NOT in an extension). The
 * classifier imports `bg` from core.js only for DB keyword loading; classifyLead
 * itself never calls it, and DB_KW starts EMPTY, so classifyLead here operates on
 * the built-in keyword base only — deterministic, no chrome/network needed.
 *
 * What we lock in (the "trọn gói" fix):
 *   1) WORD-BOUNDARY matching — "gl" must not fire inside "google".
 *   2) DEACCENT matching — "thanh ly" (no accents) still catches a seller.
 *   3) SPECIFICITY scoring — long phrases outweigh short single tokens.
 *   4) STRONG-SELLER override — definite sell phrases force the seller label.
 *   5) Buy vs seller disambiguation on posts that mention both a product+price.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deaccent,
  normForMatch,
  phraseWeight,
  scoreHits,
  hasAnyKeyword,
} from "../src/keyword-match.js";

import { classifyLead } from "../src/dashboard/leadfilter.js";

/* ============================ keyword-match.js ============================ */

test("deaccent: strips Vietnamese diacritics and maps đ/Đ -> d/D", () => {
  assert.equal(deaccent("Thanh lý"), "Thanh ly");
  assert.equal(deaccent("giao lưu"), "giao luu");
  assert.equal(deaccent("đã qua sử dụng"), "da qua su dung");
  assert.equal(deaccent("ĐỎ"), "DO");
});

test("deaccent: tolerates null/undefined", () => {
  assert.equal(deaccent(null), "");
  assert.equal(deaccent(undefined), "");
});

test("normForMatch: deaccents, lowercases, and wraps with single spaces", () => {
  assert.equal(normForMatch("Thanh Lý!!!"), " thanh ly ");
  assert.equal(normForMatch("  giao   lưu  "), " giao luu ");
  assert.equal(normForMatch(""), "");
  assert.equal(normForMatch("!!!"), "");
});

test("phraseWeight: >=2 tokens -> 1.0, single >=4 chars -> 0.6, short -> 0.4", () => {
  assert.equal(phraseWeight(normForMatch("cần bán")), 1);
  assert.equal(phraseWeight(normForMatch("review")), 0.6);
  assert.equal(phraseWeight(normForMatch("gl")), 0.4);
  assert.equal(phraseWeight(normForMatch("")), 0);
});

test("scoreHits: matches on word boundaries only — 'gl' does NOT hit 'google'", () => {
  const inGoogle = scoreHits("mình xài google drive nhé", ["gl"]);
  assert.equal(inGoogle.count, 0);
  assert.equal(inGoogle.score, 0);

  const standalone = scoreHits("máy còn zin, gl nhẹ nha", ["gl"]);
  assert.equal(standalone.count, 1);
  assert.equal(standalone.score, 0.4);
});

test("scoreHits: deaccent means accent-less text matches accented keywords", () => {
  const r = scoreHits("thanh ly gap cai man hinh", ["thanh lý"]);
  assert.equal(r.count, 1);
  assert.equal(r.score, 1); // 2-token phrase
});

test("scoreHits: de-duplicates keywords that normalise to the same phrase", () => {
  // "gl " (trailing space) and "gl" collapse to the same needle -> counted once.
  const r = scoreHits("gl nhẹ", ["gl ", "gl"]);
  assert.equal(r.count, 1);
  assert.equal(r.score, 0.4);
});

test("scoreHits: tolerates empty text / empty keywords", () => {
  assert.deepEqual(scoreHits("", ["bán"]), { score: 0, count: 0, matched: [] });
  assert.deepEqual(scoreHits("bán", []), { score: 0, count: 0, matched: [] });
});

test("hasAnyKeyword: true only on a boundary match", () => {
  assert.equal(hasAnyKeyword("cần bán gấp con này", ["cần bán"]), true);
  assert.equal(hasAnyKeyword("mình dùng google", ["gl"]), false);
  assert.equal(hasAnyKeyword("", ["bán"]), false);
  assert.equal(hasAnyKeyword("bán", []), false);
});

/* ============================== classifyLead ============================== */

test("classifyLead: buyer intent -> 'buy'", () => {
  const r = classifyLead("Cần mua RTX 4060 tầm giá 5tr, bác nào có inbox em");
  assert.equal(r.label, "buy");
  assert.ok(r.signals.buy > 0);
});

test("classifyLead: support/question -> 'support'", () => {
  const r = classifyLead("Máy mình bị lỗi không lên hình, ai biết cách fix không?");
  assert.equal(r.label, "support");
  assert.ok(r.signals.support > 0);
});

test("classifyLead: strong-seller phrase forces 'seller' even with buy words", () => {
  // Contains "cần mua" (buy) but "thanh lý" is a STRONG_SELLER -> seller wins.
  const r = classifyLead("Thanh lý gấp, ai cần mua thì inbox, giá 3tr");
  assert.equal(r.label, "seller");
  assert.equal(r.signals.buy, 0);
  assert.equal(r.signals.support, 0);
  assert.ok(r.signals.seller > 0);
});

test("classifyLead: accent-less seller ('thanh ly') still classified as seller", () => {
  const r = classifyLead("Thanh ly nhanh cai laptop cu, gia 3tr, con dung tot");
  assert.equal(r.label, "seller");
});

test("classifyLead: seller with multiple soft signals crosses the threshold", () => {
  // No strong-seller phrase; relies on cumulative SELLER_BASE score >= 2.
  const r = classifyLead("Giá bán 5tr, còn bảo hành, freeship, ib zalo nhé");
  assert.equal(r.label, "seller");
  assert.ok(r.signals.seller >= 2);
});

test("classifyLead: 'gl' alone does not misclassify a plain google mention", () => {
  const r = classifyLead("Mình lưu ảnh trên google drive rồi share link");
  assert.equal(r.label, "other");
  assert.equal(r.signals.seller, 0);
});

test("classifyLead: bare question mark nudges support when no buy signal", () => {
  const r = classifyLead("Con này xài ổn không mọi người?");
  assert.equal(r.label, "support");
  assert.ok(r.signals.support > 0);
});

test("classifyLead: empty/blank text -> 'other' with zero signals", () => {
  const r = classifyLead("   ");
  assert.equal(r.label, "other");
  assert.equal(r.score, 0);
  assert.deepEqual(r.signals, { buy: 0, support: 0, seller: 0 });
});

test("classifyLead: score is a float weighted by specificity", () => {
  // Single short token seller signal "gl" -> 0.4 (not an integer count of 1).
  const r = classifyLead("gl nhẹ cái tai nghe");
  assert.equal(r.signals.seller, 0.4);
});

test("classifyLead: shop offering 'thu mua/nhận sửa' is a seller, NOT support", () => {
  // Bài THỢ/SHOP chào dịch vụ: "nhận sửa chữa" chứa 'sửa' — trước đây lọt vào
  // 'cần hỗ trợ'. SHOP_OFFER phải ép cứng nhãn seller.
  const text =
    "Em nhận thu mua lại ghế game cũ khu vực Hà Nội. Nhận sửa chữa ghế gaming, " +
    "nhận bọc lại da ghế bị bong hỏng. Trao đổi mua bán các mẫu ghế mới và cũ. SĐT/zalo 0965...";
  const r = classifyLead(text);
  assert.equal(r.label, "seller");
});

test("classifyLead: customer 'cần sửa' still counts as support", () => {
  // Đảm bảo không giết nhầm phía KHÁCH đang cần sửa.
  const r = classifyLead("Máy mình bị treo liên tục, cần sửa gấp, ai giúp mình với");
  assert.equal(r.label, "support");
  assert.ok(r.signals.support > 0);
});
