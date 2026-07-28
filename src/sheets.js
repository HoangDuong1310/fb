/**
 * sheets.js — Domain "Kho của tôi": nhập sản phẩm từ Google Sheet công khai.
 *
 * Tách từ background.js (ESM). Phụ thuộc:
 *   - db.js: saveProducts / getProducts / deleteProduct / get-setSetting.
 *   - util.js: parsePrice, decodeEntities, stripTags, sleepJitter.
 *
 * Quy trình: listSheetTabs (đọc htmlview/pubhtml) -> previewSheet (xem trước cột)
 * -> importSheetTabs (tải CSV từng tab, map cột, lưu DB dưới source "mystore").
 *
 * Ngoài lần nhập thủ công, module còn LƯU cấu hình sheet (mystoreSheetConfig) và
 * tự đồng bộ lại theo chu kỳ bằng chrome.alarms (SHEET_ALARM) — nhờ vậy sửa giá
 * trên Google Sheet là kho tự cập nhật, không phải nhập tay lại.
 */

import * as DB from "./db.js";
import { parsePrice, decodeEntities, stripTags, sleepJitter } from "./util.js";

// ---- Kho của tôi: nhập sản phẩm từ Google Sheet công khai ----------------

const MYSTORE_SOURCE = "mystore";
const MYSTORE_NAME = "Cửa hàng của tôi";

// Tách spreadsheetId (và gid nếu có) từ link Google Sheet bất kỳ.
function parseSheetId(url) {
  const u = String(url || "").trim();
  const idMatch = u.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/(?:e\/)?([a-zA-Z0-9-_]+)/);
  const spreadsheetId = idMatch ? idMatch[1] : "";
  const gidMatch = u.match(/[#&?]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : null;
  return { spreadsheetId, gid };
}

// Rút danh sách tab từ HTML của trang htmlview bằng nhiều chiến lược.
function extractTabsFromHtml(html) {
  const tabs = [];
  const seen = new Set();
  const add = (gid, name) => {
    if (!gid || seen.has(gid)) return;
    seen.add(gid);
    tabs.push({ gid, name: name || ("Tab " + gid) });
  };

  let m;

  // Chiến lược 0 (chính xác nhất): Google nhúng danh sách tab trong JS dạng
  // items.push({name: "Vga", pageUrl: "...gid=194813850", gid: "194813850"}).
  // Lấy được đúng TÊN và đúng THỨ TỰ tab. Tên có thể chứa \" hoặc unicode.
  const reItems = /items\.push\(\{\s*name:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?gid:\s*"(\d+)"/g;
  while ((m = reItems.exec(html))) {
    const name = decodeEntities(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
    add(m[2], name);
  }

  // Chiến lược 1: menu sheet-button. Lấy trọn khối tới thẻ đóng kế tiếp rồi
  // bóc tên (tên có thể nằm trong thẻ <a> hoặc các thẻ lồng nhau).
  if (!tabs.length) {
    const reBtn = /id="sheet-button-(\d+)"[^>]*>([\s\S]*?)<\/(?:li|td|div|a)>/g;
    while ((m = reBtn.exec(html))) {
      add(m[1], stripTags(m[2]));
    }
  }

  // Chiến lược 2: liên kết neo dạng #gid=NNN với nhãn đi kèm.
  if (!tabs.length) {
    const reA = /href="#gid=(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = reA.exec(html))) {
      add(m[1], stripTags(m[2]));
    }
  }

  // Chiến lược 3: thuộc tính dữ liệu mang gid.
  if (!tabs.length) {
    const reData = /data-(?:sheet-)?gid="(\d+)"[^>]*>([\s\S]*?)</g;
    while ((m = reData.exec(html))) {
      add(m[1], stripTags(m[2]));
    }
  }

  // Chiến lược 4 (chốt chặn): gom mọi gid xuất hiện trong trang, đặt tên tạm.
  if (!tabs.length) {
    const reGid = /[#&?]gid=(\d+)|sheet-button-(\d+)|"gid":(\d+)/g;
    while ((m = reGid.exec(html))) {
      add(m[1] || m[2] || m[3], "");
    }
  }

  return tabs;
}

async function listSheetTabs(url) {
  const { spreadsheetId } = parseSheetId(url);
  if (!spreadsheetId) throw new Error("Không nhận diện được ID Google Sheet từ link.");

  // Thử lần lượt htmlview rồi bản pubhtml (một số Sheet chỉ trả tab ở pubhtml).
  const candidates = [
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`,
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/pubhtml`,
  ];

  let lastStatus = 0;
  let tabs = [];
  for (const htmlUrl of candidates) {
    let resp;
    try {
      resp = await fetch(htmlUrl, { credentials: "omit", redirect: "follow" });
    } catch (e) {
      continue;
    }
    lastStatus = resp.status;
    if (!resp.ok) continue;
    const html = await resp.text();
    tabs = extractTabsFromHtml(html);
    if (tabs.length) break;
  }

  if (!tabs.length) {
    if (lastStatus && lastStatus !== 200) {
      throw new Error(
        "Không đọc được Sheet (HTTP " + lastStatus + "). Kiểm tra Sheet đã công khai theo link chưa."
      );
    }
    throw new Error(
      "Không tìm thấy tab nào. Hãy chắc chắn Sheet ở chế độ 'Bất kỳ ai có liên kết → Người xem'."
    );
  }
  return { spreadsheetId, tabs };
}

// Parser CSV chuẩn: hỗ trợ ô có dấu phẩy, xuống dòng, và dấu " escape ("").
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Tải CSV của 1 tab theo gid.
async function fetchSheetCsv(spreadsheetId, gid) {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv&gid=${gid}`;
  const resp = await fetch(csvUrl, { credentials: "omit" });
  if (!resp.ok) throw new Error("Tải CSV thất bại (HTTP " + resp.status + ").");
  return resp.text();
}

// Đoán chỉ số cột theo từ khoá tiêu đề (không dấu, lowercase).
function detectColumns(header) {
  const norm = (header || []).map((h) =>
    String(h || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
  );
  const find = (kws) => {
    for (let i = 0; i < norm.length; i++) {
      if (kws.some((k) => norm[i].includes(k))) return i;
    }
    return -1;
  };
  return {
    name: find(["ten san pham", "san pham", "ten", "model", "mo ta", "product"]),
    price: find(["gia ban", "don gia", "gia", "price", "vnd"]),
    qty: find(["so luong", "ton", "sl", "qty", "stock"]),
    warranty: find(["bao hanh", "bh", "warranty"]),
    brand: find(["hang", "thuong hieu", "brand"]),
    sku: find(["sku", "ma sp", "ma san pham", "ma"]),
  };
}

// Tạo slug ổn định cho productId từ tên sản phẩm.
function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Đọc CSV 1 tab -> { header, rows, sample } để xem trước & map cột.
async function previewSheet(spreadsheetId, gid) {
  if (!spreadsheetId) throw new Error("Thiếu spreadsheetId.");
  const csv = await fetchSheetCsv(spreadsheetId, gid);
  const rows = parseCsv(csv).filter((r) => r.some((c) => String(c).trim() !== ""));
  if (!rows.length) return { header: [], sample: [], columns: {}, rowCount: 0 };

  // Tìm dòng tiêu đề: dòng đầu tiên có >=2 ô không rỗng.
  let headerIdx = rows.findIndex((r) => r.filter((c) => String(c).trim()).length >= 2);
  if (headerIdx < 0) headerIdx = 0;
  const header = rows[headerIdx];
  const dataRows = rows.slice(headerIdx + 1);
  const columns = detectColumns(header);
  return {
    header,
    columns,
    rowCount: dataRows.length,
    sample: dataRows.slice(0, 5),
  };
}

/**
 * Khoá định danh sản phẩm. Ưu tiên SKU: SKU là mã do người bán tự đặt nên KHÔNG
 * đổi khi sửa tên sản phẩm trong Sheet -> sửa tên là cập nhật đúng bản ghi cũ
 * thay vì sinh bản ghi mới (đây là nguồn gốc của kho bị nhân đôi trước đây).
 * Không có cột SKU thì rơi về gid::slug(tên) như bản cũ để tương thích dữ liệu
 * đã nhập trước đó.
 */
function productIdFor(name, sku, gid) {
  const bySku = slugify(sku);
  if (bySku) return `${MYSTORE_SOURCE}::sku::${bySku}`;
  return `${MYSTORE_SOURCE}::${gid}::${slugify(name)}`;
}

// Chuyển các dòng dữ liệu của 1 tab thành sản phẩm "owned".
// Dòng trùng productId trong CÙNG một lần nhập được gộp (dòng sau thắng) để
// payload gửi lên /api/products không chứa 2 bản ghi cùng khoá (upsert sẽ lỗi).
function rowsToProducts(dataRows, cols, tab) {
  const byId = new Map();
  const category = tab.category || tab.name || "Khác";
  for (const r of dataRows) {
    const get = (idx) => (idx >= 0 && idx < r.length ? String(r[idx]).trim() : "");
    let name = cols.name >= 0 ? get(cols.name) : "";
    if (!name) name = r.map((c) => String(c).trim()).find((c) => c) || "";
    if (!name) continue;

    const priceRaw = cols.price >= 0 ? get(cols.price) : "";
    const price = priceRaw ? parsePrice(priceRaw) : null;
    const qtyRaw = cols.qty >= 0 ? get(cols.qty) : "";
    const qty = qtyRaw ? parseInt(qtyRaw.replace(/[^\d]/g, ""), 10) : null;
    const sku = cols.sku >= 0 ? get(cols.sku) : "";

    const productId = productIdFor(name, sku, tab.gid);
    byId.set(productId, {
      productId,
      source: MYSTORE_SOURCE,
      sourceName: MYSTORE_NAME,
      owned: true,
      category,
      name,
      price: Number.isFinite(price) ? price : null,
      brand: cols.brand >= 0 ? get(cols.brand) : "",
      warranty: cols.warranty >= 0 ? get(cols.warranty) : "",
      sku,
      qty: Number.isFinite(qty) ? qty : null,
      url: "",
    });
  }
  return [...byId.values()];
}

/**
 * Xoá các sản phẩm "mystore" KHÔNG còn xuất hiện trong lần nhập vừa rồi.
 *
 * Đây là bước đối chiếu (reconcile) để dòng bị xoá khỏi Google Sheet cũng biến
 * mất khỏi kho — nếu chỉ upsert thì hàng đã ngừng bán vẫn nằm lại vĩnh viễn.
 *
 * CHỐT AN TOÀN: chỉ gọi khi mọi tab đã nhập THÀNH CÔNG (xem importSheetTabs).
 * Thêm trần PRUNE_CAP để một lần đối chiếu lệch không thể quét sạch cả kho.
 */
const PRUNE_CAP = 500;

async function pruneMissingProducts(keepIds) {
  if (!(keepIds instanceof Set) || keepIds.size === 0) {
    return { deleted: 0, skipped: 0, capped: false };
  }
  let existing = [];
  try {
    existing = await DB.getProducts(MYSTORE_SOURCE);
  } catch (e) {
    return { deleted: 0, skipped: 0, capped: false, error: String(e) };
  }
  const stale = (Array.isArray(existing) ? existing : []).filter(
    (p) => p && p.productId && !keepIds.has(p.productId)
  );
  const capped = stale.length > PRUNE_CAP;
  const target = capped ? stale.slice(0, PRUNE_CAP) : stale;

  let deleted = 0;
  let skipped = 0;
  for (const p of target) {
    try {
      await DB.deleteProduct(p.productId);
      deleted++;
    } catch (e) {
      skipped++;
    }
  }
  return { deleted, skipped, capped };
}

/**
 * Nhập danh sách tab đã chọn: mỗi tab {gid, name, category}. Tải CSV, map, lưu DB.
 * opts.prune = true -> sau khi TẤT CẢ tab nhập xong không lỗi, xoá những sản
 * phẩm mystore không còn trong Sheet (đồng bộ 2 chiều thật sự).
 */
async function importSheetTabs(spreadsheetId, tabs, opts = {}) {
  if (!spreadsheetId) throw new Error("Thiếu spreadsheetId.");
  if (!Array.isArray(tabs) || !tabs.length) throw new Error("Chưa chọn tab nào để nhập.");

  let added = 0;
  let updated = 0;
  let imported = 0;
  const results = [];
  const keepIds = new Set();

  for (const tab of tabs) {
    try {
      const csv = await fetchSheetCsv(spreadsheetId, tab.gid);
      const rows = parseCsv(csv).filter((r) => r.some((c) => String(c).trim() !== ""));
      if (!rows.length) {
        results.push({ gid: tab.gid, name: tab.name, ok: true, count: 0 });
        continue;
      }
      let headerIdx = rows.findIndex(
        (r) => r.filter((c) => String(c).trim()).length >= 2
      );
      if (headerIdx < 0) headerIdx = 0;
      const cols = detectColumns(rows[headerIdx]);
      const products = rowsToProducts(rows.slice(headerIdx + 1), cols, tab);
      const r = await DB.saveProducts(products);
      added += r.added || 0;
      updated += r.updated || 0;
      imported += products.length;
      for (const p of products) keepIds.add(p.productId);
      results.push({ gid: tab.gid, name: tab.name, ok: true, count: products.length });
      await sleepJitter(200, 600);
    } catch (e) {
      results.push({ gid: tab.gid, name: tab.name, ok: false, error: String(e) });
    }
  }

  // Chỉ đối chiếu khi bức tranh đầy đủ: một tab lỗi mạng giữa đường sẽ khiến
  // hàng của tab đó bị coi là "đã xoá khỏi Sheet" -> mất dữ liệu oan.
  const allOk = results.length > 0 && results.every((r) => r.ok);
  let pruned = null;
  if (opts.prune && allOk && imported > 0) {
    pruned = await pruneMissingProducts(keepIds);
  }

  return {
    ok: true,
    imported,
    added,
    updated,
    deleted: pruned ? pruned.deleted : 0,
    pruneCapped: !!(pruned && pruned.capped),
    pruneSkipped: allOk ? !opts.prune : true,
    results,
  };
}

/* ============== CẤU HÌNH + TỰ ĐỘNG ĐỒNG BỘ SHEET (alarms) ============== */

const SHEET_KEY = "mystoreSheetConfig";
const SHEET_ALARM = "mystoreSheetSync";
// Chu kỳ hợp lệ (giờ). CSV export của Google là endpoint tĩnh, công khai nên 1h
// vẫn an toàn; mặc định 6h là đủ tươi cho bảng giá bán lẻ.
const SHEET_INTERVALS = [1, 3, 6, 12, 24];
const SHEET_DEFAULT = {
  enabled: false,
  intervalHours: 6,
  url: "",
  spreadsheetId: "",
  tabs: [],
  prune: true,
  lastSyncAt: 0,
  lastResult: null,
};

function normalizeSheetHours(v) {
  const h = parseInt(v, 10);
  return SHEET_INTERVALS.includes(h) ? h : SHEET_DEFAULT.intervalHours;
}

// Chỉ giữ 3 trường cần cho lần nhập lại: gid (bắt buộc), name, category.
function normalizeSheetTabs(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const gid = String(t.gid == null ? "" : t.gid).trim();
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    out.push({
      gid,
      name: String(t.name || "").slice(0, 120),
      category: String(t.category || "").slice(0, 120),
    });
  }
  return out;
}

function normalizeSheetConfig(saved) {
  const s = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  const url = String(s.url || "").trim().slice(0, 500);
  // spreadsheetId luôn được suy lại từ url nếu url còn đó: tránh trạng thái lệch
  // khi người dùng đổi link nhưng id cũ vẫn nằm trong settings.
  const fromUrl = url ? parseSheetId(url).spreadsheetId : "";
  return {
    enabled: !!s.enabled,
    intervalHours: normalizeSheetHours(s.intervalHours),
    url,
    spreadsheetId: fromUrl || String(s.spreadsheetId || "").trim(),
    tabs: normalizeSheetTabs(s.tabs),
    prune: s.prune == null ? true : !!s.prune,
    lastSyncAt: Number.isFinite(Number(s.lastSyncAt)) ? Number(s.lastSyncAt) : 0,
    lastResult:
      s.lastResult && typeof s.lastResult === "object" && !Array.isArray(s.lastResult)
        ? s.lastResult
        : null,
  };
}

/** Đọc cấu hình dạng structured (không ném lỗi; hỏng -> default + stale). */
async function getSheetConfigResult() {
  let r = null;
  try {
    r = await DB.getSettingResult(SHEET_KEY);
  } catch (e) {
    r = null;
  }
  if (!r || !r.ok) {
    return {
      ok: false,
      status: (r && r.status) || "server_error",
      retryable: !!(r && r.retryable),
      message: (r && r.message) || "Không đọc được mystoreSheetConfig",
      found: false,
      source: "default",
      stale: true,
      config: normalizeSheetConfig({}),
    };
  }
  if (r.found && r.value != null && (typeof r.value !== "object" || Array.isArray(r.value))) {
    return {
      ok: false,
      status: "invalid_response",
      retryable: true,
      message: "mystoreSheetConfig value không phải object",
      found: false,
      source: "default",
      stale: true,
      config: normalizeSheetConfig({}),
    };
  }
  return {
    ok: true,
    status: r.status,
    found: !!r.found,
    source: r.found ? "server" : "default",
    stale: false,
    config: normalizeSheetConfig(r.found ? r.value || {} : {}),
  };
}

async function getSheetConfig() {
  const r = await getSheetConfigResult();
  return r.config;
}

// Đặt lại alarm theo cấu hình. Tách riêng để cả apply* và init* dùng chung.
async function rescheduleSheetSync(cfg) {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  try {
    await chrome.alarms.clear(SHEET_ALARM);
    if (cfg.enabled && cfg.spreadsheetId && cfg.tabs.length) {
      chrome.alarms.create(SHEET_ALARM, { periodInMinutes: cfg.intervalHours * 60 });
    }
  } catch (e) {}
}

/** Lưu cấu hình (merge từng trường) + (tái)tạo hoặc xoá alarm. */
async function applySheetConfig(input = {}) {
  const current = await getSheetConfig();
  const merged = {
    ...current,
    ...(input.url != null ? { url: input.url } : {}),
    ...(input.spreadsheetId != null ? { spreadsheetId: input.spreadsheetId } : {}),
    ...(input.tabs != null ? { tabs: input.tabs } : {}),
    ...(input.enabled != null ? { enabled: input.enabled } : {}),
    ...(input.intervalHours != null ? { intervalHours: input.intervalHours } : {}),
    ...(input.prune != null ? { prune: input.prune } : {}),
  };
  const next = normalizeSheetConfig(merged);
  await DB.setSetting(SHEET_KEY, next);
  await rescheduleSheetSync(next);
  return next;
}

// Ghi kết quả lần chạy gần nhất (không ném lỗi: chỉ là dữ liệu hiển thị).
async function recordSheetSyncResult(cfg, result) {
  const next = normalizeSheetConfig({
    ...cfg,
    lastSyncAt: Date.now(),
    lastResult: result,
  });
  try {
    await DB.setSetting(SHEET_KEY, next);
  } catch (e) {}
  return next;
}

let _sheetSyncing = false;

/**
 * Đồng bộ lại kho từ Sheet đã lưu. Dùng cho cả nút "Đồng bộ ngay" và alarm.
 * opts.force = true -> chạy dù cấu hình đang tắt tự động (nút bấm tay).
 */
async function syncMyStoreSheet(opts = {}) {
  if (_sheetSyncing) return { ok: false, error: "Đang đồng bộ, bỏ qua lượt này." };

  const cfgRes = await getSheetConfigResult();
  if (!cfgRes.ok) {
    // Settings lỗi tạm thời: KHÔNG chạy với cấu hình default (rỗng) để tránh
    // đối chiếu sai rồi xoá sạch kho.
    return { ok: false, deferred: true, status: cfgRes.status, error: cfgRes.message };
  }
  const cfg = cfgRes.config;
  if (!opts.force && !cfg.enabled) return { ok: false, error: "Tự động đồng bộ đang tắt." };
  if (!cfg.spreadsheetId) return { ok: false, error: "Chưa lưu link Google Sheet." };

  let tabs = cfg.tabs;
  if (!tabs.length) {
    // Cấu hình chỉ có link (người dùng lưu nhanh): tự dò lại toàn bộ tab.
    try {
      const listed = await listSheetTabs(cfg.url || cfg.spreadsheetId);
      tabs = normalizeSheetTabs(listed.tabs);
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  if (!tabs.length) return { ok: false, error: "Không tìm thấy tab nào trong Sheet." };

  _sheetSyncing = true;
  try {
    const r = await importSheetTabs(cfg.spreadsheetId, tabs, { prune: cfg.prune });
    const summary = {
      ok: true,
      imported: r.imported,
      added: r.added,
      updated: r.updated,
      deleted: r.deleted,
      failedTabs: r.results.filter((x) => !x.ok).length,
    };
    const saved = await recordSheetSyncResult(cfg, summary);
    return { ...r, config: saved };
  } catch (e) {
    const summary = { ok: false, error: String(e) };
    const saved = await recordSheetSyncResult(cfg, summary);
    return { ok: false, error: String(e), config: saved };
  } finally {
    _sheetSyncing = false;
  }
}

/** Handler cho alarm: chỉ chạy khi cấu hình còn bật. */
async function processSheetSync() {
  return syncMyStoreSheet({});
}

/** Khôi phục alarm khi service worker khởi động lại. */
async function initSheetSync() {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  const cfg = await getSheetConfig();
  try {
    const existing = await chrome.alarms.get(SHEET_ALARM);
    const want = cfg.enabled && !!cfg.spreadsheetId && cfg.tabs.length > 0;
    if (want && !existing) {
      chrome.alarms.create(SHEET_ALARM, { periodInMinutes: cfg.intervalHours * 60 });
    } else if (!want && existing) {
      await chrome.alarms.clear(SHEET_ALARM);
    }
  } catch (e) {}
}

export {
  MYSTORE_SOURCE,
  MYSTORE_NAME,
  parseSheetId,
  extractTabsFromHtml,
  listSheetTabs,
  parseCsv,
  fetchSheetCsv,
  detectColumns,
  slugify,
  previewSheet,
  productIdFor,
  rowsToProducts,
  pruneMissingProducts,
  importSheetTabs,
  SHEET_KEY,
  SHEET_ALARM,
  SHEET_INTERVALS,
  normalizeSheetTabs,
  normalizeSheetConfig,
  getSheetConfig,
  getSheetConfigResult,
  applySheetConfig,
  syncMyStoreSheet,
  processSheetSync,
  initSheetSync,
};
