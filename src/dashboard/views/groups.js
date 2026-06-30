/**
 * views/groups.js — Tab "Nhóm": quét nhóm đã tham gia, thêm thủ công, crawl
 * theo nhóm, crawl hàng loạt (pool song song + jitter), và tự động crawl nền.
 */

import { $, bg, store, toast, modal, esc, timeAgo, colorFor, initials, emptyState } from "../core.js";
import { flashSaved } from "../prefs.js";

/* ================================ NHÓM ================================= */

// Các cụm cho biết tên nhóm bị lẫn text thông báo/hoạt động của Facebook.
const GROUP_NAME_NOISE = [
  "Lần hoạt động gần nhất",
  "đã bình luận",
  "đã đăng",
  "đã chia sẻ",
  "đã phản hồi",
  "đã trả lời",
  "đã thích",
  "bài viết của bạn",
];

/** Trả về true nếu tên nhóm trông sạch (không phải dòng thông báo/hoạt động). */
export function isCleanGroupName(name) {
  const s = (name || "").trim();
  if (!s || s.length < 2 || s.length > 120) return false;
  if (/^https?:/i.test(s)) return false;
  if (/^Chưa đọc/i.test(s)) return false;
  return !GROUP_NAME_NOISE.some((mk) => s.includes(mk));
}

export async function loadGroups() {
  const res = await bg("GET_GROUPS");
  store.groups = (res && res.groups) || [];
  fillGroupSelects();
}

export function fillGroupSelects() {
  const opts = store.groups.map((g) => `<option value="${esc(g.groupId)}">${esc(g.groupName || g.groupId)}</option>`).join("");
  const postFilter = $("postsGroupFilter");
  if (postFilter) postFilter.innerHTML = `<option value="">Tất cả nhóm</option>` + opts;
  fillPostGroupChecklist();
}

/**
 * Dựng danh sách checkbox chọn nhóm để đăng bài hàng loạt (tab Đăng bài).
 * Giữ lại trạng thái đã tick khi nạp lại (nếu nhóm vẫn còn).
 * Ưu tiên ghim các nhóm "hay đăng" / "đăng gần đây" lên đầu (theo tài khoản,
 * lấy từ lịch sử device-local qua GET_POSTED_GROUPS).
 */
export async function fillPostGroupChecklist() {
  const list = $("postGroupList");
  if (!list) return;
  const checked = new Set(
    [...list.querySelectorAll("input.gcl-check:checked")].map((c) => c.value)
  );
  // Lọc bỏ những bản ghi rác từ lần quét cũ (text thông báo/hoạt động lẫn vào tên nhóm).
  const cleanGroups = store.groups.filter((g) => isCleanGroupName(g.groupName));
  if (!cleanGroups.length) {
    list.innerHTML = `<p class="gcl-empty">Chưa có nhóm — hãy quét nhóm ở tab Nhóm trước.</p>`;
    const cnt = $("postGroupCount");
    if (cnt) cnt.textContent = "0";
    return;
  }

  // Lấy lịch sử nhóm hay đăng / đăng gần đây để ghim lên đầu.
  // Không chặn hiển thị: nếu lỗi thì coi như không có lịch sử.
  let frequent = [];
  let recent = [];
  try {
    const res = await bg("GET_POSTED_GROUPS", { opts: { limit: 8 } });
    if (res && res.ok) {
      frequent = res.frequent || [];
      recent = res.recent || [];
    }
  } catch {
    /* bỏ qua — vẫn dựng danh sách bình thường */
  }

  // Map groupId -> nhãn ghim ("frequent" ưu tiên hơn "recent") + số lần đăng.
  const pinMeta = new Map();
  for (const g of recent) {
    if (g && g.groupId && !pinMeta.has(g.groupId)) {
      pinMeta.set(g.groupId, { kind: "recent", count: g.count || 0 });
    }
  }
  for (const g of frequent) {
    if (g && g.groupId) {
      // frequent đè lên recent (ưu tiên cao hơn).
      pinMeta.set(g.groupId, { kind: "frequent", count: g.count || 0 });
    }
  }

  // Sắp xếp: nhóm được ghim lên đầu (frequent trước recent, rồi theo số lần đăng),
  // còn lại giữ nguyên thứ tự gốc.
  const rank = (id) => {
    const m = pinMeta.get(id);
    if (!m) return 3;
    return m.kind === "frequent" ? 0 : 1;
  };
  const ordered = cleanGroups
    .map((g, idx) => ({ g, idx }))
    .sort((a, b) => {
      const ra = rank(a.g.groupId);
      const rb = rank(b.g.groupId);
      if (ra !== rb) return ra - rb;
      if (ra < 2) {
        const ca = (pinMeta.get(a.g.groupId) || {}).count || 0;
        const cb = (pinMeta.get(b.g.groupId) || {}).count || 0;
        if (cb !== ca) return cb - ca;
      }
      return a.idx - b.idx;
    })
    .map((x) => x.g);

  list.innerHTML = ordered
    .map((g) => {
      const name = g.groupName || g.groupId;
      const meta = pinMeta.get(g.groupId);
      let badge = "";
      if (meta) {
        const pinned = meta.kind === "frequent" ? "pinned-freq" : "pinned-recent";
        const label =
          meta.kind === "frequent"
            ? `Hay đăng${meta.count ? ` · ${meta.count} lần` : ""}`
            : "Gần đây";
        badge = `<span class="gcl-pin ${pinned}" title="${esc(label)}">${esc(label)}</span>`;
      }
      return `<label class="gcl-item${meta ? " is-pinned" : ""}" data-name="${esc(name)}">
        <input class="gcl-check" type="checkbox" value="${esc(g.groupId)}" data-name="${esc(name)}" ${
        checked.has(g.groupId) ? "checked" : ""
      } />
        <span class="gcl-name" title="${esc(name)}">${esc(name)}</span>${badge}
      </label>`;
    })
    .join("");
  const cnt = $("postGroupCount");
  if (cnt) cnt.textContent = String(checked.size);
}

export function renderGroups() {
  const term = ($("groupSearch").value || "").toLowerCase();
  const list = store.groups.filter(
    (g) =>
      isCleanGroupName(g.groupName) &&
      (!term || (g.groupName || "").toLowerCase().includes(term) || g.groupId.includes(term))
  );
  const wrap = $("groupsWrap");
  if (!list.length) {
    wrap.innerHTML = emptyState("Chưa có nhóm nào", 'Bấm "Quét nhóm đã tham gia" để tự động lấy danh sách nhóm.');
    return;
  }
  wrap.innerHTML = list
    .map((g) => {
      const c = colorFor(g.groupId);
      return `
      <div class="group-card${store.selected.has(g.groupId) ? " selected" : ""}" data-id="${esc(g.groupId)}">
        <div class="gc-top">
          <input class="gc-select" type="checkbox" data-sel title="Chọn để crawl hàng loạt" ${
            store.selected.has(g.groupId) ? "checked" : ""
          } />
          <div class="gc-avatar" style="background:${c}">${esc(initials(g.groupName))}</div>
          <div class="gc-meta">
            <div class="gc-name" title="${esc(g.groupName)}">${esc(g.groupName || g.groupId)}</div>
            <div class="gc-id">ID: ${esc(g.groupId)}</div>
          </div>
        </div>
        <div class="gc-stats">
          <div class="gc-stat"><b>${g.postCount || 0}</b><span>bài đã crawl</span></div>
          <div class="gc-stat"><b>${timeAgo(g.updatedAt) || "—"}</b><span>cập nhật</span></div>
        </div>
        <div class="gc-actions">
          <button class="btn primary" data-act="crawl">Crawl</button>
          <button class="btn ghost" data-act="open">Mở nhóm</button>
          <button class="btn danger-ghost" data-act="del">Xóa</button>
        </div>
      </div>`;
    })
    .join("");
  updateSelCount();
}

export async function scanGroups() {
  toast("Đang mở trang 'Nhóm của bạn' và quét... vui lòng chờ.", "info", 4000);
  const res = await bg("SCAN_JOINED_GROUPS");
  if (!res || !res.ok) {
    toast((res && res.error) || "Quét nhóm thất bại.", "err");
    return;
  }
  toast(`Đã quét ${res.scanned} nhóm (mới: ${res.added}, cập nhật: ${res.updated}).`, "ok");
  await loadGroups();
  renderGroups();
}

export function addGroupManual() {
  modal({
    title: "Thêm nhóm thủ công",
    bodyHTML: `
      <label class="field"><span>Group ID hoặc link nhóm</span>
        <input id="mGroupId" type="text" placeholder="vd: 950437708832783 hoặc https://facebook.com/groups/..." /></label>
      <label class="field"><span>Tên hiển thị (tùy chọn)</span>
        <input id="mGroupName" type="text" placeholder="Tên nhóm" /></label>`,
    confirmText: "Thêm",
    onConfirm: async (ov) => {
      let raw = (ov.querySelector("#mGroupId").value || "").trim();
      const m = raw.match(/\/groups\/([^/?#]+)/);
      const groupId = m ? m[1] : raw;
      if (!groupId) {
        toast("Hãy nhập Group ID.", "err");
        return false;
      }
      const groupName = (ov.querySelector("#mGroupName").value || "").trim() || groupId;
      const res = await bg("SAVE_GROUP", { group: { groupId, groupName } });
      if (!res || !res.ok) {
        toast((res && res.error) || "Không lưu được nhóm.", "err");
        return false;
      }
      toast("Đã thêm nhóm.", "ok");
      await loadGroups();
      renderGroups();
    },
  });
}

export function crawlOpts() {
  const num = (id, def, min, max) => {
    const v = parseInt(($(id) && $(id).value) || "", 10);
    if (isNaN(v)) return def;
    return Math.min(max, Math.max(min, v));
  };
  // "Crawl từ ngày" (yyyy-mm-dd) -> mốc epoch ms đầu ngày theo giờ địa phương.
  // Bài cũ hơn mốc này sẽ bị bỏ qua; rỗng nghĩa là không giới hạn theo ngày.
  let fromTs = 0;
  const fromStr = ($("crawlFromDate") && $("crawlFromDate").value) || "";
  if (fromStr) {
    const t = new Date(fromStr + "T00:00:00").getTime();
    if (!isNaN(t)) fromTs = t;
  }
  return {
    maxNewPosts: num("crawlMax", 100, 1, 2000),
    stopAfterKnown: num("crawlStopKnown", 8, 1, 100),
    scrollDelay: num("crawlDelay", 1500, 400, 8000),
    restBetween: num("crawlRest", 20, 0, 600),
    maxThreads: num("crawlThreads", 3, 1, 20),
    fromTs,
    safeMode: !!($("crawlSafe") && $("crawlSafe").checked),
  };
}

export function setCrawlStatus(text, busy) {
  const el = $("crawlStatus");
  if (el) {
    el.textContent = text;
    el.classList.toggle("busy", !!busy);
  }
  const bar = $("crawlBar");
  if (bar) bar.classList.toggle("show", !!busy);
}

export async function crawlGroup(groupId) {
  const g = store.groups.find((x) => x.groupId === groupId);
  const name = (g && (g.groupName || g.groupId)) || groupId;
  setCrawlStatus(`Đang mở nhóm "${name}" ở tab nền và khởi động crawl...`, true);
  toast("Đã bắt đầu crawl ở tab nền. Theo dõi tiến trình ngay tại đây.", "info", 3000);
  const res = await bg("CRAWL_GROUP", { groupId, options: crawlOpts() });
  if (!res || !res.ok) {
    setCrawlStatus((res && res.error) || "Không bắt đầu được crawl.", false);
    toast((res && res.error) || "Không bắt đầu được crawl.", "err", 5000);
  }
}

/**
 * Crawl QUA API nội bộ FB (sniff + replay). Mở tab nền, gửi START_API_CRAWL.
 * Tiến trình phát qua broadcast CRAWL_PROGRESS / CRAWL_DONE.
 */
export async function crawlGroupApi(groupId) {
  const g = store.groups.find((x) => x.groupId === groupId);
  const name = (g && (g.groupName || g.groupId)) || groupId;
  setCrawlStatus(`[API] Đang mở nhóm "${name}" ở tab nền và khởi động crawl API...`, true);
  toast("Đã bắt đầu crawl API ở tab nền. Theo dõi tiến trình ngay tại đây.", "info", 3000);
  const res = await bg("CRAWL_GROUP_API", { groupId, options: crawlOpts() });
  if (!res || !res.ok) {
    setCrawlStatus((res && res.error) || "Không bắt đầu được crawl API.", false);
    toast((res && res.error) || "Không bắt đầu được crawl API.", "err", 5000);
  }
}

/**
 * Test tự động hoàn toàn: mở nhóm 95043770832783 ở tab nền, bắt API, parse, lưu.
 * Người dùng chỉ cần bấm 1 nút — mọi thứ còn lại tự chạy.
 */
export async function testApiAuto() {
  const TEST_GROUP_ID = "381914474762181";
  // Đánh dấu: khi CRAWL_DONE về, dashboard sẽ tự chuyển sang view "posts"
  // và lọc theo groupId này để người dùng thấy ngay các bài vừa lấy được.
  store.pendingPostsView = TEST_GROUP_ID;
  setCrawlStatus(`[API TEST] Đang tự động mở nhóm ${TEST_GROUP_ID} ở tab nền...`, true);
  toast("Đang chạy test API tự động. Mọi thứ sẽ tự chạy — bạn không cần làm gì thêm.", "info", 4000);
  const res = await bg("CRAWL_GROUP_API", {
    groupId: TEST_GROUP_ID,
    options: { ...crawlOpts(), maxNewPosts: 30, stopAfterKnown: 3 },
  });
  if (!res || !res.ok) {
    setCrawlStatus((res && res.error) || "Không bắt đầu được test API.", false);
    toast((res && res.error) || "Không bắt đầu được test API.", "err", 5000);
    store.pendingPostsView = null;
  } else {
    setCrawlStatus(`[API TEST] Đã mở tab #${res.tabId}. Đang bắt API và parse...`, true);
  }
}

/* ===================== TỰ ĐỘNG CRAWL NỀN THEO CHU KỲ ===================== */
export function saveAutoCrawl() {
  const enabled = !!($("autoCrawlEnabled") && $("autoCrawlEnabled").checked);
  let interval = parseInt(($("autoCrawlInterval") && $("autoCrawlInterval").value) || "", 10);
  if (isNaN(interval)) interval = 30;
  interval = Math.min(1440, Math.max(1, interval));
  if ($("autoCrawlInterval")) $("autoCrawlInterval").value = interval;
  bg("SET_AUTOCRAWL", {
    config: { enabled, intervalMinutes: interval, options: crawlOpts() },
  }).then((res) => {
    if (res && res.ok) {
      flashSaved();
      toast(
        enabled
          ? `Đã bật tự động crawl mỗi ${interval} phút cho tất cả nhóm đã lưu.`
          : "Đã tắt tự động crawl nền.",
        "ok",
        3000
      );
    } else {
      toast((res && res.error) || "Không lưu được cấu hình tự động crawl.", "err", 5000);
    }
  });
}

export async function loadAutoCrawl() {
  const res = await bg("GET_AUTOCRAWL");
  const cfg = (res && res.config) || {};
  if ($("autoCrawlEnabled")) $("autoCrawlEnabled").checked = !!cfg.enabled;
  if ($("autoCrawlInterval") && cfg.intervalMinutes) {
    $("autoCrawlInterval").value = cfg.intervalMinutes;
  }
}

/* =========================== CRAWL HÀNG LOẠT =========================== */
export function visibleGroupIds() {
  const term = ($("groupSearch").value || "").toLowerCase();
  return store.groups
    .filter(
      (g) => !term || (g.groupName || "").toLowerCase().includes(term) || g.groupId.includes(term)
    )
    .map((g) => g.groupId);
}

export function updateSelCount() {
  const n = store.selected.size;
  const cnt = $("selCount");
  if (cnt) cnt.textContent = n ? `(${n})` : "";
  const btnSel = $("btnCrawlSelected");
  if (btnSel) btnSel.disabled = n === 0 || !!store.batch;
  const chk = $("chkSelectAll");
  if (chk) {
    const ids = visibleGroupIds();
    const allSel = ids.length > 0 && ids.every((id) => store.selected.has(id));
    chk.checked = allSel;
    chk.indeterminate = !allSel && ids.some((id) => store.selected.has(id));
  }
}

export function toggleSelectAll() {
  const chk = $("chkSelectAll");
  const ids = visibleGroupIds();
  if (chk && chk.checked) ids.forEach((id) => store.selected.add(id));
  else ids.forEach((id) => store.selected.delete(id));
  renderGroups();
}

export function toggleBatchUI(running) {
  const btnStop = $("btnStopBatch");
  const btnSel = $("btnCrawlSelected");
  if (btnStop) btnStop.style.display = running ? "" : "none";
  if (btnSel) btnSel.disabled = running || store.selected.size === 0;
}

export function updateBatchStatus(extra) {
  const b = store.batch;
  if (!b) return;
  const head = `[Hàng loạt] Xong ${b.done}/${b.total} · đang chạy ${b.active} luồng`;
  setCrawlStatus(extra ? `${head} · ${extra}` : `${head}...`, true);
}

// Giãn cách mở tab để tránh mở đồng loạt nhiều tab cùng lúc (jitter nhẹ)
export function batchStaggerMs() {
  return 2000 + Math.floor(Math.random() * 1800);
}

export async function startBatchCrawl() {
  if (store.batch) return;
  const queue = [...store.selected];
  if (!queue.length) {
    toast("Chưa chọn nhóm nào để crawl hàng loạt.", "err");
    return;
  }
  // QUAN TRỌNG: crawl TUẦN TỰ 1 nhóm/lần (không song song). Facebook ảo hoá feed
  // và CHỈ mount bài khi tab đang hiển thị (foreground). Mở nhiều tab nền cùng lúc
  // bị Chrome bóp ga/đóng băng (throttle/freeze) nên mỗi tab chỉ mount 1–2 bài ->
  // crawl thiếu. Đã XÁC MINH: crawl 1 nhóm lấy đủ, nhiều nhóm cùng lúc thì thiếu.
  // Vì chỉ một tab được foreground tại một thời điểm, chạy song song là bất khả thi
  // với feed ảo hoá -> ép 1 luồng để mỗi nhóm lấy đủ bài.
  const maxThreads = 1;
  store.batch = {
    queue,
    nextIndex: 0,
    total: queue.length,
    active: 0,
    done: 0,
    stop: false,
    maxThreads,
  };
  toggleBatchUI(true);
  toast(
    `Bắt đầu crawl hàng loạt ${queue.length} nhóm (chạy tuần tự từng nhóm để lấy ĐỦ bài; giữ jitter chống checkpoint).`,
    "info",
    3500
  );
  pumpPool();
}

// Lấp đầy pool tới maxThreads, mở tab giãn cách để tránh mở đồng loạt
export function pumpPool() {
  const b = store.batch;
  if (!b) return;
  if (b.stop) {
    if (b.active === 0) finishBatch(true);
    return;
  }
  if (b.active < b.maxThreads && b.nextIndex < b.queue.length) {
    launchNext();
    // Còn chỗ trống & còn nhóm: mở slot kế tiếp sau một nhịp giãn cách
    if (b.active < b.maxThreads && b.nextIndex < b.queue.length) {
      setTimeout(() => pumpPool(), batchStaggerMs());
    }
    return;
  }
  // Hết hàng đợi và không còn tab nào chạy => hoàn tất
  if (b.active === 0 && b.nextIndex >= b.queue.length) {
    finishBatch(false);
  }
}

export async function launchNext() {
  const b = store.batch;
  if (!b || b.stop || b.nextIndex >= b.queue.length) return;
  const groupId = b.queue[b.nextIndex];
  // Chiếm slot ngay (đồng bộ, trước await) để pumpPool đếm đúng số luồng
  b.nextIndex += 1;
  b.active += 1;
  const g = store.groups.find((x) => x.groupId === groupId);
  const name = (g && (g.groupName || g.groupId)) || groupId;
  updateBatchStatus(`mở "${name}"`);
  const res = await bg("CRAWL_GROUP", { groupId, options: crawlOpts() });
  if (!res || !res.ok) {
    // Tab không mở được: nhả slot, tính như đã xử lý, rồi lấp tiếp
    toast(`Nhóm "${name}" lỗi: ${(res && res.error) || "không rõ"}. Bỏ qua.`, "err", 4000);
    b.active -= 1;
    b.done += 1;
    scheduleRefill();
  }
  // Thành công: chờ CRAWL_DONE ở listener -> onWorkerDone()
}

// Một tab vừa crawl xong: nhả slot rồi lấp nhóm kế tiếp
export function onWorkerDone() {
  const b = store.batch;
  if (!b) return;
  b.active -= 1;
  if (b.active < 0) b.active = 0;
  b.done += 1;
  loadGroups();
  if (b.stop && b.active === 0) {
    finishBatch(true);
    return;
  }
  if (b.done >= b.total && b.active === 0) {
    finishBatch(false);
    return;
  }
  scheduleRefill();
}

// Lên lịch mở nhóm kế tiếp sau khoảng nghỉ giữa nhóm (restBetween) để giảm rủi ro checkpoint
export function scheduleRefill() {
  const b = store.batch;
  if (!b) return;
  if (b.stop) {
    if (b.active === 0) finishBatch(true);
    return;
  }
  if (b.nextIndex >= b.queue.length) {
    if (b.active === 0) finishBatch(false);
    return;
  }
  const rest = crawlOpts().restBetween;
  if (rest > 0) {
    updateBatchStatus(`nghỉ ${rest}s trước nhóm kế tiếp`);
    setTimeout(() => {
      if (store.batch) pumpPool();
    }, rest * 1000);
  } else {
    pumpPool();
  }
}

export function finishBatch(stopped) {
  const b = store.batch;
  const total = b ? b.total : 0;
  const done = b ? b.done : 0;
  store.batch = null;
  toggleBatchUI(false);
  setCrawlStatus(
    stopped
      ? `Đã dừng crawl hàng loạt (đã xong ${done}/${total}).`
      : `Hoàn tất crawl hàng loạt ${total} nhóm.`,
    false
  );
  toast(
    stopped ? "Đã dừng crawl hàng loạt." : "Hoàn tất crawl hàng loạt.",
    stopped ? "info" : "ok",
    4000
  );
}

export function stopBatchCrawl() {
  if (store.batch) {
    store.batch.stop = true;
    setCrawlStatus("Sẽ dừng sau khi các nhóm đang chạy hoàn tất (không mở thêm nhóm mới)...", true);
    toast("Sẽ dừng sau khi các tab đang crawl xong.", "info", 3000);
  }
}
