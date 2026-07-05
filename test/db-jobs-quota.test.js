/**
 * db-jobs-quota.test.js — Kiểm thử writeJobs() (qua createJob/createJobs) khi
 * chrome.storage.local.set() vượt hạn mức lưu trữ (QUOTA_BYTES) và đặt
 * chrome.runtime.lastError trong callback.
 *
 * Bug đã sửa: trước đây writeJobs() bỏ qua lastError (`void chrome.runtime.lastError`)
 * và luôn resolve, khiến createJobs() báo "thành công" dù KHÔNG có gì được lưu
 * (hàng đợi trống dù tạo nhiều job kèm nhiều ảnh cho nhiều nhóm). Nay writeJobs()
 * PHẢI reject để lỗi lan lên tới background.js -> UI.
 *
 * Cần globalThis.chrome giả (có chrome.storage.local) TRƯỚC khi import db.js, vì
 * db.js kiểm tra hasChromeStorage() = typeof chrome !== "undefined" && chrome.storage.local.
 * Dùng dynamic import để đảm bảo module được nạp lại đúng lúc.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

function installFakeChromeStorage({ failSet } = {}) {
  let stored = {};
  globalThis.chrome = {
    storage: {
      local: {
        get(key, cb) {
          chrome.runtime.lastError = undefined;
          cb({ [key]: stored[key] });
        },
        set(obj, cb) {
          if (failSet) {
            chrome.runtime.lastError = {
              message: "Resource::kQuotaBytes quota exceeded",
            };
            cb();
            chrome.runtime.lastError = undefined;
            return;
          }
          chrome.runtime.lastError = undefined;
          Object.assign(stored, obj);
          cb();
        },
      },
    },
    runtime: { lastError: undefined },
  };
  return { getStored: () => stored };
}

test("writeJobs (qua createJob) reject khi chrome.storage.local.set vượt hạn mức", async () => {
  installFakeChromeStorage({ failSet: true });
  const DB = await import("../src/db.js?quota-fail-" + Date.now());

  await assert.rejects(
    () => DB.createJob({ type: "post", content: "x" }),
    /quota/i,
    "createJob phải reject (không được nuốt lastError) khi ghi storage thất bại"
  );
});

test("writeJobs (qua createJobs batch) reject khi vượt hạn mức, KHÔNG báo thành công giả", async () => {
  installFakeChromeStorage({ failSet: true });
  const DB = await import("../src/db.js?quota-fail-batch-" + Date.now());

  await assert.rejects(
    () =>
      DB.createJobs([
        { type: "post", content: "a" },
        { type: "post", content: "b" },
      ]),
    /quota/i
  );
});

test("writeJobs thành công bình thường khi KHÔNG vượt hạn mức (đối chứng)", async () => {
  const { getStored } = installFakeChromeStorage({ failSet: false });
  const DB = await import("../src/db.js?quota-ok-" + Date.now());

  const job = await DB.createJob({ type: "post", content: "ok" });
  assert.ok(job.id != null);
  const stored = getStored();
  const savedStore = Object.values(stored)[0];
  assert.ok(
    savedStore && Array.isArray(savedStore.jobs) && savedStore.jobs.length === 1,
    "phải thực sự ghi vào storage khi không lỗi"
  );
});
