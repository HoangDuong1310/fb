/**
 * bulkCrawl.ts — Hàng đợi crawl nhóm tuần tự, SỐNG NGOÀI lifecycle React.
 *
 * Root cause (đã xác minh trong Tools.tsx CrawlTab):
 * - queue / bulkActive / CRAWL_DONE listener nằm trong CrawlTab.
 * - Tools chỉ mount CrawlTab khi tab === "crawl"; App chỉ mount Tools khi
 *   view === "tools". Rời tab/view => unmount => removeListener + mất queue.
 * - Hệ quả: sau 1–2 nhóm (hoặc trong lúc nghỉ 20–90s) hàng đợi đứng im dù
 *   CRAWL_DONE vẫn về background.
 *
 * Driver này:
 * 1. Giữ queue + listener chrome.runtime.onMessage ở module scope (dashboard
 *    page còn sống là còn chạy, không phụ thuộc React mount).
 * 2. Chỉ advance khi phase === "crawling" và CRAWL_DONE khớp groupId đang chạy
 *    (tránh auto-crawl / CRAWL_DONE lạc nhận làm xong nhóm đang nghỉ).
 * 3. UI subscribe snapshot để hiển thị progress khi remount lại CrawlTab.
 */

import { bg, type BgResponse } from "./bg";

export interface BulkGroup {
  groupId: string;
  groupName?: string;
}

export interface BulkCrawlOptions {
  method: "api" | "dom" | string;
  maxNewPosts?: number;
  stopAfterKnown?: number;
  scrollDelay?: number;
  restBetween?: number;
  fromTs?: number;
  safeMode?: boolean;
  [key: string]: unknown;
}

export type BulkPhase = "idle" | "crawling" | "waiting" | "done" | "aborted" | "stopped";

export interface BulkCrawlSnapshot {
  active: boolean;
  phase: BulkPhase;
  total: number;
  done: number;
  currentGroupId: string | null;
  currentGroupName: string | null;
  progress: string | null;
  lastReason: string | null;
  updatedAt: number;
}

type Listener = (snap: BulkCrawlSnapshot) => void;

const BLOCK_MARKERS = [
  "block",
  "checkpoint",
  "429",
  "chặn",
  "tạm khóa",
  "đăng nhập",
  "login",
];

function looksBlocked(reason?: string | null): boolean {
  if (!reason) return false;
  const s = reason.toLowerCase();
  return BLOCK_MARKERS.some((k) => s.includes(k));
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

interface InternalState {
  queue: BulkGroup[];
  options: BulkCrawlOptions;
  total: number;
  done: number;
  active: boolean;
  phase: BulkPhase;
  current: BulkGroup | null;
  progress: string | null;
  lastReason: string | null;
  waitTimer: number | null;
  gapMinMs: number;
  gapMaxMs: number;
}

const state: InternalState = {
  queue: [],
  options: { method: "api" },
  total: 0,
  done: 0,
  active: false,
  phase: "idle",
  current: null,
  progress: null,
  lastReason: null,
  waitTimer: null,
  gapMinMs: 20_000,
  gapMaxMs: 90_000,
};

const listeners = new Set<Listener>();
let runtimeHooked = false;

function snapshot(): BulkCrawlSnapshot {
  return {
    active: state.active,
    phase: state.phase,
    total: state.total,
    done: state.done,
    currentGroupId: state.current?.groupId ?? null,
    currentGroupName: state.current?.groupName ?? null,
    progress: state.progress,
    lastReason: state.lastReason,
    updatedAt: Date.now(),
  };
}

function emit() {
  const snap = snapshot();
  for (const fn of listeners) {
    try {
      fn(snap);
    } catch {
      /* listener UI lỗi không được làm hỏng driver */
    }
  }
}

function clearWaitTimer() {
  if (state.waitTimer != null) {
    window.clearTimeout(state.waitTimer);
    state.waitTimer = null;
  }
}

function ensureRuntimeHook() {
  if (runtimeHooked) return;
  runtimeHooked = true;
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    /* không trong extension context */
  }
}

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
  result?: {
    newCount?: number;
    reason?: string;
    groupId?: string;
  };
}

function formatDomProgress(
  name: string,
  p: NonNullable<ProgressMsg["progress"]>,
  prefix = "",
): string {
  const head = prefix ? `${prefix}${name}` : name;
  if (p.status === "started") return `${head}: bắt đầu…`;
  if (p.status === "stopped_known") return `${head}: dừng vì gặp bài đã biết.`;
  if (p.status === "stopped_old") return `${head}: dừng theo bộ lọc ngày.`;
  if (p.status === "resting") {
    return `${head}: nghỉ ngắn… (+${p.newCount || 0} bài, cuộn ${p.scrolls || 0})`;
  }
  if (p.status === "page") {
    return `${head}: +${p.newCount || 0} bài (trang ${p.pages || 0})`;
  }
  if (p.status === "done") {
    return `${head}: xong +${p.newCount || 0} bài (cuộn ${p.scrolls || 0})`;
  }
  // crawling / scanning / tick — luôn hiện cuộn + đã-quét để UI không "đứng"
  // khi đang quét bài cũ (console vẫn chạy).
  const seenPart =
    typeof p.seen === "number" && p.seen > 0 ? ` · quét ${p.seen}` : "";
  return `${head}: +${p.newCount || 0} bài${seenPart} (cuộn ${p.scrolls || 0})`;
}

function onRuntimeMessage(msg: ProgressMsg): void {
  if (!msg || typeof msg.type !== "string") return;
  if (!state.active) return;

  if (msg.type === "CRAWL_PROGRESS" && msg.progress) {
    // Chỉ nhận progress của nhóm đang crawl (tránh auto-crawl lẫn).
    const pid = msg.progress.groupId;
    if (state.phase === "crawling" && state.current) {
      if (pid && pid !== state.current.groupId) return;
      const name = msg.progress.groupName || state.current.groupName || state.current.groupId;
      const idx = state.done + 1;
      state.progress = formatDomProgress(name, msg.progress, `(${idx}/${state.total}) `);
      emit();
    }
    return;
  }

  if (msg.type === "CRAWL_DONE") {
    // Chỉ advance khi đang chờ CRAWL_DONE của nhóm hiện tại.
    // phase "waiting" = đang nghỉ giữa nhóm — CRAWL_DONE lạc (auto-crawl) phải bỏ qua.
    if (state.phase !== "crawling" || !state.current) return;

    const r = msg.result || {};
    // Nếu payload có groupId thì phải khớp; content.js hiện không luôn gửi groupId
    // trong result, nên chỉ filter khi có.
    if (r.groupId && r.groupId !== state.current.groupId) return;

    state.lastReason = r.reason || null;
    state.done += 1;
    state.current = null;
    state.phase = "waiting"; // tạm — advanceQueue sẽ set lại

    if (looksBlocked(r.reason)) {
      clearWaitTimer();
      state.queue = [];
      state.active = false;
      state.phase = "aborted";
      state.progress = `Đã dừng crawl hàng loạt: có dấu hiệu bị chặn${
        r.reason ? ` (${r.reason})` : ""
      }.`;
      emit();
      // Giữ progress abort vài giây rồi idle (UI vẫn đọc được last snapshot).
      window.setTimeout(() => {
        if (state.phase === "aborted" && !state.active) {
          state.phase = "idle";
          emit();
        }
      }, 8000);
      return;
    }

    advanceQueue();
  }
}

async function crawlOne(g: BulkGroup) {
  if (!state.active) return;
  state.phase = "crawling";
  state.current = g;
  const idx = state.done + 1;
  const name = g.groupName || g.groupId;
  state.progress = `(${idx}/${state.total}) Đang crawl ${name}…`;
  emit();

  // NHÃN TRUY NGUYÊN (B2): gắn Ở ĐÂY (crawlOne) chứ không gắn ở startBulkCrawl,
  // vì đây là điểm duy nhất mọi nhóm trong hàng đợi đều đi qua — kể cả nhóm được
  // thêm vào sau, hay lần thử lại sau khi dispatch lỗi. Ghi ĐÈ sau khi rải
  // state.options để cấu hình đã lưu không thể mạo nhãn khác.
  const opts = { ...(state.options || { method: "api" }), trigger: "bulk" };
  const handler = opts.method === "dom" ? "CRAWL_GROUP" : "CRAWL_GROUP_API";
  const res = await bg<BgResponse & { tabId?: number }>(handler, {
    groupId: g.groupId,
    options: opts,
  });

  if (!res.ok) {
    // Dispatch fail => không có CRAWL_DONE; tự advance để không kẹt queue.
    state.lastReason = res.error || "không crawl được";
    state.done += 1;
    state.current = null;
    state.progress = `(${state.done}/${state.total}) ${name}: ${state.lastReason}`;
    emit();
    advanceQueue();
  }
  // Thành công: chờ CRAWL_DONE từ content/background (phase vẫn "crawling").
}

function advanceQueue() {
  if (!state.active) return;
  clearWaitTimer();

  const next = state.queue.shift();
  if (!next) {
    const done = state.done;
    const total = state.total;
    state.active = false;
    state.phase = "done";
    state.current = null;
    state.progress = `Đã crawl xong ${done}/${total} nhóm.`;
    emit();
    window.setTimeout(() => {
      if (state.phase === "done" && !state.active) {
        state.phase = "idle";
        emit();
      }
    }, 8000);
    return;
  }

  // Nghỉ human-like giữa các nhóm (dashboard page foreground => setTimeout OK).
  const gap = randInt(state.gapMinMs, state.gapMaxMs);
  state.phase = "waiting";
  state.current = null;
  state.progress = `Nghỉ ${Math.round(gap / 1000)}s trước nhóm kế tiếp… (${state.done}/${state.total})`;
  emit();

  state.waitTimer = window.setTimeout(() => {
    state.waitTimer = null;
    if (!state.active) return;
    void crawlOne(next);
  }, gap);
}

/** Bắt đầu bulk crawl. Trả { ok, error? }. */
export function startBulkCrawl(
  list: BulkGroup[],
  options: BulkCrawlOptions,
  gap?: { minMs?: number; maxMs?: number },
): { ok: boolean; error?: string } {
  ensureRuntimeHook();

  if (state.active) {
    return { ok: false, error: "Đang có phiên crawl hàng loạt." };
  }
  const queue = (list || []).filter((g) => g && g.groupId);
  if (queue.length === 0) {
    return { ok: false, error: "Không có nhóm nào để crawl." };
  }

  clearWaitTimer();
  state.queue = queue.slice();
  state.options = options || { method: "api" };
  state.total = queue.length;
  state.done = 0;
  state.active = true;
  state.phase = "crawling";
  state.current = null;
  state.lastReason = null;
  state.gapMinMs = Math.max(0, gap?.minMs ?? 20_000);
  state.gapMaxMs = Math.max(state.gapMinMs, gap?.maxMs ?? 90_000);
  state.progress = `Bắt đầu crawl ${queue.length} nhóm (tuần tự)…`;
  emit();

  const first = state.queue.shift();
  if (first) void crawlOne(first);
  return { ok: true };
}

/** Dừng sau nhóm hiện tại (xóa queue; không force-kill tab đang crawl). */
export function stopBulkCrawl(): void {
  if (!state.active && state.phase === "idle") return;
  clearWaitTimer();
  state.queue = [];
  state.active = false;
  state.phase = "stopped";
  state.current = null;
  state.progress = `Đã yêu cầu dừng sau nhóm hiện tại (${state.done}/${state.total}).`;
  emit();
  window.setTimeout(() => {
    if (state.phase === "stopped" && !state.active) {
      state.phase = "idle";
      emit();
    }
  }, 6000);
}

export function getBulkCrawlSnapshot(): BulkCrawlSnapshot {
  return snapshot();
}

export function isBulkCrawlActive(): boolean {
  return state.active;
}

/** Subscribe snapshot. Trả hàm unsubscribe. Gọi ngay 1 lần với state hiện tại. */
export function subscribeBulkCrawl(fn: Listener): () => void {
  ensureRuntimeHook();
  listeners.add(fn);
  try {
    fn(snapshot());
  } catch {
    /* noop */
  }
  return () => {
    listeners.delete(fn);
  };
}
