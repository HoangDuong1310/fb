import { searchNorm, type Product } from "./pricing.ts";

export type WarrantyFilter = "all" | "has" | "none" | "upTo3" | "4To12" | "over12";

export interface ProductGroupOption {
  value: string;
  label: string;
  depth: number;
  count: number;
}

export function groupSegments(value?: string | null): string[] {
  return String(value == null ? "" : value)
    .split(/\s*(?:>>|›|→)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function groupPath(value?: string | null): string {
  return groupSegments(value).join(">>");
}

export function groupLabel(value?: string | null): string {
  // Keep the workbook's visual vocabulary: `>>` is meaningful to users because
  // it separates the 3-level group path. Do not replace it with a decorative
  // separator that makes distinct Excel values look like one flat category.
  return groupSegments(value).join(">>");
}

export function productMatchesGroup(product: Pick<Product, "category">, selected: string): boolean {
  const wanted = groupSegments(selected).map(searchNorm);
  if (!wanted.length) return true;
  const actual = groupSegments(product.category).map(searchNorm);
  return wanted.every((segment, index) => actual[index] === segment);
}

export function productGroupOptions(products: Pick<Product, "category">[]): ProductGroupOption[] {
  const options = new Map<string, ProductGroupOption>();
  for (const product of products) {
    const segments = groupSegments(product.category);
    for (let depth = 1; depth <= segments.length; depth++) {
      // Keep the exact workbook spelling in the visible option. The normalized
      // key is only for matching/filtering, never for replacing the label.
      const path = segments.slice(0, depth).join(">>");
      const key = searchNorm(path);
      const current = options.get(key);
      if (current) current.count += 1;
      else {
        options.set(key, {
          value: path,
          label: path,
          depth,
          count: 1,
        });
      }
    }
  }
  return [...options.values()].sort((a, b) => {
    const root = groupSegments(a.value)[0]?.localeCompare(groupSegments(b.value)[0] || "", "vi") || 0;
    if (root) return root;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.label.localeCompare(b.label, "vi");
  });
}

export function warrantyMonths(value?: string | null): number | null {
  const normalized = searchNorm(value);
  if (!normalized || /^(?:-|--|n\/a|none)$/.test(normalized)) return null;
  if (/khong\s+(?:co\s+)?bao\s+hanh|het\s+bao\s+hanh/.test(normalized)) return 0;

  const years = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:nam|year|years)\b/);
  if (years) return Math.round(Number(years[1].replace(",", ".")) * 12);

  const months = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:thang|month|months)\b/);
  if (months) return Math.round(Number(months[1].replace(",", ".")));

  const compact = normalized.match(/\b(\d+)\s*m\b/);
  if (compact) return Number(compact[1]);
  return null;
}

export function hasWarranty(value?: string | null): boolean {
  const normalized = searchNorm(value);
  if (!normalized || /^(?:-|--|n\/a|none)$/.test(normalized)) return false;
  return warrantyMonths(value) !== 0;
}

export function productMatchesWarranty(
  product: Pick<Product, "warranty">,
  filter: WarrantyFilter,
): boolean {
  if (filter === "all") return true;
  const present = hasWarranty(product.warranty);
  if (filter === "has") return present;
  if (filter === "none") return !present;
  if (!present) return false;

  const months = warrantyMonths(product.warranty);
  if (months == null) return false;
  if (filter === "upTo3") return months > 0 && months <= 3;
  if (filter === "4To12") return months >= 4 && months <= 12;
  return months > 12;
}
