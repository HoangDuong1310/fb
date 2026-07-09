import { useEffect, useMemo, useRef, useState } from "react";
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
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { colorFor, initials } from "@/lib/avatar";
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
}

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
        <MyStoreTab />
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
  const [groupId, setGroupId] = useState("");
  const [category, setCategory] = useState("");
  const [condition, setCondition] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");

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
    flash("info", "Đang trích giá từ bài đã crawl bằng AI…", 5000);
    const res = await bg<ExtractionResponse>("RUN_GROUP_PRICE_EXTRACTION");
    setExtracting(false);
    if (res && res.ok) {
      flash(
        "ok",
        `Trích xong: xử lý ${res.processed || 0} bài, thêm ${res.inserted || 0} dòng giá, học ${res.newKeywords || 0} từ khoá mới.`,
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
      groupId,
      category,
      condition,
      priceMin: Number.isNaN(pMin as number) ? null : pMin,
      priceMax: Number.isNaN(pMax as number) ? null : pMax,
    });
  }, [rows, groupId, category, condition, priceMin, priceMax]);

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

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
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

/* ============================ TAB 3 — KHO CỦA TÔI ====================== */

function MyStoreTab() {
  const [all, setAll] = useState<Product[]>([]);
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

  const cats = useMemo(
    () => [...new Set(all.map((p) => canonCat(p.category)).filter(Boolean))].sort(),
    [all],
  );

  const products = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = all;
    if (cat) list = list.filter((p) => canonCat(p.category) === cat);
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      list = list.filter((p) => {
        const hay = (
          (p.name || "") +
          " " +
          (p.category || "") +
          " " +
          (p.brand || "")
        ).toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    return list;
  }, [all, cat, query]);

  const { visible: windowed, sentinelRef, hasMore, loadMore, shown, total } =
    useIncremental(products, { pageSize: 24 });

  const priced = all.filter((p) => p.price != null).length;

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
              placeholder="Tìm trong kho của tôi…"
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

        {/* Category chips */}
        {cats.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setCat("")}
              className={cn(
                "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                cat === ""
                  ? "bg-accent text-on-accent"
                  : "bg-surface-2 text-ink-faint hover:text-ink",
              )}
            >
              Tất cả
            </button>
            {cats.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCat(c)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                  cat === c
                    ? "bg-accent text-on-accent"
                    : "bg-surface-2 text-ink-faint hover:text-ink",
                )}
              >
                {c}
              </button>
            ))}
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
          desc="Nhập kho từ Google Sheet (ở dashboard cũ) để bắt đầu, hoặc đồng bộ nguồn giá."
        />
      ) : products.length === 0 ? (
        <EmptyState
          title="Không có sản phẩm"
          desc="Thử đổi bộ lọc hoặc từ khoá tìm kiếm."
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {windowed.map((p) => {
            const catLabel = canonCat(p.category);
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
