/**
 * sheets-import.test.js — "Kho của tôi": nhập + TỰ ĐỘNG đồng bộ từ Google Sheet.
 *
 * Chạy bằng plain Node (`node --test test/`): KHÔNG có `chrome`, KHÔNG backend.
 * sheets.js gọi DB qua src/db.js -> apiFetch -> global.fetch, và tải CSV bằng
 * global.fetch trực tiếp, nên chỉ cần mock fetch theo URL là chạy được cả luồng.
 *
 * Bốn hợp đồng được khoá lại ở đây, vì mỗi cái từng là (hoặc suýt là) mất dữ liệu:
 *
 *  1) ĐỊNH DANH THEO SKU — productId phải bám SKU khi Sheet có cột SKU. Bản cũ
 *     dùng gid::slug(tên) nên sửa tên sản phẩm là sinh bản ghi MỚI -> kho nhân đôi.
 *  2) GỘP TRÙNG TRONG 1 LẦN NHẬP — 2 dòng cùng SKU không được tạo 2 phần tử cùng
 *     khoá trong payload upsert.
 *  3) ĐỐI CHIẾU CÓ CHỐT AN TOÀN — dòng bị xoá khỏi Sheet phải rời kho, NHƯNG chỉ
 *     khi mọi tab nhập thành công. Một tab lỗi mạng mà vẫn prune = xoá oan cả tab đó.
 *  4) SETTINGS LỖI THÌ HOÃN — đọc cấu hình thất bại tuyệt đối không được chạy tiếp
 *     với cấu hình default (rỗng), vì "Sheet rỗng" + prune = quét sạch kho.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { setBaseUrl, setToken } from "../src/api.js";
import {
  productIdFor,
  rowsToProducts,
  detectColumns,
  normalizeSheetTabs,
  normalizeSheetConfig,
  importSheetTabs,
  applySheetConfig,
  getSheetConfigResult,
  syncMyStoreSheet,
  SHEET_KEY,
} from "../src/sheets.js";

/* ------------------------------ fetch mock ------------------------------- */

const BASE = "http://localhost:3300";

let calls = [];
let handler = null;

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function csvRes(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => null,
  };
}

function install(routes) {
  handler = routes;
  calls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init.method || "GET").toUpperCase();
    calls.push({ url: u, method, body: init.body ? JSON.parse(init.body) : null });
    const res = handler(u, method);
    if (!res) throw new Error("Route không được mock: " + method + " " + u);
    return res;
  };
}

function callsTo(method, fragment) {
  return calls.filter((c) => c.method === method && c.url.includes(fragment));
}

beforeEach(() => {
  setBaseUrl(BASE);
  setToken("tok-test");
  calls = [];
});

/* --------------------- 1) định danh sản phẩm theo SKU --------------------- */

test("productIdFor bám SKU nên đổi tên sản phẩm KHÔNG sinh bản ghi mới", () => {
  const before = productIdFor("Tai nghe Sony WH-1000XM4", "SKU-01", "0");
  const after = productIdFor("Tai nghe Sony WH-1000XM4 (mới)", "SKU-01", "0");

  assert.equal(before, "mystore::sku::sku-01");
  assert.equal(after, before, "cùng SKU phải cùng productId dù tên đã đổi");
});

test("productIdFor rơi về gid::slug(tên) khi Sheet không có SKU (tương thích dữ liệu cũ)", () => {
  assert.equal(productIdFor("Chuột Logitech G102", "", "123"), "mystore::123::chuot-logitech-g102");
  // Không SKU thì đổi tên vẫn là bản ghi khác — giới hạn đã biết, ghi lại để rõ.
  assert.notEqual(
    productIdFor("Chuột Logitech G102", "", "123"),
    productIdFor("Chuot Logitech G102 den", "", "123")
  );
});

/* ------------------- 2) gộp trùng trong cùng một lần nhập ---------------- */

test("rowsToProducts gộp các dòng cùng SKU (dòng sau thắng) để payload không trùng khoá", () => {
  const header = ["Tên sản phẩm", "Giá bán", "SKU", "Số lượng"];
  const cols = detectColumns(header);
  const rows = [
    ["Bàn phím K1", "500000", "KB-1", "3"],
    ["Bàn phím K1 (bản 2024)", "550000", "KB-1", "5"],
    ["Bàn phím K2", "700000", "KB-2", "1"],
  ];

  const out = rowsToProducts(rows, cols, { gid: "0", name: "Bàn phím" });

  assert.equal(out.length, 2, "3 dòng nhưng chỉ 2 SKU");
  const ids = out.map((p) => p.productId);
  assert.equal(new Set(ids).size, ids.length, "productId phải là duy nhất trong payload");

  const k1 = out.find((p) => p.productId === "mystore::sku::kb-1");
  assert.equal(k1.name, "Bàn phím K1 (bản 2024)", "dòng dưới ghi đè dòng trên");
  assert.equal(k1.price, 550000);
  assert.equal(k1.qty, 5);
  assert.equal(k1.category, "Bàn phím", "tab -> category");
  assert.equal(k1.owned, true);
  assert.equal(k1.source, "mystore");
});

/* -------------------------- 3) chuẩn hoá cấu hình ------------------------ */

test("normalizeSheetConfig suy lại spreadsheetId từ url (chống lệch khi người dùng đổi link)", () => {
  const cfg = normalizeSheetConfig({
    url: "https://docs.google.com/spreadsheets/d/NEW_ID_123/edit#gid=7",
    spreadsheetId: "OLD_ID_STALE",
  });
  assert.equal(cfg.spreadsheetId, "NEW_ID_123");
});

test("normalizeSheetConfig kẹp chu kỳ về giá trị hợp lệ và mặc định prune = true", () => {
  assert.equal(normalizeSheetConfig({ intervalHours: 7 }).intervalHours, 6, "7h không hợp lệ -> mặc định");
  assert.equal(normalizeSheetConfig({ intervalHours: "12" }).intervalHours, 12, "chuỗi số vẫn nhận");
  assert.equal(normalizeSheetConfig({}).prune, true);
  assert.equal(normalizeSheetConfig({ prune: false }).prune, false);
  assert.equal(normalizeSheetConfig(null).enabled, false, "saved hỏng -> default an toàn (tắt)");
});

test("normalizeSheetTabs bỏ tab thiếu gid và gộp gid trùng", () => {
  const out = normalizeSheetTabs([
    { gid: "0", name: "Laptop" },
    { name: "Không có gid" },
    { gid: "0", name: "Laptop trùng" },
    { gid: 12, name: "Phụ kiện", category: "Phụ kiện" },
    "rác",
  ]);
  assert.deepEqual(
    out.map((t) => t.gid),
    ["0", "12"]
  );
  assert.equal(out[1].name, "Phụ kiện");
});

/* --------------------- 4) đối chiếu + chốt an toàn ----------------------- */

const CSV_TAB0 = "Tên sản phẩm,Giá bán,SKU\nLaptop A,20000000,LA-1\n";
const CSV_TAB1 = "Tên sản phẩm,Giá bán,SKU\nChuột B,300000,MB-1\n";

function sheetRoutes({ tab1Status = 200, existing = [] } = {}) {
  return (url, method) => {
    if (url.includes("format=csv&gid=0")) return csvRes(CSV_TAB0);
    if (url.includes("format=csv&gid=1")) {
      return tab1Status === 200 ? csvRes(CSV_TAB1) : csvRes("", tab1Status);
    }
    if (url.includes("/api/products?source=mystore") && method === "GET") {
      return jsonRes(200, { products: existing });
    }
    if (url.includes("/api/products/") && method === "DELETE") return jsonRes(200, {});
    if (url.includes("/api/products") && method === "POST") {
      return jsonRes(200, { added: 1, updated: 0 });
    }
    return null;
  };
}

test("importSheetTabs prune xoá sản phẩm không còn trong Sheet khi MỌI tab nhập OK", async () => {
  install(
    sheetRoutes({
      existing: [
        { productId: "mystore::sku::la-1", name: "Laptop A" },
        { productId: "mystore::sku::mb-1", name: "Chuột B" },
        { productId: "mystore::sku::ngung-ban", name: "Hàng đã bỏ" },
      ],
    })
  );

  const r = await importSheetTabs(
    "SID",
    [
      { gid: "0", name: "Laptop" },
      { gid: "1", name: "Phụ kiện" },
    ],
    { prune: true }
  );

  assert.equal(r.ok, true);
  assert.equal(r.imported, 2);
  assert.equal(r.deleted, 1);
  assert.equal(r.pruneCapped, false);

  const dels = callsTo("DELETE", "/api/products/");
  assert.equal(dels.length, 1, "chỉ xoá đúng 1 sản phẩm đã rời Sheet");
  assert.match(decodeURIComponent(dels[0].url), /mystore::sku::ngung-ban$/);
});

test("importSheetTabs KHÔNG prune khi có tab lỗi — tránh xoá oan hàng của tab đó", async () => {
  install(
    sheetRoutes({
      tab1Status: 500,
      existing: [{ productId: "mystore::sku::mb-1", name: "Chuột B" }],
    })
  );

  const r = await importSheetTabs(
    "SID",
    [
      { gid: "0", name: "Laptop" },
      { gid: "1", name: "Phụ kiện" },
    ],
    { prune: true }
  );

  assert.equal(r.deleted, 0);
  assert.equal(r.pruneSkipped, true, "một tab lỗi -> bỏ qua bước đối chiếu");
  assert.equal(callsTo("DELETE", "/api/products/").length, 0);
  assert.equal(r.results.filter((x) => !x.ok).length, 1);
});

test("importSheetTabs mặc định (không opts.prune) chỉ upsert, không xoá gì", async () => {
  install(sheetRoutes({ existing: [{ productId: "mystore::sku::cu", name: "Cũ" }] }));

  const r = await importSheetTabs("SID", [{ gid: "0", name: "Laptop" }]);

  assert.equal(r.deleted, 0);
  assert.equal(r.pruneSkipped, true);
  assert.equal(callsTo("GET", "/api/products?source=mystore").length, 0, "không cần đọc kho khi không prune");
});

/* ----------------------- 5) lưu cấu hình + alarm ------------------------- */

test("applySheetConfig merge từng trường rồi PUT vào settings mystoreSheetConfig", async () => {
  let saved = { url: "https://docs.google.com/spreadsheets/d/SID/edit", tabs: [{ gid: "0", name: "Laptop" }] };
  install((url, method) => {
    if (url.includes("/api/settings/" + SHEET_KEY)) {
      if (method === "GET") return jsonRes(200, { value: saved });
      saved = calls[calls.length - 1].body.value;
      return jsonRes(200, { value: saved });
    }
    return null;
  });

  const next = await applySheetConfig({ enabled: true, intervalHours: 3 });

  assert.equal(next.enabled, true);
  assert.equal(next.intervalHours, 3);
  assert.equal(next.spreadsheetId, "SID", "link đã lưu trước đó không bị mất");
  assert.deepEqual(next.tabs, [{ gid: "0", name: "Laptop", category: "" }]);

  const put = callsTo("PUT", "/api/settings/" + SHEET_KEY);
  assert.equal(put.length, 1);
  assert.equal(put[0].body.value.enabled, true);
});

test("getSheetConfigResult trả default + stale khi đọc settings lỗi (không ném)", async () => {
  install((url) => (url.includes("/api/settings/") ? jsonRes(500, { error: "boom" }) : null));

  const r = await getSheetConfigResult();

  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(r.config.enabled, false);
  assert.equal(r.config.spreadsheetId, "");
});

test("syncMyStoreSheet HOÃN khi settings lỗi — không được chạy với cấu hình rỗng rồi prune", async () => {
  install((url) => (url.includes("/api/settings/") ? jsonRes(503, { error: "down" }) : null));

  const r = await syncMyStoreSheet({ force: true });

  assert.equal(r.ok, false);
  assert.equal(r.deferred, true);
  assert.equal(callsTo("GET", "/api/products").length, 0);
  assert.equal(callsTo("DELETE", "/api/products/").length, 0, "tuyệt đối không xoá khi chưa đọc được cấu hình");
});

test("syncMyStoreSheet chạy lại đúng tab đã lưu và ghi lastResult", async () => {
  let saved = {
    enabled: true,
    intervalHours: 6,
    url: "https://docs.google.com/spreadsheets/d/SID/edit",
    tabs: [{ gid: "0", name: "Laptop" }],
    prune: false,
  };
  const products = sheetRoutes({});
  install((url, method) => {
    if (url.includes("/api/settings/" + SHEET_KEY)) {
      if (method === "GET") return jsonRes(200, { value: saved });
      saved = calls[calls.length - 1].body.value;
      return jsonRes(200, { value: saved });
    }
    return products(url, method);
  });

  const r = await syncMyStoreSheet({});

  assert.equal(r.ok, true);
  assert.equal(r.imported, 1);
  assert.equal(callsTo("POST", "/api/products").length, 1);
  assert.ok(saved.lastSyncAt > 0, "phải ghi mốc thời gian đồng bộ gần nhất");
  assert.equal(saved.lastResult.ok, true);
  assert.equal(saved.lastResult.imported, 1);
});

test("syncMyStoreSheet từ chối khi tự động đang tắt, trừ khi force", async () => {
  const saved = {
    enabled: false,
    url: "https://docs.google.com/spreadsheets/d/SID/edit",
    tabs: [{ gid: "0", name: "Laptop" }],
  };
  const products = sheetRoutes({});
  install((url, method) => {
    if (url.includes("/api/settings/" + SHEET_KEY)) {
      if (method === "GET") return jsonRes(200, { value: saved });
      return jsonRes(200, { value: saved });
    }
    return products(url, method);
  });

  const off = await syncMyStoreSheet({});
  assert.equal(off.ok, false);
  assert.equal(callsTo("POST", "/api/products").length, 0);

  const forced = await syncMyStoreSheet({ force: true });
  assert.equal(forced.ok, true, "nút 'Đồng bộ ngay' vẫn chạy được khi tắt tự động");
});
