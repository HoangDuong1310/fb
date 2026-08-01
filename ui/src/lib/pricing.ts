// Pure pricing/price-intelligence logic, ported from the legacy dashboard views:
//   - src/dashboard/views/groupprices.js  (Giá Group)
//   - src/dashboard/views/products.js     (Sản phẩm / so giá cửa hàng)
//   - src/dashboard/views/mystore.js       (Kho của tôi + so giá thị trường)
// Everything here is DOM-free and network-free so it can be unit-tested and
// reused across the React views. Behavior is kept faithful to the originals.

/* ============================ TYPES ============================== */

// A raw price row extracted from a group sale post (group_prices backend).
export interface GroupPriceRow {
  name?: string;
  price?: number | string | null;
  groupId?: string;
  postId?: string;
  category?: string;
  condition?: string;
  warranty?: string;
  sellerName?: string;
  sellerProfile?: string;
  postedAt?: number | string;
}

// A product record synced from a store source, or owned (mystore).
export interface Product {
  productId?: string;
  name?: string;
  price?: number | string | null;
  buildPrice?: number | string | null;
  brand?: string;
  category?: string;
  condition?: string;
  warranty?: string;
  qty?: number | string | null;
  source?: string;
  sourceName?: string;
  url?: string;
  inStock?: boolean;
  owned?: boolean;
  sku?: string;
  barcode?: string;
  imageUrl?: string;
  description?: string;
  businessStatus?: string;
  itemType?: string;
}

export interface Source {
  id: string;
  name?: string;
  url?: string;
  lastSyncAt?: number;
  lastCount?: number;
}

export interface ProductGroup {
  key: string;
  name: string;
  rows: GroupPriceRow[];
  minPrice: number | null;
  maxPrice: number | null;
}

export interface GroupPriceFilters {
  groupId?: string;
  category?: string;
  condition?: string;
  priceMin?: number | null;
  priceMax?: number | null;
  // Free-text search over name / seller / category / condition. Diacritic- and
  // case-insensitive; every whitespace-separated token must appear (AND).
  query?: string;
}

export interface Cluster {
  sig: string;
  tokens: Set<string>;
  name: string;
  brand?: string;
  category?: string;
  offers: Product[];
  minPrice: number | null;
  maxPrice: number | null;
  storeCount: number;
  spread: number;
}

/* ========================= FORMAT HELPERS ======================== */

export function fmtPrice(v?: number | string | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("vi-VN").format(n) + "₫";
}

// Only allow http/https when building links from AI/crawl data (less trusted):
// block javascript:/data: and other dangerous schemes. Returns "" if invalid.
export function safeHttpUrl(raw?: string | null): string {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

/* ==================== GIÁ GROUP (group prices) =================== */

// Normalize a product name for grouping the same item: lowercase + collapse
// whitespace. Empty/null -> "".
export function normalizeProductKey(name?: string): string {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Strip Vietnamese diacritics + lowercase, so "ram ddr4" matches "RAM DDR4" and
// "man hinh" matches "Màn hình". NFD splits the base letter from its combining
// marks; đ/Đ has no decomposition so it is mapped explicitly.
export function searchNorm(s?: string | null): string {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Split a query into search tokens (already normalized). Empty -> [].
export function queryTokens(query?: string | null): string[] {
  const q = searchNorm(query);
  return q ? q.split(" ").filter(Boolean) : [];
}

// A row matches when EVERY token appears somewhere in its searchable text.
// Token-AND (not whole-phrase) so word order and extra words don't matter:
// "ram 16" finds "RAM Kingston 16GB". Price is included as raw digits so
// typing "5000000" also works.
export function rowMatchesTokens(row: GroupPriceRow, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  if (!row) return false;
  const hay = searchNorm(
    [
      row.name,
      row.sellerName,
      row.category,
      row.condition,
      row.warranty,
      row.price == null ? "" : String(row.price),
    ]
      .filter(Boolean)
      .join(" "),
  );
  return tokens.every((t) => hay.includes(t));
}

// Return a row/group price, or +Infinity if missing, to push it last on sort.
function priceOrInfinity(
  obj: { price?: unknown; minPrice?: unknown } | null,
  field: "price" | "minPrice" = "price",
): number {
  const v = obj ? (obj as Record<string, unknown>)[field] : null;
  return v == null || Number.isNaN(Number(v)) ? Infinity : Number(v);
}

// Group price rows by normalized name. Each group: sorted rows (price asc),
// minPrice/maxPrice (rows without price excluded from min/max). Groups sorted
// by minPrice asc; priceless groups last.
export function groupByProduct(rows: GroupPriceRow[]): ProductGroup[] {
  if (!Array.isArray(rows)) return [];
  const map = new Map<string, ProductGroup>();
  for (const r of rows) {
    if (!r) continue;
    const key = normalizeProductKey(r.name);
    if (!map.has(key)) {
      map.set(key, { key, name: r.name || "", rows: [], minPrice: null, maxPrice: null });
    }
    map.get(key)!.rows.push(r);
  }

  const groups: ProductGroup[] = [];
  for (const g of map.values()) {
    g.rows.sort((a, b) => priceOrInfinity(a) - priceOrInfinity(b));
    const prices = g.rows
      .map((r) => r.price)
      .filter((p) => p != null && !Number.isNaN(Number(p)))
      .map(Number);
    g.minPrice = prices.length ? Math.min(...prices) : null;
    g.maxPrice = prices.length ? Math.max(...prices) : null;
    groups.push(g);
  }

  groups.sort(
    (a, b) => priceOrInfinity(a, "minPrice") - priceOrInfinity(b, "minPrice"),
  );
  return groups;
}

// Filter price rows by conditions (skip empty filters). groupId/category/
// condition are exact matches; priceMin/priceMax define an inclusive range.
// Rows without price are dropped when a range constraint exists. `query` is a
// diacritic-insensitive token-AND search over name/seller/category/price.
export function filterRows(
  rows: GroupPriceRow[],
  filters: GroupPriceFilters = {},
): GroupPriceRow[] {
  if (!Array.isArray(rows)) return [];
  const { groupId, category, condition, priceMin, priceMax, query } = filters || {};
  // Tokenize once, not per row.
  const tokens = queryTokens(query);
  return rows.filter((r) => {
    if (!r) return false;
    if (groupId && String(r.groupId) !== String(groupId)) return false;
    if (category && r.category !== category) return false;
    if (condition && r.condition !== condition) return false;
    if (tokens.length > 0 && !rowMatchesTokens(r, tokens)) return false;
    const hasRange = priceMin != null || priceMax != null;
    if (hasRange) {
      if (r.price == null) return false;
      if (priceMin != null && Number(r.price) < Number(priceMin)) return false;
      if (priceMax != null && Number(r.price) > Number(priceMax)) return false;
    }
    return true;
  });
}

export const COND_LABEL: Record<string, string> = {
  "mới": "Mới",
  "cũ": "Cũ",
  likenew: "Like new",
};

/* ================= SẢN PHẨM (store product compare) ============= */

// Merge synonymous category names into a single canonical label so filtering/
// display doesn't fragment. Unknown names are kept as-is.
export function canonCat(c?: string): string {
  const n = String(c || "").trim().toLowerCase();
  if (!n) return "";
  if (n === "cpu") return "CPU";
  if (n === "ram") return "RAM";
  if (n === "vga" || n === "card" || n.includes("card màn") || n.includes("card man"))
    return "VGA";
  if (n.includes("main") || n.includes("bo mạch") || n.includes("bo mach"))
    return "Mainboard";
  if (n === "ssd") return "SSD";
  if (n === "hdd") return "HDD";
  if (n.includes("ổ cứng") || n.includes("o cung")) return "Ổ cứng";
  if (n.includes("nguồn") || n.includes("nguon") || n === "psu") return "Nguồn";
  if (n.includes("case") || n.includes("vỏ") || n === "vo") return "Case";
  if (n.includes("tản") || n.includes("tan nhiet")) return "Tản nhiệt";
  if (n.includes("màn") || n.includes("man hinh") || n.includes("monitor"))
    return "Màn hình";
  return String(c).trim();
}

// Keep only sellable items: in stock (inStock !== false) and retail price > 0.
export function isSellable(p?: Product): boolean {
  if (p && p.inStock === false) return false;
  const price = Number(p && p.price);
  return Number.isFinite(price) && price > 0;
}

// Build an absolute URL for the "View" link. Legacy records may store relative
// URLs; rejoin them against the source domain when possible.
export function resolveProductUrl(p: Product, sources: Source[]): string {
  const raw = (p && p.url ? String(p.url) : "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return "https:" + raw;
  const src = sources.find((s) => s.id === p.source);
  if (!src || !src.url) return raw;
  try {
    const origin = new URL(src.url).origin;
    return new URL(raw, origin).toString();
  } catch {
    return raw;
  }
}

const PROD_STOPWORDS = new Set([
  "laptop", "may", "tinh", "pc", "san", "pham", "chinh", "hang", "moi", "new",
  "cpu", "vga", "ram", "ssd", "hdd", "mainboard", "main", "bo", "mach", "case",
  "vo", "nguon", "psu", "man", "hinh", "monitor", "ban", "phim", "chuot",
  "tan", "nhiet", "quat", "cao", "cap", "gia", "re", "khuyen", "mai", "the",
  "hop", "kit", "for", "and", "with", "core", "gen", "chiec", "sp", "ma",
]);

// Build a product "signature" to group the same item across stores. Prefer
// model-code / spec tokens (tokens containing digits) as they are stable.
export function productSignature(name?: string): string[] {
  let s = (name || "").toLowerCase();
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
  s = s.replace(/[^a-z0-9]+/g, " ");
  const tokens = s.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => {
    if (!t || t.length <= 1) return false;
    if (PROD_STOPWORDS.has(t)) return false;
    return true;
  });
  if (!kept.length) return [];
  const strong = kept.filter((t) => /[0-9]/.test(t));
  const basis = strong.length ? strong : kept;
  return [...new Set(basis)].sort();
}

// A token set is a subset of another (every element of a is in b).
export function tokensSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// A distinctive "model code / spec" token (long enough + has a digit).
export function isModelCode(t: string): boolean {
  return t.length >= 4 && /[0-9]/.test(t);
}

// Cluster a flat product list into "same product across stores" groups.
export function clusterProducts(products: Product[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const p of products) {
    const toks = productSignature(p.name);
    if (!toks.length) continue;
    const set = new Set(toks);
    let best: Cluster | null = null;
    for (const c of clusters) {
      const small = set.size <= c.tokens.size ? set : c.tokens;
      const large = set.size <= c.tokens.size ? c.tokens : set;
      if (!tokensSubset(small, large)) continue;
      if (small.size >= 2) {
        best = c;
        break;
      }
      if (small.size === 1 && isModelCode([...small][0])) {
        best = c;
        break;
      }
    }
    if (!best) {
      best = {
        sig: toks.join(" "),
        tokens: set,
        name: p.name || "",
        brand: p.brand,
        category: p.category,
        offers: [],
        minPrice: null,
        maxPrice: null,
        storeCount: 0,
        spread: 0,
      };
      clusters.push(best);
    } else {
      const inter = new Set<string>();
      for (const t of best.tokens) if (set.has(t)) inter.add(t);
      if (inter.size >= 2) best.tokens = inter;
    }
    best.offers.push(p);
    if ((p.name || "").length > (best.name || "").length) best.name = p.name || "";
  }
  for (const c of clusters) {
    const prices = c.offers
      .map((o) => Number(o.price))
      .filter((n) => Number.isFinite(n) && n > 0);
    c.minPrice = prices.length ? Math.min(...prices) : null;
    c.maxPrice = prices.length ? Math.max(...prices) : null;
    c.storeCount = new Set(c.offers.map((o) => o.source)).size;
    c.spread = c.minPrice != null ? (c.maxPrice as number) - c.minPrice : 0;
  }
  clusters.sort((a, b) => b.storeCount - a.storeCount || b.spread - a.spread);
  return clusters;
}

// For a cluster, keep one cheapest offer per store, sorted by price asc.
export function bestOffersPerStore(offers: Product[]): Product[] {
  const byStore = new Map<string, Product>();
  for (const o of offers) {
    const cur = byStore.get(o.source || "");
    const price = Number(o.price);
    if (
      !cur ||
      (Number.isFinite(price) && price > 0 && price < (Number(cur.price) || Infinity))
    ) {
      byStore.set(o.source || "", o);
    }
  }
  return [...byStore.values()].sort((a, b) => {
    const pa = Number(a.price) || Infinity;
    const pb = Number(b.price) || Infinity;
    return pa - pb;
  });
}

// Price spread across the shown (one-per-store) offers.
export function shownSpread(offers: Product[]): number {
  const prices = offers
    .map((o) => Number(o.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  return prices.length >= 2 ? Math.max(...prices) - Math.min(...prices) : 0;
}

// Count products per source (to show data coverage).
export function sourceBreakdown(products: Product[]): [string, number][] {
  const map = new Map<string, number>();
  for (const p of products) {
    const key = p.sourceName || p.source || "(không rõ)";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/* ================= KHO CỦA TÔI (market compare) ================= */

// Compare one owned product against the market (other stores): match by name
// signature + model code, keep one cheapest in-stock offer per store.
export function marketMatches(mine: Product, market: Product[]): Product[] {
  const toks = productSignature(mine.name);
  const set = new Set(toks);
  const matches: Product[] = [];
  if (set.size) {
    for (const o of market) {
      const ot = new Set(productSignature(o.name));
      if (!ot.size) continue;
      const small = set.size <= ot.size ? set : ot;
      const large = set.size <= ot.size ? ot : set;
      if (!tokensSubset(small, large)) continue;
      if (small.size >= 2 || (small.size === 1 && isModelCode([...small][0]))) {
        matches.push(o);
      }
    }
  }
  const byStore = new Map<string, Product>();
  for (const o of matches) {
    const price = Number(o.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (o.inStock === false) continue;
    const cur = byStore.get(o.source || "");
    if (!cur || price < Number(cur.price)) byStore.set(o.source || "", o);
  }
  return [...byStore.values()].sort(
    (a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity),
  );
}
