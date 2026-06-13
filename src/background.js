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
import { discoverSelectors, buildConfigWithAI, listModels, spinPostContent } from "./ai.js";
import {
  generateAdvisories,
  analyzePost,
  approveAdvisory,
  draftConversationReply,
} from "./advisory.js";
import {
  startCrawlInActiveTab,
  stopCrawlInActiveTab,
  crawlGroupInTab,
  scanJoinedGroups,
  removeCrawlTab,
  runJob,
  executeDeletePost,
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
} from "./crawl.js";

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

    case "AI_SPIN_CONTENT": {
      spinPostContent(msg.payload || {})
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GET_SELECTORS": {
      chrome.storage.local.get("fbSelectors", (r) => {
        sendResponse({ ok: true, selectors: (r && r.fbSelectors) || null });
      });
      return true;
    }

    case "CLEAR_SELECTORS": {
      chrome.storage.local.remove("fbSelectors", () => sendResponse({ ok: true }));
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

    // ---- Build cấu hình PC bằng AI --------------------------------------
    case "BUILD_CONFIG": {
      buildConfigWithAI(msg.payload || {})
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    // ---- Lấy danh sách model khả dụng từ endpoint ------------------------
    case "LIST_MODELS": {
      listModels()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
      generateAdvisories(msg.options || {})
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
      approveAdvisory(msg.postId)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
        if (!myComment) return sendResponse({ ok: false, error: "Cần nhập nội dung bình luận của bạn để dò reply." });
        // Suy ra postId / groupId / commentId từ URL (best-effort).
        const postId =
          (url.match(/\/posts\/(\d+)/) || url.match(/[?&](?:story_fbid|fbid|multi_permalinks)=(\d+)/) || [])[1] || "";
        const groupId = (url.match(/\/groups\/(\d+)/) || [])[1] || "";
        const commentId = (url.match(/[?&]comment_id=(\d+)/) || [])[1] || "";
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
        const conv = await DB.getConversation(msg.id);
        if (!conv) return sendResponse({ ok: false, error: "Không tìm thấy hội thoại." });
        const draft = await draftConversationReply(conv);
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
            draftedAt: Date.now(),
          },
        });
        sendResponse({ ok: true, draft });
      })().catch((e) => sendResponse({ ok: false, error: String(e) }));
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
        const url = conv.myCommentUrl || conv.postUrl;
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

    // Phân tích MỘT bài theo yêu cầu (nút "AI phân tích") -> soạn nháp trả lời
    // ngay, KHÔNG lưu sẵn. Người dùng xem rồi tự copy / tạo việc bình luận.
    case "ANALYZE_POST": {
      analyzePost(msg.post || {})
        .then((res) => sendResponse(res))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
        });
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
  API.onUnauthorized(() => {
    setAuthUser(null);
    broadcast("AUTH_REQUIRED");
  });
  // Nạp token + user SONG SONG và giữ promise để các handler phụ thuộc token
  // (AUTH_STATE/AUTH_LOGIN) await trước khi đọc cache — tránh đua với message
  // đến sớm lúc SW vừa được đánh thức (getToken() trả null oan).
  readyPromise = Promise.all([API.loadToken(), loadAuthUser()]);

  chrome.alarms.create("jobTick", { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => {
    if (!a) return;
    if (a.name === "jobTick") processDueJobs();
    else if (a.name === AUTOCRAWL_ALARM) processAutoCrawl();
    else if (a.name === AUTOSYNC_ALARM) processAutoSync();
    else if (a.name === WATCH_ALARM) processReplyWatch();
  });
  initAutoCrawl();
  initAutoSync();
  initReplyWatch();
  // Dọn nguồn trùng "Linh kiện máy tính" đời cũ TRƯỚC khi seed lại 4 nguồn chuẩn.
  pruneLegacySources().then(() => seedPriceSources());
} catch (e) {}
