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
  Radar,
  Database,
  KeyRound,
  Zap,
  ExternalLink,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { colorFor, initials } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import { useIncremental } from "@/lib/useIncremental";

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
type TabId = "queue" | "crawl" | "config";

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

const TABS: { id: TabId; label: string; icon: typeof ListChecks }[] = [
  { id: "queue", label: "Hàng đợi", icon: ListChecks },
  { id: "crawl", label: "Thu thập", icon: Download },
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
    const res = await bg<BgResponse & { approved?: number }>("APROVE_ALL_JOBS", {});
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
  const [crawlingId, setCrawlingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [newGroupId, setNewGroupId] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

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

  // Realtime crawl progress from the service worker broadcast.
  useEffect(() => {
    interface ProgressMsg {
      type?: string;
      progress?: {
        status?: string;
        groupName?: string;
        newCount?: number;
        scrolls?: number;
      };
      result?: { newCount?: number; reason?: string };
    }
    const handler = (msg: ProgressMsg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "CRAWL_PROGRESS" && msg.progress) {
        const p = msg.progress;
        const name = p.groupName || "nhóm";
        if (p.status === "started") setProgress(`Bắt đầu crawl ${name}…`);
        else if (p.status === "stopped_known")
          setProgress(`${name}: dừng vì gặp bài đã biết.`);
        else setProgress(`${name}: +${p.newCount || 0} bài (cuộn ${p.scrolls || 0})`);
      } else if (msg.type === "CRAWL_DONE") {
        const r = msg.result || {};
        setProgress(
          `Xong: +${r.newCount || 0} bài${r.reason ? ` (${r.reason})` : ""}`,
        );
        setCrawlingId(null);
        load();
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
    const res = await bg<BgResponse & { scanned?: number; added?: number; updated?: number }>(
      "SCAN_JOINED_GROUPS",
    );
    setScanning(false);
    if (!res.ok) {
      flash("err", res.error || "Quét nhóm thất bại.");
      return;
    }
    flash(
      "ok",
      `Đã quét ${res.scanned ?? 0} nhóm (mới: ${res.added ?? 0}, cập nhật: ${res.updated ?? 0}).`,
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
                      disabled={busy || !!crawlingId}
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

/* ============================ TAB 3 — CẤU HÌNH =========================== */
function ConfigTab({ flash }: { flash: FlashFn }) {
  const [ai, setAi] = useState<AiConfig>({
    apiBase: "",
    apiKey: "",
    model: "gpt-5.5",
  });
  const [models, setModels] = useState<string[]>(FALLBACK_MODELS);
  const [customModel, setCustomModel] = useState("");
  const [settings, setSettings] = useState<CrawlSettings>(CRAWL_DEFAULTS);
  const [stats, setStats] = useState<Stats>({});
  const [loading, setLoading] = useState(true);
  const [savingAi, setSavingAi] = useState(false);
  const [reloadingModels, setReloadingModels] = useState(false);
  const [savingCrawl, setSavingCrawl] = useState(false);
  const [confirmClearPosts, setConfirmClearPosts] = useState(false);

  async function load() {
    setLoading(true);
    const [store, sres] = await Promise.all([
      storageGet(["aiConfig", "aiModelList", "crawlSettings"]),
      bg<StatsResponse>("GET_STATS"),
    ]);
    const cfg = (store.aiConfig as Partial<AiConfig>) || {};
    setAi({
      apiBase: cfg.apiBase || "",
      apiKey: cfg.apiKey || "",
      model: cfg.model || "gpt-5.5",
    });
    const cached = store.aiModelList;
    if (Array.isArray(cached) && cached.length) setModels(cached as string[]);
    const saved = store.crawlSettings as Partial<CrawlSettings> | undefined;
    if (saved) setSettings({ ...CRAWL_DEFAULTS, ...saved });
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
    const cfg: AiConfig = {
      apiBase: ai.apiBase.trim() || "https://danglamgiau.com/v1",
      apiKey: ai.apiKey.trim(),
      model,
    };
    await storageSet({ aiConfig: cfg });
    setAi(cfg);
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
          </span>
          <input
            type="password"
            value={ai.apiKey}
            onChange={(e) => setAi((a) => ({ ...a, apiKey: e.target.value }))}
            placeholder="sk-…"
            className="rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-sm font-normal text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
          />
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
