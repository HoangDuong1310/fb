import { useEffect, useMemo, useRef, useState } from "react";
import { parseExcelFile, type ExcelImportSummary } from "@/lib/excelImport";
import {
  Tag,
  Store,
  Boxes,
  RefreshCw,
  Sparkles,
  Loader2,
  ExternalLink,
  Search,
  Trash2,
  X,
  Inbox,
  AlertCircle,
  LayoutGrid,
  List,
  FileSpreadsheet,
  ChevronDown,
  Clock,
  Download,
  CheckCircle2,
  Upload,
  SlidersHorizontal,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { colorFor, initials } from "@/lib/avatar";
import {
  groupLabel,
  productGroupOptions,
  productMatchesGroup,
  productMatchesWarranty,
  type WarrantyFilter,
} from "@/lib/inventoryFilters";
import { cn } from "@/lib/utils";
import { useIncremental } from "@/lib/useIncremental";
import {
  fmtPrice,
  safeHttpUrl,
  groupByProduct,
  filterRows,
  COND_LABEL,
  canonCat,
  isSellable,
  resolveProductUrl,
  clusterProducts,
  bestOffersPerStore,
  shownSpread,
  sourceBreakdown,
  marketMatches,
  queryTokens,
  searchNorm,
  type GroupPriceRow,
  type Product,
  type Source,
} from "@/lib/pricing";

/* -------------------------------------------------------------------------
   Prices — the price-intelligence room. Three tabs:
     1. Giá Group  — market price floor extracted from group sale posts,
                     grouped by product (low→high), with AI extraction.
     2. Sản phẩm   — store product catalog, compare the same item across shops.
     3. Kho của tôi — your own products (Google Sheet import) vs. the market.
   All lists use client-side windowing to stay smooth with thousands of rows.
   ------------------------------------------------------------------------- */

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;
type FlashFn = (kind: NonNullable<Toast>["kind"], text: string, ms?: number) => void;
type TabId = "group" | "catalog" | "mine";

interface GroupPricesResponse extends BgResponse {
  groupPrices?: GroupPriceRow[];
}
interface ProductsResponse extends BgResponse {
  products?: Product[];
}
interface GroupsResponse extends BgResponse {
  groups?: { groupId: string; name?: string }[];
}
interface SourcesResponse extends BgResponse {
  sources?: Source[];
}
interface ExtractionResponse extends BgResponse {
  processed?: number;
  inserted?: number;
  newKeywords?: number;
  // Số bài bộ trích cục bộ tự xử lý (0 token) vs. số bài phải nhờ AI.
  localPosts?: number;
  aiPosts?: number;
}

/* ---- Nhập kho từ Google Sheet -------------------------------------------- */

interface SheetTab {
  gid: string;
  name: string;
  category?: string;
}
interface SheetTabsResponse extends BgResponse {
  spreadsheetId?: string;
  tabs?: SheetTab[];
}
interface SheetTabResult {
  gid: string;
  name?: string;
  ok: boolean;
  count?: number;
  error?: string;
}
interface SheetImportResponse extends BgResponse {
  imported?: number;
  added?: number;
  updated?: number;
  deleted?: number;
  results?: SheetTabResult[];
}
interface SheetSyncSummary {
  ok: boolean;
  imported?: number;
  added?: number;
  updated?: number;
  deleted?: number;
  failedTabs?: number;
  error?: string;
}
interface SheetConfig {
  enabled: boolean;
  intervalHours: number;
  url: string;
  spreadsheetId: string;
  tabs: SheetTab[];
  prune: boolean;
  lastSyncAt: number;
  lastResult: SheetSyncSummary | null;
}
interface SheetConfigResponse extends BgResponse {
  config?: SheetConfig;
}

// Khớp SHEET_INTERVALS trong src/sheets.js — service worker sẽ ép về mốc hợp lệ.
const SHEET_INTERVALS = [1, 3, 6, 12, 24];

const TABS: { id: TabId; label: string; icon: typeof Tag }[] = [
  { id: "group", label: "Giá Group", icon: Tag },
  { id: "catalog", label: "Sản phẩm", icon: Store },
  { id: "mine", label: "Kho của tôi", icon: Boxes },
];

function timeAgo(ts?: number | string): string {
  if (ts == null || ts === "") return "";
  let t = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(t)) t = new Date(ts).getTime();
  if (!Number.isFinite(t) || t <= 0) return "";
  if (t < 1e12) t = t * 1000;
  const diff = Date.now() - t;
  if (diff < 60000) return "vừa xong";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} ngày trước`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} tháng trước`;
  return `${Math.floor(mo / 12)} năm trước`;
}

function Dot({ name }: { name: string }) {
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ background: colorFor(name) }}
    />
  );
}

function StoreBadge({ name }: { name: string }) {
  return (
    <span
      className="grid size-8 shrink-0 place-items-center rounded-md font-mono text-xs font-semibold text-ink"
      style={{ background: colorFor(name) }}
    >
      {initials(name)}
    </span>
  );
}

function EmptyState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line bg-surface px-6 py-14 text-center">
      <Inbox className="size-8 text-ink-faint" strokeWidth={1.5} />
      <p className="text-sm font-medium text-ink-soft">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-ink-faint">{desc}</p>
    </div>
  );
}

function ErrorState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-red-soft bg-red-soft/10 px-6 py-14 text-center">
      <AlertCircle className="size-8 text-red" strokeWidth={1.5} />
      <p className="text-sm font-medium text-ink-soft">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-ink-faint">{desc}</p>
    </div>
  );
}

function SentinelButton({
  hasMore,
  loadMore,
  shown,
  total,
  sentinelRef,
  className,
}: {
  hasMore: boolean;
  loadMore: () => void;
  shown: number;
  total: number;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  if (!hasMore) return null;
  return (
    <div ref={sentinelRef} className={cn("flex justify-center py-3", className)}>
      <button
        type="button"
        onClick={loadMore}
        className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-4 py-2 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
      >
        <Loader2 className="size-3.5 animate-spin text-accent" />
        Tải thêm ({shown}/{total})
      </button>
    </div>
  );
}

export function Prices() {
  const [tab, setTab] = useState<TabId>("group");
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);

  const flash: FlashFn = (kind, text, ms = 3200) => {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  return (
    <div className="relative mx-auto flex w-full max-w-[960px] flex-col gap-4">
      {/* Sub-nav — segmented control */}
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
        {TABS.map((t) => {
          const active = tab === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-accent-soft/40 text-accent-ink"
                  : "text-ink-faint hover:bg-surface-2 hover:text-ink-soft",
              )}
            >
              <Icon
                className={cn("size-4", active ? "text-accent" : "")}
                strokeWidth={active ? 2.25 : 1.75}
              />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "group" ? (
        <GroupPriceTab flash={flash} />
      ) : tab === "catalog" ? (
        <CatalogTab flash={flash} />
      ) : (
        <MyStoreTab flash={flash} />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 z-toast -translate-x-1/2 rounded-md border px-4 py-2.5 text-sm shadow-md",
            toast.kind === "ok" && "border-green-soft bg-green-soft/30 text-green",
            toast.kind === "err" && "border-red-soft bg-red-soft/30 text-red",
            toast.kind === "info" && "border-line bg-surface-2 text-ink-soft",
          )}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

/* ============================ TAB 1 — GIÁ GROUP ======================== */

function GroupPriceTab({ flash }: { flash: FlashFn }) {
  const [rows, setRows] = useState<GroupPriceRow[]>([]);
  const [groups, setGroups] = useState<{ groupId: string; name?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  // Filters
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [groupId, setGroupId] = useState("");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");

  // Gõ tới đâu lọc tới đó, nhưng chỉ tính lại sau 180ms để không refilter +
  // re-render toàn bộ danh sách trên từng ký tự.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const [gRes, pRes] = await Promise.all([
      bg<GroupsResponse>("GET_GROUPS"),
      bg<GroupPricesResponse>("GET_GROUP_PRICES", { filters: {} }),
    ]);
    setGroups((gRes && gRes.groups) || []);
    if (!pRes || !pRes.ok) {
      setLoadError(
        pRes?.error ||
          "Đăng nhập tài khoản web ở popup tiện ích để xem mặt bằng giá.",
      );
      setRows([]);
    } else {
      setRows(pRes.groupPrices || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function runExtraction() {
    setExtracting(true);
    flash("info", "Đang trích giá: đọc cục bộ trước, chỉ bài khó mới nhờ AI…", 5000);
    const res = await bg<ExtractionResponse>("RUN_GROUP_PRICE_EXTRACTION");
    setExtracting(false);
    if (res && res.ok) {
      const local = res.localPosts || 0;
      const ai = res.aiPosts || 0;
      flash(
        "ok",
        `Trích xong: ${res.processed || 0} bài (${local} tự đọc, ${ai} qua AI), thêm ${res.inserted || 0} dòng giá, học ${res.newKeywords || 0} từ khoá mới.`,
        5000,
      );
      await load();
    } else {
      flash("err", res?.error || "Trích giá thất bại.", 6000);
    }
  }

  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.category).filter(Boolean) as string[])].sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const pMin = priceMin.trim() ? Number(priceMin) : null;
    const pMax = priceMax.trim() ? Number(priceMax) : null;
    return filterRows(rows, {
      query: debouncedQuery,
      groupId,
      category,
      condition,
      priceMin: Number.isNaN(pMin as number) ? null : pMin,
      priceMax: Number.isNaN(pMax as number) ? null : pMax,
    });
  }, [rows, debouncedQuery, groupId, category, condition, priceMin, priceMax]);

  const productGroups = useMemo(() => groupByProduct(filtered), [filtered]);

  const { visible: windowed, sentinelRef, hasMore, loadMore, shown, total } =
    useIncremental(productGroups, { pageSize: 12 });

  const groupName = (gid?: string) => {
    const g = groups.find((x) => String(x.groupId) === String(gid));
    return g ? g.name || g.groupId : gid || "";
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">Mặt bằng giá trong nhóm</h2>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">
              Giá đã trích từ bài rao bán, gom theo sản phẩm để thấy dải giá
              thấp → cao.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              Làm mới
            </button>
            <button
              type="button"
              onClick={() => void runExtraction()}
              disabled={extracting}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
            >
              {extracting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              Trích xuất giá
            </button>
          </div>
        </div>

        {/* Search + filters */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm tên sản phẩm, người bán, mức giá…"
              aria-label="Tìm trong mặt bằng giá"
              className="w-full rounded-md border border-line bg-bg py-1.5 pl-8 pr-2.5 text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
            />
          </div>
          <select
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs text-ink focus:border-accent/60 focus-visible:outline-none"
          >
            <option value="">Tất cả nhóm</option>
            {groups.map((g) => (
              <option key={g.groupId} value={g.groupId}>
                {g.name || g.groupId}
              </option>
            ))}
          </select>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs text-ink focus:border-accent/60 focus-visible:outline-none"
          >
            <option value="">Tất cả loại</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs text-ink focus:border-accent/60 focus-visible:outline-none"
          >
            <option value="">Mọi tình trạng</option>
            <option value="mới">Mới</option>
            <option value="likenew">Like new</option>
            <option value="cũ">Cũ</option>
          </select>
          <input
            type="number"
            inputMode="numeric"
            value={priceMin}
            onChange={(e) => setPriceMin(e.target.value)}
            placeholder="Giá từ"
            className="w-24 rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
          />
          <input
            type="number"
            inputMode="numeric"
            value={priceMax}
            onChange={(e) => setPriceMax(e.target.value)}
            placeholder="đến"
            className="w-24 rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
          />
          {total > 0 && (
            <span className="ml-auto text-xs text-ink-faint">
              {shown < total ? `${shown}/${total}` : total} sản phẩm
            </span>
          )}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <ListSkeleton />
      ) : loadError ? (
        <ErrorState title="Cần đăng nhập" desc={loadError} />
      ) : productGroups.length === 0 ? (
        <EmptyState
          title="Chưa có dữ liệu giá"
          desc='Bấm "Trích xuất giá" để AI trích giá từ các bài rao bán đã crawl, hoặc đổi bộ lọc.'
        />
      ) : (
        <div className="flex flex-col gap-3">
          {windowed.map((g) => {
            const range =
              g.minPrice == null
                ? "—"
                : g.minPrice === g.maxPrice
                  ? fmtPrice(g.minPrice)
                  : `${fmtPrice(g.minPrice)} – ${fmtPrice(g.maxPrice)}`;
            return (
              <article
                key={g.key || g.name}
                className="overflow-hidden rounded-lg border border-line bg-surface"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-soft px-4 py-2.5">
                  <h3 className="text-sm font-semibold text-ink">
                    {g.name || "(không tên)"}
                  </h3>
                  <span className="rounded-sm bg-accent-soft/30 px-2 py-0.5 text-xs font-semibold text-accent-ink">
                    {range}
                  </span>
                  <span className="ml-auto rounded-sm bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-faint">
                    {g.rows.length} tin
                  </span>
                </div>
                <div className="divide-y divide-line-soft">
                  {g.rows.map((r, i) => {
                    const seller = r.sellerName || "Ẩn danh";
                    const profile = safeHttpUrl(r.sellerProfile);
                    const when = r.postedAt ? timeAgo(r.postedAt) : "";
                    const source =
                      r.groupId && r.postId
                        ? `https://www.facebook.com/groups/${r.groupId}/posts/${r.postId}/`
                        : "";
                    const cond = r.condition
                      ? COND_LABEL[r.condition] || r.condition
                      : "";
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-4 py-2.5"
                      >
                        <StoreBadge name={seller} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-ink">
                            {r.name || "(không tên)"}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
                            {profile ? (
                              <a
                                href={profile}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-ink-soft hover:text-accent"
                              >
                                {seller}
                              </a>
                            ) : (
                              <span>{seller}</span>
                            )}
                            <span>· {groupName(r.groupId)}</span>
                            {when && <span>· {when}</span>}
                            {cond && (
                              <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">
                                {cond}
                              </span>
                            )}
                            {r.warranty && (
                              <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">
                                BH: {r.warranty}
                              </span>
                            )}
                            {r.category && (
                              <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">
                                {r.category}
                              </span>
                            )}
                            {source && (
                              <a
                                href={source}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-0.5 text-accent hover:text-accent-bright"
                              >
                                Bài gốc <ExternalLink className="size-3" />
                              </a>
                            )}
                          </div>
                        </div>
                        <div className="shrink-0 font-mono text-sm font-semibold text-ink">
                          {fmtPrice(r.price)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </article>
            );
          })}
          <SentinelButton
            hasMore={hasMore}
            loadMore={loadMore}
            shown={shown}
            total={total}
            sentinelRef={sentinelRef}
          />
        </div>
      )}
    </div>
  );
}

/* ============================ TAB 2 — SẢN PHẨM ========================= */

type CatalogMode = "compare" | "list";

function CatalogTab({ flash }: { flash: FlashFn }) {
  const [all, setAll] = useState<Product[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<CatalogMode>("compare");
  const [confirmClear, setConfirmClear] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const [pRes, sRes] = await Promise.all([
      bg<ProductsResponse>("GET_PRODUCTS"),
      bg<SourcesResponse>("GET_SOURCES"),
    ]);
    setSources((sRes && sRes.sources) || []);
    if (!pRes || !pRes.ok) {
      setLoadError(pRes?.error || "Không nạp được kho sản phẩm.");
      setAll([]);
    } else {
      setAll(pRes.products || []);
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function clearAll() {
    setConfirmClear(false);
    const res = await bg<BgResponse & { deleted?: number }>("CLEAR_PRODUCTS", {});
    await load();
    flash("ok", `Đã xóa ${(res && res.deleted) || 0} sản phẩm.`);
  }

  // Filter to sellable + search terms.
  const products = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sellable = all.filter(isSellable);
    if (!q) return sellable;
    const terms = q.split(/\s+/).filter(Boolean);
    return sellable.filter((p) => {
      const hay = (
        (p.name || "") +
        " " +
        (p.category || "") +
        " " +
        canonCat(p.category) +
        " " +
        (p.brand || "")
      ).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [all, query]);

  const clusters = useMemo(() => clusterProducts(products), [products]);
  const multi = useMemo(() => clusters.filter((c) => c.storeCount >= 2), [clusters]);
  const breakdown = useMemo(() => sourceBreakdown(products), [products]);
  const single = clusters.length - multi.length;

  // Windowing: compare mode paginates clusters, list mode paginates products.
  const compareWin = useIncremental(multi, { pageSize: 16 });
  const listWin = useIncremental(products, { pageSize: 40 });

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm sản phẩm (tên / hãng / loại)…"
              className="w-full rounded-md border border-line bg-bg py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
            />
          </div>
          <div className="flex items-center gap-1 rounded-md border border-line bg-surface-2 p-0.5">
            <button
              type="button"
              onClick={() => setMode("compare")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors",
                mode === "compare"
                  ? "bg-accent text-on-accent"
                  : "text-ink-faint hover:text-ink",
              )}
            >
              <LayoutGrid className="size-3.5" />
              So giá
            </button>
            <button
              type="button"
              onClick={() => setMode("list")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-xs font-medium transition-colors",
                mode === "list"
                  ? "bg-accent text-on-accent"
                  : "text-ink-faint hover:text-ink",
              )}
            >
              <List className="size-3.5" />
              Danh sách
            </button>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Làm mới
          </button>
        </div>

        {mode === "compare" && products.length > 0 && (
          <p className="text-xs leading-relaxed text-ink-faint">
            Tổng {products.length} SP từ {breakdown.length} nguồn (
            {breakdown.map(([n, c]) => `${n}: ${c}`).join(" · ")}). Gom thành{" "}
            {clusters.length} sản phẩm, {multi.length} có ở từ 2 cửa hàng trở lên
            (đang hiển thị). {single} sản phẩm chỉ có 1 cửa hàng được ẩn — xem chế
            độ "Danh sách" để thấy tất cả.
          </p>
        )}
      </div>

      {loading ? (
        <ListSkeleton />
      ) : loadError ? (
        <ErrorState title="Lỗi tải dữ liệu" desc={loadError} />
      ) : products.length === 0 ? (
        <EmptyState
          title="Kho trống"
          desc="Đồng bộ một nguồn giá để nạp sản phẩm vào kho, hoặc đổi từ khoá tìm kiếm."
        />
      ) : mode === "compare" ? (
        multi.length === 0 ? (
          <EmptyState
            title="Chưa ghép được sản phẩm chung"
            desc="Không tìm thấy sản phẩm nào xuất hiện ở từ 2 cửa hàng trở lên để so giá. Hãy đồng bộ các nguồn cùng nhóm hàng rồi thử lại."
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {compareWin.visible.map((c) => {
              const offers = bestOffersPerStore(c.offers);
              const spread = shownSpread(offers);
              const sub = [c.brand, canonCat(c.category)].filter(Boolean).join(" · ");
              return (
                <article
                  key={c.sig}
                  className="flex flex-col rounded-lg border border-line bg-surface"
                >
                  <div className="border-b border-line-soft px-4 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold leading-snug text-ink">
                        {c.name || "(không tên)"}
                      </h3>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-medium text-ink-faint">
                        {c.storeCount} cửa hàng
                      </span>
                      {spread > 0 && (
                        <span className="rounded-sm bg-amber-soft/30 px-1.5 py-0.5 font-medium text-amber">
                          Chênh {fmtPrice(spread)}
                        </span>
                      )}
                      {sub && <span className="text-ink-faint">{sub}</span>}
                    </div>
                  </div>
                  <div className="divide-y divide-line-soft">
                    {offers.map((o, i) => {
                      const store = o.sourceName || o.source || "";
                      const href = resolveProductUrl(o, sources);
                      const best = i === 0 && offers.length > 1;
                      const extra = [
                        o.warranty ? `BH ${o.warranty}` : "",
                        o.condition || "",
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <div
                          key={o.productId || `${store}-${i}`}
                          className={cn(
                            "flex items-center gap-2 px-4 py-2",
                            best && "bg-green-soft/10",
                          )}
                        >
                          <Dot name={store} />
                          <span className="truncate text-xs text-ink-soft">
                            {store}
                          </span>
                          {best && (
                            <span className="rounded-sm bg-green-soft/30 px-1.5 py-0.5 text-[10px] font-semibold text-green">
                              Rẻ nhất
                            </span>
                          )}
                          {extra && (
                            <span className="truncate text-[11px] text-ink-faint">
                              {extra}
                            </span>
                          )}
                          <span className="ml-auto shrink-0 font-mono text-sm font-semibold text-ink">
                            {fmtPrice(o.price)}
                          </span>
                          {href && (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Mở trang gốc"
                              className="text-ink-faint hover:text-accent"
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
            <SentinelButton
              hasMore={compareWin.hasMore}
              loadMore={compareWin.loadMore}
              shown={compareWin.shown}
              total={compareWin.total}
              sentinelRef={compareWin.sentinelRef}
              className="md:col-span-2"
            />
          </div>
        )
      ) : (
        <div className="flex flex-col divide-y divide-line-soft overflow-hidden rounded-lg border border-line bg-surface">
          {listWin.visible.map((p, i) => {
            const store = p.sourceName || p.source || "";
            const href = resolveProductUrl(p, sources);
            const catLabel = canonCat(p.category);
            const extra = [p.warranty ? `BH ${p.warranty}` : "", p.condition || ""]
              .filter(Boolean)
              .join(" · ");
            return (
              <div
                key={p.productId || `${store}-${i}`}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <StoreBadge name={store} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-ink">
                    {p.name || "(không tên)"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-faint">
                    {store && (
                      <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-ink-soft">
                        {store}
                      </span>
                    )}
                    {p.brand && (
                      <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">
                        {p.brand}
                      </span>
                    )}
                    {catLabel && (
                      <span className="rounded-sm bg-surface-2 px-1.5 py-0.5">
                        {catLabel}
                      </span>
                    )}
                    {extra && <span>{extra}</span>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm font-semibold text-ink">
                    {fmtPrice(p.price)}
                  </div>
                  {p.buildPrice != null && p.buildPrice !== p.price && (
                    <div className="text-[11px] text-ink-faint">
                      Build: {fmtPrice(p.buildPrice)}
                    </div>
                  )}
                </div>
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-sm border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                  >
                    Xem <ExternalLink className="size-3" />
                  </a>
                )}
              </div>
            );
          })}
          <SentinelButton
            hasMore={listWin.hasMore}
            loadMore={listWin.loadMore}
            shown={listWin.shown}
            total={listWin.total}
            sentinelRef={listWin.sentinelRef}
          />
        </div>
      )}

      {/* Danger zone */}
      {all.length > 0 && (
        <div className="flex items-center justify-end">
          {confirmClear ? (
            <div className="flex items-center gap-2 rounded-md border border-red-soft bg-red-soft/20 px-3 py-2">
              <span className="text-xs text-ink-soft">
                Xóa toàn bộ {all.length} sản phẩm trong kho? Không hoàn tác được.
              </span>
              <button
                type="button"
                onClick={() => setConfirmClear(false)}
                className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-ink-faint hover:text-ink"
              >
                <X className="size-3.5" />
                Hủy
              </button>
              <button
                type="button"
                onClick={() => void clearAll()}
                className="inline-flex items-center gap-1.5 rounded-sm bg-red px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                <Trash2 className="size-3.5" />
                Xóa hết
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:border-red-soft hover:text-red"
            >
              <Trash2 className="size-3.5" />
              Xóa toàn bộ kho
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ================= NHẬP KHO TỪ GOOGLE SHEET (panel) ==================== */

/**
 * SheetImportPanel — đường vào duy nhất cho luồng nhập kho từ Google Sheet.
 *
 * Ba bước: dán link -> chọn tab -> nhập. Sau khi nhập, cấu hình (link + tab)
 * được LƯU lại nên có thể bật "tự động đồng bộ": service worker sẽ nhập lại
 * theo chu kỳ, nhờ đó sửa giá trên Sheet là kho tự cập nhật.
 */
function SheetImportPanel({
  flash,
  onImported,
}: {
  flash: FlashFn;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [spreadsheetId, setSpreadsheetId] = useState("");
  const [tabs, setTabs] = useState<SheetTab[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [listing, setListing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [cfg, setCfg] = useState<SheetConfig | null>(null);
  const [results, setResults] = useState<SheetTabResult[] | null>(null);

  // Nạp cấu hình đã lưu để hiển thị trạng thái tự động đồng bộ + prefill link.
  async function loadConfig() {
    const res = await bg<SheetConfigResponse>("GET_SHEET_CONFIG");
    if (res && res.ok && res.config) {
      setCfg(res.config);
      if (res.config.url) setUrl((u) => u || res.config!.url);
      if (res.config.spreadsheetId) {
        setSpreadsheetId((s) => s || res.config!.spreadsheetId);
      }
      if (res.config.tabs.length) {
        setPicked((p) => (p.size ? p : new Set(res.config!.tabs.map((t) => t.gid))));
      }
      // Đã lưu cấu hình -> mở panel để người dùng thấy ngay trạng thái.
      if (res.config.spreadsheetId) setOpen(true);
    }
  }

  useEffect(() => {
    void loadConfig();
  }, []);

  async function fetchTabs() {
    const link = url.trim();
    if (!link) {
      flash("err", "Hãy dán link Google Sheet trước.");
      return;
    }
    setListing(true);
    setResults(null);
    const res = await bg<SheetTabsResponse>("SHEET_TABS", { url: link });
    setListing(false);
    if (!res || !res.ok) {
      flash("err", res?.error || "Không đọc được Sheet.", 6000);
      return;
    }
    const list = res.tabs || [];
    setSpreadsheetId(res.spreadsheetId || "");
    setTabs(list);
    // Mặc định chọn hết: phần lớn người dùng muốn nhập cả bảng giá.
    setPicked(new Set(list.map((t) => t.gid)));
    flash("ok", `Tìm thấy ${list.length} tab.`);
  }

  function toggleTab(gid: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(gid)) next.delete(gid);
      else next.add(gid);
      return next;
    });
  }

  const selected = useMemo(
    () => tabs.filter((t) => picked.has(t.gid)),
    [tabs, picked],
  );

  async function runImport() {
    if (!spreadsheetId) {
      flash("err", "Chưa có Sheet nào được đọc.");
      return;
    }
    if (!selected.length) {
      flash("err", "Hãy chọn ít nhất một tab.");
      return;
    }
    setImporting(true);
    setResults(null);
    const res = await bg<SheetImportResponse>("IMPORT_SHEET", {
      spreadsheetId,
      tabs: selected,
    });
    setImporting(false);
    if (!res || !res.ok) {
      flash("err", res?.error || "Nhập kho thất bại.", 6000);
      return;
    }
    setResults(res.results || null);
    // Lưu lại link + tab để có thể bật tự động đồng bộ mà không phải chọn lại.
    const saved = await bg<SheetConfigResponse>("SET_SHEET_CONFIG", {
      config: { url: url.trim(), spreadsheetId, tabs: selected },
    });
    if (saved && saved.ok && saved.config) setCfg(saved.config);
    flash(
      "ok",
      `Đã nhập ${res.imported || 0} dòng · thêm ${res.added || 0} · cập nhật ${
        res.updated || 0
      }.`,
      5000,
    );
    onImported();
  }

  async function patchConfig(patch: Record<string, unknown>) {
    const res = await bg<SheetConfigResponse>("SET_SHEET_CONFIG", { config: patch });
    if (!res || !res.ok) {
      flash("err", res?.error || "Không lưu được cấu hình.", 6000);
      return;
    }
    if (res.config) setCfg(res.config);
  }

  async function toggleAuto(next: boolean) {
    if (next && !(cfg?.spreadsheetId || spreadsheetId)) {
      flash("err", "Hãy nhập kho một lần trước để lưu link Sheet.");
      return;
    }
    await patchConfig({ enabled: next });
    flash(
      next ? "ok" : "info",
      next ? "Đã bật tự động đồng bộ theo chu kỳ." : "Đã tắt tự động đồng bộ.",
    );
  }

  async function syncNow() {
    setSyncing(true);
    const res = await bg<SheetImportResponse & SheetConfigResponse>("SYNC_SHEET_NOW");
    setSyncing(false);
    if (!res || !res.ok) {
      flash("err", res?.error || "Đồng bộ thất bại.", 6000);
      if (res && res.config) setCfg(res.config);
      return;
    }
    if (res.config) setCfg(res.config);
    flash(
      "ok",
      `Đồng bộ xong: ${res.imported || 0} dòng · thêm ${res.added || 0} · cập nhật ${
        res.updated || 0
      } · xóa ${res.deleted || 0}.`,
      5000,
    );
    onImported();
  }

  const hasSaved = !!cfg?.spreadsheetId;

  return (
    <div className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left"
      >
        <FileSpreadsheet className="size-4 shrink-0 text-accent" strokeWidth={2} />
        <span className="text-sm font-medium text-ink">Nhập kho từ Google Sheet</span>
        {hasSaved && (
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 text-xs font-medium",
              cfg?.enabled
                ? "bg-green-soft/30 text-green"
                : "bg-surface-2 text-ink-faint",
            )}
          >
            {cfg?.enabled ? `Tự động ${cfg.intervalHours}h` : "Tự động: tắt"}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-ink-faint transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-line-soft px-4 py-3.5">
          {/* Bước 1 — link */}
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="sheet-url"
              className="text-xs font-medium text-ink-soft"
            >
              Link Google Sheet (chia sẻ "Bất kỳ ai có liên kết → Người xem")
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="sheet-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                className="min-w-[240px] flex-1 rounded-md border border-line bg-bg px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
              />
              <button
                type="button"
                onClick={() => void fetchTabs()}
                disabled={listing}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
              >
                {listing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Search className="size-3.5" />
                )}
                Đọc tab
              </button>
            </div>
          </div>

          {/* Bước 2 — chọn tab */}
          {tabs.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-ink-soft">
                  Chọn tab để nhập ({picked.size}/{tabs.length})
                </span>
                <button
                  type="button"
                  onClick={() => setPicked(new Set(tabs.map((t) => t.gid)))}
                  className="rounded-sm px-1.5 py-0.5 text-xs text-ink-faint hover:text-accent"
                >
                  Chọn hết
                </button>
                <button
                  type="button"
                  onClick={() => setPicked(new Set())}
                  className="rounded-sm px-1.5 py-0.5 text-xs text-ink-faint hover:text-accent"
                >
                  Bỏ chọn
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tabs.map((t) => {
                  const on = picked.has(t.gid);
                  return (
                    <button
                      key={t.gid}
                      type="button"
                      onClick={() => toggleTab(t.gid)}
                      aria-pressed={on}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                        on
                          ? "bg-accent text-on-accent"
                          : "bg-surface-2 text-ink-faint hover:text-ink",
                      )}
                    >
                      {on && <CheckCircle2 className="size-3" />}
                      {t.name || `Tab ${t.gid}`}
                    </button>
                  );
                })}
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => void runImport()}
                  disabled={importing || !picked.size}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-semibold text-on-accent transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {importing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  Nhập {picked.size} tab vào kho
                </button>
              </div>
            </div>
          )}

          {/* Kết quả từng tab */}
          {results && results.length > 0 && (
            <div className="flex flex-col gap-1 rounded-md border border-line-soft bg-surface-2 p-2.5">
              {results.map((r) => (
                <div
                  key={r.gid}
                  className="flex items-center gap-2 text-xs"
                >
                  {r.ok ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-green" />
                  ) : (
                    <AlertCircle className="size-3.5 shrink-0 text-red" />
                  )}
                  <span className="truncate text-ink-soft">
                    {r.name || `Tab ${r.gid}`}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-ink-faint">
                    {r.ok ? `${r.count || 0} dòng` : r.error || "lỗi"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Bước 3 — tự động đồng bộ */}
          <div className="flex flex-col gap-2.5 border-t border-line-soft pt-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-ink-soft">
                <input
                  type="checkbox"
                  checked={!!cfg?.enabled}
                  onChange={(e) => void toggleAuto(e.target.checked)}
                  className="size-3.5 accent-[var(--accent)]"
                />
                Tự động đồng bộ lại từ Sheet
              </label>
              <select
                value={cfg?.intervalHours ?? 6}
                onChange={(e) =>
                  void patchConfig({ intervalHours: Number(e.target.value) })
                }
                disabled={!hasSaved}
                className="rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink focus:border-accent/60 focus-visible:outline-none disabled:opacity-60"
                aria-label="Chu kỳ đồng bộ"
              >
                {SHEET_INTERVALS.map((h) => (
                  <option key={h} value={h}>
                    mỗi {h} giờ
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void syncNow()}
                disabled={syncing || !hasSaved}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
              >
                <RefreshCw className={cn("size-3.5", syncing && "animate-spin")} />
                Đồng bộ ngay
              </button>
            </div>

            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-faint">
              <input
                type="checkbox"
                checked={cfg?.prune !== false}
                onChange={(e) => void patchConfig({ prune: e.target.checked })}
                disabled={!hasSaved}
                className="size-3.5 accent-[var(--accent)]"
              />
              Xóa khỏi kho những dòng đã bị xóa trong Sheet
            </label>

            {cfg?.lastSyncAt ? (
              <p className="flex items-center gap-1.5 text-xs text-ink-faint">
                <Clock className="size-3.5" />
                Đồng bộ lần cuối {timeAgo(cfg.lastSyncAt)}
                {cfg.lastResult
                  ? cfg.lastResult.ok
                    ? ` · ${cfg.lastResult.imported || 0} dòng, xóa ${
                        cfg.lastResult.deleted || 0
                      }`
                    : ` · lỗi: ${cfg.lastResult.error || "không rõ"}`
                  : ""}
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-ink-faint">
                Google Sheet không tự thông báo khi có thay đổi, nên kho được làm
                mới theo chu kỳ bạn chọn ở trên (hoặc bấm "Đồng bộ ngay").
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ============================ TAB 3 — KHO CỦA TÔI ====================== */

function MyStoreTab({ flash }: { flash: FlashFn }) {
  const [all, setAll] = useState<Product[]>([]);
  const [excelImporting, setExcelImporting] = useState(false);
  const [excelSummary, setExcelSummary] = useState<ExcelImportSummary | null>(null);
  const [stockFilter, setStockFilter] = useState<"all" | "in" | "out">("all");
  const [priceFilter, setPriceFilter] = useState<"all" | "priced" | "missing">("all");
  const [warrantyFilter, setWarrantyFilter] = useState<WarrantyFilter>("all");
  const [sortMode, setSortMode] = useState<"name" | "priceAsc" | "priceDesc" | "stockAsc">("name");
  const [market, setMarket] = useState<Product[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const [pRes, sRes] = await Promise.all([
      bg<ProductsResponse>("GET_PRODUCTS"),
      bg<SourcesResponse>("GET_SOURCES"),
    ]);
    setSources((sRes && sRes.sources) || []);
    if (!pRes || !pRes.ok) {
      setLoadError(pRes?.error || "Không nạp được kho của bạn.");
      setAll([]);
      setMarket([]);
    } else {
      const products = pRes.products || [];
      setAll(products.filter((p) => p.owned || p.source === "mystore"));
      setMarket(products.filter((p) => !(p.owned || p.source === "mystore")));
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function importExcel(file: File) {
    setExcelImporting(true);
    setExcelSummary(null);
    try {
      const parsed = await parseExcelFile(file);
      const response = await bg<BgResponse>("IMPORT_PRODUCTS", {
        products: parsed.products,
        prune: false,
      });
      if (!response.ok) throw new Error(response.error || "Không nhập được file Excel.");
      setExcelSummary(parsed.summary);
      flash("ok", `Đã nhập ${parsed.summary.imported} sản phẩm từ ${parsed.summary.sheetName}.`);
      await load();
    } catch (error) {
      flash("err", String(error instanceof Error ? error.message : error));
    } finally {
      setExcelImporting(false);
    }
  }

  const groups = useMemo(() => productGroupOptions(all), [all]);

  const products = useMemo(() => {
    const terms = queryTokens(query);
    let list = all.filter((p) => {
      if (!productMatchesGroup(p, cat)) return false;
      const qty = p.qty == null ? null : Number(p.qty);
      if (stockFilter === "in" && qty != null && qty <= 0) return false;
      if (stockFilter === "out" && (qty == null || qty > 0)) return false;
      if (priceFilter === "priced" && (p.price == null || Number(p.price) <= 0)) return false;
      if (priceFilter === "missing" && p.price != null && Number(p.price) > 0) return false;
      if (!productMatchesWarranty(p, warrantyFilter)) return false;
      if (terms.length) {
        const hay = searchNorm([
          p.name,
          p.category,
          p.itemType,
          p.brand,
          p.sku,
          p.barcode,
          p.warranty,
          p.description,
        ].filter(Boolean).join(" "));
        if (!terms.every((term) => hay.includes(term))) return false;
      }
      return true;
    });
    return [...list].sort((a, b) => {
      if (sortMode === "priceAsc" || sortMode === "priceDesc") {
        const av = Number(a.price); const bv = Number(b.price);
        const aa = Number.isFinite(av) ? av : sortMode === "priceAsc" ? Infinity : -Infinity;
        const bb = Number.isFinite(bv) ? bv : sortMode === "priceAsc" ? Infinity : -Infinity;
        return sortMode === "priceAsc" ? aa - bb : bb - aa;
      }
      if (sortMode === "stockAsc") return (Number(a.qty) || 0) - (Number(b.qty) || 0);
      return String(a.name || "").localeCompare(String(b.name || ""), "vi");
    });
  }, [all, cat, priceFilter, query, sortMode, stockFilter, warrantyFilter]);

  const { visible: windowed, sentinelRef, hasMore, loadMore, shown, total } =
    useIncremental(products, { pageSize: 24 });

  const priced = all.filter((p) => p.price != null).length;

  return (
    <div className="flex flex-col gap-4">
      {/* Nhập / đồng bộ từ Google Sheet và Excel */}
      <SheetImportPanel flash={flash} onImported={() => void load()} />
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-ink">
              <FileSpreadsheet className="size-4 text-accent" /> Nhập kho từ Excel
            </div>
            <p className="mt-1 text-xs text-ink-faint">Tự nhận diện các cột mã hàng, tên hàng, nhóm hàng, giá bán, giá vốn, tồn kho và bảo hành.</p>
          </div>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-xs font-semibold text-on-accent hover:opacity-90">
            {excelImporting ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
            {excelImporting ? "Đang đọc…" : "Chọn file Excel"}
            <input type="file" accept=".xlsx,.xls" className="hidden" disabled={excelImporting} onChange={(e) => { const file = e.target.files?.[0]; if (file) void importExcel(file); e.currentTarget.value = ""; }} />
          </label>
        </div>
        {excelSummary && <p className="text-xs text-ink-faint">{excelSummary.imported} dòng đã nhập · {excelSummary.skipped} dòng bỏ qua{excelSummary.warnings.length ? ` · ${excelSummary.warnings.join(" ")}` : ""}</p>}
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm tên, mã hàng, nhóm hàng, bảo hành…"
              className="w-full rounded-md border border-line bg-bg py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
          >
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Làm mới
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
          <SlidersHorizontal className="size-3.5 text-ink-faint" />
          <select value={stockFilter} onChange={(e) => setStockFilter(e.target.value as typeof stockFilter)} className="rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink" aria-label="Lọc tồn kho">
            <option value="all">Tất cả tồn kho</option><option value="in">Còn hàng</option><option value="out">Hết hàng</option>
          </select>
          <select value={priceFilter} onChange={(e) => setPriceFilter(e.target.value as typeof priceFilter)} className="rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink" aria-label="Lọc giá">
            <option value="all">Tất cả giá</option><option value="priced">Đã có giá</option><option value="missing">Thiếu giá</option>
          </select>
          <select value={warrantyFilter} onChange={(e) => setWarrantyFilter(e.target.value as WarrantyFilter)} className="rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink" aria-label="Lọc bảo hành">
            <option value="all">Tất cả bảo hành</option><option value="has">Có bảo hành</option><option value="none">Không bảo hành</option><option value="upTo3">Tối đa 3 tháng</option><option value="4To12">4–12 tháng</option><option value="over12">Trên 12 tháng</option>
          </select>
          <select value={sortMode} onChange={(e) => setSortMode(e.target.value as typeof sortMode)} className="rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink" aria-label="Sắp xếp kho">
            <option value="name">Tên A → Z</option><option value="priceAsc">Giá thấp → cao</option><option value="priceDesc">Giá cao → thấp</option><option value="stockAsc">Tồn kho thấp → cao</option>
          </select>
        </div>

        {groups.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
            <span className="text-xs font-medium text-ink-soft">Nhóm hàng</span>
            <select value={cat} onChange={(e) => setCat(e.target.value)} className="min-w-[240px] max-w-full rounded-md border border-line bg-bg px-2 py-1.5 text-xs text-ink" aria-label="Lọc nhóm hàng">
              <option value="">Tất cả nhóm hàng ({all.length})</option>
              {groups.map((group) => (
                <option key={group.value} value={group.value}>
                  {`${group.depth > 1 ? "↳ " : ""}${group.label} (${group.count})`}
                </option>
              ))}
            </select>
            {cat && <span className="rounded-sm bg-accent-soft/30 px-2 py-1 text-xs text-accent-ink">Đang lọc: {groupLabel(cat)}</span>}
          </div>
        )}

        {all.length > 0 && (
          <p className="text-xs leading-relaxed text-ink-faint">
            {all.length} sản phẩm · {priced} có giá
            {total < all.length ? ` · đang lọc ${total}` : ""}. Bấm "So giá thị
            trường" trên từng sản phẩm để đối chiếu với các cửa hàng khác.
          </p>
        )}
      </div>

      {loading ? (
        <ListSkeleton />
      ) : loadError ? (
        <ErrorState title="Lỗi tải dữ liệu" desc={loadError} />
      ) : all.length === 0 ? (
        <EmptyState
          title="Chưa có sản phẩm"
          desc="Nhập file Excel hoặc dán link Google Sheet ở các khung phía trên để bắt đầu."
        />
      ) : products.length === 0 ? (
        <EmptyState
          title="Không có sản phẩm"
          desc="Thử đổi bộ lọc hoặc từ khoá tìm kiếm."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {windowed.map((p) => {
            const catLabel = groupLabel(p.category) || canonCat(p.category);
            const isOpen = expanded === p.productId;
            const offers = isOpen ? marketMatches(p, market) : [];
            return (
              <article
                key={p.productId}
                className="flex flex-col rounded-lg border border-line bg-surface p-3.5"
              >
                <div className="text-sm font-medium leading-snug text-ink">
                  {p.name || "(không tên)"}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                  {catLabel && (
                    <span className="rounded-sm bg-accent-soft/30 px-1.5 py-0.5 font-medium text-accent-ink">
                      {catLabel}
                    </span>
                  )}
                  {p.brand && (
                    <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-ink-faint">
                      {p.brand}
                    </span>
                  )}
                  {p.warranty && (
                    <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-ink-faint">
                      BH {p.warranty}
                    </span>
                  )}
                  {p.qty != null && (
                    <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 text-ink-faint">
                      SL {String(p.qty)}
                    </span>
                  )}
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "font-mono text-sm font-semibold",
                      p.price != null ? "text-ink" : "text-ink-faint",
                    )}
                  >
                    {p.price != null ? fmtPrice(p.price) : "Chưa có giá"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setExpanded(isOpen ? null : p.productId || null)
                    }
                    className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                  >
                    <Store className="size-3.5" />
                    {isOpen ? "Thu gọn" : "So giá thị trường"}
                  </button>
                </div>

                {isOpen && (
                  <div className="mt-2.5 border-t border-line-soft pt-2.5">
                    {offers.length === 0 ? (
                      <p className="text-xs leading-relaxed text-ink-faint">
                        Chưa tìm thấy sản phẩm tương ứng ở các cửa hàng khác. Hãy
                        đồng bộ nguồn cùng loại rồi thử lại.
                      </p>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {offers.map((o, i) => {
                          const store = o.sourceName || o.source || "";
                          const href = resolveProductUrl(o, sources);
                          return (
                            <div
                              key={o.productId || `${store}-${i}`}
                              className={cn(
                                "flex items-center gap-2 rounded-sm px-1.5 py-1 text-xs",
                                i === 0 && "bg-green-soft/15",
                              )}
                            >
                              <Dot name={store} />
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="truncate text-ink-soft hover:text-accent"
                                >
                                  {store}
                                </a>
                              ) : (
                                <span className="truncate text-ink-soft">
                                  {store}
                                </span>
                              )}
                              <span className="ml-auto shrink-0 font-mono font-semibold text-ink">
                                {fmtPrice(o.price)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
          <SentinelButton
            hasMore={hasMore}
            loadMore={loadMore}
            shown={shown}
            total={total}
            sentinelRef={sentinelRef}
            className="sm:col-span-2"
          />
        </div>
      )}
    </div>
  );
}

/* ============================ SKELETON ================================= */

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-lg border border-line bg-surface"
        />
      ))}
    </div>
  );
}
