/**
 * Ô tìm kiếm của tab "Giá Group" (ui/src/lib/pricing.ts).
 *
 * Trước đây view chỉ có LỌC (dropdown group/category/condition + khoảng giá) —
 * tức là người dùng phải biết trước giá trị chính xác để chọn. Tìm kiếm là bài
 * toán khác: gõ tự do, không dấu, sai thứ tự từ, và vẫn phải ra kết quả.
 *
 * Ba tính chất được khoá lại ở đây:
 *   1. Bỏ dấu + không phân biệt hoa/thường  ("man hinh" khớp "Màn hình").
 *   2. Token-AND, không phải khớp cả cụm     ("ram 16" khớp "RAM Kingston 16GB").
 *   3. Tìm kiếm là MỘT điều kiện nữa của filterRows, không thay thế các filter cũ.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  searchNorm,
  queryTokens,
  rowMatchesTokens,
  filterRows,
  productMatchesSmartQuery,
} from "../ui/src/lib/pricing.ts";

/* ------------------------------ searchNorm ------------------------------- */

test("searchNorm: bỏ dấu, hạ chữ thường, gộp khoảng trắng", () => {
  assert.equal(searchNorm("Màn hình"), "man hinh");
  assert.equal(searchNorm("RAM DDR4"), "ram ddr4");
  assert.equal(searchNorm("  Card   Đồ  Hoạ \n"), "card do hoa");
  // đ/Đ không có dạng phân rã NFD nên phải map tay.
  assert.equal(searchNorm("Đèn"), "den");
  assert.equal(searchNorm("Ổ cứng ĐỜI mới"), "o cung doi moi");
});

test("searchNorm: null/undefined/số không làm nổ", () => {
  assert.equal(searchNorm(null), "");
  assert.equal(searchNorm(undefined), "");
  assert.equal(searchNorm(""), "");
});

/* ------------------------------ queryTokens ------------------------------ */

test("queryTokens: tách token, rỗng/khoảng trắng -> []", () => {
  assert.deepEqual(queryTokens("RAM 16GB"), ["ram", "16gb"]);
  assert.deepEqual(queryTokens("  màn   hình  "), ["man", "hinh"]);
  assert.deepEqual(queryTokens(""), []);
  assert.deepEqual(queryTokens("   "), []);
  assert.deepEqual(queryTokens(null), []);
});

/* --------------------------- rowMatchesTokens ---------------------------- */

const ROW = {
  name: "RAM Kingston Fury 16GB DDR4",
  price: 850000,
  sellerName: "Nguyễn Văn A",
  category: "RAM",
  condition: "likenew",
  warranty: "12 tháng",
};

test("rowMatchesTokens: không token -> khớp hết (không lọc oan)", () => {
  assert.equal(rowMatchesTokens(ROW, []), true);
});

test("rowMatchesTokens: token-AND, không cần đúng thứ tự hay liền nhau", () => {
  assert.equal(rowMatchesTokens(ROW, queryTokens("ram 16")), true);
  assert.equal(rowMatchesTokens(ROW, queryTokens("16gb kingston")), true);
  assert.equal(rowMatchesTokens(ROW, queryTokens("kingston ddr4 fury")), true);
  // Thiếu một token là loại.
  assert.equal(rowMatchesTokens(ROW, queryTokens("ram 32")), false);
});

test("rowMatchesTokens: tìm được cả người bán, tình trạng, bảo hành", () => {
  assert.equal(rowMatchesTokens(ROW, queryTokens("nguyen van")), true);
  assert.equal(rowMatchesTokens(ROW, queryTokens("likenew")), true);
  assert.equal(rowMatchesTokens(ROW, queryTokens("12 thang")), true);
});

test("rowMatchesTokens: gõ số tiền thô cũng ra (price được đưa vào vùng tìm)", () => {
  assert.equal(rowMatchesTokens(ROW, queryTokens("850000")), true);
  assert.equal(rowMatchesTokens(ROW, queryTokens("990000")), false);
});

test("rowMatchesTokens: row thiếu trường / null không ném lỗi", () => {
  assert.equal(rowMatchesTokens(null, queryTokens("ram")), false);
  assert.equal(rowMatchesTokens({}, queryTokens("ram")), false);
  assert.equal(rowMatchesTokens({ name: "RAM" }, queryTokens("ram")), true);
  // price null không được biến thành chuỗi "null" rồi khớp bừa.
  assert.equal(rowMatchesTokens({ name: "RAM", price: null }, queryTokens("null")), false);
});

/* ------------------------------ filterRows ------------------------------- */

const ROWS = [
  {
    name: "Màn hình LG 24 inch",
    price: 2000000,
    groupId: "g1",
    category: "monitor",
    condition: "cũ",
    sellerName: "Trần B",
  },
  {
    name: "RAM Kingston 16GB",
    price: 850000,
    groupId: "g1",
    category: "RAM",
    condition: "likenew",
    sellerName: "Nguyễn A",
  },
  {
    name: "RAM Corsair 8GB",
    price: 450000,
    groupId: "g2",
    category: "RAM",
    condition: "cũ",
    sellerName: "Nguyễn A",
  },
];

test("filterRows: không có query -> hành vi cũ nguyên vẹn", () => {
  assert.equal(filterRows(ROWS, {}).length, 3);
  assert.equal(filterRows(ROWS, { query: "" }).length, 3);
  assert.equal(filterRows(ROWS, { query: "   " }).length, 3);
  assert.equal(filterRows(ROWS, { groupId: "g1" }).length, 2);
});

test("filterRows: query bỏ dấu tìm đúng dòng", () => {
  const out = filterRows(ROWS, { query: "man hinh" });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Màn hình LG 24 inch");
});

test("filterRows: query kết hợp AND với các filter cũ", () => {
  // "ram" ra 2 dòng, thêm group g2 chỉ còn Corsair.
  assert.equal(filterRows(ROWS, { query: "ram" }).length, 2);
  const out = filterRows(ROWS, { query: "ram", groupId: "g2" });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "RAM Corsair 8GB");

  // Query + khoảng giá.
  const cheap = filterRows(ROWS, { query: "ram", priceMax: 500000 });
  assert.equal(cheap.length, 1);
  assert.equal(cheap[0].name, "RAM Corsair 8GB");

  // Query + tình trạng.
  const ln = filterRows(ROWS, { query: "ram", condition: "likenew" });
  assert.equal(ln.length, 1);
  assert.equal(ln[0].name, "RAM Kingston 16GB");
});

test("filterRows: tìm theo người bán gom hết hàng của họ", () => {
  const out = filterRows(ROWS, { query: "nguyen a" });
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((r) => r.name),
    ["RAM Kingston 16GB", "RAM Corsair 8GB"],
  );
});

test("filterRows: query không khớp gì -> mảng rỗng, không phải toàn bộ", () => {
  assert.deepEqual(filterRows(ROWS, { query: "cpu ryzen" }), []);
});

test("filterRows: đầu vào không phải mảng -> []", () => {
  assert.deepEqual(filterRows(null, { query: "ram" }), []);
  assert.deepEqual(filterRows(undefined, {}), []);
});

/* ----------------------- productMatchesSmartQuery ------------------------ */

const RTX_PRODUCT = {
  name: "Card màn hình ASUS Dual GeForce RTX 3060 OC 12GB GDDR6",
  price: 10200000,
  buildPrice: 9500000,
  category: "Card màn hình",
  brand: "ASUS",
  source: "nguyencong",
  sourceName: "Nguyễn Công",
  sku: "DUAL-RTX3060-O12G",
  warranty: "36 tháng",
};

const MAIN_PRODUCT = {
  name: "Bo mạch chủ MSI B760M Mortar WIFI DDR5",
  price: 3890000,
  category: "Mainboard",
  brand: "MSI",
  sourceName: "An Phát",
};

test("productMatchesSmartQuery: tìm mềm bỏ dấu, sai thứ tự và thêm sku/source", () => {
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "asus 3060"), true);
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "3060 nguyen"), true);
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "dual rtx3060"), true);
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "36 thang"), true);
});

test("productMatchesSmartQuery: hiểu đồng nghĩa nhóm linh kiện", () => {
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "vga 3060"), true);
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "gpu 3060"), true);
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "card do hoa 3060"), true);
  assert.equal(productMatchesSmartQuery(MAIN_PRODUCT, "main b760"), true);
  assert.equal(productMatchesSmartQuery(MAIN_PRODUCT, "bo mach chu b760"), true);
});

test("productMatchesSmartQuery: chịu được typo 1 ký tự cho token dài", () => {
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "geforc 3060"), true);
  assert.equal(productMatchesSmartQuery(MAIN_PRODUCT, "morter b760"), true);
  assert.equal(productMatchesSmartQuery(RTX_PRODUCT, "geforxxx 3060"), false);
});
