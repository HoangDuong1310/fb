/**
 * util.js — Các helper DÙNG CHUNG xuyên nhiều domain (prices/sheets/ai/advisory/crawl).
 * Tách ra module riêng để các module domain import lại, tránh lặp code.
 * Đây là ES module (import/export) — service worker chạy ở chế độ "type":"module".
 */

import { apiFetch } from "./api.js";

// ---- Tab / DOM helpers ------------------------------------------------------

/** Lấy tab đang active ở cửa sổ hiện tại (null nếu không có). */
export function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

/** Chờ một tab tải xong (status=complete) hoặc hết thời gian. */
export function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs || 30000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        cleanup();
        resolve(true);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Mở (hoặc focus) trang quản lý dashboard. */
export async function openDashboard() {
  const url = chrome.runtime.getURL("dist/ui/index.html");
  const tabs = await new Promise((r) => chrome.tabs.query({}, r));
  const existing = (tabs || []).find((t) => t.url && t.url.indexOf(url) === 0);
  if (existing) {
    chrome.tabs.update(existing.id, { active: true });
    if (existing.windowId != null) chrome.windows.update(existing.windowId, { focused: true });
    return { ok: true, tabId: existing.id };
  }
  const tab = await new Promise((r) => chrome.tabs.create({ url }, r));
  return { ok: true, tabId: tab.id };
}

// ---- Async / messaging helpers ---------------------------------------------

/** Nghỉ ms mili-giây. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nghỉ ngẫu nhiên giữa các trang để giảm rủi ro bị chặn (chống spam request). */
export function sleepJitter(minMs, maxMs) {
  const lo = Math.max(0, minMs | 0);
  const hi = Math.max(lo, maxMs | 0);
  const ms = lo + Math.floor(Math.random() * (hi - lo + 1));
  return new Promise((r) => setTimeout(r, ms));
}

/** Phát broadcast tới mọi trang extension (dashboard/popup) đang mở. */
export function broadcast(type, payload) {
  try {
    chrome.runtime.sendMessage({ type, ...(payload || {}) }, () => {
      void chrome.runtime.lastError;
    });
  } catch (e) {}
}

/**
 * fetch kèm timeout: nếu endpoint treo quá lâu -> tự huỷ để rơi fallback nhanh,
 * tránh để người dùng chờ vô tận. Trả về Response như fetch thường.
 */
export async function fetchWithTimeout(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- JSON / object path helpers --------------------------------------------

/** Lấy giá trị theo đường dẫn kiểu "data.products" hoặc "a.b.0.c" từ object JSON. */
export function getByPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Chuyển chuỗi giá kiểu "12.990.000₫" / "12,990,000" về số nguyên VND. */
export function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === "number") return Math.round(v);
  const digits = String(v).replace(/[^\d]/g, "");
  if (!digits) return null;
  return parseInt(digits, 10);
}

// ---- URL helpers ------------------------------------------------------------

/**
 * Chuyển URL tương đối ("foo.html", "/foo.html") thành tuyệt đối theo domain
 * của nguồn. Nếu đã là URL tuyệt đối thì giữ nguyên. Trả "" nếu không dựng được.
 */
export function resolveUrl(raw, baseUrl) {
  const s = (raw || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (/^\/\//.test(s)) return "https:" + s;
  try {
    // Lấy origin của nguồn làm gốc (product URL thường tính từ gốc site).
    const origin = new URL(baseUrl).origin;
    return new URL(s, origin).toString();
  } catch (e) {
    return s;
  }
}

/** Gắn/ghi đè 1 tham số query vào URL (giữ nguyên các tham số sẵn có). */
export function withQueryParam(url, key, value) {
  try {
    const u = new URL(url);
    u.searchParams.set(key, String(value));
    return u.toString();
  } catch (e) {
    // URL tương đối hoặc không hợp lệ: nối thủ công.
    const sep = url.includes("?") ? "&" : "?";
    const re = new RegExp("([?&])" + key + "=[^&]*");
    if (re.test(url)) return url.replace(re, "$1" + key + "=" + encodeURIComponent(value));
    return url + sep + key + "=" + encodeURIComponent(value);
  }
}

// ---- HTML entity decode / strip tags ---------------------------------------

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  iexcl: "¡",
  cent: "¢",
  pound: "£",
  curren: "¤",
  yen: "¥",
  brvbar: "¦",
  sect: "§",
  uml: "¨",
  copy: "©",
  ordf: "ª",
  laquo: "«",
  not: "¬",
  shy: "­",
  reg: "®",
  macr: "¯",
  deg: "°",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  acute: "´",
  micro: "µ",
  para: "¶",
  middot: "·",
  cedil: "¸",
  sup1: "¹",
  ordm: "º",
  raquo: "»",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  iquest: "¿",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Atilde: "Ã",
  Auml: "Ä",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Igrave: "Ì",
  Iacute: "Í",
  Icirc: "Î",
  Iuml: "Ï",
  ETH: "Ð",
  Ntilde: "Ñ",
  Ograve: "Ò",
  Oacute: "Ó",
  Ocirc: "Ô",
  Otilde: "Õ",
  Ouml: "Ö",
  times: "×",
  Oslash: "Ø",
  Ugrave: "Ù",
  Uacute: "Ú",
  Ucirc: "Û",
  Uuml: "Ü",
  Yacute: "Ý",
  THORN: "Þ",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  eth: "ð",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  divide: "÷",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  thorn: "þ",
  yuml: "ÿ",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  trade: "™",
  euro: "€",
};

function decodeEntitiesOnce(s) {
  return String(s || "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : m
    );
}

export function decodeEntities(s) {
  // Pass đôi để xử lý entity bị bọc kép (vd "&amp;aacute;" -> "&aacute;" -> "á").
  let out = decodeEntitiesOnce(s);
  if (out.indexOf("&") !== -1) {
    out = decodeEntitiesOnce(out);
  }
  return out.trim();
}

/** Bóc tên/đoạn text từ một đoạn HTML: bỏ mọi thẻ con, gộp khoảng trắng. */
export function stripTags(htmlFrag) {
  return decodeEntities(
    String(htmlFrag || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
  );
}

// ---- AI config / JSON parse helpers ----------------------------------------

/** Đọc cấu hình AI (apiBase/apiKey/model...) theo TÀI KHOẢN từ server. */
export async function getAIConfig() {
  try {
    const r = await apiFetch("/api/settings/aiConfig");
    return (r && r.value) || {};
  } catch (e) {
    return {};
  }
}

/** Bóc object JSON từ phản hồi AI: bỏ code fence, cắt từ "{" đầu tới "}" cuối. */
export function parseSelectorJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Bỏ code fence nếu có.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Nếu vẫn còn chữ thừa, cắt từ "{" đầu tới "}" cuối.
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    const obj = JSON.parse(s);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    // LLM hay trả JSON có dấu "\" thừa trước ký tự không hợp lệ (vd emoji),
    // khiến JSON.parse ném lỗi. Thử làm sạch escape sai rồi parse lại.
    try {
      const cleaned = s.replace(/\\(?!["\\/bfnrtu])/g, "");
      const obj = JSON.parse(cleaned);
      return obj && typeof obj === "object" ? obj : null;
    } catch (e2) {
      return null;
    }
  }
}
