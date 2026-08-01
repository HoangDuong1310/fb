import { test } from "node:test";
import assert from "node:assert/strict";
import { mapExcelRows } from "../ui/src/lib/excelImport.ts";
import {
  groupSegments,
  productGroupOptions,
  productMatchesGroup,
  hasWarranty,
  productMatchesWarranty,
  warrantyMonths,
} from "../ui/src/lib/inventoryFilters.ts";

const normalized = (value) => String(value == null ? "" : value)
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const numberValue = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = String(value == null ? "" : value).trim().replace(/,/g, "");
  if (!raw || raw === "--") return null;
  const parsed = Number(raw.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const productId = (name, sku, barcode) => {
  const stable = normalized(sku || barcode || name).replace(/\s+/g, "-");
  return `mystore::excel::${stable}`;
};

test("Excel demo columns normalize Vietnamese headers", () => {
  const headers = ["Nhóm hàng", "Mã hàng", "Tên hàng", "Giá bán", "Giá vốn", "Tồn kho", "Bảo hành"];
  assert.equal(normalized(headers[0]), "nhom hang");
  assert.equal(normalized(headers[2]), "ten hang");
  assert.equal(normalized(headers[6]), "bao hanh");
});

test("Excel numeric values support workbook numbers and formatted strings", () => {
  assert.equal(numberValue(12000000), 12000000);
  assert.equal(numberValue("12,000,000 đ"), 12000000);
  assert.equal(numberValue("--"), null);
});

test("Excel identity prefers SKU and remains stable when name changes", () => {
  assert.equal(
    productId("RAM cũ", "SP9000424211", ""),
    productId("RAM Patriot DDR5", "SP9000424211", ""),
  );
  assert.notEqual(productId("RAM cũ", "", "SN-1"), productId("RAM mới", "", "SN-2"));
});

test("Excel import uses the demo Nhóm hàng(3 Cấp) column, not Loại hàng", () => {
  const result = mapExcelRows(
    [
      ["Loại hàng", "Nhóm hàng(3 Cấp)", "Mã hàng", "Tên hàng", "Bảo hành"],
      ["Hàng hóa", "LINH KIỆN MÁY TÍNH>>VGA", "VGA-01", "VGA test", "3 tháng"],
    ],
    "demo",
  );
  assert.equal(result.products[0]?.category, "LINH KIỆN MÁY TÍNH>>VGA");
  assert.equal(result.products[0]?.itemType, "Hàng hóa");
  assert.equal(result.products[0]?.warranty, "3 tháng");
});

test("group hierarchy preserves the workbook's distinct group values", () => {
  const products = [
    { category: "HÀNG CŨ ( 2ND )" },
    { category: "DỊCH VỤ" },
    { category: "VGA XÁCH TAY" },
    { category: "VGA HÀNG" },
    { category: "LINH KIỆN MÁY TÍNH>>VGA" },
    { category: "LINH KIỆN MÁY TÍNH>>RAM" },
    { category: "LINH KIỆN MÁY TÍNH>>SSD" },
    { category: "LINH KIỆN MÁY TÍNH>>MAINBOARD ( BO MẠCH CHỦ )" },
  ];
  const values = productGroupOptions(products).map((option) => option.value);
  assert.ok(values.includes("HÀNG CŨ ( 2ND )"));
  assert.ok(values.includes("DỊCH VỤ"));
  assert.ok(values.includes("VGA XÁCH TAY"));
  assert.ok(values.includes("VGA HÀNG"));
  assert.ok(values.includes("LINH KIỆN MÁY TÍNH>>VGA"));
  assert.ok(values.includes("LINH KIỆN MÁY TÍNH>>RAM"));
  assert.ok(values.includes("LINH KIỆN MÁY TÍNH>>SSD"));
  assert.ok(values.includes("LINH KIỆN MÁY TÍNH>>MAINBOARD ( BO MẠCH CHỦ )"));
});

test("group hierarchy exposes parent and leaf filters with descendant counts", () => {
  const products = [
    { category: "LINH KIỆN MÁY TÍNH>>VGA" },
    { category: "LINH KIỆN MÁY TÍNH >> RAM" },
    { category: "VGA XÁCH TAY" },
  ];
  assert.deepEqual(groupSegments(products[0].category), ["LINH KIỆN MÁY TÍNH", "VGA"]);
  assert.equal(productMatchesGroup(products[0], "LINH KIỆN MÁY TÍNH"), true);
  assert.equal(productMatchesGroup(products[1], "LINH KIỆN MÁY TÍNH >> VGA"), false);

  const options = productGroupOptions(products);
  assert.equal(options.find((option) => option.value === "LINH KIỆN MÁY TÍNH")?.count, 2);
  assert.equal(options.find((option) => option.value === "LINH KIỆN MÁY TÍNH>>VGA")?.count, 1);
});

test("warranty parser supports Vietnamese month/year text and missing states", () => {
  assert.equal(warrantyMonths("Toàn bộ sản phẩm:3 tháng"), 3);
  assert.equal(warrantyMonths("Bảo hành 2 năm"), 24);
  assert.equal(warrantyMonths("Không bảo hành"), 0);
  assert.equal(hasWarranty("Toàn bộ sản phẩm:3 tháng"), true);
  assert.equal(hasWarranty("--"), false);
});

test("warranty smart filters classify common ranges", () => {
  assert.equal(productMatchesWarranty({ warranty: "3 tháng" }, "upTo3"), true);
  assert.equal(productMatchesWarranty({ warranty: "12 tháng" }, "4To12"), true);
  assert.equal(productMatchesWarranty({ warranty: "24 tháng" }, "over12"), true);
  assert.equal(productMatchesWarranty({ warranty: "Không bảo hành" }, "none"), true);
  assert.equal(productMatchesWarranty({ warranty: "Bảo hành chính hãng" }, "has"), true);
});
