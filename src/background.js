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
import { discoverSelectors, listModels, spinPostContent, generateProfileSkill } from "./ai.js";
import { clearProfileCache } from "./prompts.js";
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
  crawlGroupApiInTab,
  crawlGroupApiTabless,
  crawlGroupApiSmart,
  scanJoinedGroups,
  removeCrawlTab,
  getCrawlBlockState,
  noteCrawlDoneReason,
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
import { runGroupPriceExtraction } from "./group-prices.js";
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

    case "AI_SPIN_CONTENT": {
      spinPostContent(msg.payload || {})
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }

    case "GEN_PROFILE_SKILL": {
      generateProfileSkill(msg.payload || {})
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
      (async () => {
        const jobs = await DB.getJobs(msg.jobType);
        const paused = jobs.filter((j) => j.status === "paused");
        for (const j of paused) await DB.updateJob(j.id, { status: "pending" });
        if (paused.length) scheduleTickSoon();
        sendResponse({ ok: true, approved: paused.length });
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
        const conv = await DB.getConversation(msg.id);
        if (!conv) return sendResponse({ ok: false, error: "Không tìm thấy hội thoại." });
        // targetReplyId (tuỳ chọn): khi NHIỀU người cùng trả lời dưới bình luận
        // của ta, UI gửi id của reply cần trả lời để AI soạn ĐÚNG người đó.
        const draft = await draftConversationReply(conv, { targetReplyId: msg.targetReplyId });
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
        const result = await runGroupPriceExtraction();
        sendResponse({ ok: true, ...result });
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
  API.onUnauthorized(() => {
    setAuthUser(null);
    broadcast("AUTH_REQUIRED");
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
  });
  initAutoCrawl();
  initAutoSync();
  initReplyWatch();
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
