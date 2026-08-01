import * as XLSX from "xlsx";

export interface ExcelProduct {
  productId: string;
  source: "mystore";
  sourceName: string;
  owned: true;
  category: string;
  itemType: string;
  name: string;
  price: number | null;
  buildPrice: number | null;
  brand: string;
  warranty: string;
  sku: string;
  barcode: string;
  qty: number | null;
  url: string;
  inStock: boolean;
  condition: string;
  imageUrl: string;
  description: string;
  businessStatus: string;
}

export interface ExcelImportSummary {
  imported: number;
  skipped: number;
  warnings: string[];
  sheetName: string;
}

const SOURCE = "mystore" as const;
const SOURCE_NAME = "Cửa hàng của tôi";

function text(value: unknown): string {
  return String(value == null ? "" : value).trim();
}

function normalized(value: unknown): string {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value).replace(/,/g, "");
  if (!raw || raw === "--") return null;
  const parsed = Number(raw.replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function slug(value: string): string {
  return normalized(value).replace(/\s+/g, "-");
}

function productId(name: string, sku: string, barcode: string): string {
  const stable = slug(sku) || slug(barcode) || slug(name);
  return `${SOURCE}::excel::${stable}`;
}

function headerIndex(headers: string[], aliases: string[]): number {
  const normalizedHeaders = headers.map(normalized);
  for (const alias of aliases.map(normalized)) {
    const exact = normalizedHeaders.findIndex((header) => header === alias);
    if (exact >= 0) return exact;
    const partial = normalizedHeaders.findIndex((header) => header.includes(alias));
    if (partial >= 0) return partial;
  }
  return -1;
}

export function mapExcelRows(rows: unknown[][], sheetName: string): {
  products: ExcelProduct[];
  summary: ExcelImportSummary;
} {
  if (!rows.length) {
    return { products: [], summary: { imported: 0, skipped: 0, warnings: ["Sheet trống."], sheetName } };
  }
  const headers = rows[0].map(text);
  const indexes = {
    category: headerIndex(headers, ["nhóm hàng (3 cấp)", "nhóm hàng", "product group", "category"]),
    itemType: headerIndex(headers, ["loại hàng", "item type", "product type"]),
    sku: headerIndex(headers, ["mã hàng", "sku", "mã sản phẩm", "product code"]),
    barcode: headerIndex(headers, ["mã vạch", "barcode"]),
    name: headerIndex(headers, ["tên hàng", "tên sản phẩm", "name", "product"]),
    brand: headerIndex(headers, ["thương hiệu", "hãng", "brand"]),
    price: headerIndex(headers, ["giá bán", "price"]),
    buildPrice: headerIndex(headers, ["giá vốn", "cost"]),
    qty: headerIndex(headers, ["tồn kho", "số lượng", "qty", "stock"]),
    warranty: headerIndex(headers, ["bảo hành", "warranty"]),
    imageUrl: headerIndex(headers, ["hình ảnh", "image", "url"]),
    description: headerIndex(headers, ["mô tả", "description"]),
    businessStatus: headerIndex(headers, ["đang kinh doanh", "business status"]),
  };
  if (indexes.name < 0) throw new Error("Không tìm thấy cột Tên hàng/Tên sản phẩm trong file Excel.");

  const byId = new Map<string, ExcelProduct>();
  let skipped = 0;
  const warnings: string[] = [];
  for (const values of rows.slice(1)) {
    const get = (key: keyof typeof indexes) => text(values[indexes[key]]);
    const name = get("name");
    if (!name) {
      skipped++;
      continue;
    }
    const sku = get("sku");
    const barcode = get("barcode");
    const category = get("category") || get("itemType") || "Khác";
    const qty = numberValue(values[indexes.qty]);
    byId.set(productId(name, sku, barcode), {
      productId: productId(name, sku, barcode),
      source: SOURCE,
      sourceName: SOURCE_NAME,
      owned: true,
      category,
      itemType: get("itemType"),
      name,
      price: numberValue(values[indexes.price]),
      buildPrice: numberValue(values[indexes.buildPrice]),
      brand: get("brand"),
      warranty: get("warranty"),
      sku,
      barcode,
      qty,
      url: "",
      inStock: qty == null ? true : qty > 0,
      condition: /\b(?:cu|2nd|second)\b/i.test(normalized(category)) ? "cũ" : "mới",
      imageUrl: get("imageUrl"),
      description: get("description"),
      businessStatus: get("businessStatus"),
    });
  }
  if (skipped) warnings.push(`${skipped} dòng bị bỏ qua vì thiếu tên sản phẩm.`);
  return { products: [...byId.values()], summary: { imported: byId.size, skipped, warnings, sheetName } };
}

export async function parseExcelFile(file: File): Promise<{
  products: ExcelProduct[];
  summary: ExcelImportSummary;
}> {
  const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("File Excel không có sheet dữ liệu.");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheetName], {
    header: 1,
    defval: "",
    raw: true,
  });
  return mapExcelRows(rows, sheetName);
}
