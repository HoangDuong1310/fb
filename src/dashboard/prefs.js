/**
 * prefs.js — Lưu/khôi phục các tùy chọn UI vào chrome.storage.local (F5 vẫn giữ).
 *
 *  - Cấu hình crawl (số bài tối đa, dừng khi gặp bài cũ, độ trễ, nghỉ, luồng, an toàn).
 *  - Các tùy chọn UI nhỏ khác (bộ lọc nhóm ở tab Bài viết, ô nhập ở tab Tư vấn AI...).
 */

import { $ } from "./core.js";

/* ===================== LƯU CẤU HÌNH CRAWL (F5 vẫn giữ) ===================== */
const CRAWL_CFG_KEY = "crawlSettings";
export const CRAWL_FIELDS = ["crawlMethod", "crawlMax", "crawlStopKnown", "crawlDelay", "crawlRest", "crawlThreads", "crawlFromDate"];
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
  try {
    chrome.storage.local.set({ [CRAWL_CFG_KEY]: data }, () => void chrome.runtime.lastError);
  } catch (_) {
    /* bỏ qua */
  }
  flashSaved();
}

export function loadCrawlSettings() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CRAWL_CFG_KEY, (res) => {
        void chrome.runtime.lastError;
        const data = (res && res[CRAWL_CFG_KEY]) || {};
        CRAWL_FIELDS.forEach((id) => {
          if ($(id) && data[id] != null && data[id] !== "") $(id).value = data[id];
        });
        if ($("crawlSafe") && typeof data.crawlSafe === "boolean") {
          $("crawlSafe").checked = data.crawlSafe;
        }
        resolve();
      });
    } catch (_) {
      resolve();
    }
  });
}

/* ===================== LƯU CÁC TÙY CHỌN UI KHÁC (F5 vẫn giữ) ===================== */
// Lưu chung các lựa chọn nhỏ của giao diện (bộ lọc nhóm ở tab Bài viết, các ô
// nhập ở tab Tư vấn AI...) vào một key duy nhất trong chrome.storage.local.
const UI_PREFS_KEY = "uiPrefs";
const _uiPrefs = {};

export function saveUIPref(key, value) {
  _uiPrefs[key] = value;
  try {
    chrome.storage.local.set({ [UI_PREFS_KEY]: _uiPrefs }, () => void chrome.runtime.lastError);
  } catch (_) {
    /* bỏ qua */
  }
}

export function loadUIPrefs() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(UI_PREFS_KEY, (res) => {
        void chrome.runtime.lastError;
        Object.assign(_uiPrefs, (res && res[UI_PREFS_KEY]) || {});
        resolve(_uiPrefs);
      });
    } catch (_) {
      resolve(_uiPrefs);
    }
  });
}

export function uiPref(key, def) {
  return _uiPrefs[key] != null && _uiPrefs[key] !== "" ? _uiPrefs[key] : def;
}
