/**
 * db.js — Lớp truy cập dữ liệu cho extension, nay là MỘT API CLIENT mỏng.
 *
 * Trước đây dùng IndexedDB cục bộ; nay mọi dữ liệu CHIA SẺ (posts, groups,
 * products, sources, advisories, conversations...) đi qua web backend bằng
 * apiFetch() trong api.js (gắn Bearer token, parse JSON, ném khi non-2xx).
 *
 * NAY MỌI THỨ THEO TÀI KHOẢN: hàng đợi job (đăng bài/bình luận), hộp thư
 * Messenger (inbox threads) và lịch sử nhóm đã đăng (posted groups) cũng ĐI QUA
 * server theo user (isolation bằng JWT). Chỉ token/đăng nhập và trạng thái
 * tab/session mới còn ở chrome.storage.local. Nhờ vậy dữ liệu đồng bộ trên mọi
 * thiết bị của cùng một tài khoản.
 *
 * QUAN TRỌNG: TÊN HÀM XUẤT RA & HÌNH DẠNG GIÁ TRỊ TRẢ VỀ được GIỮ NGUYÊN để
 * crawl.js / advisory.js / prices.js / background.js / dashboard views không
 * phải đổi gì. Tiêu thụ qua `import * as DB from "./db.js"`.
 *
 * Module ES (import/export), khớp phong cách util.js / api.js.
 */

import { apiFetch } from "./api.js";

/* ----------------------------- Helpers ---------------------------------- */

/**
 * Dựng query string từ object, BỎ QUA các giá trị null/undefined/"".
 * Trả về "" khi không có tham số nào (để URL giữ nguyên không có dấu "?").
 */
function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === "") continue;
    usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? "?" + s : "";
}

/* ============================ POSTS ====================================== */

/**
 * Lưu (hoặc cập nhật) nhiều bài viết. Trả về { added, updated } từ server.
 * Bài đã tồn tại (cùng postId) sẽ được cập nhật nhưng không tính là mới.
 */
async function savePosts(posts) {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { added: 0, updated: 0 };
  }
  const body = await apiFetch("/api/posts", {
    method: "POST",
    body: JSON.stringify({ posts }),
  });
  return { added: body?.added || 0, updated: body?.updated || 0 };
}

/**
 * Lấy danh sách postId đã lưu (toàn bộ hoặc theo nhóm) dưới dạng MẢNG string.
 * Dùng làm danh sách "đã thấy" để content script bỏ qua bài cũ (caller bọc
 * thành Set). GIỮ shape: trả về mảng.
 */
async function getKnownIds(groupId) {
  const body = await apiFetch("/api/posts/known-ids" + qs({ groupId }));
  return Array.isArray(body?.ids) ? body.ids : [];
}

/** Lấy toàn bộ bài viết (tùy chọn lọc theo nhóm). Trả về MẢNG (server sort sẵn).
 * Dữ liệu bài viết là RIÊNG TƯ theo tài khoản: server chỉ trả bài do chính
 * người dùng hiện tại crawl. */
async function getAllPosts(groupId) {
  const body = await apiFetch("/api/posts" + qs({ groupId }));
  return Array.isArray(body?.posts) ? body.posts : [];
}

/** Lấy lịch sử bình luận của MỘT bài viết (ai đã comment, nội dung gì) để AI
 * tránh trùng lặp. Trả về MẢNG [{id, postId, userId, content, commentedAt}]. */
async function getPostComments(postId) {
  if (!postId) return [];
  const body = await apiFetch(
    "/api/posts/" + encodeURIComponent(postId) + "/comments"
  );
  return Array.isArray(body?.comments) ? body.comments : [];
}

/** Thống kê: { total, groups:[{groupId, groupName, count}] } — giữ đúng shape cũ. */
async function getStats() {
  const body = await apiFetch("/api/stats");
  return {
    total: body?.total || 0,
    groups: Array.isArray(body?.groups) ? body.groups : [],
  };
}

/** Xóa bài của CHÍNH user (hoặc theo nhóm). Trả về SỐ bài đã xóa. */
async function clearPosts(groupId) {
  const body = await apiFetch("/api/posts" + qs({ groupId }), {
    method: "DELETE",
  });
  return body?.deleted || 0;
}

/* ============================ GROUPS ===================================== */

/** Thêm/cập nhật MỘT nhóm. Trả về bản ghi nhóm (best-effort, echo input). */
async function saveGroup(group) {
  if (!group || !group.groupId) throw new Error("Thiếu groupId.");
  await apiFetch("/api/groups", {
    method: "POST",
    body: JSON.stringify({ groups: [group] }),
  });
  return { ...group };
}

/** Lưu nhiều nhóm. Trả về { added, updated } từ server. */
async function saveGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) return { added: 0, updated: 0 };
  const body = await apiFetch("/api/groups", {
    method: "POST",
    body: JSON.stringify({ groups }),
  });
  return { added: body?.added || 0, updated: body?.updated || 0 };
}

/** Lấy toàn bộ nhóm, kèm postCount (server tính sẵn). Trả về MẢNG. */
async function getGroups() {
  const body = await apiFetch("/api/groups");
  return Array.isArray(body?.groups) ? body.groups : [];
}

/** Xóa một nhóm (không xóa bài đã crawl của nhóm đó). Trả về true. */
async function deleteGroup(groupId) {
  await apiFetch("/api/groups/" + encodeURIComponent(groupId), {
    method: "DELETE",
  });
  return true;
}

/* ============================= JOBS ====================================== */
//
// Job = hàng đợi tự động hoá (đăng bài / bình luận / nhắn tin). TRƯỚC ĐÂY lưu
// CỤC BỘ trong chrome.storage.local ("localJobs"); NAY đã chuyển LÊN SERVER theo
// TÀI KHOẢN người dùng qua /api/jobs (đồng bộ mọi thiết bị, không còn giới hạn
// ~10MB của chrome.storage). Toàn bộ logic hàng đợi (cấp id, chống trùng, khôi
// phục job kẹt, trần số tin/ngày) nằm ở server (web/routes/jobs.js); ở đây chỉ
// là lớp gọi API mỏng, GIỮ NGUYÊN tên hàm + hình dạng bản ghi trả về để
// crawl.js / background.js / dashboard không phải đổi gì.

/** Tạo một job (đăng bài / bình luận / nhắn tin). Trả về job đã lưu (kèm id). */
async function createJob(job) {
  return apiFetch("/api/jobs", {
    method: "POST",
    body: JSON.stringify({ job: job || {} }),
  });
}

/** Tạo nhiều job cùng lúc (batch). Trả về mảng job đã lưu. */
async function createJobs(jobs) {
  return apiFetch("/api/jobs/batch", {
    method: "POST",
    body: JSON.stringify({ jobs: Array.isArray(jobs) ? jobs : [] }),
  });
}

/** Cập nhật một job theo id (gộp các trường truyền vào). Trả về job merged hoặc null. */
async function updateJob(id, patch) {
  try {
    return await apiFetch("/api/jobs/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify({ patch: patch || {} }),
    });
  } catch (e) {
    // 404 -> job không tồn tại: giữ hợp đồng cũ (trả null thay vì ném).
    if (/\b404\b/.test(String(e && e.message))) return null;
    throw e;
  }
}

/** Lấy toàn bộ job (tùy chọn lọc theo type), mới nhất trước. */
async function getJobs(type) {
  return apiFetch("/api/jobs" + qs({ type }));
}

/** Lấy các job đang chờ tới hạn chạy (status=pending và scheduledAt<=now). */
async function getDueJobs(now) {
  return apiFetch("/api/jobs/due" + qs({ now: now || Date.now() }));
}

/**
 * Khôi phục các job bị KẸT ở trạng thái "running" (client MV3 bị tắt giữa
 * chừng). Server đưa job kẹt về "pending" để chạy lại, hoặc "error" nếu đã thử
 * quá số lần. Trả về số job đã thay đổi.
 */
async function recoverStuckJobs(now) {
  const r = await apiFetch("/api/jobs/recover-stuck", {
    method: "POST",
    body: JSON.stringify({ now: now || Date.now() }),
  });
  return (r && r.changed) || 0;
}

/** Xóa một job theo id. Trả về true. */
async function deleteJob(id) {
  await apiFetch("/api/jobs/" + encodeURIComponent(id), { method: "DELETE" });
  return true;
}

/** Xóa các job đã hoàn tất hoặc lỗi (dọn dẹp). Trả về số job đã xóa. */
async function clearFinishedJobs() {
  const r = await apiFetch("/api/jobs/clear-finished", { method: "POST" });
  return (r && r.deleted) || 0;
}

/** Xóa TOÀN BỘ job trong hàng đợi (bất kể trạng thái). Trả về số job đã xóa. */
async function clearAllJobs() {
  const r = await apiFetch("/api/jobs/clear-all", { method: "POST" });
  return (r && r.deleted) || 0;
}

/**
 * Duyệt HÀNG LOẠT: mọi job đang CHỜ DUYỆT (paused) chuyển sang pending trong MỘT
 * lượt gọi (server chạy một câu UPDATE). Tránh N vòng PATCH tuần tự làm service
 * worker MV3 quá hạn phản hồi (lỗi "message port closed"). Trả về số job đã duyệt.
 */
async function approveAllJobs(type) {
  const r = await apiFetch("/api/jobs/approve-all", {
    method: "POST",
    body: JSON.stringify(type ? { type } : {}),
  });
  return (r && r.approved) || 0;
}

/* ============ GIỚI HẠN AN TOÀN CHO JOB CHÀO HÀNG (message) ============== */
//
// Gửi tin nhắn chào hàng qua inbox rủi ro cao hơn đăng bài / bình luận, nên áp
// hạn mức BẢO THỦ ở server — coi như chốt chặn cuối (UI vẫn duyệt tay từng tin):
// (1) trần số tin mỗi ngày; (2) CHỐNG TRÙNG — không tạo 2 job chào hàng tới cùng
// một người khi job cũ chưa kết thúc hoặc đã gửi thành công.

// Trần số tin nhắn chào hàng mỗi ngày (theo lịch ngày địa phương). Giữ NGUYÊN
// hằng số này ở client để các nơi hiển thị/ước lượng còn dùng; server áp cùng trần.
const MESSAGE_DAILY_CAP = 15;

/**
 * Đếm số job chào hàng (type="message") ĐÃ CHIẾM SUẤT trong ngày chứa `now`.
 * Mốc 00:00 tính theo giờ ĐỊA PHƯƠNG của client nên truyền `now` (ms) lên server.
 */
async function countMessageJobsToday(now) {
  const r = await apiFetch("/api/jobs/message-count-today" + qs({ now: now || Date.now() }));
  return (r && r.count) || 0;
}

/**
 * Tìm job chào hàng đang "sống" (pending/running/done) gửi tới cùng một trang
 * cá nhân khách (meta.authorProfile) để CHỐNG TRÙNG. Trả về job hoặc null.
 */
async function findLiveMessageJobByProfile(authorProfile) {
  const key = String(authorProfile || "").trim();
  if (!key) return null;
  const r = await apiFetch("/api/jobs/live-message" + qs({ authorProfile: key }));
  return (r && r.job) || null;
}

/* ============ HỘP THƯ MESSENGER (inbox threads) ========================= */
//
// Các cuộc HỘI THOẠI CÓ SẴN trong Messenger thật của người dùng, quét được từ
// DOM khi họ bấm "Quét hộp thư". TRƯỚC ĐÂY lưu cục bộ (chrome.storage.local
// "inboxThreads"); NAY chuyển LÊN SERVER theo TÀI KHOẢN qua /api/inbox. Mỗi
// thread định danh bằng `threadId`; quét lại là UPSERT (gộp) ở server, giữ
// draft/nháp + tên hợp lệ + tin cũ + trạng thái đọc. Client chỉ gọi API.

/** Lấy toàn bộ hội thoại hộp thư, mới cập nhật trước. */
async function getInboxThreads() {
  const list = await apiFetch("/api/inbox");
  return Array.isArray(list) ? list : [];
}

/** Lấy MỘT hội thoại theo threadId, hoặc null. */
async function getInboxThread(threadId) {
  const key = String(threadId || "").trim();
  if (!key) return null;
  return apiFetch("/api/inbox/" + encodeURIComponent(key));
}

/**
 * UPSERT một danh sách hội thoại quét được (theo threadId). Server gộp vào bản
 * ghi cũ (giữ draft/nháp, tên hợp lệ, tin nhắn + trạng thái đọc). Trả về
 * { added, updated, total }.
 */
async function upsertInboxThreads(threads) {
  return apiFetch("/api/inbox/upsert", {
    method: "POST",
    body: JSON.stringify({ threads: Array.isArray(threads) ? threads : [] }),
  });
}

/** Cập nhật một hội thoại theo threadId (gộp trường). Trả về bản ghi hoặc null. */
async function updateInboxThread(threadId, patch) {
  const key = String(threadId || "").trim();
  if (!key) return null;
  try {
    return await apiFetch("/api/inbox/" + encodeURIComponent(key), {
      method: "PATCH",
      body: JSON.stringify({ patch: patch || {} }),
    });
  } catch (e) {
    if (/\b404\b/.test(String(e && e.message))) return null;
    throw e;
  }
}

/** Xoá một hội thoại khỏi hộp thư. Trả về true. */
async function deleteInboxThread(threadId) {
  const key = String(threadId || "").trim();
  await apiFetch("/api/inbox/" + encodeURIComponent(key), { method: "DELETE" });
  return true;
}

/* ===================== POSTED GROUPS (lịch sử đăng) ====================== */
//
// Danh sách nhóm mà từng NICK FACEBOOK đã đăng bài, kèm số lần đăng (count) và
// lần đăng gần nhất (lastPostedAt). TRƯỚC ĐÂY lưu cục bộ (chrome.storage.local
// "postedGroups", map theo FB account id); NAY chuyển LÊN SERVER theo TÀI KHOẢN
// người dùng qua /api/posted-groups, VẪN tách theo từng nick FB (`userId` ở đây
// chính là FB account id -> gửi lên làm `fbAccountId`).

/**
 * Ghi nhận một nick FB vừa đăng vào các nhóm (tăng count + cập nhật lastPostedAt).
 * `userId` là FB account id (có thể null -> "_local"). `groups` là mảng
 * { groupId, groupName }. Trả về danh sách nhóm-đã-đăng mới nhất của nick đó.
 */
async function recordPostedGroups(userId, groups) {
  return apiFetch("/api/posted-groups/record", {
    method: "POST",
    body: JSON.stringify({
      fbAccountId: userId == null || userId === "" ? "_local" : String(userId),
      groups: Array.isArray(groups) ? groups : [],
    }),
  });
}

/**
 * Lấy danh sách nhóm-đã-đăng của một nick FB, kèm hai cách sắp xếp gợi ý.
 * Trả về { recent: PostedGroup[], frequent: PostedGroup[] }.
 */
async function getPostedGroups(userId, opts = {}) {
  return apiFetch(
    "/api/posted-groups" +
      qs({
        fbAccountId: userId == null || userId === "" ? "_local" : String(userId),
        limit: typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined,
      })
  );
}

/* ====================== WARMING ACTIVITY LOG =========================== *
 * Nhật ký hoạt động "nuôi tài khoản" (cuộn feed, xem video, mở thông báo...),
 * LƯU HOÀN TOÀN TRÊN SERVER theo TÀI KHOẢN (không dùng chrome.storage.local).
 *   POST /api/warming/log body { type, status, data } -> { id, createdAt }
 *   GET  /api/warming/log?limit -> { entries:[...] } (mới nhất trước)
 * ---------------------------------------------------------------------- */

/**
 * Ghi một mục nhật ký nuôi tài khoản. `entry` = { type, status, data }.
 * Trả về { id, createdAt }.
 */
async function recordWarmingActivity(entry = {}) {
  return apiFetch("/api/warming/log", {
    method: "POST",
    body: JSON.stringify({
      type: entry.type != null ? String(entry.type) : "action",
      status: entry.status != null ? String(entry.status) : "done",
      data: entry.data ?? {},
    }),
  });
}

/**
 * Lấy nhật ký nuôi tài khoản (mới nhất trước). Trả về { entries: [...] }.
 */
async function getWarmingActivity(opts = {}) {
  return apiFetch(
    "/api/warming/log" +
      qs({
        limit: typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : undefined,
      })
  );
}

/* ============================ SETTINGS ================================== */
//
// Cấu hình nhỏ theo TÀI KHOẢN (key/value JSON) — thay cho các khoá trước đây ở
// chrome.storage.local: aiConfig, aiModelList, fbSelectors, crawlSettings,
// uiPrefs, deletedPriceSeedIds, autoCrawlConfig, autoSyncConfig,
// watchRepliesConfig. Đồng bộ trên mọi thiết bị của cùng một tài khoản.
//
// LƯU Ý: chỉ gọi được từ ngữ cảnh CÓ token (background/popup/dashboard).
// Content script KHÔNG gọi trực tiếp — phải nhờ background qua message.

/**
 * Đọc một khoá cấu hình. Trả về `value` (hoặc `def` nếu chưa có / lỗi mạng).
 */
async function getSetting(key, def = null) {
  try {
    const r = await apiFetch("/api/settings/" + encodeURIComponent(key));
    return r && "value" in r && r.value != null ? r.value : def;
  } catch (e) {
    return def;
  }
}

/** Ghi (upsert) một khoá cấu hình. Trả về giá trị đã ghi. */
async function setSetting(key, value) {
  const r = await apiFetch("/api/settings/" + encodeURIComponent(key), {
    method: "PUT",
    body: JSON.stringify({ value: value ?? null }),
  });
  return r && "value" in r ? r.value : value;
}

/** Xoá một khoá cấu hình. */
async function deleteSetting(key) {
  return apiFetch("/api/settings/" + encodeURIComponent(key), { method: "DELETE" });
}

/* ====================== MESSAGE TEMPLATES ============================== *
 * Mẫu tin chào hàng tái sử dụng — LƯU HOÀN TOÀN TRÊN SERVER theo TÀI KHOẢN
 * (không dùng chrome.storage.local). `content` có thể chứa {{ten}} để tự
 * điền tên khách khi gửi. `kind` phân loại 'pitch' | 'zalo' | ...
 * ---------------------------------------------------------------------- */

/** Lấy danh sách mẫu tin (tuỳ chọn lọc theo kind). Trả về MẢNG. */
async function getMessageTemplates(kind) {
  const body = await apiFetch("/api/message-templates" + qs({ kind }));
  return Array.isArray(body?.templates) ? body.templates : [];
}

/**
 * Lưu (tạo mới hoặc cập nhật) một mẫu tin. Nếu `tpl.id` có sẵn -> PATCH,
 * ngược lại -> POST tạo mới. Trả về { ok, id? }.
 */
async function saveMessageTemplate(tpl) {
  const t = tpl || {};
  if (t.id != null && t.id !== "") {
    const body = await apiFetch(
      "/api/message-templates/" + encodeURIComponent(t.id),
      {
        method: "PATCH",
        body: JSON.stringify({ name: t.name, content: t.content, images: t.images, kind: t.kind }),
      }
    );
    return { ok: true, id: t.id, updated: body?.updated ?? 0 };
  }
  const body = await apiFetch("/api/message-templates", {
    method: "POST",
    body: JSON.stringify({ name: t.name, content: t.content ?? "", images: t.images, kind: t.kind ?? "pitch" }),
  });
  return { ok: true, id: body?.id };
}

/** Xoá một mẫu tin theo id. */
async function deleteMessageTemplate(id) {
  return apiFetch("/api/message-templates/" + encodeURIComponent(id), {
    method: "DELETE",
  });
}

/* ============================ PRODUCTS =================================== */

/** Lưu (hoặc cập nhật) nhiều sản phẩm vào catalog chung. Trả về { added, updated }. */
async function saveProducts(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return { added: 0, updated: 0 };
  }
  const body = await apiFetch("/api/products", {
    method: "POST",
    body: JSON.stringify({ products }),
  });
  return { added: body?.added || 0, updated: body?.updated || 0 };
}

/** Lấy toàn bộ sản phẩm (tùy chọn lọc theo source). Trả về MẢNG. */
async function getProducts(source) {
  const body = await apiFetch("/api/products" + qs({ source }));
  return Array.isArray(body?.products) ? body.products : [];
}

/**
 * Tìm sản phẩm theo từ khóa + khoảng giá + danh mục (server lọc).
 * opts: { query, minPrice, maxPrice, category, source, limit }. Trả về MẢNG.
 */
async function searchProducts(opts = {}) {
  const body = await apiFetch(
    "/api/products/search" +
      qs({
        query: opts.query,
        minPrice: Number.isFinite(opts.minPrice) ? opts.minPrice : undefined,
        maxPrice: Number.isFinite(opts.maxPrice) ? opts.maxPrice : undefined,
        category: opts.category,
        source: opts.source,
        limit: opts.limit,
      })
  );
  return Array.isArray(body?.products) ? body.products : [];
}

/**
 * Xóa sản phẩm. Có source -> xóa theo source. Không có source -> xóa TOÀN BỘ
 * (truyền cờ all=1 để server phân biệt "xóa hết có chủ đích" với lỗi thiếu
 * tham số — server chặn DELETE không phạm vi để tránh xóa nhầm cả kho).
 * Trả về SỐ sản phẩm đã xóa.
 */
async function clearProducts(source) {
  const query = source ? qs({ source }) : qs({ all: 1 });
  const body = await apiFetch("/api/products" + query, {
    method: "DELETE",
  });
  return body?.deleted || 0;
}

/** Xóa một sản phẩm theo productId. Trả về true. */
async function deleteProduct(productId) {
  await apiFetch("/api/products/" + encodeURIComponent(productId), {
    method: "DELETE",
  });
  return true;
}

/* ============================ SOURCES =================================== */
//
// Server lưu cấu hình nguồn dưới dạng { id, config }. Lớp shim này dẹp phẳng
// (flatten) để caller (prices.js) vẫn thấy object phẳng { id, name, url, ... }
// như IndexedDB cũ.

/** Dẹp phẳng một row source { id, config, updatedAt } -> object phẳng. */
function flattenSource(row) {
  let cfg = row && row.config;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (e) {
      cfg = {};
    }
  }
  return { ...(cfg || {}), id: row.id, updatedAt: row.updatedAt };
}

/**
 * Lưu/cập nhật một cấu hình nguồn dữ liệu (upsert theo id). Trả về bản ghi đã
 * lưu (đã gộp default), giữ đúng shape cũ mà prices.js trông đợi.
 */
async function saveSource(source) {
  if (!source || !source.id) throw new Error("Thiếu id nguồn dữ liệu.");
  const record = {
    method: "GET",
    headers: {},
    bodyTemplate: "",
    itemsPath: "",
    mapping: {},
    enabled: true,
    ...source,
    updatedAt: Date.now(),
  };
  await apiFetch("/api/sources", {
    method: "POST",
    body: JSON.stringify({ id: record.id, config: record }),
  });
  return record;
}

/** Lấy toàn bộ cấu hình nguồn dữ liệu (đã dẹp phẳng). Trả về MẢNG. */
async function getSources() {
  const body = await apiFetch("/api/sources");
  const rows = Array.isArray(body?.sources) ? body.sources : [];
  return rows.map(flattenSource);
}

/** Xóa một cấu hình nguồn theo id. Trả về true. */
async function deleteSource(id) {
  await apiFetch("/api/sources/" + encodeURIComponent(id), {
    method: "DELETE",
  });
  return true;
}

/* ========================== PROMPT PROFILES ============================== *
 * "Hồ sơ ngành" — phần đặc thù ngành của các system prompt AI, lưu ở backend
 * (bảng prompt_profiles) nên chia sẻ được. prompts.js gọi getActivePromptProfile()
 * để lấy hồ sơ đang dùng; dashboard dùng các hàm còn lại để quản lý.
 * ------------------------------------------------------------------------- */

/** Lấy toàn bộ hồ sơ ngành. Trả về MẢNG (mỗi phần tử gồm config + id/name/isActive). */
async function getPromptProfiles() {
  const body = await apiFetch("/api/prompt-profiles");
  const rows = Array.isArray(body?.profiles) ? body.profiles : [];
  return rows.map((r) => ({
    ...(r.config || {}),
    id: r.id,
    name: r.name,
    isActive: !!r.isActive,
    updatedAt: r.updatedAt,
  }));
}

/** Lấy hồ sơ ngành ĐANG KÍCH HOẠT (đã dẹp phẳng config). Trả về object hoặc null. */
async function getActivePromptProfile() {
  const body = await apiFetch("/api/prompt-profiles/active");
  const r = body?.profile;
  if (!r) return null;
  return {
    ...(r.config || {}),
    id: r.id,
    name: r.name,
    isActive: !!r.isActive,
    updatedAt: r.updatedAt,
  };
}

/** Lưu/cập nhật một hồ sơ ngành (upsert theo id). Trả về bản ghi đã lưu. */
async function savePromptProfile(profile) {
  if (!profile || !profile.id) throw new Error("Thiếu id hồ sơ ngành.");
  await apiFetch("/api/prompt-profiles", {
    method: "POST",
    body: JSON.stringify({
      id: profile.id,
      name: profile.name ?? profile.id,
      config: profile,
      isActive: !!profile.isActive,
    }),
  });
  return profile;
}

/** Kích hoạt một hồ sơ ngành (đặt là hồ sơ duy nhất AI dùng). Trả về true. */
async function activatePromptProfile(id) {
  await apiFetch("/api/prompt-profiles/" + encodeURIComponent(id) + "/activate", {
    method: "POST",
  });
  return true;
}

/** Xóa một hồ sơ ngành theo id. Trả về true. */
async function deletePromptProfile(id) {
  await apiFetch("/api/prompt-profiles/" + encodeURIComponent(id), {
    method: "DELETE",
  });
  return true;
}

/* ========================== ADVISORIES =================================== */

/**
 * Lưu (hoặc cập nhật) một nháp tư vấn (upsert theo postId của user). Trả về
 * bản ghi đã lưu, hoặc null nếu thiếu postId.
 */
async function saveAdvisory(adv) {
  if (!adv || !adv.postId) return null;
  const body = await apiFetch("/api/advisories", {
    method: "POST",
    body: JSON.stringify(adv),
  });
  return body?.advisory || null;
}

/** Lấy toàn bộ nháp tư vấn (tùy chọn lọc theo status). Trả về MẢNG. */
async function getAdvisories(status) {
  const body = await apiFetch("/api/advisories" + qs({ status }));
  return Array.isArray(body?.advisories) ? body.advisories : [];
}

/** Lấy 1 nháp theo postId, hoặc null. */
async function getAdvisory(postId) {
  const body = await apiFetch(
    "/api/advisories/" + encodeURIComponent(postId)
  );
  return body?.advisory || null;
}

/**
 * Cập nhật một nháp theo postId (gộp các trường truyền vào). Trả về bản ghi
 * sau cập nhật (đọc lại để giữ shape object như cũ), hoặc null nếu không có.
 */
async function updateAdvisory(postId, patch) {
  await apiFetch("/api/advisories/" + encodeURIComponent(postId), {
    method: "PATCH",
    body: JSON.stringify(patch || {}),
  });
  return getAdvisory(postId);
}

/** Xóa một nháp theo postId. Trả về true. */
async function deleteAdvisory(postId) {
  await apiFetch("/api/advisories/" + encodeURIComponent(postId), {
    method: "DELETE",
  });
  return true;
}

/**
 * Xóa toàn bộ nháp tư vấn (hoặc theo status). Server không có endpoint xóa
 * hàng loạt nên ta liệt kê rồi xóa từng cái. Trả về số bản ghi đã xóa.
 */
async function clearAdvisories(status) {
  const list = await getAdvisories(status);
  let deleted = 0;
  for (const a of list) {
    if (!a || !a.postId) continue;
    await deleteAdvisory(a.postId);
    deleted += 1;
  }
  return deleted;
}

/* ----------------------- HỘI THOẠI (conversations) --------------------- */

/**
 * Tạo một hội thoại mới (sau khi đăng bình luận thành công). Trả về bản ghi
 * kèm id. `replies` luôn khởi tạo rỗng; theo dõi nền sẽ merge dần vào sau.
 */
async function createConversation(conv) {
  const c = conv || {};
  const record = {
    status: "watching", // watching | drafted | replied | closed
    postId: "",
    postUrl: "",
    groupId: "",
    groupName: "",
    jobId: null,
    commentId: null,
    myComment: "",
    myCommentUrl: "",
    myAuthorId: null,
    myAuthorName: null,
    replies: [],
    draft: null,
    lastWatchedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...c,
  };
  const body = await apiFetch("/api/conversations", {
    method: "POST",
    body: JSON.stringify({
      postId: record.postId,
      commentPermalink: record.commentPermalink ?? record.myCommentUrl,
      // ID bình luận GỐC của ta (parent). Trích chắc chắn từ URL (comment_id=)
      // nên định vị reply CHÍNH XÁC, khỏi dò mò theo nội dung text.
      commentId: record.commentId,
      replies: record.replies,
      status: record.status,
      // Rich context fields must reach the server too, otherwise getConversations
      // / getConversation drop them and callers (dashboard, advisory, background)
      // lose myComment / postText / draft / etc. on round-trip.
      postUrl: record.postUrl,
      groupId: record.groupId,
      groupName: record.groupName,
      myComment: record.myComment,
      myCommentUrl: record.myCommentUrl,
      myAuthorId: record.myAuthorId,
      myAuthorName: record.myAuthorName,
      postText: record.postText,
      draft: record.draft,
      jobId: record.jobId,
      lastWatchedAt: record.lastWatchedAt,
    }),
  });
  return { ...record, id: body?.id };
}

/** Lấy toàn bộ hội thoại (tùy chọn lọc theo status), mới cập nhật trước. */
async function getConversations(status) {
  const body = await apiFetch("/api/conversations" + qs({ status }));
  return Array.isArray(body?.conversations) ? body.conversations : [];
}

/**
 * Lấy một hội thoại theo id. Server không có endpoint lấy đơn lẻ nên ta liệt
 * kê rồi tìm theo id. Trả về bản ghi hoặc null.
 */
async function getConversation(id) {
  const list = await getConversations();
  return list.find((c) => c && c.id == id) || null; // eslint-disable-line eqeqeq
}

/**
 * Cập nhật một hội thoại theo id (gộp trường). Trả về bản ghi sau cập nhật
 * (đọc lại để giữ shape object như cũ), hoặc null nếu không tìm thấy.
 */
async function updateConversation(id, patch) {
  await apiFetch("/api/conversations/" + encodeURIComponent(id), {
    method: "PATCH",
    body: JSON.stringify(patch || {}),
  });
  return getConversation(id);
}

/**
 * MERGE các reply mới vào hội thoại (server dedupe, KHÔNG ghi đè reply cũ).
 * Trả về { added, total }.
 */
async function mergeReplies(id, incoming) {
  const replies = Array.isArray(incoming) ? incoming : [];
  const body = await apiFetch(
    "/api/conversations/" + encodeURIComponent(id) + "/replies",
    {
      method: "POST",
      body: JSON.stringify({ replies }),
    }
  );
  return { added: body?.added || 0, total: body?.total || 0 };
}

/** Xóa một hội thoại theo id. Trả về true. */
async function deleteConversation(id) {
  await apiFetch("/api/conversations/" + encodeURIComponent(id), {
    method: "DELETE",
  });
  return true;
}

// Xuất dưới dạng ES module. background.js nạp qua `import * as DB from "./db.js"`.
export {
  // posts
  savePosts,
  getKnownIds,
  getAllPosts,
  getPostComments,
  getStats,
  clearPosts,
  // groups
  saveGroup,
  saveGroups,
  getGroups,
  deleteGroup,
  // jobs (hàng đợi — theo TÀI KHOẢN qua /api/jobs)
  createJob,
  createJobs,
  updateJob,
  getJobs,
  getDueJobs,
  recoverStuckJobs,
  deleteJob,
  clearFinishedJobs,
  clearAllJobs,
  approveAllJobs,
  // giới hạn an toàn cho job chào hàng (message)
  countMessageJobsToday,
  findLiveMessageJobByProfile,
  MESSAGE_DAILY_CAP,
  // hộp thư Messenger (inbox threads — theo TÀI KHOẢN qua /api/inbox)
  getInboxThreads,
  getInboxThread,
  upsertInboxThreads,
  updateInboxThread,
  deleteInboxThread,
  // posted groups (lịch sử đăng — theo TÀI KHOẢN qua /api/posted-groups)
  recordPostedGroups,
  getPostedGroups,
  // warming activity log (nhật ký nuôi tài khoản — theo TÀI KHOẢN qua /api/warming/log)
  recordWarmingActivity,
  getWarmingActivity,
  // settings (cấu hình nhỏ theo TÀI KHOẢN qua /api/settings)
  getSetting,
  setSetting,
  deleteSetting,
  // message templates (mẫu tin chào hàng — theo TÀI KHOẢN qua /api/message-templates)
  getMessageTemplates,
  saveMessageTemplate,
  deleteMessageTemplate,
  // products
  saveProducts,
  getProducts,
  searchProducts,
  clearProducts,
  deleteProduct,
  // sources
  saveSource,
  getSources,
  deleteSource,
  // prompt profiles (hồ sơ ngành — đặc thù ngành của system prompt AI)
  getPromptProfiles,
  getActivePromptProfile,
  savePromptProfile,
  activatePromptProfile,
  deletePromptProfile,
  // advisories (nháp tư vấn AI)
  saveAdvisory,
  getAdvisories,
  getAdvisory,
  updateAdvisory,
  deleteAdvisory,
  clearAdvisories,
  // conversations (hội thoại bình luận + theo dõi reply)
  createConversation,
  getConversations,
  getConversation,
  updateConversation,
  mergeReplies,
  deleteConversation,
};
