/**
 * prefs.js — Lưu/khôi phục các tùy chọn UI lên server theo TÀI KHOẢN (qua
 * background /api/settings). Đăng nhập ở máy khác vẫn giữ nguyên tùy chọn.
 *
 *  - Cấu hình crawl (số bài tối đa, dừng khi gặp bài cũ, độ trễ, nghỉ, luồng, an toàn).
 *  - Các tùy chọn UI nhỏ khác (bộ lọc nhóm ở tab Bài viết, ô nhập ở tab Tư vấn AI...).
 */

import { $, bg } from "./core.js";

/* ===================== LƯU CẤU HÌNH CRAWL (F5 vẫn giữ) ===================== */
const CRAWL_CFG_KEY = "crawlSettings";
export const CRAWL_FIELDS = ["crawlMethod", "crawlMax", "crawlStopKnown", "crawlDelay", "crawlRest", "crawlFromDate"];
let _flashTimer = null;

export function flashSaved() {
  const el = $("cfgSaved");
  if (!el) return;
  el.textContent = "Đã lưu";
  el.classList.add("flash");
  clearTimeout(_flashTimer);
  _flashTimer = setTimeout(() => {
    el.classList.remove("flash");
    el.textContent = "Tự lưu";
  }, 1200);
}

export function saveCrawlSettings() {
  const data = {};
  CRAWL_FIELDS.forEach((id) => {
    if ($(id)) data[id] = $(id).value;
  });
  if ($("crawlSafe")) data.crawlSafe = $("crawlSafe").checked;
  // Lưu nền lên server; không chặn UI, lỗi thì bỏ qua (im lặng).
  bg("SET_SETTING", { key: CRAWL_CFG_KEY, value: data }).catch(() => {});
  flashSaved();
}

export async function loadCrawlSettings() {
  try {
    const res = await bg("GET_SETTING", { key: CRAWL_CFG_KEY });
    const data = (res && res.ok && res.value) || {};
    CRAWL_FIELDS.forEach((id) => {
      if ($(id) && data[id] != null && data[id] !== "") $(id).value = data[id];
    });
    if ($("crawlSafe") && typeof data.crawlSafe === "boolean") {
      $("crawlSafe").checked = data.crawlSafe;
    }
  } catch (_) {
    /* bỏ qua */
  }
}

/* ===================== LƯU CÁC TÙY CHỌN UI KHÁC (F5 vẫn giữ) ===================== */
// Lưu chung các lựa chọn nhỏ của giao diện (bộ lọc nhóm ở tab Bài viết, các ô
// nhập ở tab Tư vấn AI...) vào một key duy nhất trong chrome.storage.local.
const UI_PREFS_KEY = "uiPrefs";
const _uiPrefs = {};

export function saveUIPref(key, value) {
  _uiPrefs[key] = value;
  // Lưu nền lên server theo tài khoản; lỗi thì bỏ qua.
  bg("SET_SETTING", { key: UI_PREFS_KEY, value: _uiPrefs }).catch(() => {});
}

export async function loadUIPrefs() {
  try {
    const res = await bg("GET_SETTING", { key: UI_PREFS_KEY });
    Object.assign(_uiPrefs, (res && res.ok && res.value) || {});
  } catch (_) {
    /* bỏ qua */
  }
  return _uiPrefs;
}

export function uiPref(key, def) {
  return _uiPrefs[key] != null && _uiPrefs[key] !== "" ? _uiPrefs[key] : def;
}
