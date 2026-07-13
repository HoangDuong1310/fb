/**
 * background.js — Service worker (MV3), nay là ROUTER thuần.
 *
 * Vai trò:
 *  - Là nơi DUY NHẤT sở hữu IndexedDB của extension (qua db.js).
 *  - Trung gian message giữa content script, popup và dashboard.
 *  - Lập lịch chạy job + tự động crawl/sync nền qua chrome.alarms.
 *
 * Sau bước tách module (B3): logic nghiệp vụ nằm ở các module domain:
 *  - util.js     : helper dùng chung (tab/DOM, fetch, parse, decode...).
 *  - db.js       : toàn bộ truy cập IndexedDB (import * as DB).
 *  - prices.js   : nguồn giá bán lẻ + seed + đồng bộ sản phẩm.
 *  - sheets.js   : "Kho của tôi" (nhập từ Google Sheet công khai).
 *  - ai.js       : khám phá selector + build cấu hình bằng AI + list model.
 *  - advisory.js : tư vấn AI (phân loại ý định, soạn nháp, duyệt gửi).
 *  - crawl.js    : crawl theo nhóm/hàng loạt, job đăng bài/bình luận,
 *                  auto-crawl + auto-sync nền.
 *
 * File này CHỈ còn: nạp module, định tuyến message, và khối khởi tạo alarms.
 */

import * as DB from "./db.js";
import { openDashboard, broadcast } from "./util.js";
import * as API from "./api.js";
import {
  syncSource,
  syncAllSources,
  SEED_PRICE_SOURCE_IDS,
  rememberDeletedSeed,
  pruneLegacySources,
  seedPriceSources,
} from "./prices.js";
import { listSheetTabs, previewSheet, importSheetTabs } from "./sheets.js";
import { discoverSelectors, listModels, spinPostContent, generatePostContent } from "./ai.js";
import { clearProfileCache } from "./prompts.js";
import {
  startCrawlInActiveTab,
  stopCrawlInActiveTab,
  crawlGroupInTab,
  crawlGroupApiInTab,
  crawlGroupApiTabless,
  crawlGroupApiSmart,
  scanJoinedGroups,
  removeCrawlTab,
  getCrawlBlockState,
  noteCrawlDoneReason,
  runJob,
  executeDeletePost,
  scanInbox,
  readInboxThread,
  processDueJobs,
  scheduleTickSoon,
  AUTOCRAWL_ALARM,
  getAutoCrawlConfig,
  applyAutoCrawlConfig,
  processAutoCrawl,
  initAutoCrawl,
  AUTOSYNC_ALARM,
  getAutoSyncConfig,
  applyAutoSyncConfig,
  processAutoSync,
  initAutoSync,
  WATCH_ALARM,
  getWatchConfig,
  applyWatchConfig,
  processReplyWatch,
  initReplyWatch,
  WARMING_ALARM,
  getWarmingConfig,
  applyWarmingConfig,
  processWarming,
  stopWarming,
  scheduleNextWarming,
  initWarming,
} from "./crawl.js";
import { runGroupPriceExtraction } from "./group-prices.js";
import { runLeadClassification } from "./lead-classify.js";
import { pollRemoteCommands, connectRealtime, disconnectRealtime } from "./remote-commands.js";

/* ----------------------- XÁC THỰC WEB BACKEND (state) ------------------ */

// Khoá lưu thông tin user đăng nhập (để AUTH_STATE trả display_name qua restart).
const AUTH_USER_KEY = "webAuthUser";

// Cache in-memory thông tin user hiện tại ({ id, email, displayName } | null).
let authUser = null;

// Promise hoàn tất việc nạp token + user từ storage lúc khởi động SW. Các handler
// phụ thuộc token (AUTH_STATE/AUTH_LOGIN...) await cái này trước khi đọc token,
// tránh đua với message đến sớm khi SW vừa được đánh thức (getToken() = null oan).
let readyPromise = Promise.resolve();

/** Lưu user vào cache + chrome.storage.local (null để xoá). */
function setAuthUser(user) {
  authUser = user || null;
  return new Promise((resolve) => {
    try {
      if (authUser) {
        chrome.storage.local.set({ [AUTH_USER_KEY]: authUser }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } else {
        chrome.storage.local.remove(AUTH_USER_KEY, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      }
    } catch (e) {
      resolve();
    }
  });
}

/** Nạp user đã lưu vào cache in-memory (gọi lúc khởi động SW). */
function loadAuthUser() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(AUTH_USER_KEY, (r) => {
        void chrome.runtime.lastError;
        authUser = (r && r[AUTH_USER_KEY]) || null;
        resolve(authUser);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Xử lý message bất đồng bộ: trả true để giữ kênh sendResponse mở.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  switch (msg.type) {
    case "GET_KNOWN_IDS": {
      DB.getKnownIds(msg.groupId)
        .then((ids) => sendResponse({ ok: true, ids }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "SAVE_POSTS": {
      DB.savePosts(msg.posts || [])
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "GET_STATS": {
      DB.getStats()
        .then((stats) => sendResponse({ ok: true, stats }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "GET_ALL_POSTS": {
      DB.getAllPosts(msg.groupId)
        .then((posts) => sendResponse({ ok: true, posts }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "GET_POST_COMMENTS": {
      DB.getPostComments(msg.postId)
        .then((comments) => sendResponse({ ok: true, comments }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "CLEAR_POSTS": {
      DB.clearPosts(msg.groupId)
        .then((deleted) => sendResponse({ ok: true, deleted }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "DISCOVER_SELECTORS": {
      discoverSelectors()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    // Viết lại nội dung (spin) — SERVER-SIDE qua POST /api/ai/spin-post để key AI
    // không rời server. LƯU Ý: spinPostContent (server) đọc payload.content, còn
    // route nhận {text, options} rồi trải options ra -> phải nhét content vào
    // options. UI (Compose) gửi payload {content, count}.
    case "AI_SPIN_CONTENT": {
      (async () => {
        await readyPromise;
        const p = msg.payload || {};
        const content = String(p.content || "").trim();
        const result = await API.apiFetch("/api/ai/spin-post", {
          method: "POST",
          body: JSON.stringify({
            text: content,
            options: { content, count: p.count },
          }),
        });
        sendResponse(result);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Viết mới nội dung bán hàng — SERVER-SIDE qua POST /api/ai/generate-content.
    // UI (Compose) gửi payload {brief, tone, count}.
    case "AI_GENERATE_CONTENT": {
      (async () => {
        await readyPromise;
        const p = msg.payload || {};
        const result = await API.apiFetch("/api/ai/generate-content", {
          method: "POST",
          body: JSON.stringify({ brief: p.brief, tone: p.tone, count: p.count }),
        });
        sendResponse(result);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    case "GEN_PROFILE_FULL": {
      (async () => {
        await readyPromise;
        const result = await API.apiFetch("/api/ai/generate-profile", {
          method: "POST",
          body: JSON.stringify(msg.payload || {}),
        });
        sendResponse(result);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    case "GET_SELECTORS": {
      DB.getSetting("fbSelectors")
        .then((selectors) => sendResponse({ ok: true, selectors: selectors || null }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CLEAR_SELECTORS": {
      DB.deleteSetting("fbSelectors")
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_SETTING": {
      DB.getSetting(msg.key, msg.def ?? null)
        .then((value) => sendResponse({ ok: true, value }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SET_SETTING": {
      DB.setSetting(msg.key, msg.value)
        .then((value) => sendResponse({ ok: true, value }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "DELETE_SETTING": {
      DB.deleteSetting(msg.key)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ---- Cấu hình AI theo tài khoản (server-side, key không rời server) ----
    // Đọc qua GET /api/me/ai-config. Server KHÔNG trả key thô, chỉ trả hasKey +
    // keyMasked cùng apiBase/model (và giá trị default/effective). Đây thay cho
    // đường cũ /api/settings/aiConfig (không tồn tại trên server đã deploy).
    case "GET_AI_CONFIG": {
      (async () => {
        await readyPromise;
        const config = await API.apiFetch("/api/me/ai-config");
        sendResponse({ ok: true, config });
      })().catch((e) =>
        sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true;
    }

    // Ghi qua PUT /api/me/ai-config. Server CHỈ ghi key khi truyền chuỗi khác
    // rỗng và không chứa dấu che "•"; gửi clearKey:true để xoá key. Nhờ vậy lưu
    // lại form mà không gõ lại key sẽ giữ nguyên key cũ trên server.
    case "SET_AI_CONFIG": {
      (async () => {
        await readyPromise;
        const p = msg.payload || {};
        const config = await API.apiFetch("/api/me/ai-config", {
          method: "PUT",
          body: JSON.stringify({
            apiBase: p.apiBase,
            model: p.model,
            apiKey: p.apiKey,
            clearKey: p.clearKey === true,
          }),
        });
        sendResponse({ ok: true, config });
      })().catch((e) =>
        sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true;
    }

    case "START_CRAWL": {
      startCrawlInActiveTab(msg.options || {})
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "STOP_CRAWL": {
      stopCrawlInActiveTab()
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    case "OPEN_DASHBOARD": {
      openDashboard()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_GROUPS": {
      DB.getGroups()
        .then((groups) => sendResponse({ ok: true, groups }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SAVE_GROUP": {
      DB.saveGroup(msg.group || {})
        .then((g) => sendResponse({ ok: true, group: g }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "DELETE_GROUP": {
      DB.deleteGroup(msg.groupId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SCAN_JOINED_GROUPS": {
      scanJoinedGroups()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CRAWL_GROUP": {
      crawlGroupInTab(msg.groupId, msg.options || {})
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CRAWL_GROUP_API": {
      // Crawl QUA API nội bộ FB (sniff + replay). Định tuyến qua crawlGroupApiSmart:
      //  - ĐÃ CÓ khuôn GQL trong storage => chạy NGẦM hoàn toàn (tabless), KHÔNG mở
      //    tab, KHÔNG resize/nhảy tab của người dùng.
      //  - CHƯA CÓ khuôn => mở 1 tab foreground DUY NHẤT 1 lần để bắt khuôn; các lần
      //    sau tự động chuyển sang nhánh ngầm.
      const apiOpts = msg.options || {};
      crawlGroupApiSmart(msg.groupId, apiOpts)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_JOBS": {
      DB.getJobs(msg.jobType)
        .then((jobs) => sendResponse({ ok: true, jobs }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CREATE_JOB": {
      DB.createJob(msg.job || {})
        .then((job) => {
          scheduleTickSoon();
          sendResponse({ ok: true, job });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CREATE_JOBS": {
      // Batch: tạo nhiều job cùng lúc trong một lần message (giảm rủi ro mất SW).
      DB.createJobs(msg.jobs || [])
        .then((jobs) => {
          scheduleTickSoon();
          sendResponse({ ok: true, jobs });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "UPLOAD_IMAGES": {
      // UI gửi lên mảng data URL ảnh (đã nén phía client). Backend ghi từng ảnh
      // ra ổ đĩa và trả về mảng URL công khai "/uploads/...". UI dùng các URL này
      // thay cho base64 khi tạo job -> jobs.data không còn phình vì ảnh.
      API.apiFetch("/api/uploads", {
        method: "POST",
        body: JSON.stringify({ dataUrls: Array.isArray(msg.dataUrls) ? msg.dataUrls : [] }),
      })
        .then((res) => sendResponse({ ok: true, urls: (res && res.urls) || [] }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "RECORD_POSTED_GROUPS": {
      // Lưu lịch sử nhóm đã đăng theo tài khoản (device-local).
      // authUser?.id dùng để tách dữ liệu theo từng tài khoản đăng nhập.
      DB.recordPostedGroups(authUser ? authUser.id : null, msg.groups || [])
        .then((groups) => sendResponse({ ok: true, groups }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_POSTED_GROUPS": {
      // Trả về danh sách nhóm đăng gần đây / hay đăng theo tài khoản.
      DB.getPostedGroups(authUser ? authUser.id : null, msg.opts || {})
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "DELETE_JOB": {
      (async () => {
        // Tuỳ chọn: xoá luôn bài trên Facebook nếu có link bài và người dùng đồng ý.
        let remote = null;
        if (msg.deleteRemote && msg.postUrl) {
          remote = await executeDeletePost(msg.postUrl);
        }
        await DB.deleteJob(msg.id);
        sendResponse({ ok: true, remote });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CLEAR_FINISHED_JOBS": {
      DB.clearFinishedJobs()
        .then((deleted) => sendResponse({ ok: true, deleted }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CLEAR_ALL_JOBS": {
      DB.clearAllJobs()
        .then((deleted) => sendResponse({ ok: true, deleted }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "RUN_JOB_NOW": {
      (async () => {
        const jobs = await DB.getJobs();
        const job = jobs.find((j) => j.id === msg.id);
        if (!job) return sendResponse({ ok: false, error: "Không tìm thấy job." });
        const r = await runJob(job);
        sendResponse(r);
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "APPROVE_JOB": {
      // Duyệt 1 việc: paused -> pending để guồng lịch (processDueJobs) tự đăng.
      (async () => {
        const jobs = await DB.getJobs();
        const job = jobs.find((j) => j.id === msg.id);
        if (!job) return sendResponse({ ok: false, error: "Không tìm thấy job." });
        if (job.status !== "paused")
          return sendResponse({ ok: false, error: "Việc không ở trạng thái chờ duyệt." });
        await DB.updateJob(msg.id, { status: "pending" });
        scheduleTickSoon();
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "APPROVE_ALL_JOBS": {
      // Duyệt tất cả việc đang chờ (tuỳ chọn lọc theo type): paused -> pending.
      // MỘT lượt gọi server (một câu UPDATE) thay cho N vòng PATCH tuần tự — tránh
      // service worker MV3 quá hạn phản hồi khi hàng đợi nhiều job ảnh base64
      // (lỗi "The message port closed before a response was received.").
      (async () => {
        const approved = await DB.approveAllJobs(msg.jobType);
        if (approved) scheduleTickSoon();
        sendResponse({ ok: true, approved });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_AUTOCRAWL": {
      getAutoCrawlConfig()
        .then((cfg) => sendResponse({ ok: true, config: cfg }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SET_AUTOCRAWL": {
      applyAutoCrawlConfig(msg.config || {})
        .then((cfg) => sendResponse({ ok: true, config: cfg }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_AUTOSYNC": {
      getAutoSyncConfig()
        .then((cfg) => sendResponse({ ok: true, config: cfg }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SET_AUTOSYNC": {
      applyAutoSyncConfig(msg.config || {})
        .then((cfg) => sendResponse({ ok: true, config: cfg }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ---- Kho của tôi: nhập từ Google Sheet công khai --------------------
    case "SHEET_TABS": {
      listSheetTabs(msg.url || "")
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SHEET_PREVIEW": {
      previewSheet(msg.spreadsheetId, msg.gid)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "IMPORT_SHEET": {
      importSheetTabs(msg.spreadsheetId, msg.tabs || [])
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ---- Lấy danh sách model khả dụng (SERVER-SIDE proxy) ----------------
    // GET /api/ai/models: server dùng key đã lưu để gọi endpoint /models của nhà
    // cung cấp, key không rời server. Trả { ok, models } hoặc { ok:false, error }.
    case "LIST_MODELS": {
      (async () => {
        await readyPromise;
        const result = await API.apiFetch("/api/ai/models");
        sendResponse(result);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // ---- Trợ lý AI (ChatAI) — proxy các endpoint /api/chat -----------------
    // Extension dùng bản KHÔNG streaming (SSE không chạy qua message port MV3).
    // Mọi endpoint đều nằm dưới authRequired, req.userId được set ở server.

    // Danh sách hội thoại: GET /api/chat/conversations -> { conversations }
    case "GET_CHAT_CONVERSATIONS": {
      (async () => {
        await readyPromise;
        const result = await API.apiFetch("/api/chat/conversations");
        sendResponse({ ok: true, ...result });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Tạo hội thoại mới: POST /api/chat/conversations {title?, model?} -> { conversation }
    case "CREATE_CHAT_CONVERSATION": {
      (async () => {
        await readyPromise;
        const body = {};
        if (msg.title != null) body.title = msg.title;
        if (msg.model != null) body.model = msg.model;
        const result = await API.apiFetch("/api/chat/conversations", {
          method: "POST",
          body: JSON.stringify(body),
        });
        sendResponse({ ok: true, ...result });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Chi tiết hội thoại: GET /api/chat/conversations/:id -> { conversation, messages }
    case "GET_CHAT_DETAIL": {
      (async () => {
        await readyPromise;
        const result = await API.apiFetch(
          "/api/chat/conversations/" + encodeURIComponent(msg.id)
        );
        sendResponse({ ok: true, ...result });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Đổi tên hội thoại: PATCH /api/chat/conversations/:id {title} -> { ok }
    case "RENAME_CHAT_CONVERSATION": {
      (async () => {
        await readyPromise;
        await API.apiFetch(
          "/api/chat/conversations/" + encodeURIComponent(msg.id),
          {
            method: "PATCH",
            body: JSON.stringify({ title: msg.title }),
          }
        );
        sendResponse({ ok: true });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Xoá hội thoại: DELETE /api/chat/conversations/:id -> { ok }
    case "DELETE_CHAT_CONVERSATION": {
      (async () => {
        await readyPromise;
        await API.apiFetch(
          "/api/chat/conversations/" + encodeURIComponent(msg.id),
          { method: "DELETE" }
        );
        sendResponse({ ok: true });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Gửi tin nhắn (KHÔNG streaming): POST /api/chat/conversations/:id/messages
    // {text, model?} -> { waitingAsync, content, messages }
    case "SEND_CHAT_MESSAGE": {
      (async () => {
        await readyPromise;
        const body = { text: msg.text };
        if (msg.model != null) body.model = msg.model;
        const result = await API.apiFetch(
          "/api/chat/conversations/" + encodeURIComponent(msg.id) + "/messages",
          {
            method: "POST",
            body: JSON.stringify(body),
          }
        );
        sendResponse({ ok: true, ...result });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // ---- Nguồn dữ liệu giá/sản phẩm -------------------------------------
    case "GET_SOURCES": {
      DB.getSources()
        .then((sources) => sendResponse({ ok: true, sources }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SAVE_SOURCE": {
      DB.saveSource(msg.source || {})
        .then((source) => sendResponse({ ok: true, source }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "DELETE_SOURCE": {
      (async () => {
        await DB.deleteSource(msg.id);
        // Nếu xoá đúng nguồn seed sẵn => ghi nhớ để không tự thêm lại ở lần khởi động sau.
        if (SEED_PRICE_SOURCE_IDS.has(msg.id)) await rememberDeletedSeed(msg.id);
      })()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Gọi URL API nội bộ đã cấu hình -> chuẩn hoá -> lưu vào kho sản phẩm.
    case "SYNC_SOURCE": {
      syncSource(msg.id)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SYNC_ALL_SOURCES": {
      syncAllSources()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ---- Sản phẩm -------------------------------------------------------
    case "GET_PRODUCTS": {
      DB.getProducts(msg.source)
        .then((products) => sendResponse({ ok: true, products }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SEARCH_PRODUCTS": {
      DB.searchProducts(msg.opts || {})
        .then((products) => sendResponse({ ok: true, products }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CLEAR_PRODUCTS": {
      DB.clearProducts(msg.source)
        .then((deleted) => sendResponse({ ok: true, deleted }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "DELETE_PRODUCT": {
      DB.deleteProduct(msg.productId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ----------------------- TƯ VẤN AI (advisories) ----------------------
    case "GEN_ADVISORIES": {
      (async () => {
        await readyPromise;
        const result = await API.apiFetch("/api/ai/generate-advisories", {
          method: "POST",
          body: JSON.stringify(msg.options || {}),
        });
        sendResponse(result);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    case "GET_ADVISORIES": {
      DB.getAdvisories(msg.status)
        .then((advisories) => sendResponse({ ok: true, advisories }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "UPDATE_ADVISORY": {
      DB.updateAdvisory(msg.postId, msg.patch || {})
        .then((adv) => sendResponse({ ok: true, advisory: adv }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "APPROVE_ADVISORY": {
      (async () => {
        await readyPromise;
        const result = await API.apiFetch("/api/ai/approve-advisory", {
          method: "POST",
          body: JSON.stringify({ postId: msg.postId }),
        });
        sendResponse(result);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    case "REJECT_ADVISORY": {
      DB.updateAdvisory(msg.postId, { status: "rejected", rejectedAt: Date.now() })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "DELETE_ADVISORY": {
      DB.deleteAdvisory(msg.postId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "CLEAR_ADVISORIES": {
      DB.clearAdvisories(msg.status)
        .then((deleted) => sendResponse({ ok: true, deleted }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ----------------------- HỘI THOẠI (conversations) ------------------
    case "GET_CONVERSATIONS": {
      DB.getConversations(msg.status)
        .then((conversations) => sendResponse({ ok: true, conversations }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "UPDATE_CONVERSATION": {
      DB.updateConversation(msg.id, msg.patch || {})
        .then((conversation) => sendResponse({ ok: true, conversation }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "DELETE_CONVERSATION": {
      DB.deleteConversation(msg.id)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Đăng ký THỦ CÔNG một hội thoại để theo dõi: dùng cho bình luận ta đã đăng
    // TAY trên Facebook (không qua việc bình luận của extension). Người dùng dán
    // link bài + nội dung bình luận của mình; ta tạo conversation rồi quét ngay.
    case "TRACK_CONVERSATION": {
      (async () => {
        const url = String(msg.url || "").trim();
        const myComment = String(msg.myComment || "").trim();
        if (!url) return sendResponse({ ok: false, error: "Thiếu link bài viết." });
        // Suy ra postId / groupId / commentId từ URL (best-effort).
        // postId hiện đại có thể là token "pfbid..." (chữ+số), không chỉ số thuần.
        const PID = "(pfbid[A-Za-z0-9]+|\\d+)";
        const postId =
          (url.match(new RegExp("/posts/" + PID)) ||
            url.match(new RegExp("[?&](?:story_fbid|fbid|multi_permalinks)=" + PID)) ||
            [])[1] || "";
        const groupId = (url.match(/\/groups\/(\d+)/) || [])[1] || "";
        const commentId = (url.match(/[?&]comment_id=(\d+)/) || [])[1] || "";
        // Cần MỘT trong hai để định vị bình luận của ta: hoặc comment_id trích
        // CHẮC CHẮN từ URL (định vị reply chính xác, khỏi dò text), hoặc nội dung
        // bình luận để dò mềm. Có comment_id thì KHÔNG bắt buộc dán nội dung nữa.
        if (!commentId && !myComment) {
          return sendResponse({
            ok: false,
            error: "Link không có comment_id — hãy dán link bình luận của bạn (có comment_id=) hoặc nhập nội dung bình luận để dò.",
          });
        }
        let groupName = "";
        if (groupId) {
          try {
            const g = (await DB.getGroups()).find((x) => x.groupId === groupId);
            if (g) groupName = g.name || "";
          } catch (e) {}
        }
        const conv = await DB.createConversation({
          status: "watching",
          source: "manual",
          postUrl: url,
          postId,
          groupId,
          groupName,
          myComment,
          myCommentUrl: commentId ? url : "",
          commentId: commentId || null,
        });
        broadcast("CONVERSATION_UPDATE", { id: conv.id });
        // Quét ngay để gom reply hiện có.
        let watch = null;
        try { watch = await processReplyWatch({ manual: true, maxPerRun: 1 }); } catch (e) {}
        sendResponse({ ok: true, conversation: conv, watch });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Quét reply NGAY cho 1 (hoặc tất cả) hội thoại đang theo dõi.
    case "WATCH_REPLIES_NOW": {
      processReplyWatch({ manual: true, maxPerRun: msg.maxPerRun })
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Soạn NHÁP phản hồi cho 1 hội thoại -> lưu vào conv.draft (KHÔNG tự đăng).
    case "DRAFT_CONV_REPLY": {
      (async () => {
        await readyPromise;
        const conv = await DB.getConversation(msg.id);
        if (!conv) return sendResponse({ ok: false, error: "Không tìm thấy hội thoại." });
        // targetReplyId (tuỳ chọn): khi NHIỀU người cùng trả lời dưới bình luận
        // của ta, UI gửi id của reply cần trả lời để AI soạn ĐÚNG người đó.
        // SERVER-SIDE: gọi /api/ai/draft-conversation-reply để key AI không rời
        // server; DB.getConversation/updateConversation vẫn ở SW như cũ.
        const draft = await API.apiFetch("/api/ai/draft-conversation-reply", {
          method: "POST",
          body: JSON.stringify({ conv, opts: { targetReplyId: msg.targetReplyId } }),
        });
        if (!draft || !draft.allowReply) {
          return sendResponse({ ok: false, error: (draft && draft.error) || "AI không soạn được nháp." });
        }
        await DB.updateConversation(msg.id, {
          status: "drafted",
          draft: {
            reply: draft.reply,
            usedProducts: draft.usedProducts || [],
            confidence: draft.confidence,
            needsHumanCheck: !!draft.needsHumanCheck,
            checkNote: draft.checkNote || "",
            // Người mà nháp này nhắm trả lời (khi có nhiều người cùng reply) ->
            // UI hiển thị "Trả lời <Tên>" cho rõ, đăng đúng mạch.
            targetAuthor: draft.targetAuthor || "",
            targetReplyId: draft.targetReplyId || null,
            draftedAt: Date.now(),
          },
        });
        sendResponse({ ok: true, draft });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Duyệt nháp phản hồi -> tạo comment job đăng vào ĐÚNG bài (permalink), đánh
    // dấu hội thoại "replied". Cho phép truyền nội dung đã chỉnh tay (msg.reply).
    case "APPROVE_CONV_REPLY": {
      (async () => {
        const conv = await DB.getConversation(msg.id);
        if (!conv) return sendResponse({ ok: false, error: "Không tìm thấy hội thoại." });
        const reply = (msg.reply != null ? String(msg.reply) : (conv.draft && conv.draft.reply) || "").trim();
        if (!reply) return sendResponse({ ok: false, error: "Nháp rỗng, không thể đăng." });
        // LUÔN ưu tiên dựng lại link từ postUrl (bài GỐC) + commentId, GIỐNG như
        // executeWatchReplies. Lý do: với bài trang cá nhân dạng permalink.php,
        // danh tính bài nằm HẾT ở query string (story_fbid & id). FB tự render
        // href bình luận chỉ còn permalink.php?comment_id=X (mất story_fbid/id)
        // nên myCommentUrl đã LƯU của các hội thoại cũ (hoặc tạo qua theo dõi thủ
        // công) có thể bị hỏng. postUrl vẫn giữ đủ story_fbid/id -> ghép commentId
        // vào đó mới ra link mở được, dùng làm targetUrl để đăng rep tiếp. Nếu
        // thiếu postUrl/commentId thì mới rơi về myCommentUrl || postUrl như cũ.
        let url = conv.myCommentUrl || conv.postUrl;
        if (conv.postUrl && conv.commentId) {
          try {
            const u = new URL(conv.postUrl);
            u.searchParams.set("comment_id", String(conv.commentId));
            url = u.toString();
          } catch (_) {}
        }
        if (!url) return sendResponse({ ok: false, error: "Thiếu link bài để đăng phản hồi." });
        const job = await DB.createJob({
          type: "comment",
          targetUrl: url,
          content: reply,
          scheduledAt: Date.now(),
          meta: {
            postId: conv.postId || "",
            groupId: conv.groupId || "",
            groupName: conv.groupName || "",
            postText: conv.postText || "",
            source: "conversation",
            conversationId: conv.id,
          },
        });
        await DB.updateConversation(msg.id, { status: "replied", lastReplyJobId: job.id });
        scheduleTickSoon();
        sendResponse({ ok: true, jobId: job.id });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Soạn NHÁP tin CHÀO HÀNG (inbox riêng) cho MỘT khách tiềm năng vừa đăng bài.
    // Trả về nội dung để UI hiển thị cho người dùng DUYỆT/chỉnh tay -> KHÔNG tự gửi.
    // Hỗ trợ cả 2 chế độ: AI tự soạn theo bài đăng, hoặc bám ý người dùng tự điền
    // (msg.userPitch) — đúng yêu cầu "gửi chào hàng theo nội dung user điền".
    case "GEN_PITCH": {
      (async () => {
        await readyPromise;
        const res = await API.apiFetch("/api/ai/draft-pitch", {
          method: "POST",
          body: JSON.stringify({
            postText: msg.postText || "",
            authorName: msg.authorName || "",
            groupName: msg.groupName || "",
            userPitch: msg.userPitch || "",
          }),
        });
        sendResponse(res);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Duyệt tin chào hàng -> tạo MỘT "message" job để gửi inbox qua DOM (thủ công
    // từng tin). Cho phép truyền nội dung đã chỉnh tay (msg.message). targetUrl là
    // link hội thoại Messenger suy ra từ profile tác giả bài đăng.
    case "APPROVE_PITCH": {
      (async () => {
        const message = (msg.message != null ? String(msg.message) : "").trim();
        if (!message) return sendResponse({ ok: false, error: "Nội dung chào hàng rỗng, không thể gửi." });
        const authorProfile = String(msg.authorProfile || "").trim();
        if (!authorProfile) {
          return sendResponse({ ok: false, error: "Thiếu link trang cá nhân của khách nên chưa mở được hộp thoại." });
        }
        // Suy ra link Messenger dạng /messages/t/<id-hoặc-username> từ profile.
        // profile.php?id=<số> -> /messages/t/<số>; /<username> -> /messages/t/<username>.
        const deriveThread = (profileUrl) => {
          try {
            const u = new URL(profileUrl);
            const idParam = u.searchParams.get("id");
            if (idParam) return "https://www.facebook.com/messages/t/" + idParam;
            const seg = u.pathname.split("/").filter(Boolean)[0] || "";
            if (seg && seg !== "profile.php") return "https://www.facebook.com/messages/t/" + seg;
          } catch (_) {}
          return "";
        };
        const targetUrl = deriveThread(authorProfile);
        if (!targetUrl) {
          return sendResponse({ ok: false, error: "Không dựng được link Messenger từ trang cá nhân của khách." });
        }

        // ── Chốt chặn an toàn ──────────────────────────────────────
        // 1. Kill-switch / circuit-breaker (crawl bị FB chặn → dừng hết)
        const blockState = await getCrawlBlockState();
        if (blockState && blockState.blocked) {
          return sendResponse({
            ok: false,
            error: "Hệ thống đang tạm dừng do phát hiện rủi ro (kill-switch). Lý do: " +
              (blockState.reason || "không rõ") + ". Thử lại sau.",
          });
        }
        // 2. Chống trùng — đã có job chào hàng tới cùng người chưa kết thúc?
        const dup = await DB.findLiveMessageJobByProfile(authorProfile);
        if (dup) {
          return sendResponse({
            ok: false,
            error: "Đã có tin chào hàng tới người này trong hàng đợi (job " + dup.id + "). Không tạo thêm.",
          });
        }
        // 3. Trần số tin nhắn chào hàng mỗi ngày
        const todayCount = await DB.countMessageJobsToday();
        if (todayCount >= DB.MESSAGE_DAILY_CAP) {
          return sendResponse({
            ok: false,
            error: "Đã đạt trần " + DB.MESSAGE_DAILY_CAP + " tin nhắn chào hàng trong ngày. Thử lại ngày mai.",
          });
        }

        const job = await DB.createJob({
          type: "message",
          targetUrl,
          content: message,
          images: Array.isArray(msg.images) ? msg.images : [],
          scheduledAt: Date.now(),
          meta: {
            source: "pitch",
            postId: msg.postId || "",
            authorName: msg.authorName || "",
            authorProfile,
            groupId: msg.groupId || "",
            groupName: msg.groupName || "",
            postText: msg.postText || "",
          },
        });
        scheduleTickSoon();
        sendResponse({ ok: true, jobId: job.id });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Trả quota chào hàng inbox hôm nay (dùng cho UI hiển thị thanh quota).
    case "GET_PITCH_QUOTA": {
      (async () => {
        const todayCount = await DB.countMessageJobsToday();
        sendResponse({ ok: true, todayCount, dailyCap: DB.MESSAGE_DAILY_CAP });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    /* =============== MẪU TIN CHÀO HÀNG (lưu trên server) =============== */

    // Lấy danh sách mẫu tin chào hàng của tài khoản (tuỳ chọn lọc theo kind).
    case "GET_MSG_TEMPLATES": {
      (async () => {
        const templates = await DB.getMessageTemplates(msg.kind);
        sendResponse({ ok: true, templates });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Lưu (tạo mới nếu không có id, hoặc cập nhật) một mẫu tin chào hàng.
    case "SAVE_MSG_TEMPLATE": {
      (async () => {
        const name = (msg.name != null ? String(msg.name) : "").trim();
        if (!name) return sendResponse({ ok: false, error: "Tên mẫu tin không được để trống." });
        const res = await DB.saveMessageTemplate({
          id: msg.id,
          name,
          content: msg.content ?? "",
          images: Array.isArray(msg.images) ? msg.images : [],
          kind: msg.kind || "pitch",
        });
        sendResponse(res);
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Xoá một mẫu tin chào hàng theo id.
    case "DELETE_MSG_TEMPLATE": {
      (async () => {
        await DB.deleteMessageTemplate(msg.id);
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    /* =============== HỘP THƯ MESSENGER (hội thoại có sẵn) =============== */

    // Lấy danh sách hội thoại đã quét (device-local). Không gọi Facebook.
    case "GET_INBOX_THREADS": {
      DB.getInboxThreads()
        .then((threads) => sendResponse({ ok: true, threads }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // QUÉT hộp thư thật: mở tab /messages ở nền, đọc danh sách hội thoại (và
    // đọc chi tiết tin nếu deep=true). READ-ONLY — chỉ chạy khi người dùng bấm.
    case "SCAN_INBOX": {
      scanInbox({ deep: !!msg.deep, maxThreads: msg.maxThreads })
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // MỞ & ĐỌC một hội thoại cụ thể (đọc tin mới nhất, cập nhật store).
    case "OPEN_INBOX_THREAD": {
      readInboxThread(msg.threadId)
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Soạn NHÁP trả lời (AI) cho một hội thoại có sẵn — KHÔNG tự gửi.
    case "GEN_INBOX_REPLY": {
      (async () => {
        await readyPromise;
        const res = await API.apiFetch("/api/ai/draft-inbox-reply", {
          method: "POST",
          body: JSON.stringify({
            contactName: msg.contactName || "",
            messages: Array.isArray(msg.messages) ? msg.messages : [],
            userHint: msg.userHint || "",
          }),
        });
        sendResponse(res);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Duyệt trả lời -> tạo "message" job gửi vào ĐÚNG hội thoại (targetUrl là
    // link /messages/t/<threadId>). Dùng lại pipeline message: kill-switch,
    // trần ngày, giãn cách. Không dùng chống-trùng-theo-profile (trả lời hội
    // thoại có sẵn có thể diễn ra nhiều lượt).
    case "APPROVE_INBOX_REPLY": {
      (async () => {
        const message = (msg.message != null ? String(msg.message) : "").trim();
        if (!message) return sendResponse({ ok: false, error: "Nội dung trả lời rỗng, không thể gửi." });
        const threadId = String(msg.threadId || "").trim();
        if (!threadId) return sendResponse({ ok: false, error: "Thiếu mã hội thoại." });

        const blockState = await getCrawlBlockState();
        if (blockState && blockState.blocked) {
          return sendResponse({
            ok: false,
            error: "Hệ thống đang tạm dừng do phát hiện rủi ro (kill-switch). Lý do: " +
              (blockState.reason || "không rõ") + ". Thử lại sau.",
          });
        }
        // Trần số tin nhắn mỗi ngày (dùng chung với chào hàng để bảo thủ).
        const todayCount = await DB.countMessageJobsToday();
        if (todayCount >= DB.MESSAGE_DAILY_CAP) {
          return sendResponse({
            ok: false,
            error: "Đã đạt trần " + DB.MESSAGE_DAILY_CAP + " tin nhắn trong ngày. Thử lại ngày mai.",
          });
        }

        const targetUrl = "https://www.facebook.com/messages/t/" + encodeURIComponent(threadId);
        const job = await DB.createJob({
          type: "message",
          targetUrl,
          content: message,
          scheduledAt: Date.now(),
          meta: {
            source: "inbox",
            threadId,
            contactName: msg.contactName || "",
          },
        });
        // Ghi nháp đã gửi vào thread + xoá nháp chờ.
        try {
          const thread = await DB.getInboxThread(threadId);
          const messages = (thread && Array.isArray(thread.messages)) ? thread.messages.slice() : [];
          messages.push({ mine: true, text: message, ts: Date.now() });
          await DB.updateInboxThread(threadId, { messages, draft: null, lastJobId: job.id });
        } catch (e) {}
        scheduleTickSoon();
        sendResponse({ ok: true, jobId: job.id });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Lưu nháp trả lời cho một hội thoại (không gửi).
    case "SAVE_INBOX_DRAFT": {
      DB.updateInboxThread(msg.threadId, { draft: msg.draft != null ? String(msg.draft) : null })
        .then((thread) => sendResponse({ ok: true, thread }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Xoá một hội thoại khỏi hộp thư (chỉ cục bộ, không đụng Facebook).
    case "DELETE_INBOX_THREAD": {
      DB.deleteInboxThread(msg.threadId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_WATCH_CONFIG": {
      getWatchConfig()
        .then((config) => sendResponse({ ok: true, config }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SET_WATCH_CONFIG": {
      applyWatchConfig(msg.config || {})
        .then((config) => sendResponse({ ok: true, config }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_WARMING_CONFIG": {
      getWarmingConfig()
        .then((config) => sendResponse({ ok: true, config }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "SET_WARMING_CONFIG": {
      applyWarmingConfig(msg.config || {})
        .then((config) => sendResponse({ ok: true, config }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Chạy NGAY một lượt nuôi tài khoản (nút bấm tay), bỏ qua cờ enabled.
    case "WARMING_RUN_NOW": {
      processWarming({ manual: true, actionsPerRun: msg.actionsPerRun })
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Người dùng bấm nút Dừng -> đặt cờ dừng để lượt đang chạy thoát sớm.
    case "WARMING_STOP": {
      sendResponse(stopWarming());
      return true;
    }

    case "GET_WARMING_ACTIVITY": {
      DB.getWarmingActivity({ limit: msg.limit })
        .then((entries) => sendResponse({ ok: true, entries }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Phân tích MỘT bài theo yêu cầu (nút "AI phân tích") -> soạn nháp trả lời
    // ngay, KHÔNG lưu sẵn. Người dùng xem rồi tự copy / tạo việc bình luận.
    case "ANALYZE_POST": {
      // Phương án A: phân tích chạy SERVER-SIDE (POST /api/ai/analyze) để key AI
      // không rời server. apiFetch NÉM lỗi khi server trả 422 (vd chưa cấu hình
      // key) -> bắt lại, bỏ tiền tố "API 4xx:" cho gọn rồi trả {ok:false,error}.
      (async () => {
        await readyPromise;
        const result = await API.apiFetch("/api/ai/analyze", {
          method: "POST",
          body: JSON.stringify({ post: msg.post || {} }),
        });
        sendResponse(result);
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Content phát tiến độ -> popup/dashboard tự lắng nghe, background không xử lý.
    case "CRAWL_PROGRESS":
      return false;

    // Crawl xong: nếu là tab do background tự mở (chế độ nền / hàng loạt) thì đóng lại,
    // tránh để lại hàng loạt tab rác sau khi crawl nhiều nhóm.
    //
    // QUAN TRỌNG (MV3): phải GIỮ kênh sendResponse mở (return true) cho tới khi
    // đóng tab xong. Nếu return false, sau khi xử lý message service worker có
    // thể bị suspend NGAY — khi đó mọi setTimeout/việc async còn dang dở sẽ
    // không chạy, để lại tab rác. Lỗi này lộ rõ khi AUTO-CRAWL chạy nền (không
    // có dashboard mở để giữ SW sống). Content đã `await flush()` (lưu xong bài
    // cuối) TRƯỚC khi gửi CRAWL_DONE, nên đóng tab ngay là an toàn, không cần đợi.
    case "CRAWL_DONE": {
      // Ngắt mạch: nhánh in-tab (content.js) chỉ lộ dấu hiệu FB chặn ra ĐÂY
      // (không có trong giá trị trả về của crawlGroupApiSmart, vì tab foreground
      // resolve gần như ngay khi mở). Soi `reason` để kích hoạt cooldown auto-crawl
      // ngay cả khi block xảy ra ở nhánh in-tab.
      try {
        noteCrawlDoneReason(msg && msg.result && msg.result.reason);
      } catch (e) {}
      const tabId = sender && sender.tab && sender.tab.id;
      if (tabId == null) {
        sendResponse({ ok: true, closed: false });
        return true;
      }
      // removeCrawlTab trả true nếu tabId đúng là tab do background tự mở.
      // Đọc từ chrome.storage.session nên vẫn đúng dù SW vừa khởi động lại.
      removeCrawlTab(tabId)
        .then((wasOurs) => {
          if (!wasOurs) {
            sendResponse({ ok: true, closed: false });
            return;
          }
          chrome.tabs.remove(tabId, () => {
            void chrome.runtime.lastError;
            sendResponse({ ok: true, closed: true });
          });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true; // giữ SW sống tới khi đóng tab xong
    }

    // Dashboard hỏi trạng thái ngắt mạch (đang tạm ngưng auto-crawl do bị FB
    // chặn hay không) để hiển thị banner cảnh báo.
    case "GET_CRAWL_BLOCK_STATE": {
      getCrawlBlockState()
        .then((state) => sendResponse({ ok: true, state }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ------------------- GIÁ GROUP / TỪ KHÓA / CHIA SẺ (web backend) ------
    // Tất cả đi qua API.apiFetch (token JWT chỉ sống ở service worker này).
    // Backend trả JSON KHÔNG bọc {ok}, nên ta tự gắn ok:true + trộn dữ liệu.
    // 401 -> apiFetch tự kích hoạt luồng AUTH_REQUIRED; ở đây trả ok:false.

    // Danh sách dòng giá group đã trích. Dữ liệu này riêng tư theo tài khoản:
    // server chỉ trả về dòng do chính người dùng hiện tại crawl/trích.
    case "GET_GROUP_PRICES": {
      (async () => {
        await readyPromise;
        const f = (msg.filters && typeof msg.filters === "object") ? msg.filters : {};
        const qs = new URLSearchParams();
        if (f.groupId) qs.set("groupId", String(f.groupId));
        if (f.category) qs.set("category", String(f.category));
        if (f.condition) qs.set("condition", String(f.condition));
        if (f.priceMin != null) qs.set("priceMin", String(f.priceMin));
        if (f.priceMax != null) qs.set("priceMax", String(f.priceMax));
        const q = qs.toString();
        const data = await API.apiFetch("/api/group-prices" + (q ? "?" + q : ""));
        sendResponse({ ok: true, groupPrices: (data && data.groupPrices) || [] });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Chạy phễu trích giá (nạp keywords + posts + AI + lưu) — toàn bộ ở SW vì
    // cần token + IndexedDB. Trả về { processed, inserted, newKeywords }.
    case "RUN_GROUP_PRICE_EXTRACTION": {
      (async () => {
        await readyPromise;
        // SERVER-SIDE AI: tiêm aiCall gọi /api/ai/extract-group-prices để key AI
        // không rời server; phần nạp keyword/posts + lưu vẫn ở SW như cũ.
        const result = await runGroupPriceExtraction({
          aiCall: async (batch, sellKeywords) => {
            const resp = await API.apiFetch("/api/ai/extract-group-prices", {
              method: "POST",
              body: JSON.stringify({ batch, sellKeywords }),
            });
            return (resp && resp.results) || [];
          },
        });
        sendResponse({ ok: true, ...result });
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Chạy phễu phân loại lead (rule chốt ca rõ, AI cho ca mơ hồ, rồi ĐÀO
    // keyword tự làm giàu bộ lọc). Toàn bộ ở SW vì cần token + apiFetch.
    // Trả { processed, ruleCount, aiCount, promoted, queued }.
    case "RUN_LEAD_CLASSIFICATION": {
      (async () => {
        await readyPromise;
        // Giữ service worker thức trong suốt job dài (nhiều lô AI + lưu ~ngàn
        // bài). MV3 hay cho SW ngủ khi "im" 30s -> nếu ngủ giữa chừng thì
        // sendResponse không bao giờ bắn, UI kẹt ở "Đang phân loại…". Ping nhẹ
        // mỗi 20s để reset đồng hồ ngủ.
        const keepAlive = setInterval(() => {
          try {
            chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
          } catch (_) {}
        }, 20000);
        try {
          // SERVER-SIDE AI: tiêm aiCall gọi /api/ai/classify-leads để key AI
          // không rời server; phần chọn bài + rule + đào keyword vẫn ở SW.
          const result = await runLeadClassification({
            force: !!msg.force,
            // Phát tiến độ realtime để UI biết job ĐANG chạy (không đơ spinner).
            onProgress: (info) => broadcast("LEAD_PROGRESS", info || {}),
            aiCall: async (batch) => {
              const resp = await API.apiFetch("/api/ai/classify-leads", {
                method: "POST",
                body: JSON.stringify({ batch }),
              });
              return (resp && resp.results) || [];
            },
          });
          sendResponse({ ok: true, ...result });
        } finally {
          clearInterval(keepAlive);
        }
      })().catch((e) => {
        const clean = String((e && e.message) || e).replace(/^API\s+\d+:\s*/, "");
        // Báo lỗi ra UI qua cả kênh trả lời lẫn broadcast (phòng khi port đã đóng).
        broadcast("LEAD_PROGRESS", { phase: "error", error: clean });
        sendResponse({ ok: false, error: clean });
      });
      return true;
    }

    // Đổi nhãn lead THỦ CÔNG cho một bài (nguồn 'manual' — không bị phễu tự
    // động ghi đè). Người dùng dạy hệ thống ca khó -> vòng học lấy làm chuẩn.
    case "SET_LEAD_LABEL": {
      (async () => {
        await readyPromise;
        const data = await API.apiFetch("/api/posts/" + encodeURIComponent(msg.postId), {
          method: "PATCH",
          body: JSON.stringify({ leadLabel: msg.label, leadSource: "manual" }),
        });
        // Backend trả { updated: affectedRows }. Nếu 0 → không ghi được hàng nào
        // (sai postId, không phải bài của mình, hoặc backend cũ nuốt field) ⇒
        // báo lỗi thay vì false-success để UI không hiện "thành công" giả.
        const updated = data && typeof data.updated === "number" ? data.updated : null;
        if (updated === 0) {
          sendResponse({ ok: false, error: "Không lưu được nhãn (không tìm thấy bài hoặc không có quyền)." });
          return;
        }
        sendResponse({ ok: true, updated });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Danh sách từ khóa đã học (lọc theo type nếu có).
    case "GET_KEYWORDS": {
      (async () => {
        await readyPromise;
        const type = String(msg.kwType || "").trim();
        const data = await API.apiFetch("/api/keywords" + (type ? "?type=" + encodeURIComponent(type) : ""));
        sendResponse({ ok: true, keywords: (data && data.keywords) || [] });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Thêm từ khóa thủ công (idempotent ở backend theo UNIQUE(keyword,type)).
    case "ADD_KEYWORD": {
      (async () => {
        await readyPromise;
        await API.apiFetch("/api/keywords", {
          method: "POST",
          body: JSON.stringify({
            keyword: msg.keyword,
            type: msg.kwType || "sell",
            addedBy: "user",
            enabled: msg.enabled !== false,
          }),
        });
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Bật/tắt hoặc đổi tên một từ khóa.
    case "UPDATE_KEYWORD": {
      (async () => {
        await readyPromise;
        await API.apiFetch("/api/keywords/" + encodeURIComponent(msg.id), {
          method: "PATCH",
          body: JSON.stringify(msg.patch || {}),
        });
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Xóa một từ khóa.
    case "DELETE_KEYWORD": {
      (async () => {
        await readyPromise;
        await API.apiFetch("/api/keywords/" + encodeURIComponent(msg.id), {
          method: "DELETE",
        });
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Hàng chờ vòng học keyword: danh sách đề xuất (lọc theo status/label nếu có).
    case "GET_KEYWORD_CANDIDATES": {
      (async () => {
        await readyPromise;
        const params = new URLSearchParams();
        if (msg.status) params.set("status", String(msg.status));
        if (msg.label) params.set("label", String(msg.label));
        const qs = params.toString();
        const data = await API.apiFetch(
          "/api/keyword-candidates" + (qs ? "?" + qs : "")
        );
        sendResponse({ ok: true, candidates: (data && data.candidates) || [] });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Duyệt/loại một đề xuất. approved -> backend tự thăng cấp sang learned_keywords.
    case "SET_CANDIDATE_STATUS": {
      (async () => {
        await readyPromise;
        const data = await API.apiFetch(
          "/api/keyword-candidates/" + encodeURIComponent(msg.id),
          {
            method: "PATCH",
            body: JSON.stringify({ status: msg.status }),
          }
        );
        sendResponse({ ok: true, ...(data || {}) });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Xóa hẳn một đề xuất khỏi hàng chờ.
    case "DELETE_KEYWORD_CANDIDATE": {
      (async () => {
        await readyPromise;
        await API.apiFetch(
          "/api/keyword-candidates/" + encodeURIComponent(msg.id),
          { method: "DELETE" }
        );
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ---- LỆNH TỪ WEB: trả danh sách lệnh (dùng cho dashboard view) ----
    case "GET_REMOTE_COMMANDS": {
      (async () => {
        await readyPromise;
        const params = new URLSearchParams();
        if (msg.status) params.set("status", msg.status);
        if (msg.page) params.set("page", String(msg.page));
        if (msg.limit) params.set("limit", String(msg.limit));
        const qs = params.toString();
        const data = await API.apiFetch("/api/remote-commands" + (qs ? "?" + qs : ""));
        sendResponse({ ok: true, ...(data || {}) });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ---- POLL NGAY: kích hoạt pollRemoteCommands() thủ công từ dashboard ----
    case "POLL_REMOTE_COMMANDS": {
      (async () => {
        await readyPromise;
        await pollRemoteCommands();
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ----------------------- XÁC THỰC WEB BACKEND (JWT) ------------------
    // Đăng nhập: gọi POST /api/auth/login, lưu token vào api.js (persist storage),
    // nhớ display_name để AUTH_STATE trả lại, rồi trả về user để UI hiển thị.
    // Token sẽ tự gắn vào mọi apiFetch sau đó.
    case "AUTH_LOGIN": {
      (async () => {
        await readyPromise;
        const email = String(msg.email || "").trim();
        const password = String(msg.password || "");
        // skipAuthHandler: 401 lúc đăng nhập = sai thông tin, KHÔNG được kích hoạt
        // luồng 401 toàn cục (xoá token phiên hiện tại + broadcast AUTH_REQUIRED).
        const data = await API.apiFetch("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
          skipAuthHandler: true,
        });
        API.setToken(data && data.token);
        const user = (data && data.user) || null;
        await setAuthUser(user);
        sendResponse({ ok: true, user });
        // Seed lại nguồn giá ngay sau khi có token hợp lệ. Nếu SW khởi động lúc
        // CHƯA đăng nhập thì seed lúc khởi tạo đã 401 và bị bỏ qua -> mục "Nguồn
        // dữ liệu giá" trống. Chạy lại ở đây để 4 nguồn mặc định xuất hiện ngay
        // sau lần đăng nhập đầu. Lỗi (nếu có) nuốt im, không cản luồng đăng nhập.
        pruneLegacySources().then(() => seedPriceSources()).catch(() => {});
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Đăng ký: gọi POST /api/auth/register. Backend trả {token, user} y như
    // login, nên lưu token + user và đăng nhập luôn cho người dùng. skipAuthHandler:
    // lỗi 4xx lúc đăng ký (email trùng / mật khẩu yếu) KHÔNG được kích hoạt luồng
    // 401 toàn cục — đó là lỗi nhập liệu, không phải token phiên hết hạn.
    case "AUTH_REGISTER": {
      (async () => {
        await readyPromise;
        const email = String(msg.email || "").trim();
        const password = String(msg.password || "");
        const displayName = String(msg.displayName || "").trim();
        const data = await API.apiFetch("/api/auth/register", {
          method: "POST",
          body: JSON.stringify({
            email,
            password,
            displayName: displayName || undefined,
          }),
          skipAuthHandler: true,
        });
        API.setToken(data && data.token);
        const user = (data && data.user) || null;
        await setAuthUser(user);
        sendResponse({ ok: true, user });
        // Seed nguồn giá ngay sau khi đăng ký xong (token mới, hợp lệ) để user
        // mới thấy 4 nguồn mặc định ngay, không phải đợi SW khởi động lại.
        pruneLegacySources().then(() => seedPriceSources()).catch(() => {});
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Đăng xuất: xoá token (cả cache in-memory lẫn chrome.storage.local) + user.
    case "AUTH_LOGOUT": {
      API.setToken(null);
      setAuthUser(null).finally(() => sendResponse({ ok: true }));
      return true;
    }

    // Trạng thái đăng nhập hiện tại (token + user). Await readyPromise trước để
    // không trả "chưa đăng nhập" oan khi SW vừa được đánh thức bởi message này
    // mà token trong storage chưa kịp nạp vào cache.
    case "AUTH_STATE": {
      (async () => {
        await readyPromise;
        const token = API.getToken();
        sendResponse({
          ok: true,
          loggedIn: !!token,
          display_name: (token && authUser && authUser.displayName) || "",
          userId: (token && authUser && authUser.id) || null,
        });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ----------------------- HỒ SƠ NGÀNH (prompt profiles) ----------------
    // Quản lý từ dashboard view "Hồ sơ ngành". Dữ liệu 100% ở backend (bảng
    // prompt_profiles) nên chia sẻ được. Mọi handler đi qua DB.* (wrap apiFetch).
    case "GET_PROMPT_PROFILES": {
      (async () => {
        await readyPromise;
        const profiles = await DB.getPromptProfiles();
        sendResponse({ ok: true, profiles });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Lưu/cập nhật một hồ sơ ngành (upsert theo id ở backend).
    case "SAVE_PROMPT_PROFILE": {
      (async () => {
        await readyPromise;
        await DB.savePromptProfile(msg.profile || {});
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Kích hoạt một hồ sơ ngành (đặt là hồ sơ duy nhất AI dùng). Xoá cache để
    // các lần gọi AI sau nạp lại hồ sơ mới ngay, không phải đợi cache 60s hết hạn.
    case "ACTIVATE_PROMPT_PROFILE": {
      (async () => {
        await readyPromise;
        await DB.activatePromptProfile(msg.id);
        clearProfileCache();
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // Xóa một hồ sơ ngành. Cũng xoá cache phòng khi đang xóa hồ sơ active.
    case "DELETE_PROMPT_PROFILE": {
      (async () => {
        await readyPromise;
        await DB.deletePromptProfile(msg.id);
        clearProfileCache();
        sendResponse({ ok: true });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    default:
      return false;
  }
});

/* ----------------------- KHỞI TẠO: alarms + seed ----------------------- */

try {
  // Khởi tạo client xác thực web backend: nạp token + user đã lưu vào cache,
  // và đăng ký handler 401 -> xoá token và báo UI cần đăng nhập lại.
  API.onUnauthorized((reason) => {
    setAuthUser(null);
    // reason: "locked" | "pending" | "inactive" | "expired" — để popup hiển thị
    // thông báo phù hợp (vd tài khoản bị admin khóa vs phiên hết hạn).
    broadcast("AUTH_REQUIRED", { reason });
  });
  // Nạp token + user SONG SONG và giữ promise để các handler phụ thuộc token
  // (AUTH_STATE/AUTH_LOGIN) await trước khi đọc cache — tránh đua với message
  // đến sớm lúc SW vừa được đánh thức (getToken() trả null oan).
  readyPromise = Promise.all([API.loadToken(), loadAuthUser()]);

  chrome.alarms.create("jobTick", { periodInMinutes: 1 });
  chrome.alarms.create("cmdPoll", { periodInMinutes: 0.5 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (!a) return;
    if (a.name === "jobTick") processDueJobs();
    else if (a.name === "cmdPoll") pollRemoteCommands();
    else if (a.name === AUTOCRAWL_ALARM) processAutoCrawl();
    else if (a.name === AUTOSYNC_ALARM) processAutoSync();
    else if (a.name === WATCH_ALARM) processReplyWatch();
    else if (a.name === WARMING_ALARM) {
      // Alarm một-lần: chạy lượt rồi TỰ lên lịch lượt kế tiếp (có dao động) để
      // lịch trình không máy móc. Reschedule cả khi lượt lỗi/bị bỏ qua.
      processWarming().finally(() => scheduleNextWarming());
    }
  });
  initAutoCrawl();
  initAutoSync();
  initReplyWatch();
  initWarming();
  // Dọn nguồn trùng "Linh kiện máy tính" đời cũ TRƯỚC khi seed lại 4 nguồn chuẩn.
  // PHẢI đợi readyPromise (token đã nạp vào cache) trước, nếu không các lệnh
  // getSources/saveSource bắn đi khi SW vừa thức dậy sẽ thiếu Authorization ->
  // 401 -> seed bị nuốt lỗi (catch rỗng) và token bị xoá oan. Đây là lý do mục
  // "Nguồn dữ liệu giá" trống dù lẽ ra phải có 4 nguồn seed mặc định.
  // Open WebSocket for instant command push (best-effort; polling remains
  // as fallback).  connectRealtime() needs the token to be loaded first.
  readyPromise
    .then(() => connectRealtime())
    .catch(() => {});

  readyPromise
    .then(() => pruneLegacySources())
    .then(() => seedPriceSources())
    .catch(() => {});
} catch (e) {}
