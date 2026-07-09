import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Loader2,
  ExternalLink,
  RefreshCw,
  Newspaper,
  AlertCircle,
  CheckCircle2,
  X,
  MessageCircle,
  ThumbsUp,
  History,
  Image as ImageIcon,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { colorFor, initials } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import { useIncremental } from "@/lib/useIncremental";
import {
  classifyLead,
  LEAD_META,
  matchLeadMode,
  type LeadMode,
} from "@/lib/leadfilter";

interface Post {
  postId: string;
  text?: string;
  authorName?: string;
  authorProfile?: string;
  images?: string[];
  links?: string[];
  permalink?: string;
  timestamp?: number | string;
  crawledAt?: number | string;
  timeText?: string;
  groupName?: string;
  groupId?: string;
  reactions?: number;
  comments?: number;
}

interface PostsResponse extends BgResponse {
  posts?: Post[];
}

interface UsedProduct {
  name?: string;
  price?: number | string;
  buildPrice?: number | string;
  url?: string;
  source?: string;
}

interface AnalyzeResponse extends BgResponse {
  saved?: boolean;
  intent?: string;
  confidence?: number;
  needsHumanCheck?: boolean;
  checkNote?: string;
  reply?: string;
  usedProducts?: UsedProduct[];
  postId?: string;
}

interface PostComment {
  content?: string;
  commentedAt?: number | string;
}

interface CommentsResponse extends BgResponse {
  comments?: PostComment[];
}

interface Analysis {
  intent?: string;
  confidence?: number;
  needsHumanCheck?: boolean;
  checkNote?: string;
  usedProducts: UsedProduct[];
}

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;

const LEAD_TONE_CLS: Record<
  ReturnType<typeof classifyLead>["label"] | "buy",
  string
> = {
  buy: "border-green-soft bg-green-soft/30 text-green",
  support: "border-accent-soft bg-accent-soft/30 text-accent-ink",
  seller: "border-amber-soft bg-amber-soft/20 text-amber",
  other: "border-line-soft bg-surface-2 text-ink-faint",
};

const LEAD_FILTERS: { id: LeadMode; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "lead", label: "Khách tiềm năng" },
  { id: "buy", label: "Cần mua" },
  { id: "support", label: "Cần hỗ trợ" },
  { id: "seller", label: "Người bán" },
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

function fmtPrice(v?: number | string): string {
  if (v == null || v === "") return "—";
  const n =
    typeof v === "number" ? v : Number(String(v).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return String(v);
  return `${n.toLocaleString("vi-VN")}đ`;
}

function sortKey(p: Post): number {
  if (p.timestamp != null && p.timestamp !== "") {
    const n = Number(p.timestamp);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  }
  if (p.crawledAt) {
    const t = new Date(p.crawledAt).getTime();
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-mono text-sm font-semibold text-ink"
      style={{ background: colorFor(name), width: size, height: size }}
    >
      {initials(name)}
    </span>
  );
}

export function Feed() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [analysis, setAnalysis] = useState<Record<string, Analysis>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [commentsOpen, setCommentsOpen] = useState<Record<string, boolean>>({});
  const [commentsData, setCommentsData] = useState<
    Record<string, PostComment[]>
  >({});
  const [commentsLoading, setCommentsLoading] = useState<
    Record<string, boolean>
  >({});
  const [leadMode, setLeadMode] = useState<LeadMode>("all");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [genLoading, setGenLoading] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);

  function flash(kind: NonNullable<Toast>["kind"], text: string, ms = 3200) {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }

  async function load() {
    setLoading(true);
    setLoadError(null);
    const res = await bg<PostsResponse>("GET_ALL_POSTS", { groupId: "" });
    if (!res.ok) {
      setLoadError(res.error || "Không tải được bài viết.");
      setPosts([]);
      setLoading(false);
      return;
    }
    const list = Array.isArray(res.posts) ? res.posts : [];
    setPosts(list.filter((p) => p && p.postId));
    setLoading(false);
  }

  useEffect(() => {
    load();
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return posts
      .slice()
      .sort((a, b) => sortKey(b) - sortKey(a))
      .filter((p) => {
        if (leadMode !== "all") {
          const lead = classifyLead(p.text || "");
          if (!matchLeadMode(lead.label, leadMode)) return false;
        }
        if (term) {
          const hay = `${p.text || ""} ${p.authorName || ""}`.toLowerCase();
          if (!hay.includes(term)) return false;
        }
        return true;
      });
  }, [posts, leadMode, search]);

  const {
    visible: windowed,
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  } = useIncremental(visible, { pageSize: 12 });

  function setDraft(postId: string, text: string) {
    setDrafts((d) => ({ ...d, [postId]: text }));
  }

  async function suggestAI(post: Post) {
    const id = post.postId;
    setGenLoading((g) => ({ ...g, [id]: true }));
    setConfirmingId((c) => (c === id ? null : c));
    try {
      const res = await bg<AnalyzeResponse>("ANALYZE_POST", { post });
      if (!res.ok) {
        flash("err", res.error || "AI chưa phân tích được bài này.");
        return;
      }
      setDraft(id, res.reply || "");
      setAnalysis((a) => ({
        ...a,
        [id]: {
          intent: res.intent,
          confidence: res.confidence,
          needsHumanCheck: res.needsHumanCheck,
          checkNote: res.checkNote,
          usedProducts: res.usedProducts || [],
        },
      }));
      flash("ok", "AI đã soạn nháp. Kiểm tra kỹ giá trước khi gửi.");
    } finally {
      setGenLoading((g) => ({ ...g, [id]: false }));
    }
  }

  async function sendComment(post: Post) {
    const id = post.postId;
    const text = (drafts[id] ?? "").trim();
    if (!text) {
      flash("err", "Nội dung bình luận đang trống.");
      return;
    }
    if (!post.permalink) {
      flash("err", "Bài này không có link gốc nên chưa bình luận được.");
      return;
    }
    setSending((s) => ({ ...s, [id]: true }));
    try {
      const res = await bg("CREATE_JOB", {
        job: {
          type: "comment",
          status: "paused",
          targetUrl: post.permalink,
          content: text,
          images: [],
          scheduledAt: Date.now(),
        },
      });
      if (!res.ok) {
        flash("err", res.error || "Không thêm được vào hàng đợi.");
        return;
      }
      setConfirmingId(null);
      setDrafts((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
      setAnalysis((a) => {
        const next = { ...a };
        delete next[id];
        return next;
      });
      flash(
        "ok",
        'Đã thêm vào hàng đợi (CHỜ DUYỆT). Bấm "Duyệt" ở Công cụ để gửi.',
      );
    } finally {
      setSending((s) => ({ ...s, [id]: false }));
    }
  }

  async function toggleComments(post: Post) {
    const id = post.postId;
    const willOpen = !commentsOpen[id];
    setCommentsOpen((c) => ({ ...c, [id]: willOpen }));
    if (!willOpen || commentsData[id]) return;
    setCommentsLoading((l) => ({ ...l, [id]: true }));
    try {
      const res = await bg<CommentsResponse>("GET_POST_COMMENTS", {
        postId: id,
      });
      if (!res.ok) {
        flash("err", res.error || "Không tải được lịch sử bình luận.");
        setCommentsData((d) => ({ ...d, [id]: [] }));
        return;
      }
      setCommentsData((d) => ({ ...d, [id]: res.comments || [] }));
    } finally {
      setCommentsLoading((l) => ({ ...l, [id]: false }));
    }
  }

  return (
    <div className="relative mx-auto flex w-full max-w-[720px] flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <Newspaper className="size-4 text-accent" />
            <span>
              {loading
                ? "Đang tải…"
                : shown < total
                  ? `${shown}/${total} bài viết`
                  : `${total} bài viết`}
            </span>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
          >
            <RefreshCw
              className={cn("size-3.5", loading && "animate-spin text-accent")}
            />
            Làm mới
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {LEAD_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setLeadMode(f.id)}
              className={cn(
                "rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors",
                leadMode === f.id
                  ? "border-accent/60 bg-accent-soft/30 text-accent-ink"
                  : "border-line bg-surface-2 text-ink-faint hover:border-line hover:text-ink-soft",
              )}
            >
              {f.label}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Tìm nội dung, người đăng…"
            className="ml-auto w-48 rounded-sm border border-line bg-bg px-2.5 py-1 text-xs text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
          />
        </div>
      </div>

      {/* List */}
      {loading ? (
        <FeedSkeleton />
      ) : loadError ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-red-soft bg-red-soft/20 px-4 py-10 text-center">
          <AlertCircle className="size-6 text-red" />
          <p className="text-sm font-medium text-red">{loadError}</p>
          <button
            onClick={load}
            className="mt-1 inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft hover:text-ink"
          >
            <RefreshCw className="size-3.5" />
            Thử lại
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-4 py-14 text-center">
          <Newspaper className="size-7 text-ink-faint" />
          <p className="text-sm font-medium text-ink-soft">
            Chưa có bài viết nào.
          </p>
          <p className="text-xs text-ink-faint">
            Thu thập bài viết nhóm rồi quay lại đây để bình luận.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {windowed.map((post) => {
            const id = post.postId;
            const author = post.authorName || "Không rõ";
            const text = post.text || "";
            const isLong = text.length > 280;
            const isExpanded = !!expanded[id];
            const lead = classifyLead(text);
            const showBadge = lead.label !== "other";
            const draft = drafts[id] ?? "";
            const meta = analysis[id];
            const imgs = (post.images || []).slice(0, 4);
            const moreImgs = (post.images || []).length - imgs.length;
            const links = (post.links || []).slice(0, 3);
            const when =
              post.timeText ||
              timeAgo(post.timestamp ?? post.crawledAt) ||
              "Không rõ thời gian";
            const place = post.groupName || post.groupId || "";
            const confirming = confirmingId === id;
            const isSending = !!sending[id];
            const canComment = !!post.permalink;

            return (
              <article
                key={id}
                className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface"
              >
                {/* Header */}
                <header className="flex items-start gap-3 px-4 pt-4">
                  {post.authorProfile ? (
                    <a
                      href={post.authorProfile}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Avatar name={author} size={40} />
                    </a>
                  ) : (
                    <Avatar name={author} size={40} />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-ink">
                        {author}
                      </span>
                      {showBadge && (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-sm border px-2 py-0.5 text-xs font-medium",
                            LEAD_TONE_CLS[lead.label],
                          )}
                        >
                          {LEAD_META[lead.label].text}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-faint">
                      <span className="tnum">{when}</span>
                      {place && (
                        <>
                          <span>·</span>
                          <span className="truncate">{place}</span>
                        </>
                      )}
                    </div>
                  </div>
                  {post.permalink && (
                    <a
                      href={post.permalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-faint transition-colors hover:text-accent"
                    >
                      <ExternalLink className="size-3.5" />
                      Bài gốc
                    </a>
                  )}
                </header>

                {/* Body */}
                {text && (
                  <div className="px-4 pt-3">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                      {isLong && !isExpanded
                        ? `${text.slice(0, 280)}…`
                        : text}
                    </p>
                    {isLong && (
                      <button
                        onClick={() =>
                          setExpanded((e) => ({ ...e, [id]: !isExpanded }))
                        }
                        className="mt-1 text-xs font-medium text-accent hover:text-accent-bright"
                      >
                        {isExpanded ? "Thu gọn" : "Xem thêm"}
                      </button>
                    )}
                  </div>
                )}

                {/* Images */}
                {imgs.length > 0 && (
                  <div className="px-4 pt-3">
                    <div
                      className={cn(
                        "grid gap-1 overflow-hidden rounded-md",
                        imgs.length === 1 ? "grid-cols-1" : "grid-cols-2",
                      )}
                    >
                      {imgs.map((src, i) => (
                        <div
                          key={i}
                          className="relative aspect-video overflow-hidden bg-surface-2"
                        >
                          <img
                            src={src}
                            alt=""
                            loading="lazy"
                            className="size-full object-cover"
                          />
                          {i === imgs.length - 1 && moreImgs > 0 && (
                            <span className="absolute inset-0 grid place-items-center bg-bg/60 text-lg font-semibold text-ink">
                              +{moreImgs}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Links */}
                {links.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                    {links.map((l, i) => (
                      <a
                        key={i}
                        href={l}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex max-w-full items-center gap-1 truncate rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                      >
                        <ImageIcon className="size-3 shrink-0 text-ink-faint" />
                        <span className="truncate">{l}</span>
                      </a>
                    ))}
                  </div>
                )}

                {/* Metrics */}
                <div className="mt-3 flex items-center gap-4 border-t border-line-soft px-4 py-2 text-xs text-ink-faint">
                  <span className="inline-flex items-center gap-1">
                    <ThumbsUp className="size-3.5" />
                    <span className="tnum">{post.reactions ?? 0}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MessageCircle className="size-3.5" />
                    <span className="tnum">{post.comments ?? 0}</span>
                  </span>
                  <button
                    onClick={() => toggleComments(post)}
                    className="ml-auto inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium text-ink-soft transition-colors hover:text-accent"
                  >
                    <History className="size-3.5" />
                    {commentsOpen[id] ? "Ẩn lịch sử BL" : "Lịch sử BL"}
                  </button>
                </div>

                {/* Comment history */}
                {commentsOpen[id] && (
                  <div className="border-t border-line-soft bg-bg px-4 py-3">
                    {commentsLoading[id] ? (
                      <div className="flex items-center gap-2 text-xs text-ink-faint">
                        <Loader2 className="size-3.5 animate-spin text-accent" />
                        Đang tải lịch sử bình luận…
                      </div>
                    ) : (commentsData[id] || []).length === 0 ? (
                      <p className="text-xs text-ink-faint">
                        Chưa có bình luận nào được ghi lại.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {(commentsData[id] || []).map((c, i) => (
                          <li
                            key={i}
                            className="rounded-md border border-line-soft bg-surface px-3 py-2"
                          >
                            <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
                              {c.content || "(trống)"}
                            </p>
                            {c.commentedAt != null && (
                              <span className="mt-1 block text-[11px] text-ink-faint">
                                {timeAgo(c.commentedAt)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Composer */}
                <div className="border-t border-line-soft bg-surface px-4 py-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-ink-faint">
                      Bình luận của bạn
                    </span>
                    <button
                      onClick={() => suggestAI(post)}
                      disabled={genLoading[id]}
                      className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
                    >
                      {genLoading[id] ? (
                        <Loader2 className="size-3.5 animate-spin text-accent" />
                      ) : (
                        <Sparkles className="size-3.5 text-accent" />
                      )}
                      {genLoading[id] ? "Đang soạn…" : "AI gợi ý"}
                    </button>
                  </div>

                  <textarea
                    value={draft}
                    onChange={(e) => {
                      setDraft(id, e.target.value);
                      if (confirmingId === id) setConfirmingId(null);
                    }}
                    rows={3}
                    placeholder="Viết bình luận của bạn, hoặc bấm ✨ AI gợi ý…"
                    className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
                  />

                  {/* AI analysis meta */}
                  {meta && (
                    <div className="mt-2 rounded-md border border-line-soft bg-bg px-3 py-2 text-xs">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-faint">
                        {meta.intent && (
                          <span className="inline-flex items-center gap-1">
                            <Sparkles className="size-3 text-accent" />
                            Ý định:{" "}
                            <span className="text-ink-soft">{meta.intent}</span>
                          </span>
                        )}
                        <span>
                          Độ tự tin:{" "}
                          <span className="tnum text-ink-soft">
                            {meta.confidence != null
                              ? `${Math.round(meta.confidence * 100)}%`
                              : "—"}
                          </span>
                        </span>
                      </div>
                      {meta.usedProducts.length > 0 && (
                        <ul className="mt-1.5 flex flex-col gap-0.5">
                          {meta.usedProducts.map((p, i) => (
                            <li
                              key={i}
                              className="flex items-center gap-1.5 text-ink-soft"
                            >
                              <span className="truncate">
                                {p.name || "(không tên)"}
                              </span>
                              <span className="font-medium text-ink">
                                {fmtPrice(p.price ?? p.buildPrice)}
                              </span>
                              {p.source && (
                                <span className="text-ink-faint">
                                  {p.source}
                                </span>
                              )}
                              {p.url && (
                                <a
                                  href={p.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-accent hover:text-accent-bright"
                                >
                                  xem
                                </a>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {meta.needsHumanCheck && (
                        <div className="mt-1.5 flex items-start gap-1.5 rounded-sm border border-amber-soft bg-amber-soft/20 px-2 py-1 text-amber">
                          <AlertCircle className="mt-0.5 size-3 shrink-0" />
                          <span>
                            Cần kiểm tra tay:{" "}
                            {meta.checkNote || "có số liệu cần xác minh"}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Action row */}
                  {confirming ? (
                    <div className="mt-2.5 flex items-center justify-between gap-3 rounded-md border border-amber-soft bg-amber-soft/20 px-3 py-2">
                      <span className="text-xs font-medium text-amber">
                        Thêm bình luận này vào hàng đợi chờ duyệt?
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setConfirmingId(null)}
                          className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:text-ink"
                        >
                          <X className="size-3.5" />
                          Hủy
                        </button>
                        <button
                          onClick={() => sendComment(post)}
                          disabled={isSending}
                          className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isSending ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="size-3.5" />
                          )}
                          Xác nhận
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2.5 flex items-center justify-between gap-3">
                      <span className="text-xs text-ink-faint">
                        {canComment
                          ? "Gửi vào hàng đợi, duyệt trước khi đăng lên Facebook."
                          : "Bài này thiếu link gốc nên chưa bình luận được."}
                      </span>
                      <button
                        onClick={() => setConfirmingId(id)}
                        disabled={!canComment || !draft.trim()}
                        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Send className="size-4" />
                        Duyệt & bình luận
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          {hasMore && (
            <div
              ref={sentinelRef}
              className="flex justify-center py-4"
            >
              <button
                onClick={loadMore}
                className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
              >
                <Loader2 className="size-3.5 animate-spin text-accent" />
                Đang tải thêm… ({shown}/{total})
              </button>
            </div>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 z-toast -translate-x-1/2 rounded-md border px-4 py-2.5 text-sm shadow-md",
            toast.kind === "ok" &&
              "border-green-soft bg-green-soft/30 text-green",
            toast.kind === "err" && "border-red-soft bg-red-soft/30 text-red",
            toast.kind === "info" &&
              "border-line bg-surface-2 text-ink-soft",
          )}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function FeedSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <div className="flex items-center gap-3">
            <div className="size-10 animate-pulse rounded-full bg-surface-2" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="h-3 w-32 animate-pulse rounded bg-surface-2" />
              <div className="h-2.5 w-24 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
          <div className="h-3 w-full animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-surface-2" />
          <div className="h-20 w-full animate-pulse rounded-md bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
