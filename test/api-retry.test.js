/**
 * api-retry.test.js — Timeout và tự-thử-lại của apiFetch (src/api.js).
 *
 * Hai cơ chế này chỉ lộ ra khi mạng hỏng, nên rất dễ hồi quy mà không ai biết
 * cho tới lúc người dùng gặp. Cụ thể cần khoá lại:
 *
 *  - Request KHÔNG có timeout thì treo vĩnh viễn (fetch không tự huỷ). Trong
 *    MV3 điều đó nghĩa là crawl đứng im và sendResponse không bao giờ được gọi.
 *  - Retry phải BẬT cho lỗi tạm thời trên request an toàn, và phải TẮT cho POST
 *    thường (gửi lại có thể tạo bản ghi thứ hai) cũng như cho lỗi 4xx (thử lại
 *    chỉ tốn thời gian vì kết quả không đổi).
 *
 * Chạy: node --test test/api-retry.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { setBaseUrl, setToken, onUnauthorized, apiFetch, ApiError } from "../src/api.js";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function setup() {
  setBaseUrl("http://localhost:3300");
  setToken("tok");
  onUnauthorized(() => {});
}

test("thử lại GET khi gặp 500 rồi thành công", async () => {
  setup();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls < 3 ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, { ok: true });
  };

  const body = await apiFetch("/api/posts");
  assert.deepEqual(body, { ok: true });
  assert.equal(calls, 3, "hai lần hỏng rồi lần thứ ba thành công");
});

test("thử lại khi mất mạng rồi thành công", async () => {
  setup();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNREFUSED");
    return jsonResponse(200, { ids: [] });
  };

  const body = await apiFetch("/api/posts/known-ids");
  assert.deepEqual(body, { ids: [] });
  assert.equal(calls, 2);
});

test("ném ApiError sau khi hết lượt thử, giữ nguyên metadata", async () => {
  setup();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse(503, { error: "unavailable" });
  };

  await assert.rejects(
    () => apiFetch("/api/posts"),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 503);
      assert.equal(err.retryable, true);
      return true;
    }
  );
  assert.equal(calls, 3, "một lần đầu + hai lần thử lại");
});

test("KHÔNG thử lại lỗi 4xx (kết quả sẽ y như cũ)", async () => {
  setup();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse(400, { error: "invalid" });
  };

  await assert.rejects(() => apiFetch("/api/posts"));
  assert.equal(calls, 1, "4xx phải hỏng ngay lập tức");
});

test("KHÔNG thử lại POST thường (gửi lại có thể tạo bản ghi thứ hai)", async () => {
  setup();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse(500, { error: "boom" });
  };

  await assert.rejects(
    () => apiFetch("/api/jobs", { method: "POST", body: JSON.stringify({}) })
  );
  assert.equal(calls, 1, "POST không idempotent chỉ được gửi đúng một lần");
});

test("CÓ thử lại POST được đánh dấu idempotent (upsert theo khoá)", async () => {
  setup();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return calls < 2 ? jsonResponse(500, { error: "boom" }) : jsonResponse(200, { added: 1 });
  };

  const body = await apiFetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ posts: [] }),
    idempotent: true,
  });
  assert.deepEqual(body, { added: 1 });
  assert.equal(calls, 2);
});

test("retries: 0 tắt hẳn việc thử lại", async () => {
  setup();
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse(500, { error: "boom" });
  };

  await assert.rejects(() => apiFetch("/api/posts", { retries: 0 }));
  assert.equal(calls, 1);
});

test("huỷ request khi quá hạn chờ và báo lỗi đọc được", async () => {
  setup();
  let sawAbort = false;
  // Giả lập server treo: không bao giờ trả lời, chỉ settle khi bị abort — đúng
  // hành vi của fetch thật khi AbortController kích hoạt.
  global.fetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        sawAbort = true;
        const e = new Error("The operation was aborted");
        e.name = "AbortError";
        reject(e);
      });
    });

  await assert.rejects(
    () => apiFetch("/api/posts", { timeoutMs: 40, retries: 0 }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.kind, "timeout");
      assert.equal(err.retryable, true);
      assert.match(String(err.message), /Hết thời gian chờ/);
      return true;
    }
  );
  assert.equal(sawAbort, true, "phải thực sự abort request đang treo");
});

test("tôn trọng signal của caller (dừng crawl huỷ được request đang bay)", async () => {
  setup();
  const ctrl = new AbortController();
  global.fetch = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });

  const p = apiFetch("/api/posts", { signal: ctrl.signal, retries: 0 });
  ctrl.abort();
  await assert.rejects(p, (err) => {
    assert.equal(err.kind, "timeout");
    return true;
  });
});
