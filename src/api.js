/**
 * api.js — Extension-side HTTP client cho web backend (Node + Express + MySQL).
 *
 * Vai trò:
 *  - Giữ base URL + JWT token, gắn header Authorization vào mọi request.
 *  - Parse JSON, ném lỗi khi status không phải 2xx (kèm status + body.error).
 *  - Khi gặp 401: XOÁ token TRƯỚC rồi gọi handler onUnauthorized, sau đó mới ném.
 *
 * Lưu trữ token:
 *  - Trong extension (MV3): persist vào chrome.storage.local để sống qua restart.
 *  - Ngoài extension (test chạy bằng plain Node, không có `chrome`): rơi về biến
 *    in-memory để test chạy được. Luôn giữ cache in-memory để getToken() đồng bộ.
 *
 * Module ES (import/export), khớp phong cách util.js / db.js.
 */

import { API_BASE_URL } from "./config.js";

// Khoá lưu token trong chrome.storage.local.
const TOKEN_KEY = "webAuthToken";

// Base URL backend: lấy từ config.js (NƠI DUY NHẤT để sửa khi deploy — xem
// src/config.js). setBaseUrl() vẫn có thể ghi đè runtime nếu sau này cần.
let baseUrl = API_BASE_URL;

// Cache token in-memory để getToken() đồng bộ (không phải đợi storage async).
let tokenCache = null;

// Handler gọi khi gặp 401 (token hết hạn / không hợp lệ). Mặc định no-op.
let unauthorizedHandler = null;

/** Có đang chạy trong môi trường extension có chrome.storage không? */
function hasChromeStorage() {
  return (
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.local
  );
}

/** Đặt base URL của backend (bỏ dấu "/" thừa ở cuối). */
export function setBaseUrl(url) {
  baseUrl = String(url || "").replace(/\/+$/, "");
}

/** Lấy base URL hiện tại. */
export function getBaseUrl() {
  return baseUrl;
}

/**
 * Đặt token (hoặc null để xoá). Cập nhật cache in-memory NGAY (đồng bộ) rồi
 * persist xuống chrome.storage.local nếu có (best-effort, không chờ).
 */
export function setToken(token) {
  tokenCache = token || null;
  if (hasChromeStorage()) {
    try {
      if (tokenCache) {
        chrome.storage.local.set({ [TOKEN_KEY]: tokenCache }, () => {
          void chrome.runtime.lastError;
        });
      } else {
        chrome.storage.local.remove(TOKEN_KEY, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch (e) {
      // Bỏ qua: cache in-memory vẫn đúng để phiên hiện tại hoạt động.
    }
  }
}

/** Lấy token hiện tại (đồng bộ, từ cache in-memory). */
export function getToken() {
  return tokenCache;
}

/**
 * Nạp token từ chrome.storage.local vào cache in-memory (gọi lúc khởi động SW).
 * Ngoài extension thì không có gì để nạp -> trả về cache hiện tại.
 */
export function loadToken() {
  if (!hasChromeStorage()) {
    return Promise.resolve(tokenCache);
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(TOKEN_KEY, (r) => {
        void chrome.runtime.lastError;
        tokenCache = (r && r[TOKEN_KEY]) || null;
        resolve(tokenCache);
      });
    } catch (e) {
      resolve(tokenCache);
    }
  });
}

/** Đăng ký handler chạy khi gặp 401 (sau khi token đã bị xoá). */
export function onUnauthorized(cb) {
  unauthorizedHandler = typeof cb === "function" ? cb : null;
}

/**
 * Gọi API: gắn bearer header (nếu có token), parse JSON, ném khi non-2xx.
 *
 * @param {string} path  Đường dẫn tương đối ("/api/groups") hoặc URL tuyệt đối.
 * @param {object} init  Tuỳ chọn fetch (method, body, headers...).
 * @returns {Promise<any>} Body JSON đã parse khi thành công.
 */
export async function apiFetch(path, init = {}) {
  const url = /^https?:\/\//i.test(path) ? path : baseUrl + path;

  // MV3: service worker bị tắt sau ~30s rảnh. Khi một alarm/message đánh thức nó
  // dậy, module được NẠP LẠI nên tokenCache = null trong khi token THẬT vẫn nằm
  // ở chrome.storage.local. Nếu gọi API ngay lúc này (vd jobTick mỗi phút), request
  // sẽ thiếu Bearer -> backend trả 401 -> luồng 401 bên dưới xoá NHẦM token đã lưu
  // và phát AUTH_REQUIRED, khiến người dùng bị "đăng xuất sau vài phút" dù token
  // vẫn còn hạn. Nạp lại token từ storage TRƯỚC khi gửi để đóng cửa sổ đua này cho
  // MỌI caller (kể cả các tác vụ nền chạy theo alarm không await readyPromise).
  if (!tokenCache && hasChromeStorage()) {
    await loadToken();
  }

  const headers = { ...(init.headers || {}) };
  // Ghi lại token THỰC SỰ gửi đi: dùng để phân biệt 401 "phiên hết hạn" (có gửi
  // token) với 401 "chưa đăng nhập" (không có token) ở luồng xử lý lỗi bên dưới.
  const sentToken = tokenCache;
  // Chỉ gắn Authorization khi thực sự có token.
  if (sentToken) {
    headers.Authorization = "Bearer " + sentToken;
  }
  // Mặc định gửi/nhận JSON khi có body và chưa set Content-Type.
  if (init.body != null && headers["Content-Type"] == null) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, { ...init, headers });

  // Parse JSON best-effort (một số endpoint có thể trả rỗng).
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }

  if (!res.ok) {
    // 401: xoá token TRƯỚC rồi mới gọi handler, đảm bảo handler thấy token = null.
    // skipAuthHandler=true: BỎ QUA luồng 401 toàn cục (vd lúc đăng nhập, 401 chỉ
    // nghĩa là sai thông tin — KHÔNG được xoá token phiên hiện tại hay broadcast
    // AUTH_REQUIRED). Vẫn ném lỗi như thường để caller tự xử lý.
    //
    // CHỈ coi 401 là "phiên hết hạn" khi request THỰC SỰ có gửi token (sentToken).
    // Một 401 cho request KHÔNG kèm token nghĩa là "chưa đăng nhập" chứ không phải
    // token đã hỏng — xoá token đã lưu lúc này sẽ đá NHẦM người dùng ra (đúng triệu
    // chứng "đăng xuất sau vài phút" khi SW vừa thức dậy mà cache token còn rỗng).
    if (res.status === 401 && sentToken && !init.skipAuthHandler) {
      setToken(null);
      if (unauthorizedHandler) {
        try {
          unauthorizedHandler();
        } catch (e) {
          // Không để lỗi handler che lỗi 401 gốc.
        }
      }
    }
    const serverMsg = body && body.error ? ": " + body.error : "";
    throw new Error("API " + res.status + serverMsg);
  }

  return body;
}
