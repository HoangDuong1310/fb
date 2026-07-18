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
 * Lỗi HTTP/mạng có metadata ổn định để caller phân loại (RISK-BE-04).
 * message vẫn giữ dạng "API <status>: ..." để tương thích test/UI cũ.
 */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   kind?: string,
   *   status?: number|null,
   *   code?: string|null,
   *   retryable?: boolean,
   *   body?: any,
   *   reason?: string|null,
   * }} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = meta.kind || "server_error";
    this.status = meta.status == null ? null : meta.status;
    this.code = meta.code == null ? null : meta.code;
    this.retryable = !!meta.retryable;
    // Body đã parse (có thể null). Caller không nên log raw body ra telemetry.
    this.body = meta.body === undefined ? null : meta.body;
    this.reason = meta.reason == null ? null : meta.reason;
  }
}

/**
 * Phân loại HTTP status -> kind ổn định (không parse message string).
 * @param {number} status
 * @param {any} body
 */
function classifyHttpFailure(status, body) {
  if (status === 401) {
    return {
      kind: "unauthorized",
      retryable: false,
      code: body && body.code ? String(body.code) : null,
      reason: "expired",
    };
  }
  if (status === 403 && body && body.code === "ACCOUNT_INACTIVE") {
    const reason =
      body.status === "locked"
        ? "locked"
        : body.status === "pending"
          ? "pending"
          : "inactive";
    return {
      kind: "account_inactive",
      retryable: false,
      code: "ACCOUNT_INACTIVE",
      reason,
    };
  }
  if (status === 403) {
    return {
      kind: "forbidden",
      retryable: false,
      code: body && body.code ? String(body.code) : null,
      reason: null,
    };
  }
  if (status === 400 || status === 404 || status === 422) {
    return {
      kind: "invalid_request",
      retryable: false,
      code: body && body.code ? String(body.code) : null,
      reason: null,
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      kind: "server_error",
      retryable: true,
      code: body && body.code ? String(body.code) : null,
      reason: null,
    };
  }
  // Các 4xx còn lại: coi là request/contract issue, không retry nền.
  if (status >= 400 && status <= 499) {
    return {
      kind: "invalid_request",
      retryable: false,
      code: body && body.code ? String(body.code) : null,
      reason: null,
    };
  }
  return {
    kind: "server_error",
    retryable: true,
    code: body && body.code ? String(body.code) : null,
    reason: null,
  };
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

  let res;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    // DNS / offline / connection refused / aborted — không có HTTP status.
    const msg = e && e.message ? String(e.message) : "network error";
    throw new ApiError(msg, {
      kind: "network_error",
      status: null,
      code: null,
      retryable: true,
      body: null,
      reason: null,
    });
  }

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
    // Tài khoản bị admin KHÓA (hoặc chưa duyệt / đã xóa) sẽ khiến authRequired ở
    // backend trả 403 kèm code "ACCOUNT_INACTIVE". Với client, đây tương đương
    // "phiên không còn hiệu lực": phải xoá token và phát AUTH_REQUIRED giống 401,
    // để user bị đá ra ngay thay vì lặp lỗi 403 vô nghĩa. Lưu ý 403 KHÔNG kèm
    // code này (vd adminRequired "thiếu quyền") thì KHÔNG động vào token.
    const accountInactive =
      res.status === 403 && body && body.code === "ACCOUNT_INACTIVE";
    const sessionInvalid = res.status === 401 || accountInactive;
    const classified = classifyHttpFailure(res.status, body);
    if (sessionInvalid && sentToken && !init.skipAuthHandler) {
      setToken(null);
      if (unauthorizedHandler) {
        try {
          // Truyền lý do để UI hiển thị thông báo phù hợp: "locked" (bị khóa),
          // "pending" (chờ duyệt), hoặc "expired" (phiên hết hạn/token hỏng).
          const reason = classified.reason || "expired";
          unauthorizedHandler(reason);
        } catch (e) {
          // Không để lỗi handler che lỗi gốc.
        }
      }
    }
    const serverMsg = body && body.error ? ": " + body.error : "";
    throw new ApiError("API " + res.status + serverMsg, {
      kind: classified.kind,
      status: res.status,
      code: classified.code,
      retryable: classified.retryable,
      body,
      reason: classified.reason,
    });
  }

  return body;
}
