/**
 * dashboard-groupprices.test.js — Kiểm thử LOGIC THUẦN của view "Giá Group"
 * (src/dashboard/views/groupprices.js). Chạy bằng `node --test` ở môi trường
 * Node thuần (KHÔNG có `chrome`/`document`), nên file view chỉ được import các
 * hàm thuần — không đụng DOM ở top-level.
 *
 * Hai mảng logic đáng kiểm thử:
 *   1) groupByProduct(rows): gom các dòng giá theo "sản phẩm" (chuẩn hoá tên),
 *      mỗi nhóm có dải giá thấp→cao (min/max) + danh sách dòng đã sắp tăng dần,
 *      và các nhóm được sắp theo giá thấp nhất tăng dần.
 *   2) filterRows(rows, filters): lọc theo group/category/condition/priceMin/
 *      priceMax + cờ mineOnly (chỉ dòng của tôi). Bỏ qua filter rỗng.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeProductKey,
  groupByProduct,
  filterRows,
} from "../src/dashboard/views/groupprices.js";

/* --------------------------- normalizeProductKey ------------------------- */

test("normalizeProductKey: hạ thường + bỏ khoảng trắng thừa để gom cùng SP", () => {
  assert.equal(
    normalizeProductKey("  RTX  3060  "),
    normalizeProductKey("rtx 3060")
  );
});

test("normalizeProductKey: tên rỗng/null trả chuỗi rỗng (không ném)", () => {
  assert.equal(normalizeProductKey(null), "");
  assert.equal(normalizeProductKey(""), "");
});

/* ----------------------------- groupByProduct ---------------------------- */

test("groupByProduct: gom theo tên đã chuẩn hoá, tính dải giá thấp→cao", () => {
  const rows = [
    { id: 1, name: "RTX 3060", price: 7000000 },
    { id: 2, name: "rtx 3060", price: 5000000 },
    { id: 3, name: "RTX 3060", price: 6000000 },
  ];
  const groups = groupByProduct(rows);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.minPrice, 5000000);
  assert.equal(g.maxPrice, 7000000);
  // Các dòng trong nhóm sắp tăng dần theo giá.
  assert.deepEqual(g.rows.map((r) => r.price), [5000000, 6000000, 7000000]);
});

test("groupByProduct: nhiều sản phẩm -> sắp nhóm theo giá thấp nhất tăng dần", () => {
  const rows = [
    { id: 1, name: "Card A", price: 9000000 },
    { id: 2, name: "Card B", price: 3000000 },
    { id: 3, name: "Card B", price: 4000000 },
    { id: 4, name: "Card A", price: 8000000 },
  ];
  const groups = groupByProduct(rows);
  assert.equal(groups.length, 2);
  // Card B (min 3tr) đứng trước Card A (min 8tr).
  assert.equal(groups[0].name, "Card B");
  assert.equal(groups[0].minPrice, 3000000);
  assert.equal(groups[1].name, "Card A");
  assert.equal(groups[1].minPrice, 8000000);
});

test("groupByProduct: bỏ qua dòng không có giá (price null) khi tính dải", () => {
  const rows = [
    { id: 1, name: "SSD", price: null },
    { id: 2, name: "SSD", price: 1200000 },
  ];
  const groups = groupByProduct(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].minPrice, 1200000);
  assert.equal(groups[0].maxPrice, 1200000);
});

test("groupByProduct: danh sách rỗng -> mảng rỗng", () => {
  assert.deepEqual(groupByProduct([]), []);
  assert.deepEqual(groupByProduct(null), []);
});

/* ------------------------------- filterRows ------------------------------ */

const SAMPLE = [
  { id: 1, name: "A", price: 1000000, groupId: "g1", category: "VGA", condition: "mới" },
  { id: 2, name: "B", price: 5000000, groupId: "g2", category: "CPU", condition: "cũ" },
  { id: 3, name: "C", price: 3000000, groupId: "g1", category: "VGA", condition: "likenew" },
];

test("filterRows: không filter -> trả nguyên danh sách", () => {
  assert.equal(filterRows(SAMPLE, {}).length, 3);
});

test("filterRows: lọc theo groupId", () => {
  const out = filterRows(SAMPLE, { groupId: "g1" });
  assert.deepEqual(out.map((r) => r.id), [1, 3]);
});

test("filterRows: lọc theo category", () => {
  const out = filterRows(SAMPLE, { category: "VGA" });
  assert.deepEqual(out.map((r) => r.id), [1, 3]);
});

test("filterRows: lọc theo condition", () => {
  const out = filterRows(SAMPLE, { condition: "cũ" });
  assert.deepEqual(out.map((r) => r.id), [2]);
});

test("filterRows: lọc theo khoảng giá priceMin/priceMax", () => {
  const out = filterRows(SAMPLE, { priceMin: 2000000, priceMax: 4000000 });
  assert.deepEqual(out.map((r) => r.id), [3]);
});

test("filterRows: kết hợp nhiều điều kiện", () => {
  const out = filterRows(SAMPLE, { groupId: "g1", priceMax: 2000000 });
  assert.deepEqual(out.map((r) => r.id), [1]);
});
