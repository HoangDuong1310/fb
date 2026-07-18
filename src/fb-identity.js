/**
 * fb-identity.js — Nhận diện & RÀNG BUỘC tài khoản Facebook đang hoạt động.
 *
 * Mục tiêu (hướng A):
 *  - Đọc được ID Facebook đang đăng nhập (cookie `c_user`) NGAY CẢ KHI không có
 *    tab Facebook nào đang mở, nhờ quyền `cookies` + host_permissions FB.
 *  - Cho phép "khoá" (bind) tài khoản app hiện tại với một tài khoản FB cụ thể,
 *    lưu theo TÀI KHOẢN app qua /api/settings (JWT-scoped) để đồng bộ nhiều máy.
 *  - Phát hiện khi đang thao tác dưới SAI tài khoản FB (bound != active) để chặn
 *    job tự động trước khi gây bất đồng bộ dữ liệu.
 *
 * LƯU Ý MÔI TRƯỜNG:
 *  - Chỉ chạy ở ngữ cảnh CÓ token (background). `chrome.cookies` chỉ tồn tại ở
 *    background/extension pages, không có ở content script.
 *  - Việc đọc cookie `c_user` là THAO TÁC ĐỌC THỤ ĐỘNG: không gửi request tới
 *    Facebook, không đổi phiên, không ảnh hưởng tài khoản FB.
 *  - `evaluateMatch()` là hàm THUẦN (không phụ thuộc chrome) để test dễ dàng.
 */

import * as DB from "./db.js";
import { broadcast } from "./util.js";

/* ------------------------------- Hằng số ------------------------------- */

// Khoá cấu hình (lưu theo TÀI KHOẢN app qua /api/settings).
const KEY_BOUND_ID = "boundFbId";
const KEY_BOUND_NAME = "boundFbName";

// Cache cục bộ theo THIẾT BỊ (chrome.storage.local) để đọc nhanh khi service
// worker còn sống, và làm phương án dự phòng khi mạng tới /api/settings lỗi.
const CACHE_KEY = "fbBindingCache";

// Các URL đại diện cho domain Facebook — cookie `c_user` dùng chung một phiên,
// nhưng thử nhiều domain để chắc chắn bắt được (m/web/www).
const FB_COOKIE_URLS = [
  "https://www.facebook.com",
  "https://web.facebook.com",
  "https://m.facebook.com",
];

// Mã kết quả so khớp.
export const MATCH_OK = "OK"; // bound == active -> cho chạy
export const MATCH_UNBOUND = "UNBOUND"; // chưa bind -> cho chạy nhưng nên nhắc bind
export const MATCH_FB_ABSENT = "FB_ABSENT"; // đã bind nhưng không thấy FB đăng nhập -> không xác minh được
export const MATCH_MISMATCH = "MISMATCH"; // bound != active -> CHẶN

/* --------------------------- Đọc FB đang active ------------------------ */

/**
 * Đọc ID Facebook đang đăng nhập từ cookie `c_user`.
 * @returns {Promise<string|null>} chuỗi id (chỉ chữ số) hoặc null nếu không có.
 */
export async function readActiveFbId() {
  if (typeof chrome === "undefined" || !chrome.cookies || !chrome.cookies.get) {
    return null;
  }
  for (const url of FB_COOKIE_URLS) {
    const val = await _getCookie(url, "c_user");
    const id = normalizeFbId(val);
    if (id) return id;
  }
  return null;
}

function _getCookie(url, name) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.get({ url, name }, (c) => {
        void chrome.runtime.lastError;
        resolve(c && c.value ? c.value : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/** Chuẩn hoá id FB: chỉ giữ chuỗi chữ số hợp lệ, còn lại -> null. */
export function normalizeFbId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return /^\d{5,}$/.test(s) ? s : null;
}

/* --------------------------- Ràng buộc (binding) ----------------------- */

/**
 * Structured binding read (RISK-BE-04 migration for non-warming consumer).
 * Prefer server settings; on failure, fall back to local cache with stale=true.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   status: string,
 *   found: boolean,
 *   source: "server"|"cache"|"default",
 *   stale: boolean,
 *   retryable?: boolean,
 *   message?: string,
 *   binding: { fbId: string|null, fbName: string|null }
 * }>}
 */
export async function getBindingResult() {
  // Read both keys with structured results when possible.
  let idRes = null;
  let nameRes = null;
  try {
    if (typeof DB.getSettingResult === "function") {
      idRes = await DB.getSettingResult(KEY_BOUND_ID);
      nameRes = await DB.getSettingResult(KEY_BOUND_NAME);
    }
  } catch (e) {
    idRes = null;
    nameRes = null;
  }

  // Both structured reads available and successful (found or missing).
  if (
    idRes &&
    nameRes &&
    idRes.ok &&
    nameRes.ok
  ) {
    const fbId = idRes.found ? normalizeFbId(idRes.value) : null;
    const fbName =
      nameRes.found && nameRes.value != null ? String(nameRes.value) : null;
    if (fbId) {
      await _writeCache({ fbId, fbName });
    }
    return {
      ok: true,
      status: fbId ? "found" : "missing",
      found: !!fbId,
      source: "server",
      stale: false,
      binding: { fbId, fbName },
    };
  }

  // At least one structured read failed (network/auth/server).
  const failed = [idRes, nameRes].find((r) => r && !r.ok);
  const cached = await _readCache();
  if (cached && cached.fbId) {
    return {
      ok: true,
      status: (failed && failed.status) || "network_error",
      found: true,
      source: "cache",
      stale: true,
      retryable: failed ? !!failed.retryable : true,
      message: failed && failed.message ? failed.message : "Dùng cache binding (Backend lỗi).",
      binding: {
        fbId: normalizeFbId(cached.fbId),
        fbName: cached.fbName != null ? String(cached.fbName) : null,
      },
    };
  }

  // No server, no cache — unbound / unknown.
  if (failed) {
    return {
      ok: false,
      status: failed.status || "server_error",
      found: false,
      source: "default",
      stale: true,
      retryable: !!failed.retryable,
      message: failed.message || "Không đọc được ràng buộc FB.",
      binding: { fbId: null, fbName: null },
    };
  }

  // Fallback path when getSettingResult is unavailable (legacy).
  try {
    const fbId = normalizeFbId(await DB.getSetting(KEY_BOUND_ID, null));
    const name = await DB.getSetting(KEY_BOUND_NAME, null);
    const fbName = name != null ? String(name) : null;
    if (fbId) await _writeCache({ fbId, fbName });
    return {
      ok: true,
      status: fbId ? "found" : "missing",
      found: !!fbId,
      source: "server",
      stale: false,
      binding: { fbId, fbName },
    };
  } catch (e) {
    const cached2 = await _readCache();
    if (cached2 && cached2.fbId) {
      return {
        ok: true,
        status: "network_error",
        found: true,
        source: "cache",
        stale: true,
        retryable: true,
        message: String((e && e.message) || e),
        binding: {
          fbId: normalizeFbId(cached2.fbId),
          fbName: cached2.fbName != null ? String(cached2.fbName) : null,
        },
      };
    }
    return {
      ok: false,
      status: "network_error",
      found: false,
      source: "default",
      stale: true,
      retryable: true,
      message: String((e && e.message) || e),
      binding: { fbId: null, fbName: null },
    };
  }
}

/**
 * Lấy ràng buộc hiện tại của TÀI KHOẢN app.
 * Compatibility wrapper: always returns { fbId, fbName }; uses cache on failure.
 * Critical callers that need stale/source should use getBindingResult().
 * @returns {Promise<{fbId: string|null, fbName: string|null}>}
 */
export async function getBinding() {
  const r = await getBindingResult();
  return r.binding || { fbId: null, fbName: null };
}

/**
 * Khoá TÀI KHOẢN app hiện tại với một FB id/tên cụ thể.
 * Nếu không truyền fbId, tự lấy FB đang active. Trả về binding đã ghi.
 * @param {string|null} [fbId]
 * @param {string|null} [fbName]
 */
export async function setBinding(fbId = null, fbName = null) {
  let id = normalizeFbId(fbId);
  if (!id) id = await readActiveFbId();
  if (!id) {
    return { ok: false, code: MATCH_FB_ABSENT, fbId: null, fbName: null };
  }
  const name = fbName != null ? String(fbName) : null;
  try {
    await DB.setSetting(KEY_BOUND_ID, id);
    await DB.setSetting(KEY_BOUND_NAME, name);
  } catch (e) {
    // vẫn ghi cache để không mất ràng buộc trên máy này
  }
  await _writeCache({ fbId: id, fbName: name });
  broadcast("FB_BINDING_UPDATE", { fbId: id, fbName: name });
  return { ok: true, code: MATCH_OK, fbId: id, fbName: name };
}

/** Gỡ ràng buộc của TÀI KHOẢN app hiện tại. */
export async function clearBinding() {
  try {
    await DB.deleteSetting(KEY_BOUND_ID);
    await DB.deleteSetting(KEY_BOUND_NAME);
  } catch (e) {
    // bỏ qua
  }
  await _clearCache();
  broadcast("FB_BINDING_UPDATE", { fbId: null, fbName: null });
  return { ok: true };
}

/* ------------------------------ So khớp -------------------------------- */

/**
 * Logic so khớp THUẦN (không phụ thuộc chrome/DB) — dễ test.
 * @param {{bound: string|null, current: string|null}} args
 * @returns {{ok: boolean, code: string, bound: string|null, current: string|null}}
 */
export function evaluateMatch({ bound, current } = {}) {
  const b = normalizeFbId(bound);
  const c = normalizeFbId(current);
  if (!b) {
    // Chưa ràng buộc -> cho phép chạy (không chặn), nhưng đánh dấu UNBOUND để UI
    // có thể nhắc người dùng bind.
    return { ok: true, code: MATCH_UNBOUND, bound: null, current: c };
  }
  if (!c) {
    // Đã bind nhưng không thấy FB đăng nhập -> KHÔNG xác minh được -> chặn để an toàn.
    return { ok: false, code: MATCH_FB_ABSENT, bound: b, current: null };
  }
  if (b === c) {
    return { ok: true, code: MATCH_OK, bound: b, current: c };
  }
  return { ok: false, code: MATCH_MISMATCH, bound: b, current: c };
}

/**
 * So khớp thực tế: đọc binding (backend) + FB đang active (cookie) rồi đánh giá.
 * @returns {Promise<{ok, code, bound, current, boundName}>}
 */
export async function assertFbMatch() {
  const [{ fbId: bound, fbName: boundName }, current] = await Promise.all([
    getBinding(),
    readActiveFbId(),
  ]);
  const res = evaluateMatch({ bound, current });
  return { ...res, boundName: boundName || null };
}

/* --------------------------- Cache cục bộ ------------------------------ */

function _readCache() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      resolve(null);
      return;
    }
    try {
      chrome.storage.local.get(CACHE_KEY, (r) => {
        void chrome.runtime.lastError;
        resolve((r && r[CACHE_KEY]) || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function _writeCache(obj) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }
    try {
      chrome.storage.local.set({ [CACHE_KEY]: obj }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

function _clearCache() {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      resolve();
      return;
    }
    try {
      chrome.storage.local.remove(CACHE_KEY, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}
