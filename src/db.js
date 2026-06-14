/**
 * db.js — Lớp truy cập dữ liệu cho extension, nay là MỘT API CLIENT mỏng.
 *
 * Trước đây dùng IndexedDB cục bộ; nay mọi dữ liệu CHIA SẺ (posts, groups,
 * products, sources, advisories, conversations...) đi qua web backend bằng
 * apiFetch() trong api.js (gắn Bearer token, parse JSON, ném khi non-2xx).
 *
 * NGOẠI LỆ — JOBS: hàng đợi job (đăng bài/bình luận) là TRẠNG THÁI TỰ ĐỘNG HOÁ
 * CỤC BỘ của từng thiết bị, không chia sẻ. Vì vậy job vẫn nằm trong
 * chrome.storage.local (KHÔNG gọi API). Khi chạy ngoài extension (test bằng
 * plain Node, không có `chrome`) thì rơi về một store in-memory để module nạp
 * được mà không crash.
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

/** Lấy toàn bộ bài viết (tùy chọn lọc theo nhóm). Trả về MẢNG (server sort sẵn). */
async function getAllPosts(groupId) {
  const body = await apiFetch("/api/posts" + qs({ groupId }));
  return Array.isArray(body?.posts) ? body.posts : [];
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
// Job = trạng thái tự động hoá CỤC BỘ của thiết bị. KHÔNG gọi API. Lưu trong
// chrome.storage.local; ngoài extension thì dùng store in-memory để test chạy
// được mà không cần `chrome`.
const JOBS_KEY = "localJobs";

// Store in-memory dự phòng (khi không có chrome.storage). { seq, jobs:[] }.
let _memJobs = { seq: 1, jobs: [] };

/** Có đang chạy trong môi trường extension có chrome.storage không? */
function hasChromeStorage() {
  return (
    typeof chrome !== "undefined" &&
    chrome &&
    chrome.storage &&
    chrome.storage.local
  );
}

/** Đọc toàn bộ store job ({ seq, jobs }). */
function readJobs() {
  if (!hasChromeStorage()) {
    return Promise.resolve(_memJobs);
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(JOBS_KEY, (r) => {
        void chrome.runtime.lastError;
        const v = (r && r[JOBS_KEY]) || { seq: 1, jobs: [] };
        if (!Array.isArray(v.jobs)) v.jobs = [];
        if (typeof v.seq !== "number") v.seq = 1;
        resolve(v);
      });
    } catch (e) {
      resolve({ seq: 1, jobs: [] });
    }
  });
}

/** Ghi toàn bộ store job. */
function writeJobs(store) {
  if (!hasChromeStorage()) {
    _memJobs = store;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [JOBS_KEY]: store }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

// CONCURRENCY CAVEAT (single-writer assumption): the job mutators below
// (createJob / updateJob / deleteJob / clearFinishedJobs) run a
// read-modify-write cycle over the whole store. They assume a single writer
// per device (the background service worker). Two overlapping writers could
// race on read/write and lose an update or reuse a seq. This is acceptable for
// device-local automation state and is NOT redesigned here.
/** Tạo một job (đăng bài / bình luận). Trả về job đã lưu (kèm id). */
async function createJob(job) {
  const j = job || {};
  const store = await readJobs();
  const id = store.seq++;
  const record = {
    type: "post",
    status: "pending",
    attempts: 0,
    result: null,
    error: null,
    createdAt: Date.now(),
    scheduledAt: j.scheduledAt || Date.now(),
    ...j,
    id,
  };
  store.jobs.push(record);
  await writeJobs(store);
  return record;
}

/** Cập nhật một job theo id (gộp các trường truyền vào). Trả về job merged hoặc null. */
async function updateJob(id, patch) {
  const store = await readJobs();
  const idx = store.jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  // Pin `id` last so a caller-supplied `{ id: ... }` in patch cannot rewrite
  // the primary key (symmetric with createJob, which also pins id last).
  const merged = {
    ...store.jobs[idx],
    ...patch,
    updatedAt: Date.now(),
    id: store.jobs[idx].id,
  };
  store.jobs[idx] = merged;
  await writeJobs(store);
  return merged;
}

/** Lấy toàn bộ job (tùy chọn lọc theo type), mới nhất trước. */
async function getJobs(type) {
  const store = await readJobs();
  let result = store.jobs.slice();
  if (type) result = result.filter((j) => j.type === type);
  result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return result;
}

/** Lấy các job đang chờ tới hạn chạy (status=pending và scheduledAt<=now). */
async function getDueJobs(now) {
  const t = now || Date.now();
  const store = await readJobs();
  const out = store.jobs.filter(
    (j) => j.status === "pending" && (j.scheduledAt || 0) <= t
  );
  out.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
  return out;
}

/** Xóa một job theo id. Trả về true. */
async function deleteJob(id) {
  const store = await readJobs();
  store.jobs = store.jobs.filter((j) => j.id !== id);
  await writeJobs(store);
  return true;
}

/** Xóa các job đã hoàn tất hoặc lỗi (dọn dẹp). Trả về số job đã xóa. */
async function clearFinishedJobs() {
  const store = await readJobs();
  const before = store.jobs.length;
  store.jobs = store.jobs.filter(
    (j) => j.status !== "done" && j.status !== "error"
  );
  const deleted = before - store.jobs.length;
  await writeJobs(store);
  return deleted;
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

/** Xóa sản phẩm theo source. Trả về SỐ sản phẩm đã xóa. */
async function clearProducts(source) {
  const body = await apiFetch("/api/products" + qs({ source }), {
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
    myComment: "",
    myCommentUrl: "",
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
  getStats,
  clearPosts,
  // groups
  saveGroup,
  saveGroups,
  getGroups,
  deleteGroup,
  // jobs (chrome.storage.local — device-local, NOT API)
  createJob,
  updateJob,
  getJobs,
  getDueJobs,
  deleteJob,
  clearFinishedJobs,
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
