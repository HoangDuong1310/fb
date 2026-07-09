import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  Loader2,
  ExternalLink,
  RefreshCw,
  Search,
  Plus,
  CheckCircle2,
  X,
  Trash2,
  Inbox,
  AlertCircle,
  AlertTriangle,
  Lock,
  Unlock,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { colorFor, initials } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import { useIncremental } from "@/lib/useIncremental";

/* -------------------------------------------------------------------------
   Comments view — "Hội thoại bình luận": theo dõi REPLY của khách dưới các
   bình luận của ta, rồi để AI soạn NHÁP phản hồi. 1:1 với các hợp đồng trong
   src/dashboard/views/conversations.js:
     • GET_CONVERSATIONS {status}                 → {conversations}
     • GET_WATCH_CONFIG / SET_WATCH_CONFIG {config}
     • WATCH_REPLIES_NOW {}                       → quét reply ngay (+diag)
     • TRACK_CONVERSATION {url,myComment}         → theo dõi bình luận đăng tay
     • DRAFT_CONV_REPLY {id,targetReplyId?}       → AI soạn nháp (tuỳ chọn 1 khách)
     • APPROVE_CONV_REPLY {id,reply}              → tạo comment job (đăng)
     • UPDATE_CONVERSATION {id,patch:{status}}    → đóng / mở lại
     • DELETE_CONVERSATION {id}
   Triết lý an toàn: AI chỉ tạo NHÁP; người dùng duyệt thì mới đăng. Mọi thao
   tác diễn ra ngay tại thẻ, không nhảy view.
   ------------------------------------------------------------------------- */

interface Reply {
  id?: string | number;
  mine?: boolean;
  author?: string;
  text?: string;
  seenAt?: number;
}
interface Draft {
  reply?: string;
  targetAuthor?: string;
  needsHumanCheck?: boolean;
  checkNote?: string;
}
interface Conversation {
  id: number;
  status?: string;
  groupName?: string;
  groupId?: string;
  postText?: string;
  myComment?: string;
  myCommentUrl?: string;
  postUrl?: string;
  replies?: Reply[];
  draft?: Draft;
}

interface ConversationsResponse extends BgResponse {
  conversations?: Conversation[];
}
interface WatchConfigResponse extends BgResponse {
  config?: { enabled?: boolean; intervalMinutes?: number };
}
interface WatchNowResponse extends BgResponse {
  checked?: number;
  newReplies?: number;
  noParent?: number;
  diag?: {
    commentAnchors?: number;
    bestSoftScore?: number;
    needlePreview?: string;
  };
}
interface TrackResponse extends BgResponse {
  watch?: { newReplies?: number; diag?: Record<string, unknown> };
}

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;

const STATUS_LABEL: Record<string, string> = {
  watching: "Đang theo dõi",
  replied: "Có phản hồi mới",
  drafted: "Đã soạn nháp",
  closed: "Đã đóng",
};

const TABS: { value: string; label: string }[] = [
  { value: "", label: "Tất cả" },
  { value: "replied", label: "Có phản hồi mới" },
  { value: "watching", label: "Đang theo dõi" },
  { value: "drafted", label: "Đã soạn nháp" },
  { value: "closed", label: "Đã đóng" },
];

const INTERVALS = [15, 30, 60, 120];

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "vừa xong";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  return `${d} ngày trước`;
}

/* Trạng thái hội thoại → badge. */
function StatusBadge({ status }: { status?: string }) {
  const label = STATUS_LABEL[status || ""] || status || "—";
  const cls =
    status === "replied"
      ? "border-green-soft bg-green-soft/30 text-green"
      : status === "drafted"
        ? "border-accent-soft bg-accent-soft/30 text-accent-ink"
        : status === "watching"
          ? "border-blue-soft bg-blue-soft/30 text-blue"
          : "border-line-soft bg-surface-2 text-ink-faint";
  return (
    <span
      className={cn(
        "rounded-sm border px-2 py-0.5 text-xs font-medium",
        cls,
      )}
    >
      {label}
    </span>
  );
}

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-mono text-xs font-semibold text-ink"
      style={{ background: colorFor(name), width: size, height: size }}
    >
      {initials(name)}
    </span>
  );
}

export function Comments() {
  const [items, setItems] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

  // Nháp đã CHỈNH TAY, keyed theo id hội thoại. undefined → fallback về draft.reply
  // do server trả (để nháp AI mới nhất hiện lên sau khi soạn/reload).
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [draftingKey, setDraftingKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [confirmApproveId, setConfirmApproveId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Theo dõi reply nền.
  const [watchEnabled, setWatchEnabled] = useState(false);
  const [watchInterval, setWatchInterval] = useState(30);

  // Form theo dõi bình luận đăng tay.
  const [trackOpen, setTrackOpen] = useState(false);
  const [trackUrl, setTrackUrl] = useState("");
  const [trackComment, setTrackComment] = useState("");
  const [tracking, setTracking] = useState(false);

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
    const res = await bg<ConversationsResponse>("GET_CONVERSATIONS", {
      status,
    });
    if (!res.ok) {
      setLoadError(res.error || "Không tải được hội thoại.");
      setLoading(false);
      return;
    }
    setItems(res.conversations ?? []);
    setLoading(false);
  }

  async function loadWatch() {
    const res = await bg<WatchConfigResponse>("GET_WATCH_CONFIG");
    if (res.ok) {
      setWatchEnabled(!!res.config?.enabled);
      setWatchInterval(res.config?.intervalMinutes || 30);
    }
  }

  // Reload khi đổi tab trạng thái.
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    loadWatch();
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const {
    visible: windowed,
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  } = useIncremental(items, { pageSize: 12 });

  async function saveWatch(enabled: boolean, interval: number) {
    setWatchEnabled(enabled);
    setWatchInterval(interval);
    const res = await bg("SET_WATCH_CONFIG", {
      config: { enabled, intervalMinutes: interval },
    });
    if (res.ok) flash("ok", "Đã lưu cấu hình theo dõi reply.", 1800);
    else flash("err", res.error || "Không lưu được cấu hình.", 4000);
  }

  async function scanNow() {
    setScanning(true);
    flash("info", "Đang quét phản hồi mới…", 4000);
    const res = await bg<WatchNowResponse>("WATCH_REPLIES_NOW", {});
    setScanning(false);
    if (res.ok) {
      if (res.noParent && !res.newReplies) {
        const d = res.diag;
        let extra = "";
        if (d) {
          if (!d.commentAnchors) {
            extra =
              " (Trang không có bình luận nào tải được — kiểm tra link có đúng bài/bình luận và thử lại sau khi trang tải xong.)";
          } else {
            extra =
              ` (Thấy ${d.commentAnchors} bình luận trên trang, khớp cao nhất ${d.bestSoftScore || 0}% từ.` +
              (d.needlePreview ? ` Text dò: "${d.needlePreview}".` : "") +
              ` Hãy dán đúng NGUYÊN VĂN bình luận của bạn.)`;
          }
        }
        flash(
          "err",
          `Đã quét ${res.checked || 0} hội thoại nhưng KHÔNG định vị được bình luận của bạn trên ${res.noParent} hội thoại.${extra}`,
          9000,
        );
      } else {
        flash(
          "ok",
          `Đã quét ${res.checked || 0} hội thoại, +${res.newReplies || 0} phản hồi mới.`,
          4000,
        );
      }
      await load();
    } else {
      flash("err", res.error || "Không quét được.", 5000);
    }
  }

  async function submitTrack() {
    const url = trackUrl.trim();
    const myComment = trackComment.trim();
    if (!url) {
      flash("err", "Cần nhập link bài viết.");
      return;
    }
    const hasCommentId = /[?&]comment_id=\d+/.test(url);
    if (!hasCommentId && !myComment) {
      flash(
        "err",
        "Link không có comment_id — hãy dán link bình luận của bạn hoặc nhập nội dung bình luận để dò.",
        6000,
      );
      return;
    }
    setTracking(true);
    flash("info", "Đang tạo & quét hội thoại…", 6000);
    const res = await bg<TrackResponse>("TRACK_CONVERSATION", {
      url,
      myComment,
    });
    setTracking(false);
    if (res.ok) {
      const added = res.watch?.newReplies || 0;
      flash(
        added > 0 ? "ok" : "info",
        added > 0
          ? `Đã thêm hội thoại. Tìm thấy ${added} phản hồi.`
          : "Đã thêm hội thoại. Chưa thấy phản hồi nào — thử quét lại sau ít phút.",
        added > 0 ? 4000 : 7000,
      );
      setTrackOpen(false);
      setTrackUrl("");
      setTrackComment("");
      await load();
    } else {
      flash("err", res.error || "Không tạo được hội thoại.", 5000);
    }
  }

  async function draftReply(id: number, targetReplyId?: string) {
    setDraftingKey(`${id}:${targetReplyId ?? ""}`);
    flash("info", "AI đang soạn nháp phản hồi…", 6000);
    const payload: Record<string, unknown> = { id: Number(id) };
    if (targetReplyId != null && targetReplyId !== "")
      payload.targetReplyId = String(targetReplyId);
    const res = await bg("DRAFT_CONV_REPLY", payload);
    setDraftingKey(null);
    if (res.ok) {
      // Bỏ nháp chỉnh tay cũ để hiện nháp AI mới nhất từ server sau reload.
      setDrafts((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
      flash("ok", "Đã soạn nháp. Xem lại rồi duyệt để đăng.");
      await load();
    } else {
      flash("err", res.error || "AI không soạn được nháp.", 5000);
    }
  }

  async function approveReply(c: Conversation) {
    const reply = (drafts[c.id] ?? c.draft?.reply ?? "").trim();
    if (!reply) {
      flash("err", "Nháp rỗng, không thể đăng.");
      return;
    }
    setBusyId(c.id);
    const res = await bg("APPROVE_CONV_REPLY", { id: Number(c.id), reply });
    setBusyId(null);
    setConfirmApproveId(null);
    if (res.ok) {
      flash("ok", "Đã đưa phản hồi vào hàng đợi bình luận.");
      setDrafts((d) => {
        const next = { ...d };
        delete next[c.id];
        return next;
      });
      await load();
    } else {
      flash("err", res.error || "Không tạo được việc.", 5000);
    }
  }

  async function toggleClose(c: Conversation) {
    const next = c.status === "closed" ? "watching" : "closed";
    setBusyId(c.id);
    await bg("UPDATE_CONVERSATION", {
      id: Number(c.id),
      patch: { status: next },
    });
    setBusyId(null);
    await load();
  }

  async function deleteConv(id: number) {
    setBusyId(id);
    const res = await bg("DELETE_CONVERSATION", { id: Number(id) });
    setBusyId(null);
    setConfirmDeleteId(null);
    if (res.ok) {
      flash("ok", "Đã xóa hội thoại.");
      await load();
    } else {
      flash("err", res.error || "Không xóa được hội thoại.", 5000);
    }
  }

  const ghostBtn =
    "inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60";

  return (
    <div className="relative flex flex-col gap-4">
      {/* ── Toolbar ── */}
      <div className="rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          {/* Status tabs */}
          <div className="inline-flex items-center gap-0.5 rounded-md border border-line bg-surface-2 p-0.5">
            {TABS.map((t) => (
              <button
                key={t.value || "all"}
                type="button"
                onClick={() => setStatus(t.value)}
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                  status === t.value
                    ? "bg-accent text-on-accent"
                    : "text-ink-faint hover:text-ink",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setTrackOpen((v) => !v)}
              className={ghostBtn}
            >
              <Plus className="size-3.5" />
              Theo dõi bình luận
            </button>
            <button
              type="button"
              onClick={scanNow}
              disabled={scanning}
              className={ghostBtn}
            >
              {scanning ? (
                <Loader2 className="size-3.5 animate-spin text-accent" />
              ) : (
                <Search className="size-3.5 text-accent" />
              )}
              {scanning ? "Đang quét…" : "Quét phản hồi ngay"}
            </button>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshCw
                className={cn("size-3.5", loading && "animate-spin")}
              />
              Làm mới
            </button>
          </div>
        </div>

        {/* Watch config */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line-soft px-4 py-2.5">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
            <button
              type="button"
              role="switch"
              aria-checked={watchEnabled}
              onClick={() => saveWatch(!watchEnabled, watchInterval)}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
                watchEnabled ? "bg-accent" : "bg-surface-3",
              )}
            >
              <span
                className={cn(
                  "inline-block size-4 rounded-full bg-white transition-transform",
                  watchEnabled ? "translate-x-4" : "translate-x-0.5",
                )}
              />
            </button>
            Theo dõi reply nền tự động
          </label>

          <label className="flex items-center gap-2 text-sm text-ink-soft">
            Chu kỳ
            <select
              value={watchInterval}
              onChange={(e) => saveWatch(watchEnabled, Number(e.target.value))}
              className="rounded-sm border border-line bg-bg px-2 py-1 text-sm text-ink focus:border-accent/60 focus-visible:outline-none"
            >
              {INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {n} phút
                </option>
              ))}
            </select>
          </label>

          <span className="text-xs text-ink-faint">
            Tiện ích tự quét reply mới theo chu kỳ — bạn không cần mở Facebook.
          </span>
        </div>

        {/* Track form (đăng tay) */}
        {trackOpen && (
          <div className="space-y-2.5 border-t border-line-soft bg-bg/40 px-4 py-3">
            <p className="text-xs leading-snug text-ink-faint">
              Dùng khi bạn đã bình luận TAY trên Facebook. Chính xác nhất: mở
              bình luận của bạn, bấm vào thời gian để lấy link có{" "}
              <code className="rounded-sm bg-surface-2 px-1 font-mono text-ink-soft">
                comment_id=
              </code>{" "}
              rồi dán vào đây. Nếu link không có comment_id thì nhập nội dung để
              dò.
            </p>
            <input
              type="text"
              value={trackUrl}
              onChange={(e) => setTrackUrl(e.target.value)}
              placeholder="https://www.facebook.com/groups/.../posts/...?comment_id=..."
              className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
            />
            <textarea
              value={trackComment}
              onChange={(e) => setTrackComment(e.target.value)}
              rows={2}
              placeholder="Nội dung bình luận của bạn (không bắt buộc nếu link có comment_id)…"
              className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setTrackOpen(false)}
                disabled={tracking}
                className="inline-flex items-center gap-1 rounded-sm px-2.5 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
              >
                <X className="size-3.5" />
                Hủy
              </button>
              <button
                type="button"
                onClick={submitTrack}
                disabled={tracking}
                className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
              >
                {tracking ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
                Bắt đầu theo dõi
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── List ── */}
      {loading ? (
        <ListSkeleton />
      ) : loadError ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-4 py-12 text-center">
          <AlertCircle className="size-6 text-red" />
          <p className="text-sm text-ink-soft">{loadError}</p>
          <button
            type="button"
            onClick={load}
            className="mt-1 rounded-sm border border-line bg-surface-2 px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:text-ink"
          >
            Thử lại
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-5 py-16 text-center">
          <Inbox className="size-8 text-ink-faint" />
          <p className="text-sm font-medium text-ink">Chưa có hội thoại nào</p>
          <p className="max-w-sm text-xs leading-snug text-ink-faint">
            Khi một việc bình luận chạy xong, hội thoại sẽ xuất hiện ở đây để
            theo dõi phản hồi. Hoặc bấm “Theo dõi bình luận” để thêm bình luận
            bạn đã đăng tay.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {windowed.map((c) => {
            const replies = Array.isArray(c.replies) ? c.replies : [];
            const guestReplies = replies.filter((r) => !r.mine);
            const guestByAuthor = new Map<
              string,
              { author: string; replyId: string }
            >();
            for (const r of guestReplies) {
              const who = (r.author || "Người dùng").trim() || "Người dùng";
              guestByAuthor.set(who, { author: who, replyId: String(r.id ?? "") });
            }
            const distinctGuests = [...guestByAuthor.values()];

            const draft = c.draft;
            const draftText = drafts[c.id] ?? draft?.reply ?? "";
            // Soạn tay được phép mọi lúc (trừ hội thoại đã đóng); không cần chờ AI.
            const canReply = c.status !== "closed";
            const canApprove = !!draftText.trim();
            const link = c.myCommentUrl || c.postUrl;
            const cardDrafting = draftingKey?.startsWith(`${c.id}:`) ?? false;
            const isBusy = busyId === c.id;

            return (
              <article
                key={c.id}
                className={cn(
                  "rounded-lg border bg-surface",
                  c.status === "replied"
                    ? "border-green-soft"
                    : "border-line",
                )}
              >
                {/* Head */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-soft px-4 py-2.5">
                  <StatusBadge status={c.status} />
                  <span className="truncate text-sm font-medium text-ink">
                    {c.groupName || c.groupId || "—"}
                  </span>
                  <span className="tnum ml-auto rounded-sm bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-faint">
                    {guestReplies.length} phản hồi của khách
                  </span>
                </div>

                <div className="space-y-3 px-4 py-3.5">
                  {c.postText && (
                    <div className="rounded-md border border-line-soft bg-bg/40 px-3.5 py-2.5">
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                        Bài viết
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                        {c.postText}
                      </p>
                    </div>
                  )}

                  {/* Bình luận của bạn */}
                  <div className="rounded-md border border-line-soft bg-bg/40 px-3.5 py-2.5">
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Bình luận của bạn
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                      {c.myComment || "—"}
                    </p>
                  </div>

                  {/* Replies (chat bubbles) */}
                  {replies.length > 0 ? (
                    <div className="space-y-2.5">
                      {replies.map((r, i) => {
                        const mine = !!r.mine;
                        const who = mine ? "Bạn" : r.author || "Người dùng";
                        const when = timeAgo(r.seenAt);
                        return (
                          <div
                            key={r.id ?? i}
                            className={cn(
                              "flex items-start gap-2",
                              mine && "flex-row-reverse",
                            )}
                          >
                            <Avatar name={who} size={28} />
                            <div
                              className={cn(
                                "max-w-[80%] rounded-md border px-3 py-2",
                                mine
                                  ? "border-accent-soft bg-accent-soft/25"
                                  : "border-line-soft bg-surface-2",
                              )}
                            >
                              <div className="flex items-center gap-2 text-xs">
                                <b className="text-ink">{who}</b>
                                {when && (
                                  <span className="text-ink-faint">{when}</span>
                                )}
                              </div>
                              <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                                {r.text || ""}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-xs text-ink-faint">
                      Chưa có phản hồi nào dưới bình luận này.
                    </p>
                  )}

                  {/* Reply editor — AI-drafted or written by hand */}
                  {canReply && (
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium uppercase tracking-wide text-ink-faint">
                          {draft?.reply ? "Nháp phản hồi (AI soạn)" : "Phản hồi của bạn"}
                          {draft?.targetAuthor ? (
                            <>
                              {" "}
                              cho{" "}
                              <b className="text-ink normal-case">
                                @{draft.targetAuthor}
                              </b>
                            </>
                          ) : null}
                        </span>
                        {draft?.needsHumanCheck && (
                          <span className="inline-flex items-center gap-1 rounded-sm border border-amber-soft bg-amber-soft/30 px-1.5 py-0.5 font-medium text-amber">
                            <AlertTriangle className="size-3" />
                            cần kiểm tra
                          </span>
                        )}
                      </div>
                      <textarea
                        value={draftText}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDrafts((d) => ({ ...d, [c.id]: v }));
                          if (confirmApproveId === c.id)
                            setConfirmApproveId(null);
                        }}
                        rows={3}
                        placeholder="Tự viết phản hồi của bạn, hoặc bấm “AI soạn nháp” để AI gợi ý rồi chỉnh lại…"
                        className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
                      />
                      {draft?.checkNote && (
                        <p className="text-xs leading-snug text-amber">
                          {draft.checkNote}
                        </p>
                      )}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="border-t border-line-soft px-4 py-3">
                  {confirmApproveId === c.id ? (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-amber-soft bg-amber-soft/20 px-3 py-2">
                      <span className="text-xs leading-snug text-ink-soft">
                        Đưa phản hồi này vào hàng đợi để tự động đăng lên
                        Facebook?
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmApproveId(null)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 rounded-sm px-2.5 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
                        >
                          <X className="size-3.5" />
                          Hủy
                        </button>
                        <button
                          type="button"
                          onClick={() => approveReply(c)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
                        >
                          {isBusy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <CheckCircle2 className="size-3.5" />
                          )}
                          Xác nhận đăng
                        </button>
                      </div>
                    </div>
                  ) : confirmDeleteId === c.id ? (
                    <div className="flex items-center justify-between gap-3 rounded-md border border-red-soft bg-red-soft/20 px-3 py-2">
                      <span className="text-xs leading-snug text-ink-soft">
                        Xóa hội thoại khỏi danh sách theo dõi? (Không ảnh hưởng
                        bình luận trên Facebook.)
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 rounded-sm px-2.5 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
                        >
                          <X className="size-3.5" />
                          Hủy
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteConv(c.id)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-sm bg-red px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:opacity-90 disabled:opacity-60"
                        >
                          {isBusy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          Xóa
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      {/* AI draft buttons — 1 nút / khách khi có nhiều người */}
                      {replies.length > 0 &&
                        (distinctGuests.length > 1 ? (
                          distinctGuests.map((g) => {
                            const key = `${c.id}:${g.replyId}`;
                            const busy = draftingKey === key;
                            return (
                              <button
                                key={g.author}
                                type="button"
                                onClick={() => draftReply(c.id, g.replyId)}
                                disabled={cardDrafting || isBusy}
                                className={ghostBtn}
                              >
                                {busy ? (
                                  <Loader2 className="size-3.5 animate-spin text-accent" />
                                ) : (
                                  <Sparkles className="size-3.5 text-accent" />
                                )}
                                AI soạn cho @{g.author}
                              </button>
                            );
                          })
                        ) : (
                          <button
                            type="button"
                            onClick={() => draftReply(c.id)}
                            disabled={cardDrafting || isBusy}
                            className={ghostBtn}
                          >
                            {cardDrafting ? (
                              <Loader2 className="size-3.5 animate-spin text-accent" />
                            ) : (
                              <Sparkles className="size-3.5 text-accent" />
                            )}
                            AI soạn nháp
                          </button>
                        ))}

                      {canApprove && (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(null);
                            setConfirmApproveId(c.id);
                          }}
                          disabled={isBusy || !draftText.trim()}
                          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <CheckCircle2 className="size-3.5" />
                          Duyệt & đăng
                        </button>
                      )}

                      <div className="ml-auto flex items-center gap-2">
                        {link && (
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener"
                            className="inline-flex items-center gap-1 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
                          >
                            Mở trên Facebook
                            <ExternalLink className="size-3" />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleClose(c)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-60"
                        >
                          {c.status === "closed" ? (
                            <Unlock className="size-3.5" />
                          ) : (
                            <Lock className="size-3.5" />
                          )}
                          {c.status === "closed" ? "Mở lại" : "Đóng"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmApproveId(null);
                            setConfirmDeleteId(c.id);
                          }}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:text-red disabled:opacity-60"
                        >
                          <Trash2 className="size-3.5" />
                          Xóa
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center py-4">
              <button
                type="button"
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
          role="status"
          className={cn(
            "fixed bottom-6 left-1/2 z-toast max-w-md -translate-x-1/2 rounded-md border px-4 py-2.5 text-sm shadow-md",
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

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="space-y-3 rounded-lg border border-line bg-surface p-4"
        >
          <div className="flex items-center gap-3">
            <span className="h-5 w-20 animate-pulse rounded-sm bg-surface-2" />
            <span className="h-4 w-32 animate-pulse rounded-sm bg-surface-2" />
          </div>
          <span className="block h-12 w-full animate-pulse rounded-md bg-surface-2" />
          <div className="flex items-start gap-2">
            <span className="size-7 shrink-0 animate-pulse rounded-full bg-surface-2" />
            <span className="block h-10 w-2/3 animate-pulse rounded-md bg-surface-2" />
          </div>
        </div>
      ))}
    </div>
  );
}
