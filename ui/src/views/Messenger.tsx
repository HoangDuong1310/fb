import { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  Send,
  Loader2,
  ExternalLink,
  Inbox,
  RefreshCw,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  X,
  MessageSquare,
  Megaphone,
  ScanLine,
  Trash2,
  Plus,
  Pencil,
  FileText,
  ImagePlus,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { colorFor, initials } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import { useIncremental } from "@/lib/useIncremental";
import {
  classifyLead,
  LEAD_META,
  matchLeadMode,
  type LeadLabel,
  type LeadMode,
} from "@/lib/leadfilter";

/* -------------------------------------------------------------------------
   Messenger view — two surfaces behind a tab switch:

   • "Chào hàng"  → cold-outreach DM to prospects surfaced from crawled group
     posts. Data mirrors src/dashboard/views/pitch.js:
       GET_ADVISORIES {status:"pending"} → filter to entries with authorProfile
       GET_PITCH_QUOTA / GEN_PITCH / APPROVE_PITCH

   • "Hộp thư"     → the user's REAL Messenger inbox. Threads are scanned on
     demand (read-only), stored device-locally, and replied to through the same
     safety-hardened "message" job pipeline. Contracts:
       GET_INBOX_THREADS            → list scanned threads (no Facebook call)
       SCAN_INBOX {deep,maxThreads} → open /messages in a background tab, read
       OPEN_INBOX_THREAD {threadId} → deep-read one thread
       GEN_INBOX_REPLY {...}        → AI draft reply (optional assist)
       SAVE_INBOX_DRAFT {threadId}  → persist a draft
       APPROVE_INBOX_REPLY {...}    → queue a send (awaits user approval)
       DELETE_INBOX_THREAD {...}    → drop a thread locally

   Philosophy across both: the user drives. Nothing sends without approval;
   the daily cap + kill-switch + spacing all live in the shared job pipeline.
   ------------------------------------------------------------------------- */

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;

function useToast() {
  const [toast, setToast] = useState<Toast>(null);
  const timer = useRef<number | null>(null);
  function flash(kind: NonNullable<Toast>["kind"], text: string, ms = 3200) {
    setToast({ kind, text });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), ms);
  }
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return { toast, flash };
}

function ToastEl({ toast }: { toast: Toast }) {
  if (!toast) return null;
  return (
    <div
      role="status"
      className={cn(
        "absolute bottom-3 left-1/2 z-toast -translate-x-1/2 rounded-md border px-4 py-2.5 text-sm shadow-md",
        toast.kind === "ok" && "border-green-soft bg-green-soft/30 text-green",
        toast.kind === "err" && "border-red-soft bg-red-soft/30 text-red",
        toast.kind === "info" && "border-line bg-surface-2 text-ink-soft",
      )}
    >
      {toast.text}
    </div>
  );
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

/* Intent → badge, ported from advIntentBadge() in advisory.js. */
function IntentBadge({ intent }: { intent?: string }) {
  if (intent === "buy") {
    return (
      <span className="rounded-sm border border-green-soft bg-green-soft/30 px-2 py-0.5 text-xs font-medium text-green">
        Nhu cầu mua
      </span>
    );
  }
  if (intent === "question") {
    return (
      <span className="rounded-sm border border-accent-soft bg-accent-soft/30 px-2 py-0.5 text-xs font-medium text-accent-ink">
        Câu hỏi
      </span>
    );
  }
  return (
    <span className="rounded-sm border border-line-soft bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-faint">
      {intent || "—"}
    </span>
  );
}

function QuotaBar({
  todayCount,
  dailyCap,
  loading,
  onRefresh,
}: {
  todayCount: number;
  dailyCap: number;
  loading?: boolean;
  onRefresh: () => void;
}) {
  const remaining = Math.max(0, dailyCap - todayCount);
  const capReached = remaining === 0;
  return (
    <div className="flex items-center justify-between rounded-md border border-line bg-surface px-4 py-2.5">
      <div className="flex items-center gap-2 text-sm text-ink-soft">
        <ShieldCheck className="size-4 text-accent" />
        <span>
          Hôm nay <b className="tnum text-ink">{todayCount}</b>
          <span className="text-ink-faint"> / {dailyCap}</span> tin
        </span>
        {capReached ? (
          <span className="rounded-sm border border-amber-soft bg-amber-soft/30 px-2 py-0.5 text-xs font-medium text-amber">
            Đã đạt trần hôm nay
          </span>
        ) : (
          <span className="text-ink-faint">
            — còn <b className="tnum text-ink">{remaining}</b> tin
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading}
        className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-sm font-medium text-ink-faint transition-colors hover:text-ink disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        Làm mới
      </button>
    </div>
  );
}

/* ========================================================================
   ROOT — tab switch between "Chào hàng" and "Hộp thư".
   ======================================================================== */

const TABS = [
  { id: "pitch" as const, label: "Chào hàng", icon: Megaphone },
  { id: "inbox" as const, label: "Hộp thư", icon: MessageSquare },
];

export function Messenger() {
  const [tab, setTab] = useState<"pitch" | "inbox">("pitch");
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex items-center gap-1 rounded-md border border-line bg-surface p-1">
        {TABS.map((t) => {
          const active = t.id === tab;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                "inline-flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-surface-2 text-ink"
                  : "text-ink-faint hover:text-ink",
              )}
            >
              <Icon className="size-4" />
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "pitch" ? <PitchPane /> : <InboxPane />}
      </div>
    </div>
  );
}

/* ========================================================================
   PITCH PANE — cold outreach to crawled-post LEADS using reusable, server-
   stored message templates.

   Data source (đổi từ GET_ADVISORIES sang GET_ALL_POSTS): lấy toàn bộ bài đã
   crawl, phân loại lead ngay trên máy (classifyLead) rồi lọc còn những bài
   VỪA là lead (mặc định "cần mua" + "cần hỗ trợ") VỪA có link trang cá nhân
   (authorProfile) — vì phải có profile mới nhắn tin được.

   Mẫu tin (message templates) lưu HOÀN TOÀN TRÊN SERVER qua:
     GET_MSG_TEMPLATES / SAVE_MSG_TEMPLATE / DELETE_MSG_TEMPLATE
   Chọn mẫu → thay {{ten}} bằng tên Facebook của khách (vẫn sửa được) → gửi.
   Nút "AI gợi ý" (GEN_PITCH) và pipeline duyệt-gửi (APPROVE_PITCH) giữ nguyên.
   ======================================================================== */

interface Prospect {
  postId: string;
  authorName?: string;
  authorProfile?: string;
  groupId?: string;
  groupName?: string;
  postText?: string;
  permalink?: string;
  leadLabel: LeadLabel;
}
interface Template {
  id: number | string;
  name: string;
  content: string;
  images?: string[];
  kind?: string;
}
interface TemplatesResponse extends BgResponse {
  templates?: Template[];
}
interface SaveTemplateResponse extends BgResponse {
  id?: number | string;
}
interface PostRow {
  postId: string;
  text?: string;
  authorName?: string;
  authorProfile?: string;
  groupId?: string;
  groupName?: string;
  permalink?: string;
  leadLabel?: string;
}
interface AllPostsResponse extends BgResponse {
  posts?: PostRow[];
}
interface QuotaResponse extends BgResponse {
  todayCount?: number;
  dailyCap?: number;
}
interface GenPitchResponse extends BgResponse {
  message?: string;
}
interface ApprovePitchResponse extends BgResponse {
  jobId?: string | number;
}

// Thay {{ten}} (không phân biệt hoa thường, cho phép khoảng trắng) bằng tên khách.
function fillTemplate(content: string, name: string): string {
  const who = (name || "bạn").trim() || "bạn";
  return String(content ?? "").replace(/\{\{\s*ten\s*\}\}/gi, who);
}

// Chuyển FileList -> mảng data URL để đính kèm ảnh (giống Compose).
function readFiles(fileList: FileList): Promise<string[]> {
  return Promise.all(
    [...fileList].map(
      (f) =>
        new Promise<string | null>((resolve) => {
          const fr = new FileReader();
          fr.onload = () =>
            resolve(typeof fr.result === "string" ? fr.result : null);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(f);
        }),
    ),
  ).then((arr) => arr.filter((x): x is string => !!x));
}

const PITCH_LEAD_FILTERS: { id: LeadMode; label: string }[] = [
  { id: "lead", label: "Khách tiềm năng" },
  { id: "buy", label: "Cần mua" },
  { id: "support", label: "Cần hỗ trợ" },
  { id: "all", label: "Tất cả" },
];

function PitchPane() {
  const [items, setItems] = useState<Prospect[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [leadMode, setLeadMode] = useState<LeadMode>("lead");
  const [todayCount, setTodayCount] = useState(0);
  const [dailyCap, setDailyCap] = useState(15);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [genLoading, setGenLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Mẫu tin (server-backed).
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tplLoading, setTplLoading] = useState(false);
  const [pickedTplId, setPickedTplId] = useState<string>("");
  const [editor, setEditor] = useState<Template | null>(null);
  const [tplSaving, setTplSaving] = useState(false);

  // Ảnh đính kèm cho tin sắp gửi (theo từng prospect) + input file ẩn.
  const [imageDrafts, setImageDrafts] = useState<Record<string, string[]>>({});
  const composeFileInput = useRef<HTMLInputElement>(null);
  const editorFileInput = useRef<HTMLInputElement>(null);

  const { toast, flash } = useToast();

  const remaining = Math.max(0, dailyCap - todayCount);
  const capReached = remaining === 0;

  const selected = useMemo(
    () => items.find((a) => a.postId === selectedId) ?? null,
    [items, selectedId],
  );
  const composeText = selectedId ? (drafts[selectedId] ?? "") : "";
  const composeImages = selectedId ? (imageDrafts[selectedId] ?? []) : [];

  const {
    visible: windowed,
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  } = useIncremental<Prospect, HTMLLIElement>(items, { pageSize: 20 });

  async function load() {
    setLoading(true);
    setLoadError(null);
    const res = await bg<AllPostsResponse>("GET_ALL_POSTS", { groupId: "" });
    if (!res.ok) {
      setLoadError(res.error || "Không tải được danh sách bài viết.");
      setLoading(false);
      return;
    }
    const list: Prospect[] = (res.posts ?? [])
      .filter((p) => p.authorProfile && String(p.authorProfile).trim() !== "")
      .map((p) => {
        const label =
          p.leadLabel && p.leadLabel in LEAD_META
            ? (p.leadLabel as LeadLabel)
            : classifyLead(p.text || "").label;
        return {
          postId: p.postId,
          authorName: p.authorName,
          authorProfile: p.authorProfile,
          groupId: p.groupId,
          groupName: p.groupName,
          postText: p.text,
          permalink: p.permalink,
          leadLabel: label,
        };
      })
      .filter((p) => matchLeadMode(p.leadLabel, leadMode));
    setItems(list);
    setSelectedId((prev) =>
      prev && list.some((a) => a.postId === prev)
        ? prev
        : (list[0]?.postId ?? null),
    );

    const q = await bg<QuotaResponse>("GET_PITCH_QUOTA");
    if (q.ok) {
      setTodayCount(q.todayCount ?? 0);
      setDailyCap(q.dailyCap ?? 15);
    }
    setLoading(false);
  }

  async function loadTemplates() {
    setTplLoading(true);
    const res = await bg<TemplatesResponse>("GET_MSG_TEMPLATES", {});
    setTplLoading(false);
    if (res.ok) setTemplates(res.templates ?? []);
    else flash("err", res.error || "Không tải được mẫu tin.", 5000);
  }

  useEffect(() => {
    load();
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lọc lại khi đổi bộ lọc lead (chỉ chạy sau lần load đầu).
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadMode]);

  function setCompose(text: string) {
    if (!selectedId) return;
    setDrafts((d) => ({ ...d, [selectedId]: text }));
  }

  // Ảnh cho tin sắp gửi (theo prospect đang chọn).
  async function onPickComposeImages(list: FileList | null) {
    if (!list || !list.length || !selectedId) return;
    const urls = await readFiles(list);
    const key = selectedId;
    setImageDrafts((d) => ({ ...d, [key]: [...(d[key] ?? []), ...urls] }));
    setConfirming(false);
  }
  function removeComposeImage(idx: number) {
    if (!selectedId) return;
    const key = selectedId;
    setImageDrafts((d) => ({
      ...d,
      [key]: (d[key] ?? []).filter((_, i) => i !== idx),
    }));
  }
  // Ảnh cho mẫu tin đang soạn trong editor.
  async function onPickEditorImages(list: FileList | null) {
    if (!list || !list.length) return;
    const urls = await readFiles(list);
    setEditor((ed) =>
      ed ? { ...ed, images: [...(ed.images ?? []), ...urls] } : ed,
    );
  }
  function removeEditorImage(idx: number) {
    setEditor((ed) =>
      ed ? { ...ed, images: (ed.images ?? []).filter((_, i) => i !== idx) } : ed,
    );
  }

  function pickProspect(id: string) {
    setSelectedId(id);
    setConfirming(false);
  }

  // Áp mẫu tin đang chọn vào ô soạn, thay {{ten}} bằng tên khách.
  function applyPickedTemplate(tplId: string) {
    setPickedTplId(tplId);
    if (!tplId || !selected) return;
    const tpl = templates.find((t) => String(t.id) === tplId);
    if (!tpl) return;
    setCompose(fillTemplate(tpl.content || "", selected.authorName || ""));
    // Mẫu có ảnh đính kèm sẵn -> nạp luôn vào tin sắp gửi.
    if (selectedId) {
      const imgs = Array.isArray(tpl.images) ? tpl.images : [];
      setImageDrafts((d) => ({ ...d, [selectedId]: imgs }));
    }
    setConfirming(false);
  }

  async function suggestAI() {
    if (!selected) return;
    setGenLoading(true);
    const res = await bg<GenPitchResponse>("GEN_PITCH", {
      postText: selected.postText || "",
      authorName: selected.authorName || "",
      groupName: selected.groupName || selected.groupId || "",
    });
    setGenLoading(false);
    if (res.ok && res.message) {
      setDrafts((d) => ({ ...d, [selected.postId]: res.message! }));
      flash("ok", "AI đã soạn nháp. Xem lại rồi duyệt để gửi.");
    } else {
      flash("err", res.error || "AI không soạn được nháp.", 5000);
    }
  }

  async function approveSend() {
    if (!selected) return;
    const message = composeText.trim();
    if (!message) {
      flash("err", "Nội dung trống. Hãy chọn mẫu, tự viết hoặc để AI gợi ý.");
      return;
    }
    setSending(true);
    const res = await bg<ApprovePitchResponse>("APPROVE_PITCH", {
      message,
      images: composeImages,
      authorProfile: selected.authorProfile || "",
      authorName: selected.authorName || "",
      postId: selected.postId || "",
      groupId: selected.groupId || "",
      groupName: selected.groupName || "",
      postText: selected.postText || "",
    });
    setSending(false);
    setConfirming(false);
    if (res.ok) {
      flash("ok", `Đã đưa vào hàng đợi gửi inbox. Job #${res.jobId ?? "—"}`);
      setDrafts((d) => {
        const next = { ...d };
        delete next[selected.postId];
        return next;
      });
      setImageDrafts((d) => {
        const next = { ...d };
        delete next[selected.postId];
        return next;
      });
      await load();
    } else {
      flash("err", res.error || "Không tạo được lịch gửi.", 5000);
    }
  }

  // ── Mẫu tin: tạo / sửa / xoá (lưu trên server) ──
  function newTemplate() {
    setEditor({ id: "", name: "", content: "", images: [], kind: "pitch" });
  }
  function editTemplate(tpl: Template) {
    setEditor({ ...tpl });
  }
  async function saveTemplate() {
    if (!editor) return;
    const name = (editor.name || "").trim();
    if (!name) {
      flash("err", "Đặt tên cho mẫu tin trước đã.");
      return;
    }
    setTplSaving(true);
    const res = await bg<SaveTemplateResponse>("SAVE_MSG_TEMPLATE", {
      id: editor.id || undefined,
      name,
      content: editor.content ?? "",
      images: editor.images ?? [],
      kind: editor.kind || "pitch",
    });
    setTplSaving(false);
    if (res.ok) {
      flash("ok", "Đã lưu mẫu tin.");
      setEditor(null);
      await loadTemplates();
    } else {
      flash("err", res.error || "Không lưu được mẫu tin.", 5000);
    }
  }
  async function deleteTemplate(id: number | string) {
    setTplSaving(true);
    const res = await bg("DELETE_MSG_TEMPLATE", { id });
    setTplSaving(false);
    if (res.ok) {
      flash("ok", "Đã xoá mẫu tin.");
      if (String(pickedTplId) === String(id)) setPickedTplId("");
      if (editor && String(editor.id) === String(id)) setEditor(null);
      await loadTemplates();
    } else {
      flash("err", res.error || "Không xoá được mẫu tin.", 5000);
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3">
      <QuotaBar
        todayCount={todayCount}
        dailyCap={dailyCap}
        loading={loading}
        onRefresh={load}
      />

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,320px)_1fr] gap-3">
        {/* ── Left: prospect list ── */}
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2.5">
            <span className="text-sm font-semibold text-ink">
              Khách tiềm năng
            </span>
            <span className="tnum rounded-sm bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-faint">
              {items.length}
            </span>
          </div>

          <div className="flex flex-wrap gap-1 border-b border-line-soft px-2.5 py-2">
            {PITCH_LEAD_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setLeadMode(f.id)}
                className={cn(
                  "rounded-sm px-2 py-1 text-xs font-medium transition-colors",
                  leadMode === f.id
                    ? "bg-accent text-on-accent"
                    : "bg-surface-2 text-ink-faint hover:text-ink",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <ListSkeleton />
            ) : loadError ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
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
              <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
                <Inbox className="size-7 text-ink-faint" />
                <p className="text-sm font-medium text-ink">
                  Chưa có khách nào để nhắn tin
                </p>
                <p className="text-xs leading-snug text-ink-faint">
                  Cần bài viết đã crawl là lead và có link trang cá nhân. Hãy
                  quét thêm nhóm ở tab Công cụ, hoặc đổi bộ lọc phía trên.
                </p>
              </div>
            ) : (
              <ul className="p-1.5">
                {windowed.map((a) => {
                  const active = a.postId === selectedId;
                  const name = a.authorName || "Ẩn danh";
                  const hasDraft = !!(drafts[a.postId] ?? "").trim();
                  const meta = LEAD_META[a.leadLabel];
                  return (
                    <li key={a.postId}>
                      <button
                        type="button"
                        onClick={() => pickProspect(a.postId)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                          active ? "bg-surface-2" : "hover:bg-surface-2/60",
                        )}
                      >
                        <Avatar name={name} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-ink">
                              {name}
                            </span>
                            {hasDraft && (
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-accent"
                                title="Đã có nháp"
                              />
                            )}
                          </span>
                          <span className="mt-0.5 flex items-center gap-1.5">
                            <span
                              className={cn(
                                "shrink-0 rounded-sm px-1.5 py-px text-[10px] font-medium",
                                meta.tone === "green" &&
                                  "bg-green-soft/25 text-green",
                                meta.tone === "accent" &&
                                  "bg-accent-soft/25 text-accent-ink",
                                meta.tone === "amber" &&
                                  "bg-amber-soft/25 text-amber",
                                meta.tone === "muted" &&
                                  "bg-surface-2 text-ink-faint",
                              )}
                            >
                              {meta.text}
                            </span>
                            <span className="truncate text-xs text-ink-faint">
                              {a.groupName || a.groupId || "—"}
                            </span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {hasMore && (
                  <li ref={sentinelRef} className="p-2">
                    <button
                      type="button"
                      onClick={loadMore}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                    >
                      <Loader2 className="size-3.5 animate-spin text-accent" />
                      Tải thêm ({shown}/{total})
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Right: compose panel ── */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          {!selected ? (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div className="max-w-xs">
                <Send className="mx-auto size-8 text-ink-faint" />
                <p className="mt-3 text-sm font-medium text-ink">
                  Chọn một khách để soạn tin
                </p>
                <p className="mt-1 text-xs leading-snug text-ink-faint">
                  Chọn mẫu tin có sẵn (tên khách tự điền), tự viết, hoặc để AI
                  gợi ý rồi chỉnh lại. Duyệt xong tiện ích sẽ tự gửi inbox qua
                  Messenger.
                </p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
                <Avatar name={selected.authorName || "Ẩn danh"} size={38} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink">
                      {selected.authorName || "Ẩn danh"}
                    </span>
                    <IntentBadge intent={selected.leadLabel} />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-faint">
                    {selected.groupName || selected.groupId || "—"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  {selected.authorProfile && (
                    <a
                      href={selected.authorProfile}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex items-center gap-1 text-accent-ink transition-colors hover:text-accent-bright"
                    >
                      Trang cá nhân
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                  {selected.permalink && (
                    <a
                      href={selected.permalink}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex items-center gap-1 text-ink-faint transition-colors hover:text-ink"
                    >
                      Bài gốc
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                </div>
              </header>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {selected.postText && (
                  <div className="rounded-md border border-line-soft bg-bg/40 px-3.5 py-3">
                    <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      Bài viết của khách
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
                      {selected.postText}
                    </p>
                  </div>
                )}

                {/* ── Quản lý mẫu tin (lưu trên server) ── */}
                <div className="rounded-md border border-line-soft bg-bg/40 px-3.5 py-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">
                      <FileText className="size-3.5" />
                      Mẫu tin tái sử dụng
                    </span>
                    <button
                      type="button"
                      onClick={newTemplate}
                      className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-2 px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                    >
                      <Plus className="size-3.5" />
                      Mẫu mới
                    </button>
                  </div>

                  {editor ? (
                    <div className="space-y-2 rounded-md border border-line bg-surface px-3 py-2.5">
                      <input
                        type="text"
                        value={editor.name}
                        onChange={(e) =>
                          setEditor((ed) =>
                            ed ? { ...ed, name: e.target.value } : ed,
                          )
                        }
                        placeholder="Tên mẫu (VD: Chào hàng sản phẩm)"
                        className="w-full rounded-sm border border-line bg-bg px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
                      />
                      <textarea
                        value={editor.content}
                        onChange={(e) =>
                          setEditor((ed) =>
                            ed ? { ...ed, content: e.target.value } : ed,
                          )
                        }
                        rows={3}
                        placeholder="Nội dung. Dùng {{ten}} để tự điền tên khách khi gửi."
                        className="w-full resize-none rounded-sm border border-line bg-bg px-2.5 py-1.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
                      />
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-medium text-ink-soft">
                            Ảnh mẫu{" "}
                            {(editor.images?.length ?? 0) > 0 &&
                              `(${editor.images!.length})`}
                          </span>
                          <button
                            type="button"
                            onClick={() => editorFileInput.current?.click()}
                            className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                          >
                            <ImagePlus className="size-3" />
                            Thêm ảnh
                          </button>
                          <input
                            ref={editorFileInput}
                            type="file"
                            accept="image/*"
                            multiple
                            hidden
                            onChange={(e) => onPickEditorImages(e.target.files)}
                          />
                        </div>
                        {(editor.images?.length ?? 0) > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {editor.images!.map((src, i) => (
                              <div
                                key={i}
                                className="group relative size-14 overflow-hidden rounded-sm border border-line"
                              >
                                <img
                                  src={src}
                                  alt=""
                                  className="size-full object-cover"
                                />
                                <button
                                  type="button"
                                  onClick={() => removeEditorImage(i)}
                                  title="Bỏ ảnh"
                                  className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                                >
                                  <X className="size-2.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-ink-faint">
                          Chèn <code className="text-accent-ink">{"{{ten}}"}</code>{" "}
                          để tự điền tên khách.
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setEditor(null)}
                            disabled={tplSaving}
                            className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
                          >
                            <X className="size-3.5" />
                            Hủy
                          </button>
                          <button
                            type="button"
                            onClick={saveTemplate}
                            disabled={tplSaving}
                            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-2.5 py-1 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
                          >
                            {tplSaving ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="size-3.5" />
                            )}
                            Lưu mẫu
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <select
                        value={pickedTplId}
                        onChange={(e) => applyPickedTemplate(e.target.value)}
                        disabled={tplLoading}
                        className="min-w-0 flex-1 rounded-sm border border-line bg-bg px-2.5 py-1.5 text-sm text-ink focus:border-accent/60 focus-visible:outline-none"
                      >
                        <option value="">
                          {tplLoading
                            ? "Đang tải mẫu…"
                            : templates.length === 0
                              ? "Chưa có mẫu — bấm “Mẫu mới”"
                              : "— Chọn mẫu để điền vào ô soạn —"}
                        </option>
                        {templates.map((t) => (
                          <option key={t.id} value={String(t.id)}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      {pickedTplId && (
                        <>
                          <button
                            type="button"
                            title="Sửa mẫu"
                            onClick={() => {
                              const t = templates.find(
                                (x) => String(x.id) === pickedTplId,
                              );
                              if (t) editTemplate(t);
                            }}
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-2 text-ink-faint transition-colors hover:border-accent/50 hover:text-ink"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            title="Xoá mẫu"
                            onClick={() => deleteTemplate(pickedTplId)}
                            disabled={tplSaving}
                            className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm border border-line bg-surface-2 text-ink-faint transition-colors hover:border-red/50 hover:text-red disabled:opacity-60"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="border-t border-line-soft bg-surface px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                    Tin nhắn inbox
                  </span>
                  <button
                    type="button"
                    onClick={suggestAI}
                    disabled={genLoading}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
                  >
                    {genLoading ? (
                      <Loader2 className="size-3.5 animate-spin text-accent" />
                    ) : (
                      <Sparkles className="size-3.5 text-accent" />
                    )}
                    {genLoading ? "Đang soạn…" : "AI gợi ý"}
                  </button>
                </div>

                <textarea
                  value={composeText}
                  onChange={(e) => {
                    setCompose(e.target.value);
                    setConfirming(false);
                  }}
                  rows={4}
                  placeholder="Chọn mẫu tin phía trên, tự viết, hoặc bấm “AI gợi ý” rồi chỉnh lại…"
                  className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
                />

                <div className="mt-2 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-ink-soft">
                      Ảnh đính kèm{" "}
                      {composeImages.length > 0 && `(${composeImages.length})`}
                    </span>
                    <button
                      type="button"
                      onClick={() => composeFileInput.current?.click()}
                      className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                    >
                      <ImagePlus className="size-3" />
                      Thêm ảnh
                    </button>
                    <input
                      ref={composeFileInput}
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => onPickComposeImages(e.target.files)}
                    />
                  </div>
                  {composeImages.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {composeImages.map((src, i) => (
                        <div
                          key={i}
                          className="group relative size-14 overflow-hidden rounded-sm border border-line"
                        >
                          <img
                            src={src}
                            alt=""
                            className="size-full object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => removeComposeImage(i)}
                            title="Bỏ ảnh"
                            className="absolute right-0.5 top-0.5 grid size-4 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          >
                            <X className="size-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {confirming ? (
                  <div className="mt-2.5 flex items-center justify-between gap-3 rounded-md border border-amber-soft bg-amber-soft/20 px-3 py-2">
                    <span className="text-xs leading-snug text-ink-soft">
                      Gửi tin nhắn tới{" "}
                      <b className="text-ink">
                        {selected.authorName || "khách"}
                      </b>
                      ? Tin sẽ vào hàng đợi và gửi tự động qua Messenger.
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        disabled={sending}
                        className="inline-flex items-center gap-1 rounded-sm px-2.5 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
                      >
                        <X className="size-3.5" />
                        Hủy
                      </button>
                      <button
                        type="button"
                        onClick={approveSend}
                        disabled={sending}
                        className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
                      >
                        {sending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-3.5" />
                        )}
                        Xác nhận gửi
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2.5 flex items-center justify-between">
                    <p className="text-xs text-ink-faint">
                      Duyệt xong tiện ích sẽ tự gửi inbox — bạn không cần mở
                      Facebook.
                    </p>
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      disabled={
                        sending ||
                        capReached ||
                        (!composeText.trim() && composeImages.length === 0)
                      }
                      title={
                        capReached ? "Đã đạt trần tin nhắn hôm nay" : undefined
                      }
                      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Send className="size-4" />
                      Duyệt & gửi inbox
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <ToastEl toast={toast} />
    </div>
  );
}

/* ========================================================================
   INBOX PANE — the user's REAL Messenger conversations.
   ======================================================================== */

interface InboxMessage {
  mine: boolean;
  text: string;
  ts?: number | null;
}
interface InboxThread {
  threadId: string;
  name?: string;
  threadUrl?: string;
  preview?: string;
  unread?: boolean;
  messages?: InboxMessage[];
  draft?: string | null;
  lastJobId?: string | number | null;
  scannedAt?: number | null;
  updatedAt?: number;
}
interface InboxThreadsResponse extends BgResponse {
  threads?: InboxThread[];
}
interface ScanInboxResponse extends BgResponse {
  threads?: InboxThread[];
  deep?: boolean;
  read?: number;
}
interface OpenThreadResponse extends BgResponse {
  thread?: InboxThread;
}
interface GenReplyResponse extends BgResponse {
  message?: string;
}
interface ApproveReplyResponse extends BgResponse {
  jobId?: string | number;
}

function timeAgo(ts?: number | null): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "vừa xong";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  return `${d} ngày trước`;
}

function InboxPane() {
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [todayCount, setTodayCount] = useState(0);
  const [dailyCap, setDailyCap] = useState(15);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [readingId, setReadingId] = useState<string | null>(null);
  // Hàng đợi đọc hội thoại: mở & đọc Messenger PHẢI làm lần lượt từng cái một.
  // Nếu mở nhiều tab cùng lúc (user bấm 3-4 hội thoại liền tay), Facebook chỉ
  // kịp render + giải mã 1 luồng, các luồng còn lại đọc hụt (rỗng). Vì vậy ta
  // xếp hàng và đọc tuần tự, đồng thời báo cho user còn bao nhiêu cái đang chờ.
  const [readQueue, setReadQueue] = useState<string[]>([]);
  const readingRef = useRef(false);
  // Dòng tiến độ realtime (do service worker broadcast INBOX_PROGRESS đẩy về):
  // giúp người dùng biết thao tác đang THỰC SỰ chạy thay vì chỉ thấy icon xoay
  // (mà khi tab bị nền, animation CSS có thể bị trình duyệt tạm dừng → "đứng đơ").
  // done=true -> đã xong, hiện dấu tick (không xoay) rồi tự ẩn.
  const [progress, setProgress] = useState<{ text: string; done: boolean } | null>(null);
  const [genLoading, setGenLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const { toast, flash } = useToast();

  const remaining = Math.max(0, dailyCap - todayCount);
  const capReached = remaining === 0;

  const selected = useMemo(
    () => threads.find((t) => t.threadId === selectedId) ?? null,
    [threads, selectedId],
  );
  const composeText = selectedId ? (drafts[selectedId] ?? "") : "";

  const {
    visible: windowed,
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  } = useIncremental<InboxThread, HTMLLIElement>(threads, { pageSize: 20 });

  async function load() {
    setLoading(true);
    setLoadError(null);
    const res = await bg<InboxThreadsResponse>("GET_INBOX_THREADS");
    if (!res.ok) {
      setLoadError(res.error || "Không tải được hộp thư.");
      setLoading(false);
      return;
    }
    const list = res.threads ?? [];
    setThreads(list);
    // Seed drafts from persisted server-side drafts (don't clobber local edits).
    setDrafts((d) => {
      const next = { ...d };
      for (const t of list) {
        if (next[t.threadId] === undefined && t.draft != null) {
          next[t.threadId] = String(t.draft);
        }
      }
      return next;
    });
    setSelectedId((prev) =>
      prev && list.some((t) => t.threadId === prev)
        ? prev
        : (list[0]?.threadId ?? null),
    );

    const q = await bg<QuotaResponse>("GET_PITCH_QUOTA");
    if (q.ok) {
      setTodayCount(q.todayCount ?? 0);
      setDailyCap(q.dailyCap ?? 15);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Realtime tiến độ quét/đọc hộp thư từ service worker (INBOX_PROGRESS).
  useEffect(() => {
    interface InboxProgressMsg {
      type?: string;
      phase?: string;
      status?: string;
      text?: string;
      total?: number;
      read?: number;
      failed?: number;
    }
    const handler = (msg: InboxProgressMsg) => {
      if (!msg || msg.type !== "INBOX_PROGRESS") return;
      // Kết thúc = quét xong toàn bộ (phase "done") HOẶC đọc xong 1 hội thoại
      // (phase "thread" + status "done"). Khi đó ngừng xoay và tự ẩn.
      const finished = msg.phase === "done" || msg.status === "done" || msg.status === "error";
      if (typeof msg.text === "string" && msg.text) {
        setProgress({ text: msg.text, done: finished });
      } else if (finished) {
        setProgress((p) => (p ? { ...p, done: true } : p));
      }
      if (finished) {
        // Giữ dòng tổng kết một lúc cho người dùng đọc rồi ẩn.
        window.setTimeout(() => setProgress(null), 4000);
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

  async function scan(deep: boolean) {
    setScanning(true);
    flash(
      "info",
      deep
        ? "Đang mở Messenger để quét & đọc hội thoại (chạy nền)…"
        : "Đang mở Messenger để quét danh sách hội thoại…",
      6000,
    );
    const res = await bg<ScanInboxResponse>("SCAN_INBOX", {
      deep,
      maxThreads: 20,
    });
    setScanning(false);
    if (res.ok) {
      const n = (res.threads ?? []).length;
      flash(
        "ok",
        deep
          ? `Đã quét & đọc ${res.read ?? 0}/${n} hội thoại.`
          : `Đã quét ${n} hội thoại. Bấm vào một hội thoại để đọc tin.`,
      );
      await load();
    } else {
      flash("err", res.error || "Quét hộp thư thất bại.", 5000);
    }
  }

  // Xếp một hội thoại vào hàng đợi đọc (nếu chưa có sẵn / chưa đang chờ).
  // Bộ chạy hàng đợi (useEffect bên dưới) sẽ đọc TỪNG cái một để tránh mở
  // nhiều tab Messenger cùng lúc — nguyên nhân khiến chỉ 1 luồng lấy được tin.
  function enqueueRead(id: string) {
    // Đã đang đọc chính nó hoặc đã nằm trong hàng đợi → bỏ qua (không nhân đôi).
    if (readingId === id || readQueue.includes(id)) return;
    // Nếu đang bận đọc/đã có cái xếp hàng → báo cho user là sẽ đọc lần lượt.
    if (readingId !== null || readQueue.length > 0) {
      flash(
        "info",
        `Đang đọc lần lượt từng hội thoại. Đã xếp thêm vào hàng đợi (còn ${readQueue.length + 1} cái chờ).`,
      );
    }
    setReadQueue((q) => (q.includes(id) ? q : [...q, id]));
  }

  async function pickThread(id: string) {
    setSelectedId(id);
    setConfirming(false);
    setConfirmDeleteId(null);
    const th = threads.find((t) => t.threadId === id);
    // Deep-read on open if we haven't pulled messages yet — qua hàng đợi.
    // enqueueRead sẽ tự báo cho user nếu đang bận (đọc lần lượt từng cái).
    if (th && (!th.messages || th.messages.length === 0) && !th.scannedAt) {
      enqueueRead(id);
    }
  }

  // Nút "Đọc lại" (kể cả hội thoại đã có tin) — cũng đi qua hàng đợi.
  function openThread(id: string) {
    enqueueRead(id);
  }

  // Đọc thực sự 1 hội thoại (gọi service worker mở tab nền, đọc DOM, đóng tab).
  async function readOne(id: string) {
    setReadingId(id);
    try {
      const res = await bg<OpenThreadResponse>("OPEN_INBOX_THREAD", {
        threadId: id,
      });
      if (res.ok && res.thread) {
        const t = res.thread;
        setThreads((list) =>
          list.map((x) => (x.threadId === id ? { ...x, ...t } : x)),
        );
      } else {
        flash("err", res.error || "Không đọc được hội thoại.", 5000);
      }
    } finally {
      setReadingId(null);
    }
  }

  // Bộ chạy hàng đợi: mỗi lần chỉ đọc 1 hội thoại. Khi xong 1 cái, lấy cái kế
  // tiếp trong hàng đợi. readingRef chặn chạy chồng (StrictMode gọi effect 2 lần).
  useEffect(() => {
    if (readingRef.current) return;
    if (readingId) return;
    if (readQueue.length === 0) return;
    const next = readQueue[0];
    readingRef.current = true;
    (async () => {
      try {
        await readOne(next);
      } finally {
        setReadQueue((q) => q.filter((x) => x !== next));
        readingRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readQueue, readingId]);

  function setCompose(text: string) {
    if (!selectedId) return;
    setDrafts((d) => ({ ...d, [selectedId]: text }));
  }

  async function saveDraft() {
    if (!selectedId) return;
    const draft = composeText;
    await bg("SAVE_INBOX_DRAFT", { threadId: selectedId, draft });
  }

  async function suggestAI() {
    if (!selected) return;
    const history = (selected.messages ?? []).map((m) => ({
      mine: m.mine,
      text: m.text,
    }));
    setGenLoading(true);
    const res = await bg<GenReplyResponse>("GEN_INBOX_REPLY", {
      contactName: selected.name || "",
      messages: history,
      userHint: composeText.trim(),
    });
    setGenLoading(false);
    if (res.ok && res.message) {
      setDrafts((d) => ({ ...d, [selected.threadId]: res.message! }));
      flash("ok", "AI đã soạn nháp trả lời. Xem lại rồi duyệt để gửi.");
    } else {
      flash("err", res.error || "AI không soạn được nháp.", 5000);
    }
  }

  async function approveSend() {
    if (!selected) return;
    const message = composeText.trim();
    if (!message) {
      flash("err", "Nội dung trống. Hãy tự viết hoặc để AI gợi ý.");
      return;
    }
    setSending(true);
    const res = await bg<ApproveReplyResponse>("APPROVE_INBOX_REPLY", {
      message,
      threadId: selected.threadId,
      contactName: selected.name || "",
    });
    setSending(false);
    setConfirming(false);
    if (res.ok) {
      flash("ok", `Đã đưa trả lời vào hàng đợi gửi. Job #${res.jobId ?? "—"}`);
      setDrafts((d) => {
        const next = { ...d };
        delete next[selected.threadId];
        return next;
      });
      await load();
    } else {
      flash("err", res.error || "Không tạo được lịch gửi.", 5000);
    }
  }

  async function deleteThread(id: string) {
    const res = await bg("DELETE_INBOX_THREAD", { threadId: id });
    setConfirmDeleteId(null);
    if (res.ok) {
      flash("ok", "Đã xoá hội thoại khỏi hộp thư (chỉ trong tiện ích).");
      if (selectedId === id) setSelectedId(null);
      await load();
    } else {
      flash("err", res.error || "Không xoá được hội thoại.", 5000);
    }
  }

  const msgs = selected?.messages ?? [];

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3">
      <QuotaBar
        todayCount={todayCount}
        dailyCap={dailyCap}
        loading={loading}
        onRefresh={load}
      />

      {/* Safety notice + scan actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-4 py-2.5">
        <p className="flex items-center gap-1.5 text-xs leading-snug text-ink-faint">
          <ShieldCheck className="size-3.5 shrink-0 text-accent" />
          Quét chỉ đọc, chạy khi bạn bấm. Không có tin nào tự gửi — mọi trả lời
          đều chờ bạn duyệt và tuân theo trần {dailyCap} tin/ngày.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => scan(false)}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
          >
            {scanning ? (
              <Loader2 className="size-3.5 animate-spin text-accent" />
            ) : (
              <ScanLine className="size-3.5 text-accent" />
            )}
            Quét danh sách
          </button>
          <button
            type="button"
            onClick={() => scan(true)}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
          >
            {scanning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ScanLine className="size-3.5" />
            )}
            Quét & đọc tin
          </button>
        </div>
      </div>

      {/* Dòng tiến độ realtime — text đổi liên tục để người dùng biết đang chạy
          thật, kể cả khi icon xoay bị trình duyệt tạm dừng lúc tab ở nền.
          Khi xong: đổi spinner → dấu tick và tự ẩn sau vài giây. */}
      {progress && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-md border px-4 py-2 text-xs font-medium",
            progress.done
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700"
              : "border-accent/30 bg-accent-soft/20 text-accent-ink",
          )}
        >
          {progress.done ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600" />
          ) : (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
          )}
          <span className="truncate" title={progress.text}>
            {progress.text}
          </span>
        </div>
      )}

      {/* Báo cho user biết đang đọc lần lượt & còn bao nhiêu hội thoại đang chờ.
          Đây là câu trả lời cho việc bấm nhiều hội thoại 1 lúc: không mở nhiều
          tab song song (chỉ 1 luồng đọc được), mà xếp hàng đọc từng cái. */}
      {(readingId !== null || readQueue.length > 0) && (
        <div className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft/20 px-4 py-2 text-xs font-medium text-accent-ink">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />
          <span className="truncate">
            {readingId !== null ? "Đang đọc 1 hội thoại…" : "Chuẩn bị đọc…"}
            {readQueue.length > 0 && (
              <> · Còn {readQueue.length} hội thoại đang chờ trong hàng đợi</>
            )}
          </span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(280px,340px)_1fr] gap-3">
        {/* ── Left: thread list ── */}
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line-soft px-3.5 py-2.5">
            <span className="text-sm font-semibold text-ink">Hội thoại</span>
            <span className="tnum rounded-sm bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-faint">
              {threads.length}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <ListSkeleton />
            ) : loadError ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
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
            ) : threads.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
                <MessageSquare className="size-7 text-ink-faint" />
                <p className="text-sm font-medium text-ink">
                  Hộp thư còn trống
                </p>
                <p className="text-xs leading-snug text-ink-faint">
                  Bấm “Quét & đọc tin” để nạp các cuộc trò chuyện đang có trong
                  Messenger thật của bạn.
                </p>
              </div>
            ) : (
              <ul className="p-1.5">
                {windowed.map((t) => {
                  const active = t.threadId === selectedId;
                  const name = t.name || "Hội thoại";
                  const hasDraft = !!(drafts[t.threadId] ?? "").trim();
                  const isReading = readingId === t.threadId;
                  const isQueued = readQueue.includes(t.threadId);
                  const last =
                    (t.messages && t.messages[t.messages.length - 1]) || null;
                  const previewText = last
                    ? (last.mine ? "Bạn: " : "") + last.text
                    : t.preview || "Chưa đọc tin — bấm để mở";
                  return (
                    <li key={t.threadId}>
                      <button
                        type="button"
                        onClick={() => pickThread(t.threadId)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                          active ? "bg-surface-2" : "hover:bg-surface-2/60",
                        )}
                      >
                        <Avatar name={name} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "truncate text-sm text-ink",
                                t.unread ? "font-bold" : "font-semibold",
                              )}
                            >
                              {name}
                            </span>
                            {t.unread && (
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-accent"
                                title="Chưa đọc"
                              />
                            )}
                            {isReading ? (
                              <span className="ml-auto inline-flex items-center gap-1 rounded-sm bg-accent-soft/40 px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
                                <Loader2 className="size-2.5 animate-spin" />
                                đang đọc
                              </span>
                            ) : isQueued ? (
                              <span
                                className="ml-auto rounded-sm bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-faint"
                                title="Đang chờ tới lượt đọc"
                              >
                                chờ đọc
                              </span>
                            ) : (
                              hasDraft && (
                                <span className="ml-auto rounded-sm bg-accent-soft/40 px-1.5 py-0.5 text-[10px] font-medium text-accent-ink">
                                  nháp
                                </span>
                              )
                            )}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-ink-faint">
                            {previewText}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                {hasMore && (
                  <li ref={sentinelRef} className="p-2">
                    <button
                      type="button"
                      onClick={loadMore}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                    >
                      <Loader2 className="size-3.5 animate-spin text-accent" />
                      Tải thêm ({shown}/{total})
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Right: conversation + reply composer ── */}
        <section className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
          {!selected ? (
            <div className="grid flex-1 place-items-center px-6 text-center">
              <div className="max-w-xs">
                <MessageSquare className="mx-auto size-8 text-ink-faint" />
                <p className="mt-3 text-sm font-medium text-ink">
                  Chọn một hội thoại
                </p>
                <p className="mt-1 text-xs leading-snug text-ink-faint">
                  Mở một cuộc trò chuyện để xem tin đến, rồi tự viết hoặc để AI
                  soạn trả lời. Duyệt xong tiện ích mới gửi.
                </p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
                <Avatar name={selected.name || "Hội thoại"} size={38} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-ink">
                    {selected.name || "Hội thoại"}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-faint">
                    {selected.scannedAt
                      ? `Đọc lần cuối ${timeAgo(selected.scannedAt)}`
                      : "Chưa đọc tin trong tiện ích"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => openThread(selected.threadId)}
                    disabled={readingId === selected.threadId}
                    className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-2 px-2 py-1 font-medium text-ink-soft transition-colors hover:text-ink disabled:opacity-60"
                  >
                    {readingId === selected.threadId ? (
                      <Loader2 className="size-3.5 animate-spin text-accent" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    Đọc lại
                  </button>
                  {selected.threadUrl && (
                    <a
                      href={selected.threadUrl}
                      target="_blank"
                      rel="noopener"
                      className="inline-flex items-center gap-1 text-ink-faint transition-colors hover:text-ink"
                    >
                      Mở FB
                      <ExternalLink className="size-3" />
                    </a>
                  )}
                  {confirmDeleteId === selected.threadId ? (
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => deleteThread(selected.threadId)}
                        className="rounded-sm bg-red px-2 py-1 font-semibold text-on-accent"
                      >
                        Xoá
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-sm px-1.5 py-1 text-ink-faint hover:text-ink"
                      >
                        Hủy
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(selected.threadId)}
                      title="Xoá khỏi hộp thư (chỉ trong tiện ích)"
                      className="inline-flex items-center gap-1 text-ink-faint transition-colors hover:text-red"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              </header>

              {/* Message transcript */}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-4">
                {readingId === selected.threadId && msgs.length === 0 ? (
                  <div className="grid flex-1 place-items-center py-10 text-center text-sm text-ink-faint">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 className="size-4 animate-spin text-accent" />
                      Đang đọc tin…
                    </span>
                  </div>
                ) : msgs.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 py-10 text-center">
                    <Inbox className="size-6 text-ink-faint" />
                    <p className="text-sm text-ink-soft">
                      Chưa có tin. Bấm “Đọc lại” để nạp nội dung hội thoại.
                    </p>
                  </div>
                ) : (
                  msgs.map((m, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex",
                        m.mine ? "justify-end" : "justify-start",
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[78%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                          m.mine
                            ? "rounded-br-sm bg-accent text-on-accent"
                            : "rounded-bl-sm bg-surface-2 text-ink",
                        )}
                      >
                        {m.text}
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Reply composer */}
              <div className="border-t border-line-soft bg-surface px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
                    Trả lời
                  </span>
                  <button
                    type="button"
                    onClick={suggestAI}
                    disabled={genLoading}
                    className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-60"
                  >
                    {genLoading ? (
                      <Loader2 className="size-3.5 animate-spin text-accent" />
                    ) : (
                      <Sparkles className="size-3.5 text-accent" />
                    )}
                    {genLoading ? "Đang soạn…" : "AI trả lời"}
                  </button>
                </div>

                <textarea
                  value={composeText}
                  onChange={(e) => {
                    setCompose(e.target.value);
                    setConfirming(false);
                  }}
                  onBlur={saveDraft}
                  rows={3}
                  placeholder="Tự viết trả lời, hoặc bấm “AI trả lời” rồi chỉnh lại…"
                  className="w-full resize-none rounded-md border border-line bg-bg px-3 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus-visible:outline-none"
                />

                {confirming ? (
                  <div className="mt-2.5 flex items-center justify-between gap-3 rounded-md border border-amber-soft bg-amber-soft/20 px-3 py-2">
                    <span className="text-xs leading-snug text-ink-soft">
                      Gửi trả lời tới{" "}
                      <b className="text-ink">{selected.name || "hội thoại"}</b>
                      ? Tin sẽ vào hàng đợi và gửi tự động qua Messenger.
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        disabled={sending}
                        className="inline-flex items-center gap-1 rounded-sm px-2.5 py-1.5 text-xs font-medium text-ink-faint transition-colors hover:text-ink"
                      >
                        <X className="size-3.5" />
                        Hủy
                      </button>
                      <button
                        type="button"
                        onClick={approveSend}
                        disabled={sending}
                        className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-60"
                      >
                        {sending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-3.5" />
                        )}
                        Xác nhận gửi
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2.5 flex items-center justify-between">
                    <p className="text-xs text-ink-faint">
                      Duyệt xong tiện ích sẽ tự gửi vào đúng hội thoại này.
                    </p>
                    <button
                      type="button"
                      onClick={() => setConfirming(true)}
                      disabled={sending || capReached || !composeText.trim()}
                      title={
                        capReached ? "Đã đạt trần tin nhắn hôm nay" : undefined
                      }
                      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Send className="size-4" />
                      Duyệt & gửi
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      <ToastEl toast={toast} />
    </div>
  );
}

function ListSkeleton() {
  return (
    <ul className="space-y-1 p-1.5">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 rounded-md px-2.5 py-2">
          <span className="size-10 shrink-0 animate-pulse rounded-full bg-surface-2" />
          <span className="min-w-0 flex-1 space-y-1.5">
            <span className="block h-3 w-2/3 animate-pulse rounded-sm bg-surface-2" />
            <span className="block h-2.5 w-1/2 animate-pulse rounded-sm bg-surface-2" />
          </span>
        </li>
      ))}
    </ul>
  );
}
