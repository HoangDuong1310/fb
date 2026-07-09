import { useEffect, useRef, useState } from "react";
import {
  Tag,
  ShoppingCart,
  LifeBuoy,
  Lightbulb,
  Plus,
  Trash2,
  Check,
  X,
  Sparkles,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------
   Keywords view — the self-learning heart of Lọc thông minh.

   Two sections, mirrored from the (now dead) src/dashboard/views/keywords.js:
   1. "Từ khóa" — learned_keywords the smart filter uses, split into three
      groups (sell / buy / support). The user adds/toggles/deletes here; AI
      also self-learns and marks rows "mới bởi AI".
   2. "Đề xuất" — keyword_candidates mined from classified posts. The user
      approves (promote → learned_keywords) or rejects them. This is the
      TEACHER loop: over time fewer posts need AI as the filter enriches.

   CRITICAL: bg() spreads { type, ...payload }. Never put a "type" key in a
   payload — the keyword group is passed as "kwType" instead.
   ------------------------------------------------------------------------- */

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;
type FlashFn = (
  kind: NonNullable<Toast>["kind"],
  text: string,
  ms?: number,
) => void;

type SectionId = "keywords" | "candidates";
type KwType = "sell" | "buy" | "support";

interface Keyword {
  id: string | number;
  keyword: string;
  type?: string;
  addedBy?: string;
  enabled?: boolean | number;
  createdAt?: number | string;
}

interface Candidate {
  id: string | number;
  phrase: string;
  label?: string;
  source?: string;
  ratio?: number | null;
  cnt?: number | null;
  example?: string;
  status?: string;
  createdAt?: number | string;
}

interface KeywordsResponse extends BgResponse {
  keywords?: Keyword[];
}

interface CandidatesResponse extends BgResponse {
  candidates?: Candidate[];
}

/* Nhãn nguồn từ khóa sang tiếng Việt. */
const ADDED_BY_LABEL: Record<string, string> = {
  ai: "AI",
  user: "Tôi",
  me: "Tôi",
  system: "Hệ thống",
};

/* Nhãn nhóm cho đề xuất (label lead) sang tiếng Việt. */
const CAND_LABEL: Record<string, string> = {
  buy: "Cần mua",
  support: "Cần hỗ trợ",
  seller: "Người bán",
  other: "Khác",
};

/* Nguồn đề xuất: mine = đào từ bài đã gán nhãn; ai = do AI gợi ý. */
const CAND_SOURCE: Record<string, string> = {
  mine: "Tự đào",
  ai: "AI gợi ý",
};

/* Gợi ý theo từng nhóm để người dùng hiểu nhóm dùng vào việc gì. */
const KW_HINTS: Record<KwType, string> = {
  sell: 'Từ khóa "bán" dùng ở phễu trích giá group VÀ để loại NGƯỜI BÁN khỏi Lọc thông minh. AI có thể tự học thêm (gắn nhãn "mới bởi AI"); bạn có thể bật/tắt hoặc xóa.',
  buy: 'Từ khóa "Cần mua" giúp Lọc thông minh nhận diện KHÁCH CÓ NHU CẦU MUA. Thêm/bật/tắt để tinh chỉnh bộ lọc bài viết.',
  support:
    'Từ khóa "Cần hỗ trợ" giúp Lọc thông minh nhận diện người HỎI KỸ THUẬT / GẶP SỰ CỐ. Thêm/bật/tắt để tinh chỉnh bộ lọc bài viết.',
};

const KW_TYPE_TABS: { id: KwType; label: string; icon: typeof Tag }[] = [
  { id: "sell", label: "Bán", icon: Tag },
  { id: "buy", label: "Cần mua", icon: ShoppingCart },
  { id: "support", label: "Cần hỗ trợ", icon: LifeBuoy },
];

function timeAgo(ts?: number | string): string {
  if (ts == null || ts === "") return "";
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 0) return "vừa xong";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "vừa xong";
  if (min < 60) return `${min} phút trước`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} giờ trước`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} ngày trước`;
  return new Date(t).toLocaleDateString("vi-VN");
}

export function Keywords() {
  const [section, setSection] = useState<SectionId>("keywords");
  const [candCount, setCandCount] = useState(0);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);

  const flash: FlashFn = (kind, text, ms = 3200) => {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  async function refreshCandCount() {
    const res = await bg<CandidatesResponse>("GET_KEYWORD_CANDIDATES", {
      status: "pending",
    });
    const n =
      res.ok && Array.isArray(res.candidates) ? res.candidates.length : 0;
    setCandCount(n);
  }

  useEffect(() => {
    refreshCandCount();
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const TABS: {
    id: SectionId;
    label: string;
    icon: typeof Tag;
    badge?: number;
  }[] = [
    { id: "keywords", label: "Từ khóa", icon: Tag },
    { id: "candidates", label: "Đề xuất", icon: Lightbulb, badge: candCount },
  ];

  return (
    <div className="relative mx-auto flex w-full max-w-[860px] flex-col gap-4">
      {/* Section switch — segmented control */}
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
        {TABS.map((t) => {
          const active = section === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSection(t.id)}
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
              {t.badge != null && t.badge > 0 && (
                <span className="ml-0.5 grid min-w-[18px] place-items-center rounded-full bg-amber-soft px-1.5 text-xs font-semibold text-amber">
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {section === "keywords" ? (
        <KeywordsTab flash={flash} />
      ) : (
        <CandidatesTab
          flash={flash}
          onCountChange={setCandCount}
        />
      )}

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 z-toast -translate-x-1/2 rounded-md border px-4 py-2.5 text-sm shadow-md",
            toast.kind === "ok" &&
              "border-green-soft bg-green-soft/30 text-green",
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

/* ========================= SECTION 1 — TỪ KHÓA ========================= */
function KeywordsTab({ flash }: { flash: FlashFn }) {
  const [kwType, setKwType] = useState<KwType>("sell");
  const [list, setList] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newWord, setNewWord] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | number | null>(
    null,
  );

  async function load() {
    setLoading(true);
    setLoadError(null);
    const res = await bg<KeywordsResponse>("GET_KEYWORDS", { kwType });
    if (!res.ok) {
      setLoadError(
        res.error ||
          "Đăng nhập tài khoản web ở popup tiện ích để xem từ khóa đã học.",
      );
      setList([]);
      setLoading(false);
      return;
    }
    setList(Array.isArray(res.keywords) ? res.keywords : []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kwType]);

  async function addKeyword() {
    const word = newWord.trim();
    if (!word) {
      flash("err", "Nhập từ khóa trước đã.", 2500);
      return;
    }
    setAdding(true);
    const res = await bg("ADD_KEYWORD", {
      keyword: word,
      kwType,
      enabled: true,
    });
    setAdding(false);
    if (res.ok) {
      setNewWord("");
      flash("ok", "Đã thêm từ khóa.", 2000);
      load();
    } else {
      flash("err", res.error || "Thêm từ khóa thất bại.", 5000);
    }
  }

  async function toggleKeyword(k: Keyword) {
    const id = k.id;
    const next = k.enabled ? 0 : 1;
    // Optimistic flip.
    setList((rows) =>
      rows.map((r) => (r.id === id ? { ...r, enabled: next } : r)),
    );
    const res = await bg("UPDATE_KEYWORD", {
      id,
      patch: { enabled: next },
    });
    if (!res.ok) {
      flash("err", res.error || "Cập nhật thất bại.", 5000);
      load();
    }
  }

  async function deleteKeyword(id: string | number) {
    setBusy((b) => ({ ...b, [id]: true }));
    const res = await bg("DELETE_KEYWORD", { id });
    setBusy((b) => ({ ...b, [id]: false }));
    setConfirmDeleteId(null);
    if (res.ok) {
      flash("ok", "Đã xóa từ khóa.", 2000);
      setList((rows) => rows.filter((r) => r.id !== id));
    } else {
      flash("err", res.error || "Xóa thất bại.", 5000);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Group sub-tabs */}
      <div className="flex items-center gap-1 rounded-lg border border-line bg-surface p-1">
        {KW_TYPE_TABS.map((t) => {
          const active = kwType === t.id;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setKwType(t.id)}
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
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

      {/* Hint */}
      <p className="rounded-md border border-line bg-surface-2/60 px-3 py-2 text-xs leading-snug text-ink-faint">
        {KW_HINTS[kwType]}
      </p>

      {/* Add form */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={newWord}
          onChange={(e) => setNewWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addKeyword();
          }}
          placeholder="Thêm từ khóa mới…"
          className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
        />
        <button
          type="button"
          onClick={addKeyword}
          disabled={adding}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-60"
        >
          <Plus className="size-4" strokeWidth={2.25} />
          Thêm
        </button>
      </div>

      {/* List */}
      {loading ? (
        <ListSkeleton />
      ) : loadError ? (
        <EmptyState title="Cần đăng nhập" desc={loadError} />
      ) : list.length === 0 ? (
        <EmptyState
          title="Chưa có từ khóa"
          desc='Thêm từ khóa thủ công, hoặc để AI tự học khi bạn phân loại bài viết.'
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {list.map((k) => {
            const byAI = k.addedBy === "ai";
            const source =
              ADDED_BY_LABEL[k.addedBy || ""] || k.addedBy || "Tôi";
            const enabled = !!k.enabled;
            const confirming = confirmDeleteId === k.id;
            return (
              <article
                key={k.id}
                className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink">
                      {k.keyword}
                    </span>
                    {byAI && (
                      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent-soft bg-accent-soft/30 px-2 py-0.5 text-xs font-medium text-accent-ink">
                        <Sparkles className="size-3" />
                        mới bởi AI
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-faint">
                    <span>{source}</span>
                    {k.createdAt ? (
                      <>
                        <span>·</span>
                        <span>{timeAgo(k.createdAt)}</span>
                      </>
                    ) : null}
                  </div>
                </div>

                {/* Enable toggle */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  onClick={() => toggleKeyword(k)}
                  title={enabled ? "Đang bật — bấm để tắt" : "Đang tắt — bấm để bật"}
                  className={cn(
                    "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                    enabled ? "bg-accent" : "bg-line",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
                      enabled ? "translate-x-[18px]" : "translate-x-0.5",
                    )}
                  />
                </button>

                {/* Delete */}
                {confirming ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => deleteKeyword(k.id)}
                      disabled={!!busy[k.id]}
                      className="rounded-md bg-red px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red/90 disabled:opacity-60"
                    >
                      Xóa
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-md border border-line px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2"
                    >
                      Hủy
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteId(k.id)}
                    title="Xóa từ khóa"
                    className="shrink-0 rounded-md p-1.5 text-ink-faint transition-colors hover:bg-red-soft/30 hover:text-red"
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ========================= SECTION 2 — ĐỀ XUẤT ========================= */
function CandidatesTab({
  flash,
  onCountChange,
}: {
  flash: FlashFn;
  onCountChange: (n: number) => void;
}) {
  const [list, setList] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    setLoadError(null);
    const res = await bg<CandidatesResponse>("GET_KEYWORD_CANDIDATES", {
      status: "pending",
    });
    if (!res.ok) {
      setLoadError(
        res.error ||
          "Đăng nhập tài khoản web ở popup tiện ích để xem đề xuất.",
      );
      setList([]);
      setLoading(false);
      return;
    }
    const cands = Array.isArray(res.candidates) ? res.candidates : [];
    setList(cands);
    onCountChange(cands.length);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function removeLocal(id: string | number) {
    setList((rows) => {
      const next = rows.filter((c) => String(c.id) !== String(id));
      onCountChange(next.length);
      return next;
    });
  }

  async function approve(id: string | number) {
    setBusy((b) => ({ ...b, [id]: true }));
    const res = await bg("SET_CANDIDATE_STATUS", { id, status: "approved" });
    setBusy((b) => ({ ...b, [id]: false }));
    if (res.ok) {
      flash("ok", "Đã duyệt: cụm từ giờ là từ khóa thật.", 2500);
      removeLocal(id);
    } else {
      flash("err", res.error || "Duyệt thất bại.", 5000);
    }
  }

  async function reject(id: string | number) {
    setBusy((b) => ({ ...b, [id]: true }));
    const res = await bg("SET_CANDIDATE_STATUS", { id, status: "rejected" });
    setBusy((b) => ({ ...b, [id]: false }));
    if (res.ok) {
      flash("ok", "Đã bỏ đề xuất.", 2000);
      removeLocal(id);
    } else {
      flash("err", res.error || "Bỏ đề xuất thất bại.", 5000);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="rounded-md border border-line bg-surface-2/60 px-3 py-2 text-xs leading-snug text-ink-faint">
        Cụm từ được đào từ bài đã phân loại. Duyệt để thăng cấp thành từ khóa
        thật cho Lọc thông minh, hoặc bỏ để không đề xuất lại.
      </p>

      {loading ? (
        <ListSkeleton />
      ) : loadError ? (
        <EmptyState title="Cần đăng nhập" desc={loadError} />
      ) : list.length === 0 ? (
        <EmptyState
          title="Chưa có đề xuất"
          desc='Bấm "Phân loại lại" ở màn Bảng tin để hệ thống đào thêm từ khóa từ bài đã phân loại.'
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {list.map((c) => {
            const label = CAND_LABEL[c.label || ""] || c.label || "";
            const src = CAND_SOURCE[c.source || ""] || c.source || "";
            const ratio =
              c.ratio != null
                ? Math.round(Number(c.ratio) * 100) + "%"
                : "—";
            const cnt = c.cnt != null ? c.cnt : 0;
            const example = c.example
              ? String(c.example).slice(0, 160)
              : "";
            const b = !!busy[c.id];
            return (
              <article
                key={c.id}
                className="flex items-start gap-3 rounded-lg border border-line bg-surface px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">
                      {c.phrase}
                    </span>
                    <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-soft">
                      {label}
                    </span>
                    <span className="text-xs text-ink-faint">{src}</span>
                    <span
                      className="text-xs text-ink-faint"
                      title="Độ phân biệt · Số lần gặp"
                    >
                      {ratio} · {cnt}
                    </span>
                  </div>
                  {example && (
                    <div className="mt-1 line-clamp-2 text-xs leading-snug text-ink-faint">
                      {example}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => approve(c.id)}
                    disabled={b}
                    title="Duyệt: thăng cấp thành từ khóa thật"
                    className="inline-flex items-center gap-1 rounded-md bg-green px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green/90 disabled:opacity-60"
                  >
                    <Check className="size-3.5" strokeWidth={2.5} />
                    Duyệt
                  </button>
                  <button
                    type="button"
                    onClick={() => reject(c.id)}
                    disabled={b}
                    title="Bỏ: không đề xuất lại"
                    className="inline-flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:bg-red-soft/30 hover:text-red disabled:opacity-60"
                  >
                    <X className="size-3.5" strokeWidth={2.5} />
                    Bỏ
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================== helpers =============================== */
function EmptyState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-soft">{title}</p>
      <p className="max-w-[420px] text-xs leading-snug text-ink-faint">
        {desc}
      </p>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1.5">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-[52px] animate-pulse rounded-lg border border-line bg-surface-2/40"
        />
      ))}
    </div>
  );
}
