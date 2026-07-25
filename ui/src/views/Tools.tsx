import { useEffect, useRef, useState } from "react";
import {
  ListChecks,
  Download,
  Settings2,
  RefreshCw,
  Loader2,
  CheckCircle2,
  X,
  Trash2,
  Plus,
  Inbox,
  AlertCircle,
  PlayCircle,
  StopCircle,
  Radar,
  Database,
  KeyRound,
  Zap,
  ExternalLink,
  Flame,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { colorFor, initials } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import { useIncremental } from "@/lib/useIncremental";
import {
  normalizeWarmingActivityEntries,
  warmingDiagnosticText,
  type WarmingDiagnosticEntry,
} from "@/lib/warming-diagnostics";
import {
  getBulkCrawlSnapshot,
  isBulkCrawlActive,
  startBulkCrawl,
  stopBulkCrawl,
  subscribeBulkCrawl,
  type BulkCrawlSnapshot,
} from "@/lib/bulkCrawl";

/* -------------------------------------------------------------------------
   Tools — the closed-loop control room. Three logical stages, one per tab:
     1. Hàng đợi  — every "Gửi/Bình luận/Nhắn tin" from other views lands here
                    as a paused job; the user approves before anything reaches
                    Facebook. This is the last mile of the whole flow.
     2. Thu thập  — the data source that feeds Bảng tin: scan groups, crawl,
                    schedule auto-crawl, watch live progress.
     3. Cấu hình  — AI assist settings, crawl defaults, data housekeeping.
   AI stays optional; nothing here posts on its own.
   ------------------------------------------------------------------------- */

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;
type FlashFn = (kind: NonNullable<Toast>["kind"], text: string, ms?: number) => void;
type TabId = "queue" | "crawl" | "warming" | "config";

interface Job {
  id: string;
  type?: string;
  status?: string;
  content?: string;
  targetUrl?: string;
  groupId?: string;
  targetType?: string;
  images?: string[];
  error?: string;
  scheduledAt?: number;
  createdAt?: number;
}

interface Group {
  groupId: string;
  groupName?: string;
  postCount?: number;
  updatedAt?: number | string;
}

interface Stats {
  total?: number;
  groups?: unknown[];
}

interface AutoCrawlConfig {
  enabled?: boolean;
  intervalMinutes?: number;
  options?: Record<string, unknown>;
}

interface CrawlSettings {
  crawlMethod: "api" | "dom";
  crawlMax: number;
  crawlStopKnown: number;
  crawlDelay: number;
  crawlRest: number;
  crawlFromDate: string;
  crawlSafe: boolean;
}

interface AiConfig {
  apiBase: string;
  apiKey: string;
  model: string;
}

interface JobsResponse extends BgResponse {
  jobs?: Job[];
}
interface GroupsResponse extends BgResponse {
  groups?: Group[];
}
interface StatsResponse extends BgResponse {
  stats?: Stats;
}
interface AutoCrawlResponse extends BgResponse {
  config?: AutoCrawlConfig;
}
interface ModelsResponse extends BgResponse {
  models?: string[];
}
// Shape server trả về từ GET/PUT /api/me/ai-config (bọc trong { ok, config }).
// Server KHÔNG bao giờ trả key thô — chỉ hasKey + keyMasked ("••••abcd").
interface AiConfigResponse extends BgResponse {
  config?: {
    apiBase?: string;
    apiBaseDefault?: string;
    apiBaseEffective?: string;
    model?: string;
    modelDefault?: string;
    modelEffective?: string;
    hasKey?: boolean;
    keyMasked?: string;
  };
}

const TABS: { id: TabId; label: string; icon: typeof ListChecks }[] = [
  { id: "queue", label: "Hàng đợi", icon: ListChecks },
  { id: "crawl", label: "Thu thập", icon: Download },
  { id: "warming", label: "Nuôi tài khoản", icon: Flame },
  { id: "config", label: "Cấu hình", icon: Settings2 },
];

const JOB_STATUS: Record<string, { label: string; cls: string }> = {
  paused: { label: "Chờ duyệt", cls: "border-amber-soft bg-amber-soft/20 text-amber" },
  pending: { label: "Đang chờ", cls: "border-blue-soft bg-blue-soft/20 text-blue" },
  running: { label: "Đang chạy", cls: "border-accent-soft bg-accent-soft/30 text-accent-ink" },
  done: { label: "Xong", cls: "border-green-soft bg-green-soft/30 text-green" },
  error: { label: "Lỗi", cls: "border-red-soft bg-red-soft/30 text-red" },
};

const JOB_TYPE: Record<string, string> = {
  comment: "Bình luận",
  post: "Đăng bài",
  message: "Tin nhắn",
};

const QUEUE_FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "Tất cả" },
  { id: "paused", label: "Chờ duyệt" },
  { id: "pending", label: "Đang chờ" },
  { id: "done", label: "Xong" },
  { id: "error", label: "Lỗi" },
];

const FALLBACK_MODELS = [
  "gpt-5.5",
  "gpt-5.5-high",
  "gpt-5.4",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
];

const CRAWL_DEFAULTS: CrawlSettings = {
  crawlMethod: "api",
  crawlMax: 100,
  crawlStopKnown: 8,
  crawlDelay: 1500,
  crawlRest: 20,
  crawlFromDate: "",
  crawlSafe: false,
};

const INTERVALS = [10, 15, 30, 60, 120, 240];

function clamp(v: number, min: number, max: number, def: number): number {
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

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

function storageGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (r) => {
        void chrome.runtime.lastError;
        resolve(r || {});
      });
    } catch {
      resolve({});
    }
  });
}

function storageSet(obj: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function buildCrawlOptions(s: CrawlSettings) {
  let fromTs = 0;
  if (s.crawlFromDate) {
    const t = new Date(s.crawlFromDate + "T00:00:00").getTime();
    if (!Number.isNaN(t)) fromTs = t;
  }
  return {
    method: s.crawlMethod,
    maxNewPosts: clamp(s.crawlMax, 1, 2000, 100),
    stopAfterKnown: clamp(s.crawlStopKnown, 1, 100, 8),
    scrollDelay: clamp(s.crawlDelay, 400, 8000, 1500),
    restBetween: clamp(s.crawlRest, 0, 600, 20),
    fromTs,
    safeMode: s.crawlSafe,
  };
}

function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-mono text-sm font-semibold text-ink"
      style={{ background: colorFor(name), width: size, height: size }}
    >
      {initials(name)}
    </span>
  );
}

export function Tools() {
  const [tab, setTab] = useState<TabId>("queue");
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
    <div className="relative mx-auto flex w-full max-w-[860px] flex-col gap-4">
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

      {tab === "queue" ? (
        <QueueTab flash={flash} />
      ) : tab === "crawl" ? (
        <CrawlTab flash={flash} />
      ) : tab === "warming" ? (
        <WarmingTab flash={flash} />
      ) : (
        <ConfigTab flash={flash} />
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

/* ============================ TAB 1 — HÀNG ĐỢI ============================ */
function QueueTab({ flash }: { flash: FlashFn }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [groups, setGroups] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const [jres, gres] = await Promise.all([
      bg<JobsResponse>("GET_JOBS", {}),
      bg<GroupsResponse>("GET_GROUPS"),
    ]);
    if (!jres.ok) {
      setLoadError(jres.error || "Không tải được hàng đợi.");
      setJobs([]);
      setLoading(false);
      return;
    }
    setJobs(Array.isArray(jres.jobs) ? jres.jobs.filter((j) => j && j.id) : []);
    const map: Record<string, string> = {};
    if (gres.ok && Array.isArray(gres.groups)) {
      for (const g of gres.groups) map[g.groupId] = g.groupName || g.groupId;
    }
    setGroups(map);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pausedCount = jobs.filter((j) => j.status === "paused").length;
  const visible = jobs.filter((j) => filter === "all" || j.status === filter);
  const {
    visible: windowed,
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  } = useIncremental(visible, { pageSize: 15 });

  function targetLabel(j: Job): string {
    if (j.type === "comment" || j.type === "message") {
      return j.targetUrl || "(thiếu link)";
    }
    if (j.targetType === "profile") return "Trang cá nhân của tôi";
    return groups[j.groupId || ""] || j.groupId || "(nhóm)";
  }

  async function approveJob(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    const res = await bg("APPROVE_JOB", { id });
    setBusy((b) => ({ ...b, [id]: false }));
    if (!res.ok) {
      flash("err", res.error || "Không duyệt được việc này.");
      return;
    }
    flash("ok", "Đã duyệt. Việc sẽ được gửi lên Facebook.");
    load();
  }

  async function runJob(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    const res = await bg("RUN_JOB_NOW", { id });
    setBusy((b) => ({ ...b, [id]: false }));
    if (res.ok === false) {
      flash("err", res.error || "Chạy việc thất bại.");
    } else {
      flash("ok", "Đã yêu cầu chạy ngay.");
    }
    load();
  }

  async function deleteJob(id: string) {
    setBusy((b) => ({ ...b, [id]: true }));
    const res = await bg("DELETE_JOB", { id });
    setBusy((b) => ({ ...b, [id]: false }));
    setConfirmDeleteId(null);
    if (!res.ok) {
      flash("err", res.error || "Không xóa được việc.");
      return;
    }
    flash("ok", "Đã xóa việc khỏi hàng đợi.");
    load();
  }

  async function approveAll() {
    const res = await bg<BgResponse & { approved?: number }>("APPROVE_ALL_JOBS", {});
    if (!res.ok) {
      flash("err", res.error || "Không duyệt được.");
      return;
    }
    flash("ok", `Đã duyệt ${res.approved ?? pausedCount} việc.`);
    load();
  }

  async function clearFinished() {
    const res = await bg<BgResponse & { deleted?: number }>("CLEAR_FINISHED_JOBS");
    if (!res.ok) {
      flash("err", res.error || "Không dọn được.");
      return;
    }
    flash("ok", `Đã dọn ${res.deleted ?? 0} việc đã xong.`);
    load();
  }

  async function clearAll() {
    const res = await bg<BgResponse & { deleted?: number }>("CLEAR_ALL_JOBS");
    setConfirmClearAll(false);
    if (!res.ok) {
      flash("err", res.error || "Không xóa được.");
      return;
    }
    flash("ok", `Đã xóa toàn bộ ${res.deleted ?? 0} việc.`);
    load();
  }

  if (loading) return <ListSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <ListChecks className="size-4 text-accent" />
            <span>{jobs.length} việc trong hàng đợi</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={clearFinished}
              disabled={!jobs.some((j) => j.status === "done")}
              className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-50"
            >
              Dọn việc đã xong
            </button>
            <button
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
            >
              <RefreshCw className="size-3.5" />
              Làm mới
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {QUEUE_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-sm border px-2.5 py-1 text-xs font-medium transition-colors",
                filter === f.id
                  ? "border-accent/60 bg-accent-soft/30 text-accent-ink"
                  : "border-line bg-surface-2 text-ink-faint hover:text-ink-soft",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Approve-all bar */}
      {pausedCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-soft bg-amber-soft/20 px-4 py-2.5">
          <span className="text-sm font-medium text-amber">
            {pausedCount} việc đang chờ bạn duyệt trước khi đăng.
          </span>
          <button
            onClick={approveAll}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright"
          >
            <CheckCircle2 className="size-4" />
            Duyệt tất cả
          </button>
        </div>
      )}

      {loadError ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-soft bg-red-soft/20 px-4 py-3 text-sm text-red">
          <AlertCircle className="size-4 shrink-0" />
          {loadError}
        </div>
      ) : visible.length === 0 ? (
        <div className="grid place-items-center rounded-lg border border-line bg-surface px-4 py-14 text-center">
          <Inbox className="mb-3 size-8 text-ink-faint" />
          <p className="text-sm font-medium text-ink-soft">Chưa có việc nào ở đây</p>
          <p className="mt-1 max-w-xs text-xs text-ink-faint">
            Bấm “Gửi”, “Bình luận” hoặc “Nhắn tin” ở các màn hình khác để đưa việc
            vào hàng đợi chờ duyệt.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {windowed.map((j) => {
            const st = JOB_STATUS[j.status || ""] || {
              label: j.status || "?",
              cls: "border-line-soft bg-surface-2 text-ink-faint",
            };
            const isBusy = !!busy[j.id];
            return (
              <article
                key={j.id}
                className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="rounded-sm border border-line-soft bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-ink-faint">
                      {JOB_TYPE[j.type || ""] || j.type || "Việc"}
                    </span>
                    <span
                      className="truncate text-xs text-ink-faint"
                      title={targetLabel(j)}
                    >
                      {targetLabel(j)}
                    </span>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-sm border px-2 py-0.5 text-[11px] font-semibold",
                      st.cls,
                    )}
                  >
                    {st.label}
                  </span>
                </div>

                {j.content && (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                    {j.content}
                  </p>
                )}

                {Array.isArray(j.images) && j.images.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {j.images.slice(0, 6).map((src, i) => (
                      <img
                        key={i}
                        src={src}
                        alt=""
                        className="size-14 rounded-md border border-line-soft object-cover"
                      />
                    ))}
                  </div>
                )}

                {j.error && (
                  <div className="flex items-start gap-1.5 rounded-md border border-red-soft bg-red-soft/15 px-2.5 py-1.5 text-xs text-red">
                    <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                    <span className="min-w-0 break-words">Lỗi: {j.error}</span>
                  </div>
                )}

                {confirmDeleteId === j.id ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-red-soft bg-red-soft/15 px-3 py-2">
                    <span className="text-xs font-medium text-red">
                      Xóa việc này khỏi hàng đợi?
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft hover:text-ink"
                      >
                        <X className="size-3.5" />
                        Hủy
                      </button>
                      <button
                        onClick={() => deleteJob(j.id)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-1 rounded-sm bg-red px-2.5 py-1 text-xs font-semibold text-on-accent hover:opacity-90 disabled:opacity-50"
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
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-ink-faint">
                      {j.scheduledAt && j.scheduledAt > Date.now()
                        ? "Lên lịch: " +
                          new Date(j.scheduledAt).toLocaleString("vi-VN")
                        : "Tạo " + timeAgo(j.createdAt)}
                    </span>
                    <div className="flex items-center gap-2">
                      {j.status === "paused" && (
                        <>
                          <button
                            onClick={() => approveJob(j.id)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
                          >
                            {isBusy ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="size-3.5" />
                            )}
                            Duyệt
                          </button>
                          <button
                            onClick={() => runJob(j.id)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-50"
                          >
                            <PlayCircle className="size-3.5" />
                            Đăng ngay
                          </button>
                        </>
                      )}
                      {(j.status === "pending" || j.status === "error") && (
                        <button
                          onClick={() => runJob(j.id)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-50"
                        >
                          <PlayCircle className="size-3.5" />
                          Chạy ngay
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmDeleteId(j.id)}
                        className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:border-red-soft hover:text-red"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}

          {hasMore && (
            <div ref={sentinelRef} className="flex justify-center py-2">
              <button
                onClick={loadMore}
                className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
              >
                <Loader2 className="size-3.5 animate-spin text-accent" />
                Tải thêm ({shown}/{total})
              </button>
            </div>
          )}

          {/* Clear-all footer */}
          {confirmClearAll ? (
            <div className="flex items-center justify-between gap-3 rounded-md border border-red-soft bg-red-soft/15 px-4 py-2.5">
              <span className="text-sm font-medium text-red">
                Xóa toàn bộ {jobs.length} việc trong hàng đợi?
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setConfirmClearAll(false)}
                  className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft hover:text-ink"
                >
                  <X className="size-3.5" />
                  Hủy
                </button>
                <button
                  onClick={clearAll}
                  className="inline-flex items-center gap-1 rounded-sm bg-red px-2.5 py-1 text-xs font-semibold text-on-accent hover:opacity-90"
                >
                  <Trash2 className="size-3.5" />
                  Xóa tất cả
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmClearAll(true)}
              className="self-end text-xs font-medium text-ink-faint transition-colors hover:text-red"
            >
              Xóa tất cả việc
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ============================ TAB 2 — THU THẬP =========================== */
function CrawlTab({ flash }: { flash: FlashFn }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [stats, setStats] = useState<Stats>({});
  const [autoCrawl, setAutoCrawl] = useState<AutoCrawlConfig>({
    enabled: false,
    intervalMinutes: 30,
  });
  const [settings, setSettings] = useState<CrawlSettings>(CRAWL_DEFAULTS);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // Single-group crawl (nút Crawl trên 1 dòng) — local UI state only.
  const [crawlingId, setCrawlingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newGroupId, setNewGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Bulk crawl: queue + CRAWL_DONE listener sống NGOÀI React (bulkCrawl.ts)
  // để unmount CrawlTab (đổi tab Tools / rời view Công cụ) KHÔNG giết hàng đợi.
  const [bulkSnap, setBulkSnap] = useState<BulkCrawlSnapshot>(() => getBulkCrawlSnapshot());
  const bulk =
    bulkSnap.active || bulkSnap.phase === "done" || bulkSnap.phase === "aborted" || bulkSnap.phase === "stopped"
      ? { total: bulkSnap.total, done: bulkSnap.done }
      : null;
  // Tránh load() trùng khi remount giữa lúc bulk còn chạy.
  const lastBulkPhaseRef = useRef(bulkSnap.phase);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const [gres, sres, acres, store] = await Promise.all([
      bg<GroupsResponse>("GET_GROUPS"),
      bg<StatsResponse>("GET_STATS"),
      bg<AutoCrawlResponse>("GET_AUTOCRAWL"),
      storageGet(["crawlSettings"]),
    ]);
    if (!gres.ok) {
      setLoadError(gres.error || "Không tải được danh sách nhóm.");
      setGroups([]);
      setLoading(false);
      return;
    }
    setGroups(Array.isArray(gres.groups) ? gres.groups.filter((g) => g && g.groupId) : []);
    if (sres.ok && sres.stats) setStats(sres.stats);
    if (acres.ok && acres.config) {
      setAutoCrawl({
        enabled: !!acres.config.enabled,
        intervalMinutes: acres.config.intervalMinutes || 30,
      });
    }
    const saved = store.crawlSettings as Partial<CrawlSettings> | undefined;
    if (saved) setSettings({ ...CRAWL_DEFAULTS, ...saved });
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe driver snapshot — remount vẫn thấy đúng tiến độ bulk đang chạy.
  useEffect(() => {
    return subscribeBulkCrawl((snap) => {
      setBulkSnap(snap);
      if (snap.active) {
        setCrawlingId(snap.currentGroupId);
        if (snap.progress) setProgress(snap.progress);
      } else if (
        snap.phase === "done" ||
        snap.phase === "aborted" ||
        snap.phase === "stopped"
      ) {
        setCrawlingId(null);
        if (snap.progress) setProgress(snap.progress);
      } else if (snap.phase === "idle") {
        // Chỉ clear progress bulk sau khi driver idle; single crawl tự quản lý.
        if (
          lastBulkPhaseRef.current === "done" ||
          lastBulkPhaseRef.current === "aborted" ||
          lastBulkPhaseRef.current === "stopped"
        ) {
          setProgress(null);
        }
      }
      // Reload danh sách khi bulk kết thúc / abort / stop (một lần mỗi chuyển phase).
      if (
        (snap.phase === "done" || snap.phase === "aborted" || snap.phase === "stopped") &&
        lastBulkPhaseRef.current !== snap.phase
      ) {
        void load();
      }
      lastBulkPhaseRef.current = snap.phase;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Single-group crawl progress only (bulk UI đọc từ bulkSnap).
  useEffect(() => {
    interface ProgressMsg {
      type?: string;
      progress?: {
        status?: string;
        groupId?: string;
        groupName?: string;
        newCount?: number;
        scrolls?: number;
        pages?: number;
        seen?: number;
        knownHits?: number;
      };
      result?: { newCount?: number; reason?: string };
    }
    const handler = (msg: ProgressMsg) => {
      if (!msg || typeof msg.type !== "string") return;
      // Khi bulk driver đang active, nó đã mirror progress — bỏ qua để tránh đè text.
      if (isBulkCrawlActive()) return;
      if (msg.type === "CRAWL_PROGRESS" && msg.progress) {
        const p = msg.progress;
        const name = p.groupName || "nhóm";
        if (p.status === "started") setProgress(`Bắt đầu crawl ${name}…`);
        else if (p.status === "stopped_known")
          setProgress(`${name}: dừng vì gặp bài đã biết.`);
        else if (p.status === "stopped_old")
          setProgress(`${name}: dừng theo bộ lọc ngày.`);
        else if (p.status === "resting")
          setProgress(
            `${name}: nghỉ ngắn… (+${p.newCount || 0} bài, cuộn ${p.scrolls || 0})`,
          );
        else if (p.status === "page")
          setProgress(`${name}: +${p.newCount || 0} bài (trang ${p.pages || 0})`);
        else if (p.status === "done")
          setProgress(
            `${name}: xong +${p.newCount || 0} bài (cuộn ${p.scrolls || 0})`,
          );
        else {
          // crawling / scanning — hiện cả "đã quét" để UI không đứng yên khi
          // content đang lướt bài cũ (console vẫn log bình thường).
          const seenPart =
            typeof p.seen === "number" && p.seen > 0 ? ` · quét ${p.seen}` : "";
          setProgress(
            `${name}: +${p.newCount || 0} bài${seenPart} (cuộn ${p.scrolls || 0})`,
          );
        }
      } else if (msg.type === "CRAWL_DONE") {
        const r = msg.result || {};
        setCrawlingId(null);
        setProgress(
          `Xong: +${r.newCount || 0} bài${r.reason ? ` (${r.reason})` : ""}`,
        );
        void load();
        window.setTimeout(() => setProgress(null), 6000);
      }
    };
    try {
      chrome.runtime.onMessage.addListener(handler);
    } catch {
      /* not in extension context */
    }
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(handler);
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = groups.filter((g) => {
    const term = search.trim().toLowerCase();
    if (!term) return true;
    return (
      (g.groupName || "").toLowerCase().includes(term) ||
      g.groupId.includes(term)
    );
  });
  const {
    visible: windowed,
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  } = useIncremental(visible, { pageSize: 16 });

  async function scan() {
    setScanning(true);
    flash("info", "Đang mở trang “Nhóm của bạn” và quét…", 4000);
    const res = await bg<
      BgResponse & { scanned?: number; added?: number; updated?: number; removed?: number }
    >("SCAN_JOINED_GROUPS");
    setScanning(false);
    if (!res.ok) {
      flash("err", res.error || "Quét nhóm thất bại.");
      return;
    }
    flash(
      "ok",
      `Đã quét ${res.scanned ?? 0} nhóm (mới: ${res.added ?? 0}, cập nhật: ${res.updated ?? 0}, đã loại: ${res.removed ?? 0}).`,
    );
    load();
  }

  async function addGroup() {
    const raw = newGroupId.trim();
    const m = raw.match(/\/groups\/([^/?#]+)/);
    const groupId = m ? m[1] : raw;
    if (!groupId) {
      flash("err", "Hãy nhập Group ID hoặc link nhóm.");
      return;
    }
    const groupName = newGroupName.trim() || groupId;
    const res = await bg("SAVE_GROUP", { group: { groupId, groupName } });
    if (!res.ok) {
      flash("err", res.error || "Không lưu được nhóm.");
      return;
    }
    flash("ok", "Đã thêm nhóm.");
    setNewGroupId("");
    setNewGroupName("");
    setAddOpen(false);
    load();
  }

  async function crawl(g: Group) {
    if (isBulkCrawlActive()) {
      flash("err", "Đang crawl hàng loạt, hãy đợi xong hoặc bấm Dừng.");
      return;
    }
    const opts = buildCrawlOptions(settings);
    const handler = opts.method === "dom" ? "CRAWL_GROUP" : "CRAWL_GROUP_API";
    setCrawlingId(g.groupId);
    setProgress(`Đang mở & crawl ${g.groupName || g.groupId}…`);
    const res = await bg<BgResponse & { tabId?: number }>(handler, {
      groupId: g.groupId,
      options: opts,
    });
    if (!res.ok) {
      flash("err", res.error || "Không crawl được nhóm này.");
      setCrawlingId(null);
      setProgress(null);
    }
    // Success: live updates arrive via CRAWL_PROGRESS / CRAWL_DONE.
  }

  // ── Bulk crawl ──────────────────────────────────────────────────────────
  // Driver thật ở ui/src/lib/bulkCrawl.ts (module singleton). CrawlTab chỉ
  // start/stop + hiển thị snapshot. Unmount tab không còn giết hàng đợi.
  function startBulk(list: Group[]) {
    if (isBulkCrawlActive()) {
      flash("err", "Đang có phiên crawl hàng loạt.");
      return;
    }
    if (crawlingId) {
      flash("err", "Đang có một nhóm đang crawl, hãy đợi xong đã.");
      return;
    }
    const queue = list.filter((g) => g && g.groupId);
    const res = startBulkCrawl(
      queue.map((g) => ({ groupId: g.groupId, groupName: g.groupName })),
      buildCrawlOptions(settings),
    );
    if (!res.ok) {
      flash("err", res.error || "Không bắt đầu được crawl hàng loạt.");
      return;
    }
    flash("info", `Bắt đầu crawl ${queue.length} nhóm (tuần tự).`, 4000);
  }

  function stopBulk() {
    stopBulkCrawl();
  }

  function toggleSelect(groupId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function deleteGroup(groupId: string) {
    const res = await bg("DELETE_GROUP", { groupId });
    setConfirmDeleteId(null);
    if (!res.ok) {
      flash("err", res.error || "Không xóa được nhóm.");
      return;
    }
    flash("ok", "Đã xóa nhóm.");
    load();
  }

  async function saveAuto(enabled: boolean, interval: number) {
    setAutoCrawl({ enabled, intervalMinutes: interval });
    const res = await bg<AutoCrawlResponse>("SET_AUTOCRAWL", {
      config: { enabled, intervalMinutes: interval },
    });
    if (!res.ok) {
      flash("err", res.error || "Không lưu được lịch tự động.");
      return;
    }
    flash(
      "ok",
      enabled ? `Tự động crawl mỗi ${interval} phút.` : "Đã tắt tự động crawl.",
    );
  }

  if (loading) return <ListSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-soft">
            <Radar className="size-4 text-accent" />
            <span>
              {groups.length} nhóm · {stats.total ?? 0} bài đã thu thập
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAddOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
            >
              <Plus className="size-3.5" />
              Thêm nhóm
            </button>
            <button
              onClick={scan}
              disabled={scanning}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
            >
              {scanning ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Quét nhóm đã tham gia
            </button>
          </div>
        </div>

        {/* Bulk crawl actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
          <button
            onClick={() => startBulk(groups)}
            disabled={!!bulk || !!crawlingId || groups.length === 0}
            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
          >
            <Download className="size-3.5" />
            Crawl tất cả ({groups.length})
          </button>
          <button
            onClick={() =>
              startBulk(groups.filter((g) => selected.has(g.groupId)))
            }
            disabled={!!bulk || !!crawlingId || selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-50"
          >
            <ListChecks className="size-3.5" />
            Crawl nhóm đã chọn ({selected.size})
          </button>
          {selected.size > 0 && !bulk && (
            <button
              onClick={() => setSelected(new Set())}
              className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-ink-faint transition-colors hover:text-ink"
            >
              <X className="size-3.5" />
              Bỏ chọn
            </button>
          )}
          {bulk && (
            <div className="ml-auto flex items-center gap-2 text-xs text-ink-soft">
              <Loader2 className="size-3.5 animate-spin text-accent" />
              <span>
                Đang crawl {bulk.done}/{bulk.total} nhóm…
              </span>
              <button
                onClick={stopBulk}
                className="inline-flex items-center gap-1 rounded-sm border border-red-soft bg-red-soft/15 px-2 py-1 text-xs font-medium text-red transition-colors hover:bg-red-soft/30"
              >
                <X className="size-3.5" />
                Dừng
              </button>
            </div>
          )}
        </div>

        {addOpen && (
          <div className="flex flex-col gap-2 rounded-md border border-line-soft bg-bg/40 px-3 py-2.5">
            <input
              value={newGroupId}
              onChange={(e) => setNewGroupId(e.target.value)}
              placeholder="Group ID hoặc link nhóm"
              className="rounded-sm border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
            />
            <div className="flex items-center gap-2">
              <input
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="Tên hiển thị (tùy chọn)"
                className="min-w-0 flex-1 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
              />
              <button
                onClick={addGroup}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-bright"
              >
                <Plus className="size-3.5" />
                Thêm
              </button>
            </div>
          </div>
        )}

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Tìm nhóm theo tên hoặc ID…"
          className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
        />
      </div>

      {/* Auto-crawl schedule */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={!!autoCrawl.enabled}
            onChange={(e) =>
              saveAuto(e.target.checked, autoCrawl.intervalMinutes || 30)
            }
            className="size-4 accent-[var(--accent)]"
          />
          Tự động crawl định kỳ
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-faint">
          Chu kỳ
          <select
            value={autoCrawl.intervalMinutes || 30}
            onChange={(e) =>
              saveAuto(!!autoCrawl.enabled, Number(e.target.value))
            }
            className="rounded-sm border border-line bg-surface-2 px-2 py-1 text-sm text-ink outline-none focus:border-accent/60"
          >
            {INTERVALS.map((n) => (
              <option key={n} value={n}>
                {n} phút
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Live progress */}
      {progress && (
        <div className="flex items-center gap-2 rounded-md border border-accent-soft bg-accent-soft/20 px-4 py-2.5 text-sm text-accent-ink">
          {crawlingId ? (
            <Loader2 className="size-4 shrink-0 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0" />
          )}
          {progress}
        </div>
      )}

      {loadError ? (
        <div className="flex items-center gap-2 rounded-lg border border-red-soft bg-red-soft/20 px-4 py-3 text-sm text-red">
          <AlertCircle className="size-4 shrink-0" />
          {loadError}
        </div>
      ) : visible.length === 0 ? (
        <div className="grid place-items-center rounded-lg border border-line bg-surface px-4 py-14 text-center">
          <Radar className="mb-3 size-8 text-ink-faint" />
          <p className="text-sm font-medium text-ink-soft">Chưa có nhóm nào</p>
          <p className="mt-1 max-w-xs text-xs text-ink-faint">
            Bấm “Quét nhóm đã tham gia” để tự lấy danh sách, hoặc “Thêm nhóm” thủ
            công.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {windowed.map((g) => {
            const busy = crawlingId === g.groupId;
            return (
              <article
                key={g.groupId}
                className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3"
              >
                <div className="flex items-center gap-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(g.groupId)}
                    onChange={() => toggleSelect(g.groupId)}
                    disabled={!!bulk}
                    className="size-4 shrink-0 accent-[var(--accent)] disabled:opacity-50"
                    title="Chọn để crawl hàng loạt"
                  />
                  <Avatar name={g.groupName || g.groupId} />
                  <div className="min-w-0">
                    <div
                      className="truncate text-sm font-semibold text-ink"
                      title={g.groupName || g.groupId}
                    >
                      {g.groupName || g.groupId}
                    </div>
                    <div className="truncate text-xs text-ink-faint">
                      {g.postCount || 0} bài · {timeAgo(g.updatedAt) || "chưa crawl"}
                    </div>
                  </div>
                </div>

                {confirmDeleteId === g.groupId ? (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-red-soft bg-red-soft/15 px-2.5 py-1.5">
                    <span className="text-xs font-medium text-red">Xóa nhóm?</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-sm border border-line bg-surface px-2 py-1 text-xs text-ink-soft hover:text-ink"
                      >
                        Hủy
                      </button>
                      <button
                        onClick={() => deleteGroup(g.groupId)}
                        className="rounded-sm bg-red px-2 py-1 text-xs font-semibold text-on-accent hover:opacity-90"
                      >
                        Xóa
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => crawl(g)}
                      disabled={busy || !!crawlingId || !!bulk}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-sm bg-accent px-2.5 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Download className="size-3.5" />
                      )}
                      Crawl
                    </button>
                    <a
                      href={`https://www.facebook.com/groups/${g.groupId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center gap-1 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                    <button
                      onClick={() => setConfirmDeleteId(g.groupId)}
                      className="inline-flex items-center justify-center rounded-sm border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-faint transition-colors hover:border-red-soft hover:text-red"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </article>
            );
          })}
          {hasMore && (
            <div
              ref={sentinelRef}
              className="col-span-full flex justify-center py-2"
            >
              <button
                onClick={loadMore}
                className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
              >
                <Loader2 className="size-3.5 animate-spin text-accent" />
                Tải thêm ({shown}/{total})
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ========================= TAB 3 — NUÔI TÀI KHOẢN ======================== */
// Giữ tài khoản "còn sống" bằng các hành động ĐỌC thụ động (cuộn bảng tin, xem
// video, mở thông báo) chạy theo lịch. TẤT CẢ cấu hình + nhật ký đều lưu ở
// SERVER (BE) qua các message WARMING_* -> crawl.js -> DB, không dùng
// chrome.storage.local. Không có hành động ghi (đăng/bình luận) để tránh cờ spam.

interface WarmingConfig {
  enabled: boolean;
  intervalMinutes: number;
  actionsPerRun: number;
  actions: string[];
  useOwnedTabOnly?: boolean;
  maxSessionsPerDay?: number;
  maxWritePerDay?: number;
  writeCooldownMinutes?: number;
  reactionChancePercent?: number;
  minSessionGapMinutes?: number;
  quietHoursStart?: number;
  quietHoursEnd?: number;
  riskFailThreshold?: number;
  riskBackoffMultiplier?: number;
  nextRunAt?: number | null;
  delayMinutes?: number;
}

interface WarmingStateSummary {
  sessionsToday?: number;
  writeCountToday?: number;
  riskLevel?: number;
  recentFailCount?: number;
  lastSessionAt?: number;
}

interface WarmingConfigResponse extends BgResponse {
  config?: WarmingConfig;
  state?: WarmingStateSummary | null;
  nextRunAt?: number | null;
  delayMinutes?: number;
  source?: "server" | "default" | "cache" | string;
  stale?: boolean;
  status?: string;
  found?: boolean;
  retryable?: boolean;
}

interface BindingStatus {
  fbId: string | null;
  fbName: string | null;
  matchCode?: string;
  matchOk?: boolean;
  current?: string | null;
  stale?: boolean;
  source?: string;
}

type WarmingActivityEntry = WarmingDiagnosticEntry;

interface WarmingActivityResponse extends BgResponse {
  entries?: unknown;
}

interface WarmingSkippedWrite {
  action?: string;
  ok?: boolean;
  code?: string;
  reason?: string;
}

interface WarmingRunResponse extends BgResponse {
  done?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  skippedWrites?: WarmingSkippedWrite[];
  unverified?: number;
  noOp?: number;
  attempted?: number;
  blocked?: boolean;
  stopped?: boolean;
  deferred?: boolean;
}

// Các hành động hợp lệ, khớp WARMING_ACTIONS trong src/crawl.js.
// Nhóm GHI (tương tác thật): reactPost, reactReels — khớp WARMING_WRITE_ACTIONS.
const WARMING_WRITE_ACTION_IDS = ["reactPost", "reactReels"];
const WARMING_ACTION_LABELS: { id: string; label: string; hint: string }[] = [
  { id: "scrollFeed", label: "Cuộn bảng tin", hint: "Lướt News Feed vài nhịp." },
  { id: "watchVideo", label: "Xem video", hint: "Mở Watch, xem ngắn một video." },
  {
    id: "openNotifications",
    label: "Mở thông báo",
    hint: "Ghé trang thông báo một lượt.",
  },
  {
    id: "scrollGroups",
    label: "Lướt feed nhóm",
    hint: "Mở feed các nhóm đã tham gia, cuộn xem vài nhịp.",
  },
  {
    id: "scrollReels",
    label: "Lướt Reels",
    hint: "Mở Reels (thước phim), xem và lướt vài video như người xem thật.",
  },
  {
    id: "reactPost",
    label: "Thả cảm xúc bài viết",
    hint: "Tương tác thật (bấm Thích). Rất dễ dính checkpoint với tài khoản mới nên chỉ thực hiện ngẫu nhiên ~30% số lượt, tối đa 1 bài.",
  },
  {
    id: "reactReels",
    label: "Thả cảm xúc Reels",
    hint: "Thực hiện theo tỷ lệ thả cảm xúc chung, tối đa 1 Reel; vẫn áp dụng giới hạn ngày và cooldown.",
  },
];

// Chu kỳ nuôi (phút). Rộng hơn INTERVALS của crawl vì hành vi này nên thưa.
const WARMING_INTERVALS = [15, 30, 60, 90, 120, 240, 480, 720, 1440];

function warmingIntervalLabel(n: number): string {
  if (n < 60) return `${n} phút`;
  const h = n / 60;
  return Number.isInteger(h) ? `${h} giờ` : `${(n / 60).toFixed(1)} giờ`;
}

const WARMING_STATUS_LABELS: Record<string, string> = {
  done: "Xong",
  success: "Xong",
  error: "Lỗi",
  blocked: "Bị chặn",
  stopped: "Đã dừng",
  no_op: "Không có đối tượng",
  unverified: "Chưa xác minh",
  skipped: "Bỏ qua",
  deferred: "Hoãn",
};

function warmingActionLabel(type: string): string {
  return WARMING_ACTION_LABELS.find((a) => a.id === type)?.label || type;
}

function formatNextRunAt(ts?: number | null): string {
  if (ts == null || !Number.isFinite(ts)) return "Chưa lên lịch";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function WarmingTab({ flash }: { flash: FlashFn }) {
  const [config, setConfig] = useState<WarmingConfig>({
    enabled: false,
    intervalMinutes: 90,
    actionsPerRun: 3,
    useOwnedTabOnly: true,
    maxSessionsPerDay: 8,
    maxWritePerDay: 3,
    writeCooldownMinutes: 90,
    minSessionGapMinutes: 20,
    quietHoursStart: 0,
    quietHoursEnd: 6,
    // Các hành động GHI (reactPost/reactReels) là tương tác thật nên KHÔNG bật
    // sẵn; người dùng phải chủ động tích. Khớp mặc định phía backend
    // (WARMING_DEFAULT chỉ bật các loại read-only).
    actions: WARMING_ACTION_LABELS.filter(
      (a) => !WARMING_WRITE_ACTION_IDS.includes(a.id),
    ).map((a) => a.id),
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [entries, setEntries] = useState<WarmingActivityEntry[]>([]);
  const [logLoading, setLogLoading] = useState(true);
  const [warmingState, setWarmingState] = useState<WarmingStateSummary | null>(
    null,
  );
  const [binding, setBinding] = useState<BindingStatus | null>(null);
  // RISK-BE-04: config may be default/stale when Backend is unavailable.
  const [configMeta, setConfigMeta] = useState<{
    stale: boolean;
    source: string;
    status: string;
  }>({ stale: false, source: "server", status: "found" });

  async function loadBinding() {
    try {
      const [bindRes, matchRes] = await Promise.all([
        bg<
          BgResponse & {
            binding?: { fbId: string | null; fbName: string | null };
            stale?: boolean;
            source?: string;
          }
        >("FB_GET_BINDING", {}),
        bg<
          BgResponse & {
            code?: string;
            bound?: string | null;
            current?: string | null;
            boundName?: string | null;
          }
        >("FB_CHECK_MATCH", {}),
      ]);
      const b = bindRes.binding || { fbId: null, fbName: null };
      const code = matchRes.code || "";
      const matchOk =
        code === "OK" || code === "UNBOUND"
          ? true
          : code === "MISMATCH" || code === "FB_ABSENT"
            ? false
            : !!matchRes.ok;
      setBinding({
        fbId: b.fbId ?? null,
        fbName: b.fbName ?? null,
        matchCode: code || undefined,
        matchOk,
        current: matchRes.current ?? null,
        stale: !!bindRes.stale,
        source: bindRes.source,
      });
    } catch {
      setBinding(null);
    }
  }

  async function loadConfig() {
    setLoading(true);
    const res = await bg<WarmingConfigResponse>("GET_WARMING_CONFIG", {});
    if (res.config) {
      setConfig({
        ...res.config,
        nextRunAt: res.nextRunAt ?? res.config.nextRunAt ?? null,
        delayMinutes: res.delayMinutes ?? res.config.delayMinutes,
      });
    }
    if (res.state) setWarmingState(res.state);
    setConfigMeta({
      stale: !!res.stale || !res.ok,
      source: res.source || (res.ok ? "server" : "default"),
      status: res.status || (res.ok ? "found" : "server_error"),
    });
    if (!res.ok) {
      flash(
        "info",
        res.error ||
          "Không kết nối được Backend — đang hiển thị cấu hình mặc định (stale).",
      );
    }
    setLoading(false);
  }

  async function loadLog() {
    setLogLoading(true);
    const res = await bg<WarmingActivityResponse>("GET_WARMING_ACTIVITY", {
      limit: 30,
    });
    if (res.ok) setEntries(normalizeWarmingActivityEntries(res.entries));
    setLogLoading(false);
  }

  useEffect(() => {
    void loadConfig();
    void loadLog();
    void loadBinding();
  }, []);

  // Lắng nghe tiến trình realtime WARMING_PROGRESS từ service worker (giống
  // cách CrawlTab nghe CRAWL_PROGRESS). Mỗi hành động xong sẽ đẩy một nhịp.
  useEffect(() => {
    interface WarmingProgressMsg {
      type?: string;
      action?: string;
      status?: string;
      done?: number;
      total?: number;
    }
    const handler = (msg: WarmingProgressMsg) => {
      if (!msg || msg.type !== "WARMING_PROGRESS") return;
      const label = warmingActionLabel(msg.action || "");
      const done = msg.done || 0;
      const total = msg.total || 0;
      if (msg.status === "blocked") {
        setProgress(`Dừng vì có dấu hiệu bị chặn (${label}).`);
      } else if (msg.status === "error") {
        setProgress(`${label}: lỗi (${done}/${total}).`);
      } else {
        setProgress(`${label}: xong (${done}/${total}).`);
      }
      // Làm mới nhật ký khi vừa có hành động mới ghi lên server.
      void loadLog();
    };
    try {
      chrome.runtime.onMessage.addListener(handler);
    } catch {
      /* not in extension context */
    }
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(handler);
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function computeNextActions(current: string[], id: string): string[] {
    const has = current.includes(id);
    const next = has ? current.filter((a) => a !== id) : [...current, id];
    // Luôn giữ ít nhất một hành động để mỗi lượt có việc để làm.
    return next.length ? next : current;
  }

  async function save(patch: Partial<WarmingConfig>) {
    const next = { ...config, ...patch };
    setConfig(next);
    setSaving(true);
    const res = await bg<WarmingConfigResponse>("SET_WARMING_CONFIG", {
      config: next,
    });
    setSaving(false);
    if (!res.ok) {
      flash("err", res.error || "Không lưu được cấu hình.");
      return;
    }
    if (res.config) setConfig(res.config);
    flash("ok", "Đã lưu cấu hình nuôi tài khoản.");
  }

  async function toggleActionAndSave(id: string) {
    const nextActions = computeNextActions(config.actions, id);
    if (nextActions === config.actions) return;
    await save({ actions: nextActions });
  }

  async function runNow() {
    // Soft gate: warn on binding mismatch / FB absent; still allow user to force
    // if they confirm (backend processWarming will hard-block if needed).
    if (binding && binding.matchOk === false) {
      const msg =
        binding.matchCode === "MISMATCH"
          ? "Facebook đang đăng nhập không khớp tài khoản đã liên kết. Vẫn chạy?"
          : binding.matchCode === "FB_ABSENT"
            ? "Không thấy Facebook đăng nhập. Vẫn chạy?"
            : "Trạng thái binding không ổn định. Vẫn chạy?";
      const ok = window.confirm(msg);
      if (!ok) return;
    }
    setRunning(true);
    setProgress("Đang chạy một lượt nuôi tài khoản…");
    const res = await bg<WarmingRunResponse>("WARMING_RUN_NOW", {
      actionsPerRun: config.actionsPerRun,
    });
    setRunning(false);
    if (!res.ok && !res.blocked && !res.stopped && !res.deferred) {
      setProgress(null);
      flash("err", res.error || "Không chạy được lượt nuôi tài khoản.");
      return;
    }
    const succeeded = res.succeeded ?? res.done ?? 0;
    const failed = res.failed ?? 0;
    const unverified = res.unverified ?? 0;
    const noOp = res.noOp ?? 0;
    const skippedWriteReasons = Array.isArray(res.skippedWrites)
      ? res.skippedWrites
          .map((item) => {
            const action = warmingActionLabel(item.action || "");
            const code = item.code ? ` (${item.code})` : "";
            return item.reason ? `${action}${code}: ${item.reason}` : `${action}${code}`;
          })
          .filter(Boolean)
      : [];
    if (res.blocked) {
      setProgress("Lượt chạy dừng sớm: có dấu hiệu bị chặn / sai tài khoản.");
      flash("info", res.error || "Đã dừng vì FB chặn hoặc sai tài khoản.");
    } else if (res.deferred) {
      setProgress(res.error || "Hoãn phiên theo chính sách.");
      flash("info", res.error || "Hoãn phiên nuôi tài khoản.");
    } else if (res.stopped) {
      setProgress(
        `Đã dừng (thành công ${succeeded}, lỗi ${failed}, chưa xác minh ${unverified}).`,
      );
      flash("info", "Đã dừng lượt nuôi tài khoản.");
    } else if ((res.attempted ?? 0) === 0 && skippedWriteReasons.length > 0) {
      const reasonText = skippedWriteReasons.join(" · ");
      setProgress(`Chưa chạy hành động: ${reasonText}`);
      flash("info", `Hành động ghi chưa được thực thi: ${reasonText}`);
    } else {
      setProgress(
        `Thành công ${succeeded}` +
          (failed ? `, lỗi ${failed}` : "") +
          (unverified ? `, chưa xác minh ${unverified}` : "") +
          (noOp ? `, không đối tượng ${noOp}` : "") +
          ".",
      );
      flash(
        "ok",
        `Đã nuôi: ${succeeded} thành công` +
          (failed ? `, ${failed} lỗi` : "") +
          ".",
      );
    }
    window.setTimeout(() => setProgress(null), 8000);
    void loadLog();
    void loadConfig();
    void loadBinding();
  }

  async function stopNow() {
    setProgress("Đang dừng lượt nuôi tài khoản…");
    await bg("WARMING_STOP", {});
    // processWarming sẽ thoát ở lần kiểm tra kế tiếp; nhật ký tự làm mới qua
    // WARMING_PROGRESS. Không tắt cờ running ở đây để tránh nhấp Chạy chồng.
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <ListSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Bảng điều khiển chính: bật/tắt, chu kỳ, số hành động, chạy ngay. */}
      <section className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Flame size={18} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-ink">Nuôi tài khoản</h2>
              <p className="mt-0.5 max-w-md text-xs text-ink-faint">
                Chạy các hành động đọc thụ động theo lịch để tài khoản trông tự
                nhiên. Không đăng bài, không bình luận.
              </p>
              {configMeta.stale ? (
                <p className="mt-1 text-xs text-amber-600">
                  Cấu hình đang là {configMeta.source === "default" ? "mặc định" : configMeta.source}
                  {" "}(Backend: {configMeta.status}). Automation sẽ không chạy cho đến khi đọc lại được server.
                </p>
              ) : null}
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={config.enabled}
              disabled={saving}
              onChange={(e) => void save({ enabled: e.target.checked })}
            />
            <span>{config.enabled ? "Đang bật" : "Đang tắt"}</span>
          </label>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Chu kỳ chạy
            <select
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.intervalMinutes}
              disabled={saving}
              onChange={(e) =>
                void save({ intervalMinutes: parseInt(e.target.value, 10) })
              }
            >
              {WARMING_INTERVALS.map((n) => (
                <option key={n} value={n}>
                  Mỗi {warmingIntervalLabel(n)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Số việc tối đa mỗi lượt
            <input
              type="number"
              min={1}
              max={8}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.actionsPerRun}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  actionsPerRun: clamp(
                    parseInt(e.target.value, 10),
                    1,
                    8,
                    c.actionsPerRun,
                  ),
                }))
              }
              onBlur={() => void save({ actionsPerRun: config.actionsPerRun })}
            />
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-line-soft bg-surface-2/40 px-3 py-2 text-xs text-ink-soft">
          <span>
            Lịch kế tiếp:{" "}
            <span className="font-medium text-ink">
              {formatNextRunAt(config.nextRunAt)}
            </span>
            {config.enabled ? null : (
              <span className="text-ink-faint"> (đang tắt)</span>
            )}
          </span>
          {warmingState ? (
            <>
              <span>
                Phiên hôm nay:{" "}
                <span className="font-medium text-ink">
                  {warmingState.sessionsToday ?? 0}
                  {config.maxSessionsPerDay != null
                    ? `/${config.maxSessionsPerDay}`
                    : ""}
                </span>
              </span>
              <span>
                Tương tác ghi:{" "}
                <span className="font-medium text-ink">
                  {warmingState.writeCountToday ?? 0}
                  {config.maxWritePerDay != null
                    ? `/${config.maxWritePerDay}`
                    : ""}
                </span>
              </span>
              {(warmingState.riskLevel ?? 0) > 0 ? (
                <span className="text-amber-600">
                  Risk level {warmingState.riskLevel}
                  {warmingState.recentFailCount
                    ? ` (${warmingState.recentFailCount} lỗi gần đây)`
                    : ""}
                </span>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Tỷ lệ thả cảm xúc (%)
            <input
              type="number"
              min={0}
              max={100}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.reactionChancePercent ?? 30}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  reactionChancePercent: clamp(
                    parseInt(e.target.value, 10),
                    0,
                    100,
                    c.reactionChancePercent ?? 30,
                  ),
                }))
              }
              onBlur={() =>
                void save({ reactionChancePercent: config.reactionChancePercent })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Tối đa phiên/ngày
            <input
              type="number"
              min={1}
              max={48}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.maxSessionsPerDay ?? 8}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  maxSessionsPerDay: clamp(
                    parseInt(e.target.value, 10),
                    1,
                    48,
                    c.maxSessionsPerDay ?? 8,
                  ),
                }))
              }
              onBlur={() =>
                void save({ maxSessionsPerDay: config.maxSessionsPerDay })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Tối đa ghi/ngày
            <input
              type="number"
              min={0}
              max={20}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.maxWritePerDay ?? 3}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  maxWritePerDay: clamp(
                    parseInt(e.target.value, 10),
                    0,
                    20,
                    c.maxWritePerDay ?? 3,
                  ),
                }))
              }
              onBlur={() => void save({ maxWritePerDay: config.maxWritePerDay })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Cooldown ghi (phút)
            <input
              type="number"
              min={15}
              max={1440}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.writeCooldownMinutes ?? 90}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  writeCooldownMinutes: clamp(
                    parseInt(e.target.value, 10),
                    15,
                    1440,
                    c.writeCooldownMinutes ?? 90,
                  ),
                }))
              }
              onBlur={() =>
                void save({ writeCooldownMinutes: config.writeCooldownMinutes })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Nghỉ giữa phiên (phút)
            <input
              type="number"
              min={0}
              max={720}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.minSessionGapMinutes ?? 20}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  minSessionGapMinutes: clamp(
                    parseInt(e.target.value, 10),
                    0,
                    720,
                    c.minSessionGapMinutes ?? 20,
                  ),
                }))
              }
              onBlur={() =>
                void save({
                  minSessionGapMinutes: config.minSessionGapMinutes,
                })
              }
            />
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Giờ yên lặng bắt đầu
            <input
              type="number"
              min={0}
              max={23}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.quietHoursStart ?? 0}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  quietHoursStart: clamp(
                    parseInt(e.target.value, 10),
                    0,
                    23,
                    c.quietHoursStart ?? 0,
                  ),
                }))
              }
              onBlur={() =>
                void save({ quietHoursStart: config.quietHoursStart })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Giờ yên lặng kết thúc
            <input
              type="number"
              min={0}
              max={23}
              className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent/50"
              value={config.quietHoursEnd ?? 6}
              disabled={saving}
              onChange={(e) =>
                setConfig((c) => ({
                  ...c,
                  quietHoursEnd: clamp(
                    parseInt(e.target.value, 10),
                    0,
                    23,
                    c.quietHoursEnd ?? 6,
                  ),
                }))
              }
              onBlur={() => void save({ quietHoursEnd: config.quietHoursEnd })}
            />
          </label>
          <p className="col-span-2 self-end text-xs text-ink-faint sm:col-span-2">
            Cửa sổ yên lặng theo giờ máy local (bắt đầu inclusive, kết thúc
            exclusive). Đặt hai giá trị bằng nhau để tắt. Ví dụ 0→6 = nửa đêm đến
            6h sáng.
          </p>
        </div>

        {binding ? (
          <div
            className={cn(
              "rounded-md border px-3 py-2.5 text-xs",
              binding.matchOk === false
                ? "border-rose-300/60 bg-rose-500/5 text-rose-700"
                : binding.stale
                  ? "border-amber-300/60 bg-amber-500/5 text-amber-800"
                  : "border-line-soft bg-surface-2/40 text-ink-soft",
            )}
          >
            <div className="font-medium text-ink">
              Binding Facebook
              {binding.fbName ? `: ${binding.fbName}` : ""}
              {binding.fbId ? ` (${binding.fbId})` : " — chưa liên kết"}
            </div>
            <div className="mt-0.5">
              {binding.matchOk === false
                ? binding.matchCode === "MISMATCH"
                  ? `Tài khoản đang đăng nhập${binding.current ? ` (${binding.current})` : ""} không khớp binding. Chạy ngay có thể bị chặn.`
                  : binding.matchCode === "FB_ABSENT"
                    ? "Không thấy Facebook đăng nhập trên trình duyệt. Chạy ngay có thể bị chặn."
                    : "Trạng thái binding không ổn định."
                : binding.stale
                  ? "Binding lấy từ cache (Backend lỗi) — có thể lệch."
                  : binding.fbId
                    ? "Binding khớp / sẵn sàng."
                    : "Chưa bind: warming vẫn chạy nhưng nên liên kết tài khoản để tránh nhầm profile."}
            </div>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-ink-soft">
            Hành động cho phép
          </span>
          <div className="flex flex-col gap-2">
            {WARMING_ACTION_LABELS.map((a) => (
              <label
                key={a.id}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line-soft bg-surface-2/40 px-3 py-2.5 text-sm text-ink-soft"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 accent-accent"
                  checked={config.actions.includes(a.id)}
                  disabled={saving}
                  onChange={() => {
                    void toggleActionAndSave(a.id);
                  }}
                />
                <span className="flex flex-col">
                  <span className="text-ink">{a.label}</span>
                  <span className="text-xs text-ink-faint">{a.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-line-soft bg-surface-2/40 px-3 py-2.5 text-sm text-ink-soft">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-accent"
            checked={config.useOwnedTabOnly !== false}
            disabled={saving}
            onChange={(e) => void save({ useOwnedTabOnly: e.target.checked })}
          />
          <span className="flex flex-col">
            <span className="text-ink">Dùng tab riêng (khuyến nghị)</span>
            <span className="text-xs text-ink-faint">
              Mở tab Facebook do extension sở hữu, không chiếm tab bạn đang đọc
              hoặc soạn thảo.
            </span>
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-3 border-t border-line-soft pt-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            onClick={() => void runNow()}
            disabled={running || saving}
          >
            {running ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <PlayCircle size={15} />
            )}
            Chạy ngay một lượt
          </button>
          {running ? (
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-red-soft hover:text-red disabled:opacity-50"
              onClick={() => void stopNow()}
            >
              <StopCircle size={15} />
              Dừng
            </button>
          ) : null}
          {progress ? (
            <span className="text-xs text-ink-faint">{progress}</span>
          ) : null}
        </div>
      </section>

      {/* Nhật ký hành động (lưu trên SERVER, tải qua GET_WARMING_ACTIVITY). */}
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Nhật ký gần đây</h3>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-ink-soft transition-colors hover:border-accent/40 disabled:opacity-50"
            onClick={() => void loadLog()}
            disabled={logLoading}
          >
            <RefreshCw
              size={13}
              className={logLoading ? "animate-spin" : ""}
            />
            Làm mới
          </button>
        </div>
        {logLoading ? (
          <ListSkeleton />
        ) : entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-faint">
            Chưa có hành động nào được ghi.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line-soft">
            {entries.map((e) => {
              const diagnostic = warmingDiagnosticText(e);
              return (
                <li
                  key={e.id}
                  className="flex items-start justify-between gap-3 py-2.5 text-sm"
                >
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      className={cn(
                        "mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                        e.status === "done" || e.status === "success"
                          ? "bg-emerald-500/10 text-emerald-500"
                          : e.status === "blocked" ||
                              e.status === "deferred" ||
                              e.status === "unverified" ||
                              e.status === "no_op" ||
                              e.status === "skipped"
                            ? "bg-amber-500/10 text-amber-500"
                            : "bg-rose-500/10 text-rose-500",
                      )}
                    >
                      {e.status === "done" || e.status === "success" ? (
                        <CheckCircle2 size={14} />
                      ) : (
                        <AlertCircle size={14} />
                      )}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-ink">
                          {warmingActionLabel(e.type)}
                        </span>
                        <span className="text-xs text-ink-faint">
                          {WARMING_STATUS_LABELS[e.status] || "Không xác định"}
                        </span>
                      </div>
                      {diagnostic ? (
                        <p
                          className="mt-1 break-words text-xs leading-5 text-ink-faint"
                          title={diagnostic}
                        >
                          {diagnostic}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs text-ink-faint">
                    {timeAgo(e.createdAt ?? undefined)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ============================ TAB 4 — CẤU HÌNH =========================== */
function ConfigTab({ flash }: { flash: FlashFn }) {
  const [ai, setAi] = useState<AiConfig>({
    apiBase: "",
    apiKey: "",
    model: "gpt-5.5",
  });
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [customModel, setCustomModel] = useState("");
  // Trạng thái key trên SERVER: server không trả key thô nên UI chỉ biết ĐÃ có
  // key hay chưa (hasKey) và bản che (keyMasked, vd "••••abcd") để hiện gợi ý.
  // Ô nhập key luôn để TRỐNG lúc tải; người dùng chỉ gõ khi muốn đổi key.
  const [hasKey, setHasKey] = useState(false);
  const [keyMasked, setKeyMasked] = useState("");
  const [settings, setSettings] = useState<CrawlSettings>(CRAWL_DEFAULTS);
  // Công tắc focus tab (bật/tắt) — lưu RIÊNG ở key "focusTabs" trong
  // chrome.storage.local (KHÔNG lồng trong crawlSettings) vì service worker đọc
  // đúng key này qua shouldFocusTabs() trong src/crawl.js. Mặc định false =>
  // mọi tab nhiệm vụ mở ở NỀN, không nhảy tab.
  const [focusTabs, setFocusTabs] = useState(false);
  const [stats, setStats] = useState<Stats>({});
  const [loading, setLoading] = useState(true);
  const [savingAi, setSavingAi] = useState(false);
  const [reloadingModels, setReloadingModels] = useState(false);
  const [savingCrawl, setSavingCrawl] = useState(false);
  const [confirmClearPosts, setConfirmClearPosts] = useState(false);

  async function load() {
    setLoading(true);
    // aiConfig sống trên SERVER theo tài khoản (GET /api/me/ai-config). Đây cũng
    // là nơi service worker dùng key để phân tích/soạn nội dung, nên key KHÔNG
    // rời server. Server chỉ trả apiBase/model + hasKey/keyMasked, KHÔNG trả key
    // thô. aiModelList/crawlSettings chỉ dùng nội bộ tab này nên vẫn ở local.
    const [store, sres, aiRes] = await Promise.all([
      storageGet(["aiModelList", "crawlSettings", "focusTabs"]),
      bg<StatsResponse>("GET_STATS"),
      bg<AiConfigResponse>("GET_AI_CONFIG"),
    ]);
    const cfg = (aiRes.ok && aiRes.config) || {};
    setAi({
      apiBase: cfg.apiBase || "",
      apiKey: "", // luôn trống — server không trả key thô
      model: cfg.model || "gpt-5.5",
    });
    setHasKey(!!cfg.hasKey);
    setKeyMasked(cfg.keyMasked || "");
    const cached = store.aiModelList;
    if (Array.isArray(cached) && cached.length) setModels(cached as string[]);
    const saved = store.crawlSettings as Partial<CrawlSettings> | undefined;
    if (saved) setSettings({ ...CRAWL_DEFAULTS, ...saved });
    setFocusTabs(store.focusTabs === true);
    if (sres.ok && sres.stats) setStats(sres.stats);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveAi() {
    setSavingAi(true);
    const model = customModel.trim() || ai.model || "gpt-5.5";
    const typedKey = ai.apiKey.trim();
    // Lưu lên SERVER qua PUT /api/me/ai-config (SET_AI_CONFIG). Chỉ gửi apiKey
    // khi người dùng THỰC SỰ gõ key mới; để trống -> server giữ nguyên key cũ
    // (nhờ vậy lưu lại form mà không gõ lại key không làm mất key). Key không
    // rời server, service worker dùng chính key này khi phân tích/soạn nội dung.
    const payload: {
      apiBase: string;
      model: string;
      apiKey?: string;
    } = {
      apiBase: ai.apiBase.trim() || "https://danglamgiau.com/v1",
      model,
    };
    if (typedKey) payload.apiKey = typedKey;
    const res = await bg<AiConfigResponse>("SET_AI_CONFIG", { payload });
    if (!res.ok) {
      setSavingAi(false);
      flash("err", res.error || "Không lưu được cấu hình AI.");
      return;
    }
    const cfg = res.config || {};
    setAi({
      apiBase: cfg.apiBase || payload.apiBase,
      apiKey: "", // luôn xoá ô key sau khi lưu — không giữ key thô ở UI
      model: cfg.model || model,
    });
    setHasKey(!!cfg.hasKey);
    setKeyMasked(cfg.keyMasked || "");
    if (customModel.trim() && !models.includes(model)) {
      setModels((m) => [model, ...m]);
    }
    setCustomModel("");
    setSavingAi(false);
    flash("ok", "Đã lưu cấu hình AI.");
  }

  async function reloadModels() {
    setReloadingModels(true);
    const res = await bg<ModelsResponse>("LIST_MODELS");
    setReloadingModels(false);
    if (!res.ok || !Array.isArray(res.models) || !res.models.length) {
      flash("err", res.error || "Không tải được danh sách model.");
      return;
    }
    setModels(res.models);
    await storageSet({ aiModelList: res.models });
    flash("ok", `Đã tải ${res.models.length} model.`);
  }

  async function saveCrawl() {
    setSavingCrawl(true);
    await storageSet({ crawlSettings: settings });
    setSavingCrawl(false);
    flash("ok", "Đã lưu tùy chọn thu thập.");
  }

  // Bật/tắt lưu NGAY (không cần bấm "Lưu tùy chọn") để công tắc có hiệu lực tức
  // thì cho nhiệm vụ chạy sau đó. Ghi thẳng key "focusTabs" ở chrome.storage.local.
  async function toggleFocusTabs(value: boolean) {
    setFocusTabs(value);
    await storageSet({ focusTabs: value });
    flash(
      "ok",
      value
        ? "Đã bật: mở & focus tab khi chạy nhiệm vụ."
        : "Đã tắt: tab nhiệm vụ chạy ẩn ở nền, không nhảy tab.",
    );
  }

  async function clearPosts() {
    setConfirmClearPosts(false);
    const res = await bg<BgResponse & { deleted?: number }>("CLEAR_POSTS", {
      groupId: "",
    });
    if (!res.ok) {
      flash("err", res.error || "Không xóa được dữ liệu bài viết.");
      return;
    }
    flash("ok", `Đã xóa ${res.deleted ?? 0} bài viết.`);
    load();
  }

  function setNum(key: keyof CrawlSettings, value: string) {
    setSettings((s) => ({
      ...s,
      [key]: value === "" ? 0 : Number(value),
    }));
  }

  const modelList = ai.model && !models.includes(ai.model) ? [ai.model, ...models] : models;

  if (loading) return <ListSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      {/* AI config */}
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Zap className="size-4 text-accent" />
          Trợ lý AI
          <span className="ml-auto text-xs font-normal text-ink-faint">
            Chỉ hỗ trợ soạn thảo — không tự gửi
          </span>
        </div>

        <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
          API Base
          <input
            value={ai.apiBase}
            onChange={(e) => setAi((a) => ({ ...a, apiBase: e.target.value }))}
            placeholder="https://danglamgiau.com/v1"
            className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
          <span className="flex items-center gap-1.5">
            <KeyRound className="size-3.5" />
            API Key
            {hasKey && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-normal text-green">
                <CheckCircle2 className="size-3" />
                Đã lưu key
              </span>
            )}
          </span>
          <input
            type="password"
            value={ai.apiKey}
            onChange={(e) => setAi((a) => ({ ...a, apiKey: e.target.value }))}
            placeholder={hasKey ? keyMasked || "••••••••" : "sk-…"}
            className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
          />
          {hasKey && (
            <span className="text-[11px] font-normal text-ink-faint">
              Đã có key trên máy chủ. Để trống nếu giữ nguyên, hoặc nhập key mới để thay.
            </span>
          )}
        </label>

        <div className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
          <span className="flex items-center justify-between">
            Model
            <button
              onClick={reloadModels}
              disabled={reloadingModels}
              className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
            >
              <RefreshCw
                className={cn("size-3", reloadingModels && "animate-spin text-accent")}
              />
              Tải lại model
            </button>
          </span>
          <select
            value={ai.model}
            onChange={(e) => setAi((a) => ({ ...a, model: e.target.value }))}
            className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none focus:border-accent/60"
          >
            {modelList.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            placeholder="hoặc nhập tên model thủ công…"
            className="mt-1 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
          />
        </div>

        <button
          onClick={saveAi}
          disabled={savingAi}
          className="inline-flex items-center justify-center gap-1.5 self-start rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
        >
          {savingAi ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          Lưu cấu hình AI
        </button>
      </section>

      {/* Crawl defaults */}
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Download className="size-4 text-accent" />
          Tùy chọn thu thập
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Phương thức
            <select
              value={settings.crawlMethod}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  crawlMethod: e.target.value === "dom" ? "dom" : "api",
                }))
              }
              className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none focus:border-accent/60"
            >
              <option value="api">API (nhanh, ổn định)</option>
              <option value="dom">DOM (cuộn trang)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Số bài tối đa
            <input
              type="number"
              value={settings.crawlMax}
              onChange={(e) => setNum("crawlMax", e.target.value)}
              className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none focus:border-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Dừng sau N bài đã biết
            <input
              type="number"
              value={settings.crawlStopKnown}
              onChange={(e) => setNum("crawlStopKnown", e.target.value)}
              className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none focus:border-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Độ trễ cuộn (ms)
            <input
              type="number"
              value={settings.crawlDelay}
              onChange={(e) => setNum("crawlDelay", e.target.value)}
              className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none focus:border-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Nghỉ giữa nhóm (giây)
            <input
              type="number"
              value={settings.crawlRest}
              onChange={(e) => setNum("crawlRest", e.target.value)}
              className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none focus:border-accent/60"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Chỉ lấy bài từ ngày
            <input
              type="date"
              value={settings.crawlFromDate}
              onChange={(e) =>
                setSettings((s) => ({ ...s, crawlFromDate: e.target.value }))
              }
              className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none focus:border-accent/60"
            />
          </label>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={settings.crawlSafe}
            onChange={(e) =>
              setSettings((s) => ({ ...s, crawlSafe: e.target.checked }))
            }
            className="size-4 accent-[var(--accent)]"
          />
          Chế độ an toàn (chậm hơn, giảm rủi ro bị chặn)
        </label>

        <label className="flex cursor-pointer items-start gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            checked={focusTabs}
            onChange={(e) => toggleFocusTabs(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--accent)]"
          />
          <span className="flex flex-col gap-0.5">
            <span>Focus tab khi chạy nhiệm vụ</span>
            <span className="text-xs font-normal text-ink-faint">
              Tắt (mặc định): tab nhiệm vụ mở ẩn ở nền, bạn ở nguyên tab công cụ.
              Bật: trình duyệt nhảy sang & focus tab nhiệm vụ như trước. Lưu ngay
              khi đổi.
            </span>
          </span>
        </label>

        <button
          onClick={saveCrawl}
          disabled={savingCrawl}
          className="inline-flex items-center justify-center gap-1.5 self-start rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
        >
          {savingCrawl ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <CheckCircle2 className="size-4" />
          )}
          Lưu tùy chọn
        </button>
      </section>

      {/* Data management */}
      <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <Database className="size-4 text-accent" />
          Dữ liệu
          <span className="ml-auto text-xs font-normal text-ink-faint">
            {stats.total ?? 0} bài viết đã lưu
          </span>
        </div>

        {confirmClearPosts ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-red-soft bg-red-soft/15 px-3 py-2.5">
            <span className="text-sm font-medium text-red">
              Xóa toàn bộ {stats.total ?? 0} bài viết đã thu thập? Không thể hoàn tác.
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setConfirmClearPosts(false)}
                className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft hover:text-ink"
              >
                <X className="size-3.5" />
                Hủy
              </button>
              <button
                onClick={clearPosts}
                className="inline-flex items-center gap-1 rounded-sm bg-red px-2.5 py-1 text-xs font-semibold text-on-accent hover:opacity-90"
              >
                <Trash2 className="size-3.5" />
                Xóa hết
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setConfirmClearPosts(true)}
            disabled={!stats.total}
            className="inline-flex items-center gap-1.5 self-start rounded-md border border-line bg-surface-2 px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-red-soft hover:text-red disabled:opacity-50"
          >
            <Trash2 className="size-4" />
            Xóa toàn bộ bài viết đã thu thập
          </button>
        )}
      </section>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <div className="flex items-center gap-3">
            <div className="size-9 animate-pulse rounded-full bg-surface-2" />
            <div className="flex flex-1 flex-col gap-1.5">
              <div className="h-3 w-32 animate-pulse rounded bg-surface-2" />
              <div className="h-2.5 w-24 animate-pulse rounded bg-surface-2" />
            </div>
          </div>
          <div className="h-3 w-full animate-pulse rounded bg-surface-2" />
          <div className="h-3 w-4/5 animate-pulse rounded bg-surface-2" />
        </div>
      ))}
    </div>
  );
}
