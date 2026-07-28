/**
 * signature.test.js — Chữ ký cuối bài đăng.
 *
 * VÌ SAO TEST NGAY Ở TẦNG HÀM THUẦN:
 * Chữ ký chứa số điện thoại/link — sai một ký tự là mất khách. Ba bất biến phải
 * được khoá lại:
 *   1. Đọc được mọi dạng đã lưu (null / chuỗi cũ / object) mà không throw —
 *      Compose nạp chữ ký lúc mở tab, throw ở đây là chết cả composer.
 *   2. Idempotent: build preview nhiều lần (sửa rồi xem lại) không nhân bản chữ ký.
 *   3. Tắt/rỗng thì KHÔNG chèn gì, chỉ trả về thân bài đã trim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SIGNATURE_SETTING_KEY,
  DEFAULT_SIGNATURE,
  normalizeSignature,
  isSignatureActive,
  appendSignature,
} from "../ui/src/lib/signature.ts";

test("khoá settings dùng cho chữ ký khớp regex của /api/settings/:key", () => {
  assert.equal(SIGNATURE_SETTING_KEY, "postSignature");
  assert.match(SIGNATURE_SETTING_KEY, /^[A-Za-z0-9_.:-]{1,128}$/);
});

test("mặc định là tắt và rỗng", () => {
  assert.deepEqual(DEFAULT_SIGNATURE, { enabled: false, text: "" });
});

test("normalizeSignature chịu được mọi giá trị thô từ settings", () => {
  // Chưa từng lưu.
  assert.deepEqual(normalizeSignature(null), { enabled: false, text: "" });
  assert.deepEqual(normalizeSignature(undefined), { enabled: false, text: "" });
  // Dữ liệu rác / kiểu sai không được làm hỏng UI.
  assert.deepEqual(normalizeSignature(42), { enabled: false, text: "" });
  assert.deepEqual(normalizeSignature([]), { enabled: false, text: "" });

  // Chuỗi thuần (bản lưu cũ) = đã bật, vì lưu rồi thì mặc nhiên muốn dùng.
  assert.deepEqual(normalizeSignature("LH: 0900"), {
    enabled: true,
    text: "LH: 0900",
  });
  assert.deepEqual(normalizeSignature("   "), { enabled: false, text: "" });

  // Object đầy đủ.
  assert.deepEqual(normalizeSignature({ enabled: true, text: " LH: 0900 " }), {
    enabled: true,
    text: "LH: 0900",
  });
  // Thiếu cờ enabled -> suy ra từ nội dung.
  assert.deepEqual(normalizeSignature({ text: "LH: 0900" }), {
    enabled: true,
    text: "LH: 0900",
  });
  // Bật nhưng rỗng -> coi như tắt (không có gì để dán).
  assert.deepEqual(normalizeSignature({ enabled: true, text: "" }), {
    enabled: false,
    text: "",
  });
  // Tắt vẫn GIỮ nội dung để người dùng bật lại không phải soạn lại.
  assert.deepEqual(normalizeSignature({ enabled: false, text: "LH: 0900" }), {
    enabled: false,
    text: "LH: 0900",
  });
});

test("normalizeSignature chuẩn hoá CRLF về LF", () => {
  const sig = normalizeSignature({ enabled: true, text: "LH: 0900\r\nFanpage: x" });
  assert.equal(sig.text, "LH: 0900\nFanpage: x");
});

test("isSignatureActive chỉ đúng khi đã bật và có nội dung", () => {
  assert.equal(isSignatureActive(null), false);
  assert.equal(isSignatureActive(undefined), false);
  assert.equal(isSignatureActive({ enabled: false, text: "LH" }), false);
  assert.equal(isSignatureActive({ enabled: true, text: "   " }), false);
  assert.equal(isSignatureActive({ enabled: true, text: "LH" }), true);
});

test("appendSignature dán chữ ký cách một dòng trống", () => {
  const sig = { enabled: true, text: "LH: 0900" };
  assert.equal(appendSignature("Bán laptop", sig), "Bán laptop\n\nLH: 0900");
});

test("appendSignature không chèn gì khi chữ ký tắt hoặc rỗng", () => {
  assert.equal(appendSignature("Bán laptop", null), "Bán laptop");
  assert.equal(appendSignature("  Bán laptop  ", { enabled: false, text: "LH" }), "Bán laptop");
  assert.equal(appendSignature("Bán laptop", { enabled: true, text: "" }), "Bán laptop");
});

test("appendSignature idempotent — gọi lại không nhân bản chữ ký", () => {
  const sig = { enabled: true, text: "LH: 0900" };
  const once = appendSignature("Bán laptop", sig);
  const twice = appendSignature(once, sig);
  const thrice = appendSignature(twice, sig);
  assert.equal(twice, once);
  assert.equal(thrice, once);
});

test("appendSignature không nhân bản khi người dùng tự gõ chữ ký trong ô nội dung", () => {
  const sig = { enabled: true, text: "LH: 0900" };
  const manual = "Bán laptop\n\nLH: 0900";
  assert.equal(appendSignature(manual, sig), manual);
});

test("appendSignature trả về đúng chữ ký khi thân bài rỗng", () => {
  const sig = { enabled: true, text: "LH: 0900" };
  assert.equal(appendSignature("", sig), "LH: 0900");
  assert.equal(appendSignature("   \n  ", sig), "LH: 0900");
});

test("appendSignature giữ NGUYÊN VĂN chữ ký nhiều dòng cho mọi biến thể AI", () => {
  const sig = {
    enabled: true,
    text: "— Liên hệ: 0912 345 678\nĐịa chỉ: 12 Lê Lợi\nFanpage: fb.com/shop",
  };
  // Mô phỏng AI xào nấu: thân bài khác nhau, chữ ký phải hệt nhau.
  const variants = ["Bán laptop giá tốt", "Laptop giá tốt đây ạ", "Cần bán laptop"];
  const out = variants.map((v) => appendSignature(v, sig));
  for (const text of out) {
    assert.ok(text.endsWith(sig.text), "chữ ký phải nằm cuối và nguyên văn");
  }
  assert.equal(new Set(out.map((t) => t.slice(t.indexOf(sig.text)))).size, 1);
});
