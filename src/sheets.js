/**
 * sheets.js — Domain "Kho của tôi": nhập sản phẩm từ Google Sheet công khai.
 *
 * Tách từ background.js (ESM). Phụ thuộc:
 *   - db.js: saveProducts.
 *   - util.js: parsePrice, decodeEntities, stripTags, sleepJitter.
 *
 * Quy trình: listSheetTabs (đọc htmlview/pubhtml) -> previewSheet (xem trước cột)
 * -> importSheetTabs (tải CSV từng tab, map cột, lưu DB dưới source "mystore").
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

// Chuyển các dòng dữ liệu của 1 tab thành sản phẩm "owned".
function rowsToProducts(dataRows, cols, tab) {
  const out = [];
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

    out.push({
      productId: `mystore::${tab.gid}::${slugify(name)}`,
      source: MYSTORE_SOURCE,
      sourceName: MYSTORE_NAME,
      owned: true,
      category,
      name,
      price: Number.isFinite(price) ? price : null,
      brand: cols.brand >= 0 ? get(cols.brand) : "",
      warranty: cols.warranty >= 0 ? get(cols.warranty) : "",
      sku: cols.sku >= 0 ? get(cols.sku) : "",
      qty: Number.isFinite(qty) ? qty : null,
      url: "",
    });
  }
  return out;
}

// Nhập danh sách tab đã chọn: mỗi tab {gid, name, category}. Tải CSV, map, lưu DB.
async function importSheetTabs(spreadsheetId, tabs) {
  if (!spreadsheetId) throw new Error("Thiếu spreadsheetId.");
  if (!Array.isArray(tabs) || !tabs.length) throw new Error("Chưa chọn tab nào để nhập.");

  let added = 0;
  let updated = 0;
  let imported = 0;
  const results = [];

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
      results.push({ gid: tab.gid, name: tab.name, ok: true, count: products.length });
      await sleepJitter(200, 600);
    } catch (e) {
      results.push({ gid: tab.gid, name: tab.name, ok: false, error: String(e) });
    }
  }

  return { ok: true, imported, added, updated, results };
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
  rowsToProducts,
  importSheetTabs,
};
