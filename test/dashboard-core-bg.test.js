/**
 * dashboard-core-bg.test.js — Kiểm thử logic gửi message của bg() trong
 * src/dashboard/core.js. Trọng tâm là cách xử lý lỗi kênh "tạm thời" của MV3:
 * khi service worker đang bị Chrome cho ngủ, message đầu tiên hỏng với
 * "The message port closed before a response was received." bg() phải tự gửi
 * lại để SW mới kịp thức dậy, thay vì bắt người dùng Reload extension.
 *
 * core.js KHÔNG truy cập chrome/document ở top-level nên import được trong Node
 * thuần; ta chỉ cần gắn globalThis.chrome giả trước khi gọi bg().
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { bg } from "../src/dashboard/core.js";

// Gắn một chrome.runtime.sendMessage giả: mỗi lần gọi sẽ lấy phần tử kế tiếp
// trong `responses`. Mỗi phần tử là { lastError?, res? }:
//  - lastError: chuỗi -> mô phỏng chrome.runtime.lastError (kênh lỗi).
//  - res:       giá trị trả về cho callback (khi không có lastError).
function installFakeChrome(responses) {
  const calls = [];
  let i = 0;
  globalThis.chrome = {
    runtime: {
      // sendMessage(message, callback)
      sendMessage(message, callback) {
        calls.push(message);
        const step = responses[Math.min(i, responses.length - 1)];
        i += 1;
        // Đặt lastError đúng như Chrome: chỉ tồn tại trong phạm vi callback.
        chrome.runtime.lastError = step.lastError
          ? { message: step.lastError }
          : undefined;
        callback(step.res);
        chrome.runtime.lastError = undefined;
      },
      lastError: undefined,
    },
  };
  return { calls };
}

test("bg: thành công ngay lần đầu trả nguyên response, gửi đúng 1 lần", async () => {
  const { calls } = installFakeChrome([{ res: { ok: true, keywords: [1, 2] } }]);
  const out = await bg("GET_KEYWORDS", { kwType: "sell" });
  assert.deepEqual(out, { ok: true, keywords: [1, 2] });
  assert.equal(calls.length, 1);
  // Payload KHÔNG được dùng khóa "type" (trùng khóa định tuyến của bg).
  // Dùng "kwType" để cả lệnh lẫn tham số cùng tới được service worker.
  assert.deepEqual(calls[0], { type: "GET_KEYWORDS", kwType: "sell" });
});

test("bg: lỗi kênh tạm thời lần đầu rồi thành công -> tự gửi lại, trả OK", async () => {
  const { calls } = installFakeChrome([
    { lastError: "The message port closed before a response was received." },
    { res: { ok: true, keywords: [] } },
  ]);
  const out = await bg("GET_KEYWORDS", { type: "sell" });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 2, "phải gửi lại lần 2 sau lỗi kênh tạm thời");
});

test("bg: lỗi kênh tạm thời mọi lần -> cạn lượt thử, trả thông báo Reload", async () => {
  const { calls } = installFakeChrome([
    { lastError: "Could not establish connection. Receiving end does not exist." },
  ]);
  const out = await bg("GET_KEYWORDS", { type: "sell" }, 2);
  assert.equal(out.ok, false);
  assert.match(out.error, /Mất kết nối tới tiện ích/);
  // retries=2 -> tổng cộng 3 lần gửi (1 gốc + 2 thử lại).
  assert.equal(calls.length, 3);
});

test("bg: SW trả ok:false (lỗi thật) -> KHÔNG gửi lại, trả luôn lỗi đó", async () => {
  const { calls } = installFakeChrome([
    { res: { ok: false, error: "Chưa đăng nhập" } },
  ]);
  const out = await bg("GET_KEYWORDS", { type: "sell" });
  assert.deepEqual(out, { ok: false, error: "Chưa đăng nhập" });
  assert.equal(calls.length, 1, "lỗi thật không được thử lại");
});

test("bg: SW không phản hồi (res undefined) -> báo SW bản cũ, không thử lại", async () => {
  const { calls } = installFakeChrome([{ res: undefined }]);
  const out = await bg("UNKNOWN_CMD", {});
  assert.equal(out.ok, false);
  assert.match(out.error, /không phản hồi lệnh/);
  assert.equal(calls.length, 1);
});
