/**
 * crawl.js — Crawl theo nhóm, quét nhóm đã tham gia, automation đăng bài/bình
 * luận, lập lịch chạy job (jobTick), tự động crawl nền (autoCrawl) và tự động
 * đồng bộ giá (autoSync). Tách từ background.js (B3 — chia module theo domain).
 */
import * as DB from "./db.js";
import {
  getActiveTab,
  waitTabComplete,
  sleep,
  broadcast,
  fetchWithTimeout,
} from "./util.js";
import { syncAllSources } from "./prices.js";
import { extractPostsFromChunks } from "./gql-parse.js";

/* ------------------------- QUẢN LÝ TAB CRAWL --------------------------- */
// Lưu danh sách tab do background tự mở vào chrome.storage.session để sống sót khi
// service worker bị tắt giữa chừng (MV3 tự kill SW sau ~30s rảnh). Nếu dùng biến Set
// trong RAM, set sẽ bị xoá sạch khi SW restart => khi tab gửi CRAWL_DONE, SW vừa thức
// dậy thấy set rỗng nên không nhận ra tab cần đóng => để lại hàng loạt tab rác.
const CRAWL_TABS_KEY = "crawlTabs";

async function getCrawlTabs() {
  try {
    const r = await chrome.storage.session.get(CRAWL_TABS_KEY);
    return Array.isArray(r[CRAWL_TABS_KEY]) ? r[CRAWL_TABS_KEY] : [];
  } catch (e) {
    return [];
  }
}

async function addCrawlTab(tabId) {
  if (tabId == null) return;
  const ids = await getCrawlTabs();
  if (!ids.includes(tabId)) {
    ids.push(tabId);
    await chrome.storage.session.set({ [CRAWL_TABS_KEY]: ids });
  }
}

// Trả về true nếu tabId đúng là tab do background tự mở (và đã được gỡ khỏi danh sách).
async function removeCrawlTab(tabId) {
  const ids = await getCrawlTabs();
  const next = ids.filter((id) => id !== tabId);
  if (next.length !== ids.length) {
    await chrome.storage.session.set({ [CRAWL_TABS_KEY]: next });
    return true;
  }
  return false;
}

/* ----------------------- SẮP XẾP FEED "BÀI VIẾT MỚI" -------------------- */
// Crawl tăng dần CHỈ đúng khi feed nhóm sắp theo THỜI GIAN ĐĂNG (mới->cũ).
// Mặc định FB trả "Phù hợp nhất" (thuật toán, KHÔNG theo thời gian) => bài mới &
// bài cũ xen kẽ nhau, khiến cơ chế "dừng sau N bài đã biết liên tiếp" dừng sớm
// và bỏ sót bài mới. Tham số ?sorting_setting=CHRONOLOGICAL ép FB về đúng chế độ
// "Bài viết mới". Đây là cách CHÍNH; content.js còn 1 lớp dự phòng bấm UI.
function withNewestSort(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set("sorting_setting", "CHRONOLOGICAL");
    u.hash = "";
    return u.toString();
  } catch (e) {
    // Fallback nối chuỗi nếu URL không parse được.
    const sep = rawUrl.includes("?") ? "&" : "?";
    return rawUrl.split("#")[0] + sep + "sorting_setting=CHRONOLOGICAL";
  }
}

/* ------------------------- CRAWL TAB ĐANG MỞ --------------------------- */

/** Tìm tab đang active; nếu là trang nhóm FB thì gửi lệnh bắt đầu crawl tới content script. */
async function startCrawlInActiveTab(options) {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: "Không tìm thấy tab đang mở." };

  if (!/https:\/\/(www|web)\.facebook\.com\/groups\//.test(tab.url || "")) {
    return {
      ok: false,
      error:
        "Tab hiện tại không phải trang nhóm Facebook. Hãy mở đúng nhóm rồi thử lại.",
    };
  }

  // Ép tab về chế độ "Bài viết mới" (CHRONOLOGICAL) nếu chưa có, để crawl tăng dần
  // lấy đúng & đủ bài mới. Nếu phải đổi URL thì chờ trang tải lại xong rồi mới crawl.
  if (!/[?&]sorting_setting=CHRONOLOGICAL/.test(tab.url || "")) {
    try {
      const sorted = withNewestSort(tab.url);
      await chrome.tabs.update(tab.id, { url: sorted });
      await waitTabComplete(tab.id, 30000);
      await sleep(2500); // chờ feed render lười
    } catch (e) {
      // Không đổi được URL thì vẫn tiếp tục; content.js còn lớp dự phòng bấm UI.
    }
  }

  // Đảm bảo content script đã sẵn sàng (phòng trường hợp trang mở trước khi cài).
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content.js"],
    });
  } catch (e) {
    // Nếu đã được nạp qua manifest, executeScript có thể báo lỗi trùng — bỏ qua.
  }

  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "START_CRAWL",
      options,
    });
    return res || { ok: true };
  } catch (e) {
    return {
      ok: false,
      error:
        "Không gửi được lệnh tới trang. Hãy tải lại (F5) trang nhóm rồi thử lại. Chi tiết: " +
        String(e),
    };
  }
}

async function stopCrawlInActiveTab() {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: "Không tìm thấy tab đang mở." };
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "STOP_CRAWL" });
    return res || { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/* ---------------------------- CRAWL THEO NHÓM --------------------------- */

/** Mở tab nhóm rồi khởi động crawl trong tab đó (tiến độ phát qua broadcast). */
async function crawlGroupInTab(groupId, options) {
  if (!groupId) return { ok: false, error: "Thiếu groupId." };
  // Ép feed về "Bài viết mới" (CHRONOLOGICAL) để crawl tăng dần lấy đúng & đủ bài mới.
  const url = withNewestSort("https://www.facebook.com/groups/" + groupId + "/");
  // Mở ở chế độ NỀN để người dùng ở lại dashboard; tiến trình phát qua broadcast.
  const tab = await new Promise((r) => chrome.tabs.create({ url, active: false }, r));
  // Ghi nhận tab này do background tự mở để CRAWL_DONE biết đường đóng lại sau khi xong.
  // Lưu vào chrome.storage.session để sống sót khi service worker bị tắt giữa chừng.
  await addCrawlTab(tab.id);
  await waitTabComplete(tab.id, 30000);
  await sleep(2500); // chờ feed render lười
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content.js"],
    });
  } catch (e) {}
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "START_CRAWL",
      options: options || {},
    });
    return { ok: true, tabId: tab.id, started: !!(res && res.ok) };
  } catch (e) {
    return {
      ok: false,
      tabId: tab.id,
      error: "Không gửi được lệnh crawl tới tab nhóm: " + String(e),
    };
  }
}

/* ----------------------- CRAWL QUA API (GraphQL nội bộ FB) ---------------- */

/**
 * Mở 1 TAB trong CỬA SỔ HIỆN TẠI của trình duyệt để BẮT KHUÔN GQL LẦN ĐẦU.
 * KHÔNG dùng cho mọi lần crawl — chỉ gọi khi storage CHƯA có khuôn (xem
 * crawlGroupApiSmart). Sau khi bắt được khuôn, mọi nhóm khác crawl qua
 * crawlGroupApiTabless (KHÔNG mở tab, KHÔNG đụng tab/cửa sổ của người dùng).
 *
 * Có CHỐNG LỖI:
 *  - LUÔN kiểm tra chrome.runtime.lastError: khi tạo thất bại, callback có thể
 *    trả về undefined => phải bắt để không "nuốt" lỗi.
 *  - Có retry ngắn phòng khi tạo tab trượt.
 *
 * QUAN TRỌNG — TAB PHẢI ACTIVE + CỬA SỔ PHẢI FOCUSED:
 *  Gốc rễ đã xác nhận qua nhiều lần probe: tab/cửa sổ KHÔNG được foreground thì
 *  Chrome throttle requestAnimationFrame / IntersectionObserver-batching — đúng
 *  cơ chế mà Facebook Comet dùng để lazy-load feed khi cuộn. Hậu quả: seen đứng
 *  yên, scrollH thấp, KHÔNG có GroupsCometFeedRegularStoriesPaginationQuery.
 *  Vì vậy tab crawl phải là tab ACTIVE của một cửa sổ ĐANG FOCUS.
 *
 *  Đánh đổi (user đã đồng ý, chỉ xảy ra 1 LẦN cho tới khi khuôn hết hạn/bị FB
 *  đổi doc_id): tab crawl nhấp lên foreground vài giây để bắt khuôn. KHÔNG ép
 *  `state` cửa sổ (không resize/un-maximize cửa sổ của người dùng).
 *
 * Trả về { tab, windowId, kind:"tab" } khi thành công, hoặc { error } khi thất bại.
 */
async function openHiddenCrawlTab(url) {
  // Tìm cửa sổ trình duyệt "normal" đang/được focus gần nhất để đặt tab crawl
  // vào đó (thay vì bung một popup mới). Nếu không có, chrome.tabs.create sẽ tự
  // dùng cửa sổ hiện tại (hoặc tạo mới) — vẫn chấp nhận được.
  const getFocusedNormalWindow = () =>
    new Promise((resolve) => {
      try {
        chrome.windows.getLastFocused({ windowTypes: ["normal"] }, (win) => {
          void chrome.runtime.lastError;
          resolve(win && win.id ? win : null);
        });
      } catch (_) {
        resolve(null);
      }
    });

  const createTab = (opts) =>
    new Promise((resolve) => {
      try {
        chrome.tabs.create(opts, (tab) => {
          const err = chrome.runtime.lastError;
          if (err || !tab) return resolve({ tab: null, err: err && err.message });
          resolve({ tab, err: null });
        });
      } catch (e) {
        resolve({ tab: null, err: String(e) });
      }
    });

  // Ép focus ở cấp OS để tab không bị coi là background (KHÔNG kèm `state` —
  // tránh resize/un-maximize cửa sổ hiện tại của người dùng).
  const focusWindow = (windowId) =>
    new Promise((resolve) => {
      try {
        chrome.windows.update(windowId, { focused: true }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (_) {
        resolve();
      }
    });

  const target = await getFocusedNormalWindow();
  // active:true => tab thành tab foreground của cửa sổ => không bị throttle.
  const tabOpts = { url, active: true };
  if (target && target.id) tabOpts.windowId = target.id;

  let lastErr = "";
  for (let round = 0; round < 2; round++) {
    const { tab, err } = await createTab(tabOpts);
    if (err) lastErr = err;
    if (tab) {
      await focusWindow(tab.windowId);
      return { tab, windowId: tab.windowId, kind: "tab" };
    }
    await sleep(400); // nghỉ ngắn rồi thử lại
  }
  return {
    error:
      "Không mở được tab để crawl API." + (lastErr ? " (" + lastErr + ")" : ""),
  };
}

/**
 * Mở tab nhóm rồi khởi động crawl QUA API (sniff + replay) trong tab đó.
 * Khác crawlGroupInTab ở chỗ gửi START_API_CRAWL thay vì START_CRAWL.
 * Tiến trình phát qua broadcast CRAWL_PROGRESS / CRAWL_DONE.
 */
async function crawlGroupApiInTab(groupId, options) {
  if (!groupId) return { ok: false, error: "Thiếu groupId." };
  // Ép feed về "Bài viết mới" (CHRONOLOGICAL) để replay phân trang lấy đúng thứ tự.
  const url = withNewestSort("https://www.facebook.com/groups/" + groupId + "/");
  // Mở 1 TAB ACTIVE trong cửa sổ hiện tại (không popup riêng). Tab foreground =>
  // Chrome không throttle rAF/IntersectionObserver => FB lazy-load feed bình thường.
  // IP/fingerprint THẬT của trình duyệt user => giảm rủi ro checkpoint.
  // Vì crawl API chạy TUẦN TỰ nên chỉ 1 tab active tại một thời điểm.
  const opened = await openHiddenCrawlTab(url);
  const tab = opened && opened.tab;
  if (!tab) {
    return {
      ok: false,
      error: (opened && opened.error) || "Không mở được cửa sổ ẩn để crawl API.",
    };
  }
  // Ghi nhận tab này do background tự mở để CRAWL_DONE biết đường đóng lại sau khi xong.
  // (Đóng tab cuối của popup => Chrome tự đóng luôn cửa sổ ẩn.)
  await addCrawlTab(tab.id);
  await waitTabComplete(tab.id, 30000);
  await sleep(2500); // chờ feed render lười
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content.js"],
    });
  } catch (e) {}
  try {
    const res = await chrome.tabs.sendMessage(tab.id, {
      type: "START_API_CRAWL",
      options: options || {},
    });
    return { ok: true, tabId: tab.id, started: !!(res && res.ok), mode: "api" };
  } catch (e) {
    return {
      ok: false,
      tabId: tab.id,
      error: "Không gửi được lệnh crawl API tới tab nhóm: " + String(e),
    };
  }
}

/**
 * BỘ ĐỊNH TUYẾN crawl API — quyết định mở tab hay chạy ẩn:
 *  - ĐÃ CÓ khuôn GQL trong storage => crawlGroupApiTabless: KHÔNG mở tab, KHÔNG
 *    đụng tới tab/cửa sổ của người dùng (không resize, không nhảy tab). Khuôn
 *    dùng chung cho MỌI nhóm nên chỉ cần bắt 1 lần.
 *  - CHƯA CÓ khuôn => phải mở 1 tab foreground 1 LẦN (crawlGroupApiInTab) để FB
 *    bắn feed query mà hook bắt lấy khuôn (content.js tự lưu vào storage). Các
 *    lần crawl sau sẽ tự động chuyển sang nhánh tabless ở trên.
 *
 * Nhờ vậy, trải nghiệm mặc định là "cào ngầm" — người dùng không bị giật tab
 * hay đổi kích thước cửa sổ ở mỗi lần crawl.
 */
async function crawlGroupApiSmart(groupId, options) {
  if (!groupId) return { ok: false, error: "Thiếu groupId." };
  const tpl = await getStoredGqlTemplate();
  if (tpl && tpl.doc_id) {
    // Đường ẩn hoàn toàn: replay khuôn bằng fetch trực tiếp từ extension
    // (IP/cookie của user), không mở tab, không qua backend relay.
    return crawlGroupApiTabless(groupId, options);
  }
  // Chưa có khuôn: mở tab 1 lần để bắt khuôn (đồng thời cũng cào luôn nhóm này).
  return crawlGroupApiInTab(groupId, options);
}

/* ----------------------- CRAWL KHÔNG-TAB (Mức B) ------------------------- */

/** Đọc khuôn GQL đã được content.js lưu vào chrome.storage.local. */
function getStoredGqlTemplate() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("fbcGqlTemplate", (o) =>
        resolve((o && o.fbcGqlTemplate) || null)
      );
    } catch (e) {
      resolve(null);
    }
  });
}

/** Tách response GraphQL thành các chunk JSON (port từ fb-api-hook.js). */
function splitGqlChunks(text) {
  const out = [];
  if (!text) return out;
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (e) {}
  }
  if (out.length === 0) {
    try {
      out.push(JSON.parse(text));
    } catch (e) {}
  }
  return out;
}

/** Trích fb_dtsg + lsd mới từ HTML nhóm để làm tươi token. */
function extractTokensFromHtml(html) {
  const out = { fb_dtsg: "", lsd: "" };
  if (!html) return out;
  const dtsg =
    html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
    html.match(/name="fb_dtsg"\s+value="([^"]+)"/) ||
    html.match(/"dtsg":\{"token":"([^"]+)"/);
  if (dtsg) out.fb_dtsg = dtsg[1];
  const lsd =
    html.match(/"LSD",\[\],\{"token":"([^"]+)"/) ||
    html.match(/"lsd":\{"token":"([^"]+)"/);
  if (lsd) out.lsd = lsd[1];
  return out;
}

/** Đặt cursor vào variables (giống content.js setCursorInVariables). */
function setCursorInVars(vars, cursor) {
  if (!vars || cursor == null) return;
  if ("after" in vars) vars.after = cursor;
  vars.cursor = cursor;
}

// ID cố định cho session-rule DNR chèn header khi crawl API không-tab.
const FB_GQL_RULE_ID = 8577;

/**
 * Bật session-rule DNR chèn các header BỊ CẤM (Origin/Referer/sec-fetch-*) mà
 * service worker MV3 không thể tự đặt qua fetch. Chỉ nhắm request nền của chính
 * extension (tabIds:[-1] = request không gắn tab) tới /api/graphql/ nên KHÔNG
 * đụng tới traffic người dùng tự lướt Facebook. Nhờ vậy request cào đi THẲNG từ
 * máy người dùng (đúng IP, đúng cookie phiên) — không cần relay qua server, loại
 * bỏ rủi ro checkpoint do IP datacenter + không đẩy cookie ra ngoài.
 */
async function ensureFbGqlHeaderRule(referer) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [FB_GQL_RULE_ID],
      addRules: [
        {
          id: FB_GQL_RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "origin", operation: "set", value: "https://www.facebook.com" },
              { header: "referer", operation: "set", value: referer || "https://www.facebook.com/" },
              { header: "sec-fetch-site", operation: "set", value: "same-origin" },
              { header: "sec-fetch-mode", operation: "set", value: "cors" },
              { header: "sec-fetch-dest", operation: "set", value: "empty" },
            ],
          },
          condition: {
            urlFilter: "||facebook.com/api/graphql/",
            resourceTypes: ["xmlhttprequest"],
            // -1 = request không gắn tab (tức fetch từ service worker của extension).
            tabIds: [-1],
          },
        },
      ],
    });
  } catch (e) {
    try {
      console.warn("[FBC][DNR] ensureFbGqlHeaderRule lỗi:", String(e));
    } catch (_) {}
  }
}

/** Gỡ session-rule DNR sau khi crawl xong (dọn dẹp, tránh sót rule). */
async function removeFbGqlHeaderRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [FB_GQL_RULE_ID],
    });
  } catch (_) {}
}

/**
 * Cào nhóm KHÔNG mở tab — chạy thẳng trong background service worker.
 * Lấy khuôn request (doc_id/friendly/raw/variables) mà content.js đã lưu vào
 * chrome.storage.local khi sniff feed của 1 nhóm bất kỳ, rồi POST /api/graphql/
 * trực tiếp (cookie tự đính theo host_permissions) như các dịch vụ ngoài.
 * Token fb_dtsg/lsd được làm mới từ HTML nhóm. groupId đích được nhét vào
 * variables.id (1 khuôn dùng chung cho MỌI nhóm).
 */
async function crawlGroupApiTabless(groupId, options) {
  if (!groupId) return { ok: false, error: "Thiếu groupId." };
  const opts = {
    maxNewPosts: (options && options.maxNewPosts) || 100,
    maxPages: (options && options.maxPages) || 60,
    pageDelay: (options && options.pageDelay) || 800,
    ...(options || {}),
  };

  const tpl = await getStoredGqlTemplate();
  if (!tpl || !tpl.doc_id) {
    const msg =
      "Chưa có mẫu request feed nhóm. Hãy mở 1 nhóm FB và cuộn feed 1-2 nhịp" +
      " (để bắt khuôn request), rồi chạy lại crawl không-tab.";
    broadcast("CRAWL_DONE", { result: { newCount: 0, reason: msg } });
    return { ok: false, error: "no template" };
  }

  const groupUrl = "https://www.facebook.com/groups/" + groupId + "/";
  const apiReport = (extra = {}) =>
    broadcast("CRAWL_PROGRESS", { progress: { groupId, mode: "api", ...extra } });

  try {
    // Làm mới token từ HTML nhóm (cookie phiên tự đính theo host_permissions).
    let fb_dtsg = tpl.fb_dtsg || "";
    let lsd = tpl.lsd || "";
    try {
      const htmlRes = await fetchWithTimeout(
        withNewestSort(groupUrl),
        { credentials: "include" },
        25000
      );
      const tok = extractTokensFromHtml(await htmlRes.text());
      if (tok.fb_dtsg) fb_dtsg = tok.fb_dtsg;
      if (tok.lsd) lsd = tok.lsd;
    } catch (e) {}

    const known = new Set(await DB.getKnownIds(groupId));
    apiReport({ status: "started", newCount: 0, pages: 0 });

    const seenThisRun = new Set();
    let newCount = 0;
    let pages = 0;
    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const toSave = batch;
      batch = [];
      await DB.savePosts(toSave);
    };
    const ingestChunks = (chunks) => {
      const { posts, pageInfo } = extractPostsFromChunks(chunks, {
        groupId,
        groupName: "",
        origin: "https://www.facebook.com",
      });
      for (const p of posts) {
        if (seenThisRun.has(p.postId)) continue;
        seenThisRun.add(p.postId);
        if (known.has(p.postId)) continue;
        batch.push(p);
        newCount += 1;
      }
      return pageInfo;
    };

    const buildBody = (cursor) => {
      const vars = JSON.parse(JSON.stringify(tpl.variables || {}));
      vars.id = groupId; // nhét groupId đích vào khuôn dùng chung
      if (cursor) {
        setCursorInVars(vars, cursor);
      } else {
        // Trang 1: bỏ cursor/after còn sót từ khuôn nhóm khác.
        delete vars.cursor;
        if ("after" in vars) vars.after = null;
      }
      const p = new URLSearchParams(tpl.raw || "");
      if (fb_dtsg) p.set("fb_dtsg", fb_dtsg);
      if (lsd) p.set("lsd", lsd);
      p.set("variables", JSON.stringify(vars));
      return p.toString();
    };

    const friendly =
      tpl.friendly || "GroupsCometFeedRegularStoriesPaginationQuery";
    // Chẩn đoán phản hồi /api/graphql/ trang gần nhất (để soi vì sao +0 bài).
    let lastDiag = null;
    // Lý do FB chặn (checkpoint/đăng nhập lại/giới hạn tần suất) => DỪNG SỚM
    // thay vì gõ dồn dập, để bảo vệ tài khoản.
    let blockedReason = null;

    // Số nguyên ngẫu nhiên trong [a, b] — dùng cho jitter nhịp nghỉ.
    const rint = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

    // Phát hiện dấu hiệu FB chặn/đòi xác minh để dừng crawl ngay. Gõ tiếp khi đã
    // bị 429/checkpoint chỉ làm tăng rủi ro khoá tài khoản.
    const detectBlock = (status, txt) => {
      if (status === 429)
        return "FB giới hạn tần suất (HTTP 429). Đã dừng để bảo vệ tài khoản; thử lại sau.";
      if (status === 401 || status === 403)
        return `FB từ chối truy cập (HTTP ${status}). Có thể phiên đăng nhập đã hết hạn hoặc bị chặn.`;
      if (status >= 500)
        return `FB lỗi máy chủ (HTTP ${status}). Đã dừng, thử lại sau.`;
      const head = String(txt || "").slice(0, 2000).toLowerCase();
      if (
        head.includes("checkpoint") ||
        head.includes("/login/") ||
        head.includes("login_required") ||
        head.includes("please log in") ||
        head.includes("www.facebook.com/login")
      )
        return "FB yêu cầu xác minh/đăng nhập lại (checkpoint). Đã dừng crawl để tránh rủi ro khoá tài khoản.";
      return null;
    };

    // Nhịp nghỉ giữa các trang CÓ JITTER (70%–160% nhịp cơ bản) + thỉnh thoảng
    // nghỉ dài như người thật dừng đọc => pattern bớt máy móc, giảm rủi ro
    // checkpoint so với nhịp cố định.
    let sincePageRest = 0;
    let nextRestGap = rint(5, 8);
    const nextPageDelay = () => {
      sincePageRest += 1;
      if (sincePageRest >= nextRestGap) {
        sincePageRest = 0;
        nextRestGap = rint(5, 8);
        return rint(opts.pageDelay * 3, opts.pageDelay * 6);
      }
      return Math.round(opts.pageDelay * (0.7 + Math.random() * 0.9));
    };

    // Bật rule DNR chèn header bị cấm (Origin/Referer/sec-fetch-*) cho ĐÚNG
    // request nền tới /api/graphql/. Request đi THẲNG từ máy bạn (cookie tự đính
    // theo host_permissions) nên KHÔNG lộ cookie ra server, KHÔNG dùng IP
    // datacenter => không dính rủi ro checkpoint của kiểu relay.
    await ensureFbGqlHeaderRule(withNewestSort(groupUrl));

    const fetchPage = async (cursor) => {
      // x-fb-* là header tuỳ biến — fetch tự đặt được. Origin/Referer/sec-fetch-*
      // do DNR chèn hộ (service worker bị cấm tự đặt). credentials:"include" để
      // cookie phiên facebook.com tự đính (đúng phiên, đúng IP của người dùng).
      const headers = {
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-friendly-name": friendly,
      };
      if (lsd) headers["x-fb-lsd"] = lsd;
      if (tpl.doc_id) headers["x-fb-doc-id"] = tpl.doc_id;
      const res = await fetchWithTimeout(
        "https://www.facebook.com/api/graphql/",
        {
          method: "POST",
          credentials: "include",
          headers,
          body: buildBody(cursor),
        },
        25000
      );
      const txt = await res.text();
      const chunks = splitGqlChunks(txt);
      lastDiag = {
        status: res.status,
        len: txt.length,
        chunks: chunks.length,
        sample: String(txt).slice(0, 300).replace(/\s+/g, " "),
        friendly,
        doc_id: tpl.doc_id,
        hadLsd: !!lsd,
        hadDtsg: !!fb_dtsg,
      };
      // Dừng ngay nếu FB trả dấu hiệu chặn/checkpoint/hết phiên — gõ tiếp chỉ
      // làm tăng rủi ro khoá tài khoản, không thu thêm được gì.
      blockedReason = detectBlock(res.status, txt);
      try {
        console.log("[FBC][API-DIRECT] /api/graphql/ resp:", lastDiag);
      } catch (_) {}
      return chunks;
    };

    // Trang 1 (không cursor).
    let cursor = null;
    {
      const pi = ingestChunks(await fetchPage(null));
      cursor = pi.endCursor;
      pages += 1;
      await flush();
      apiReport({ status: "page", newCount, pages, hasNext: pi.hasNext });
      if (!pi.hasNext || !pi.endCursor) cursor = null;
    }

    while (
      !blockedReason &&
      cursor &&
      newCount < opts.maxNewPosts &&
      pages < opts.maxPages
    ) {
      await sleep(nextPageDelay());
      const pi = ingestChunks(await fetchPage(cursor));
      pages += 1;
      await flush();
      apiReport({ status: "page", newCount, pages, hasNext: pi.hasNext });
      if (blockedReason || !pi.hasNext || !pi.endCursor || pi.endCursor === cursor)
        break;
      cursor = pi.endCursor;
    }

    await flush();
    // Ngắt mạch: bị chặn -> ghi mốc tạm ngưng (backoff); ngược lại xoá trạng thái
    // để chu kỳ sau chạy bình thường.
    if (blockedReason) await setCrawlBlock(blockedReason);
    else await clearCrawlBlock();
    let reason = blockedReason
      ? blockedReason
      : newCount >= opts.maxNewPosts
        ? "Đã đạt giới hạn số bài mới."
        : "Đã hết trang feed (API không-tab).";
    // Khi +0 bài, đính chẩn đoán phản hồi để soi lý do ngay trên UI (khỏi mở devtools).
    if (newCount === 0 && lastDiag) {
      reason +=
        ` [chẩn đoán: HTTP ${lastDiag.status}, dài ${lastDiag.len}B, ` +
        `${lastDiag.chunks} mảnh, lsd=${lastDiag.hadLsd ? 1 : 0}, ` +
        `dtsg=${lastDiag.hadDtsg ? 1 : 0} · ${lastDiag.sample}]`;
    }
    apiReport({ status: "done", newCount, pages });
    broadcast("CRAWL_DONE", { result: { newCount, reason, diag: lastDiag } });
    return { ok: true, newCount, reason, mode: "api-tabless", diag: lastDiag };
  } catch (err) {
    broadcast("CRAWL_DONE", {
      result: { newCount: 0, reason: "Lỗi API không-tab: " + String(err) },
    });
    return { ok: false, error: String(err) };
  } finally {
    // Luôn gỡ rule DNR sau khi crawl xong (kể cả khi lỗi) để không sót rule.
    await removeFbGqlHeaderRule();
  }
}

/* ----------------------- QUÉT NHÓM ĐÃ THAM GIA -------------------------- */

/** Hàm tự-chứa chạy trong trang "Nhóm của bạn" để thu thập (groupId, groupName). */
async function scanJoinedGroupsInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Cuộn để tải hết danh sách nhóm.
  for (let i = 0; i < 10; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(800);
  }
  const RESERVED = new Set([
    "joins", "feed", "discover", "create", "your_groups", "category", "search", "notifications",
  ]);
  // Các đoạn path cho biết link trỏ tới bài viết/thông báo cụ thể chứ không phải trang chủ nhóm.
  const POST_SEGMENTS = new Set([
    "posts", "permalink", "permalinks", "photo", "photos", "videos", "media",
    "user", "members", "notif",
  ]);
  // Các cụm cho biết text là dòng hoạt động/thông báo, không phải tên nhóm sạch.
  const NOISE_MARKERS = [
    "Lần hoạt động gần nhất",
    "đã bình luận",
    "đã đăng",
    "đã chia sẻ",
    "đã phản hồi",
    "đã trả lời",
    "đã thích",
    "bài viết của bạn",
  ];
  // Làm sạch tên nhóm: bỏ tiền tố "Chưa đọc", cắt phần phụ đề hoạt động, bỏ mốc thời gian ở đuôi.
  const cleanName = (raw) => {
    let s = (raw || "").trim();
    if (!s) return "";
    s = s.replace(/^Chưa đọc\s*/i, "").trim();
    let cut = s.length;
    for (const mk of NOISE_MARKERS) {
      const idx = s.indexOf(mk);
      if (idx >= 0 && idx < cut) cut = idx;
    }
    s = s.slice(0, cut).trim();
    // Bỏ mốc thời gian tương đối ở đuôi, vd ".3 giờ", ".41 phút", "1 tuần".
    s = s.replace(/[.\s]*\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)(\s*trước)?$/i, "").trim();
    // Bỏ dấu câu thừa ở đuôi.
    s = s.replace(/[:.\-\s]+$/, "").trim();
    return s;
  };
  const map = {};
  document.querySelectorAll('a[href*="/groups/"]').forEach((a) => {
    const href = a.href || "";
    const path = href.split(/[?#]/)[0];
    const m = path.match(/\/groups\/([^/]+)(\/[^?#]*)?$/);
    if (!m) return;
    const id = m[1];
    if (RESERVED.has(id)) return;
    // Bỏ qua link trỏ tới bài viết/thông báo cụ thể (vd /groups/{id}/posts/...).
    const rest = (m[2] || "").replace(/^\/+|\/+$/g, "");
    if (rest && POST_SEGMENTS.has(rest.split("/")[0])) return;
    const name = cleanName(a.textContent || "");
    if (
      name &&
      name.length > 1 &&
      name.length < 120 &&
      !/^https?:/i.test(name) &&
      !NOISE_MARKERS.some((mk) => name.includes(mk)) &&
      !map[id]
    ) {
      map[id] = name;
    }
  });
  return Object.keys(map).map((id) => ({ groupId: id, groupName: map[id] }));
}

/** Mở trang "Nhóm của bạn", quét rồi lưu danh sách nhóm vào IndexedDB. */
async function scanJoinedGroups() {
  const url = "https://www.facebook.com/groups/joins/";
  const tab = await new Promise((r) => chrome.tabs.create({ url, active: true }, r));
  await waitTabComplete(tab.id, 30000);
  await sleep(2500);
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanJoinedGroupsInPage,
    });
  } catch (e) {
    return { ok: false, error: "Không quét được nhóm: " + String(e) };
  }
  const groups = (res && res[0] && res[0].result) || [];
  if (!groups.length) {
    return {
      ok: false,
      error: "Không tìm thấy nhóm nào. Hãy chắc chắn đã đăng nhập và mở trang 'Nhóm của bạn'.",
    };
  }
  const saved = await DB.saveGroups(groups);
  return { ok: true, scanned: groups.length, added: saved.added, updated: saved.updated };
}

/* ----------------------- AUTOMATION: ĐĂNG BÀI --------------------------- */

/**
 * Hàm tự-chứa: mở composer trong trang nhóm, nhập nội dung rồi bấm Đăng.
 * CẢNH BÁO: thao tác mô phỏng người dùng -> rất dễ vỡ khi FB đổi UI và có thể
 * vi phạm điều khoản FB. Trả về { ok, error }.
 */
async function runPostInPage(text, images) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lower = (e) => (e.textContent || "").trim().toLowerCase();
  const findByText = (texts) => {
    const els = [...document.querySelectorAll('div[role="button"], span, a[role="link"]')];
    return els.find((e) => {
      const t = lower(e);
      return t && texts.some((x) => t.includes(x));
    });
  };
  // Chuyển dataURL -> File để gắn vào input[type=file].
  const dataUrlToFile = (dataUrl, idx) => {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl || "");
    if (!m) return null;
    const mime = m[1] || "image/png";
    const isB64 = !!m[2];
    const raw = isB64 ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const ext = (mime.split("/")[1] || "png").split("+")[0];
    return new File([bytes], "image_" + (idx + 1) + "." + ext, { type: mime });
  };
  const attachImages = async (scope) => {
    const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!imgs.length) return;
    const root = scope || document;
    let input = root.querySelector('input[type="file"][accept*="image"]') ||
      root.querySelector('input[type="file"]') ||
      document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"]');
    // Nếu chưa có input, thử bấm nút Ảnh/Video để FB render input.
    if (!input) {
      const photoBtn = [...root.querySelectorAll('div[role="button"], span')].find((e) => {
        const t = lower(e);
        return t.includes("ảnh/video") || t.includes("photo/video") || t === "ảnh" || t === "photo";
      });
      if (photoBtn) {
        try { photoBtn.click(); } catch (e) {}
        await sleep(1500);
        input = document.querySelector('input[type="file"][accept*="image"]') ||
          document.querySelector('input[type="file"]');
      }
    }
    if (!input) return;
    const dt = new DataTransfer();
    imgs.forEach((d, i) => {
      const f = dataUrlToFile(d, i);
      if (f) dt.items.add(f);
    });
    if (!dt.files.length) return;
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(3500);
  };

  // 1) Mở hộp soạn bài.
  const trigger = findByText([
    "bạn viết gì", "viết gì đó", "bạn đang nghĩ gì", "đang nghĩ gì",
    "what's on your mind", "write something", "tạo bài viết", "create post",
  ]);
  if (trigger) {
    try { trigger.click(); } catch (e) {}
    await sleep(2600);
  }

  // 2) Tìm ô soạn (ưu tiên trong dialog).
  let box =
    document.querySelector('div[role="dialog"] div[role="textbox"][contenteditable="true"]') ||
    document.querySelector('div[role="textbox"][contenteditable="true"]');
  if (!box) return { ok: false, error: "Không tìm thấy ô soạn bài." };
  box.focus();
  // FB dùng trình soạn contenteditable (Lexical). Lexical CHẶN beforeinput nên
  // execCommand("insertParagraph"/"insertLineBreak") bị vô hiệu, chỉ insertText
  // lọt qua -> "\n" bị nuốt -> dồn 1 hàng. Cách ĐÁNG TIN CẬY để giữ xuống dòng
  // là giả lập sự kiện PASTE với text/plain: Lexical tự chuyển "\n" thành ngắt
  // dòng thật. Có dự phòng gõ-từng-dòng nếu paste không lọt.
  const pasteInto = (el, str) => {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", str);
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
      return true;
    } catch (e) {
      return false;
    }
  };
  const typeFallback = (raw) => {
    const str = String(raw == null ? "" : raw);
    const lines = str.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        let broke = false;
        try { broke = document.execCommand("insertParagraph"); } catch (e) {}
        if (!broke) {
          try { broke = document.execCommand("insertLineBreak"); } catch (e) {}
        }
        if (!broke) {
          try { document.execCommand("insertText", false, "\n"); } catch (e) {}
        }
      }
      if (lines[i]) {
        try { document.execCommand("insertText", false, lines[i]); } catch (e) {}
      }
    }
  };
  pasteInto(box, text);
  await sleep(500);
  // Nếu paste không vào (ô vẫn rỗng) thì mới dùng dự phòng.
  if (!((box.textContent || "").trim())) {
    try { typeFallback(text); } catch (e) { box.textContent = text; }
  }
  await sleep(1600);

  // 2b) Đính kèm ảnh (nếu có).
  const dialogScope = box.closest('div[role="dialog"]') || document;
  try {
    await attachImages(dialogScope);
  } catch (e) {}

  // 3) Bấm nút Đăng.
  //    LƯU Ý: Tài khoản bật "chế độ chuyên nghiệp" khi đăng lên trang cá nhân
  //    KHÔNG có nút "Đăng" ngay, mà hiện nút "Tiếp" -> màn xem trước -> rồi mới
  //    có nút "Đăng". Vì vậy phải: tìm "Đăng" trước; nếu không thấy thì bấm
  //    "Tiếp"/"Next" để qua màn xem trước rồi tìm lại "Đăng" (lặp tối đa vài bước).
  const dialogOf = () => box.closest('div[role="dialog"]') || document;
  const findBtn = (labels) => {
    const scope = dialogOf();
    const els = [...scope.querySelectorAll('div[role="button"], button')];
    return els.find((b) => {
      // Bỏ qua nút đang ẩn (không hiển thị).
      if (b.offsetParent === null && b.getAttribute("aria-hidden") === "true") return false;
      const t = lower(b);
      return t && labels.some((x) => t === x);
    });
  };
  const clickWhenEnabled = async (btn) => {
    for (let i = 0; i < 8 && btn.getAttribute("aria-disabled") === "true"; i++) {
      await sleep(700);
    }
    try { btn.click(); } catch (e) {}
  };

  let postBtn = findBtn(["đăng", "post"]);
  // Nếu chưa có nút Đăng, đi qua các bước "Tiếp"/"Next" (tối đa 3 lần) tới màn xem trước.
  for (let step = 0; step < 3 && !postBtn; step++) {
    const nextBtn = findBtn(["tiếp", "next", "tiếp tục", "continue"]);
    if (!nextBtn) break;
    await clickWhenEnabled(nextBtn);
    await sleep(2200);
    postBtn = findBtn(["đăng", "post"]);
  }
  if (!postBtn) return { ok: false, error: "Không tìm thấy nút Đăng." };
  await clickWhenEnabled(postBtn);
  await sleep(3200);

  // 4) Cố gắng bắt permalink của ĐÚNG bài vừa đăng (best-effort).
  //    QUAN TRỌNG: dùng ĐÚNG cách đã chứng minh trong content.js. Trong NHÓM,
  //    BÀI VIẾT là Ô CON của [role="feed"] (DIV), KHÔNG phải [role="article"]
  //    (đó là BÌNH LUẬN). Phải duyệt feed-child + lọc link bình luận, nếu không
  //    sẽ không bao giờ bắt được link bài => modal xoá-trên-FB không hiện.
  const findPostUrl = () => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const needle = norm(text).slice(0, 60);
    // Facebook hiện đại dùng token "pfbid..." (chữ + số) cho permalink bài viết,
    // không còn là số thuần. Mỗi pattern phải chấp nhận CẢ pfbid… LẪN id số cũ.
    const PID = "(pfbid[A-Za-z0-9]+|\\d+)";
    const PATTERNS = [
      new RegExp("/groups/[^/]+/posts/" + PID),
      new RegExp("/groups/[^/]+/permalink/" + PID),
      new RegExp("multi_permalinks?=" + PID),
      new RegExp("[?&]story_fbid=" + PID),
      new RegExp("/permalink/" + PID),
      new RegExp("/posts/" + PID),
    ];
    const hasId = (href) => PATTERNS.some((re) => re.test(href || ""));
    const permaOf = (root) => {
      const anchors = root.querySelectorAll(
        'a[href*="/groups/"], a[href*="story_fbid"], a[href*="permalink"], a[href*="/posts/"]'
      );
      for (const a of anchors) {
        const href = a.href || a.getAttribute("href") || "";
        if (/comment_id=|reply_comment_id=/i.test(href)) continue; // bỏ link bình luận
        if (!hasId(href)) continue;
        try {
          const u = new URL(href, location.origin);
          return u.origin + u.pathname;
        } catch (e) {
          return href;
        }
      }
      return "";
    };
    // Tập ứng viên: ưu tiên ô con của [role="feed"]; fallback article top-level
    // (layout cũ / trang chi tiết bài).
    let candidates = [];
    const feed = document.querySelector('[role="feed"]');
    if (feed) candidates = [...feed.children];
    if (!candidates.length) {
      candidates = [...document.querySelectorAll('[role="article"]')].filter(
        (a) => !(a.parentElement && a.parentElement.closest('[role="article"]'))
      );
    }
    for (const c of candidates) {
      const body = norm(c.textContent);
      if (needle && needle.length > 8 && !body.includes(needle)) continue;
      const url = permaOf(c);
      if (url) return url;
    }
    return "";
  };
  let postUrl = "";
  for (let i = 0; i < 5 && !postUrl; i++) {
    postUrl = findPostUrl();
    if (!postUrl) await sleep(1500);
  }
  return { ok: true, postUrl };
}

/* --------------------- AUTOMATION: BÌNH LUẬN ---------------------------- */

/** Hàm tự-chứa: tìm ô bình luận của bài, nhập nội dung rồi gửi (Enter). */
async function runCommentInPage(text, images) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Chuyển dataURL -> File để gắn vào input ảnh của ô bình luận.
  const dataUrlToFile = (dataUrl, idx) => {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/.exec(dataUrl || "");
    if (!m) return null;
    const mime = m[1] || "image/png";
    const isB64 = !!m[2];
    const raw = isB64 ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const ext = (mime.split("/")[1] || "png").split("+")[0];
    return new File([bytes], "image_" + (idx + 1) + "." + ext, { type: mime });
  };
  let box = document.querySelector('div[role="textbox"][contenteditable="true"]');
  if (!box) {
    window.scrollTo(0, Math.floor(document.body.scrollHeight / 2));
    await sleep(1500);
    box = document.querySelector('div[role="textbox"][contenteditable="true"]');
  }
  if (!box) return { ok: false, error: "Không tìm thấy ô bình luận." };
  box.focus();
  // FB dùng contenteditable (Lexical) -> nó CHẶN beforeinput nên execCommand
  // insertLineBreak/insertParagraph vô hiệu, "\n" bị nuốt -> dồn 1 hàng. Cách
  // đáng tin cậy là giả lập PASTE text/plain (Lexical tự tạo ngắt dòng, KHÔNG
  // gửi bình luận như phím Enter). Dự phòng: gõ-từng-dòng bằng insertLineBreak.
  const pasteInto = (el, str) => {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", str);
      const ev = new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(ev);
      return true;
    } catch (e) {
      return false;
    }
  };
  const typeFallback = (raw) => {
    const str = String(raw == null ? "" : raw);
    const lines = str.split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        // KHÔNG dùng phím Enter vì với bình luận Enter = GỬI.
        let broke = false;
        try { broke = document.execCommand("insertLineBreak"); } catch (e) {}
        if (!broke) {
          try { broke = document.execCommand("insertParagraph"); } catch (e) {}
        }
        if (!broke) {
          try { document.execCommand("insertText", false, "\n"); } catch (e) {}
        }
      }
      if (lines[i]) {
        try { document.execCommand("insertText", false, lines[i]); } catch (e) {}
      }
    }
  };
  pasteInto(box, text);
  await sleep(500);
  if (!((box.textContent || "").trim())) {
    try { typeFallback(text); } catch (e) { box.textContent = text; }
  }
  await sleep(1200);

  // Đính kèm ảnh vào ô bình luận (nếu có): tìm input ảnh gần ô soạn.
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (imgs.length) {
    try {
      const scope = box.closest('form') || box.closest('div[role="article"]') || document;
      let input = scope.querySelector('input[type="file"][accept*="image"]') ||
        document.querySelector('input[type="file"][accept*="image"]');
      if (input) {
        const dt = new DataTransfer();
        imgs.forEach((d, i) => {
          const f = dataUrlToFile(d, i);
          if (f) dt.items.add(f);
        });
        if (dt.files.length) {
          input.files = dt.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(3000);
        }
      }
    } catch (e) {}
  }

  const fire = (type) =>
    box.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })
    );
  fire("keydown");
  fire("keypress");
  fire("keyup");
  await sleep(3000);

  // ---- BẮT PERMALINK BÌNH LUẬN CỦA TA (best-effort) --------------------
  // Sau khi đăng, FB render bình luận của ta dưới bài. Ta tìm bình luận có nội
  // dung KHỚP với text vừa gửi, rồi đọc link chứa comment_id để lấy commentId +
  // permalink. Có commentId thì khâu theo dõi reply mới lọc đúng reply CON của
  // bình luận này (link reply chứa comment_id=<của bình luận cha>).
  const captureMyComment = () => {
    const needle = String(text || "").trim().slice(0, 40).toLowerCase();
    const COMMENT_ID_RE = /[?&]comment_id=(\d+)/;
    // Duyệt các "bình luận" ([role=article] trong nhóm chính là bình luận).
    const arts = [...document.querySelectorAll('div[role="article"]')];
    // Ưu tiên bình luận khớp nội dung; nếu text rỗng (chỉ ảnh) lấy cái mới nhất có comment_id.
    const scan = (matchText) => {
      for (let i = arts.length - 1; i >= 0; i--) {
        const art = arts[i];
        const t = (art.textContent || "").toLowerCase();
        if (matchText && needle && !t.includes(needle)) continue;
        const a = [...art.querySelectorAll('a[href*="comment_id"]')]
          .map((x) => x.href || x.getAttribute("href") || "")
          .find((h) => COMMENT_ID_RE.test(h));
        if (a) {
          const m = a.match(COMMENT_ID_RE);
          let clean = a;
          try {
            const u = new URL(a, location.origin);
            clean = u.origin + u.pathname + "?comment_id=" + m[1];
          } catch (e) {}
          return { commentId: m[1], commentUrl: clean };
        }
      }
      return null;
    };
    return scan(true) || scan(false) || { commentId: null, commentUrl: "" };
  };
  let captured = { commentId: null, commentUrl: "" };
  try { captured = captureMyComment(); } catch (e) {}

  return { ok: true, commentId: captured.commentId, commentUrl: captured.commentUrl };
}

async function executePostJob(job) {
  // Đăng lên trang cá nhân (timeline) hoặc trong nhóm tuỳ targetType.
  const isProfile = job.targetType === "profile";
  const url = isProfile
    ? "https://www.facebook.com/me"
    : "https://www.facebook.com/groups/" + job.groupId + "/";
  if (!isProfile && !job.groupId) {
    return { ok: false, error: "Thiếu nhóm để đăng bài." };
  }
  const images = Array.isArray(job.images) ? job.images : [];
  const tab = await new Promise((r) => chrome.tabs.create({ url, active: true }, r));
  await waitTabComplete(tab.id, 30000);
  await sleep(3000);
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runPostInPage,
      args: [job.content || "", images],
    });
  } catch (e) {
    return { ok: false, error: "Lỗi chạy script đăng bài: " + String(e) };
  } finally {
    // Đóng tab sau khi đăng xong để một mẻ lớn (vd 39 nhóm) không mở 39 tab
    // chồng chất gây nặng máy/treo trình duyệt.
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
  return (res && res[0] && res[0].result) || { ok: false, error: "Không có kết quả." };
}

async function executeCommentJob(job) {
  const url = job.targetUrl;
  if (!url) return { ok: false, error: "Thiếu link bài viết để bình luận." };
  const images = Array.isArray(job.images) ? job.images : [];
  const meta = job.meta || {};
  // CHẠY NGẦM: mở tab ở NỀN (active:false) để KHÔNG chiếm màn hình người dùng;
  // waitTabComplete chỉ nghe tabs.onUpdated nên không cần tab active. Đóng tab
  // sau khi xong để không để lại tab rác.
  const tab = await new Promise((r) => chrome.tabs.create({ url, active: false }, r));
  await waitTabComplete(tab.id, 30000);
  await sleep(3500);
  let res;
  let out = { ok: false, error: "Không có kết quả." };
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runCommentInPage,
      args: [job.content || "", images],
    });
    out = (res && res[0] && res[0].result) || out;

    // ƯU TIÊN API: sau khi đăng, FB bắn mutation tạo bình luận -> fb-api-hook
    // đệm lại, content.js bắt được id SỐ CHÍNH XÁC của bình luận vừa đăng (khớp
    // text + tác giả). Bền hơn nhiều so dò text mờ ở DOM (runCommentInPage chỉ
    // là fallback). Nếu API bắt được thì GHI ĐÈ commentId/commentUrl.
    if (out && out.ok) {
      try {
        const cap = await chrome.tabs.sendMessage(tab.id, {
          type: "CAPTURE_CREATED_COMMENT",
          text: job.content || "",
          authorId: meta.myAuthorId || "",
          authorName: meta.myAuthorName || "",
        });
        if (cap && cap.ok && cap.commentId) {
          out.commentId = cap.commentId;
          out.commentIdSource = "api";
          // Dựng permalink theo comment_id để khâu theo dõi reply mở đúng chỗ.
          if (!out.commentUrl) {
            try {
              const u = new URL(url);
              out.commentUrl = u.origin + u.pathname + "?comment_id=" + cap.commentId;
            } catch (_) {}
          }
        }
      } catch (_) {
        // content.js chưa sẵn sàng / không có gói API -> giữ kết quả DOM.
      }
    }
  } catch (e) {
    return { ok: false, error: "Lỗi chạy script bình luận: " + String(e) };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
  return out;
}

/* ----------- THEO DÕI REPLY DƯỚI BÌNH LUẬN CỦA TA --------------------- */

/**
 * Hàm tự-chứa chạy TRONG TAB bài viết: tìm các REPLY (trả lời) nằm dưới bình
 * luận của ta để khâu theo dõi nền thu thập. Best-effort theo DOM nhóm FB.
 *
 * Cách nhận diện (theo cấu trúc THỰC TẾ đã dùng ở content.js):
 *  - Mỗi bình luận/trả lời là một div[role="article"].
 *  - Link THỜI GIAN của một REPLY chứa CẢ comment_id (của bình luận CHA) và
 *    reply_comment_id (id của chính reply). Vì vậy reply CON của bình luận ta
 *    là article có link khớp comment_id=<myCommentId>.
 *  - Nếu không có myCommentId (không bắt được lúc đăng) -> fallback: định vị
 *    article khớp nội dung bình luận của ta, rồi lấy các article reply lồng kế.
 */
async function runWatchRepliesInPage(myCommentId, myCommentText) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Cuộn NHIỀU LẦN để FB tải lười (lazy-load) toàn bộ khu vực bình luận —
  // tab nền dễ KHÔNG kịp render reply nếu chỉ cuộn 1 lần.
  for (let s = 0; s < 4; s++) {
    try { window.scrollTo(0, Math.floor((document.body.scrollHeight * (s + 1)) / 5)); } catch (e) {}
    await sleep(1200);
  }

  // CHỈ bấm nút MỞ RỘNG (xem thêm bình luận / xem các câu trả lời) để lộ reply
  // ẩn. TUYỆT ĐỐI KHÔNG bấm nút "Trả lời" (soạn phản hồi) của từng bình luận —
  // BUG cũ: khoá "trả lời"/"replies" khớp đúng nút SOẠN nên ta đã bấm Trả lời
  // lên MỌI bình luận. Phân biệt CHẮC CHẮN (không đoán): nút MỞ RỘNG luôn kèm
  // "xem"/"view" hoặc một CON SỐ ("3 câu trả lời", "view 2 replies"); còn nút
  // soạn chỉ là đúng chữ "Trả lời"/"Reply"/"Phản hồi" trơ trọi -> loại hẳn.
  const expandRe = /(xem thêm|xem tất cả|xem các câu trả lời|\d+\s*câu trả lời|view more|view all|view\s+\d+\s*repl|\d+\s*repl)/i;
  const composeOnly = /^(trả lời|reply|phản hồi|bình luận|comment)$/i;
  for (let pass = 0; pass < 2; pass++) {
    const btns = [...document.querySelectorAll('div[role="button"], span[role="button"], a[role="link"]')];
    let clicked = 0;
    for (const b of btns) {
      const t = (b.textContent || "").trim();
      if (!t || t.length > 40) continue;
      if (composeOnly.test(t)) continue;   // KHÔNG bấm nút SOẠN "Trả lời"
      if (!expandRe.test(t)) continue;      // CHỈ bấm nút MỞ RỘNG reply/bình luận
      try { b.click(); clicked++; } catch (e) {}
      if (clicked >= 6) break;
    }
    if (!clicked) break;
    await sleep(1800);
  }

  const REPLY_RE = /[?&]reply_comment_id=(\d+)/;
  const COMMENT_RE = /[?&]comment_id=(\d+)/;
  // Chuẩn hoá để khớp text BỀN: bỏ dấu tiếng Việt + gộp khoảng trắng + thường
  // hoá. Lý do bỏ dấu: cùng một chữ tiếng Việt có thể được mã hoá 2 kiểu khác
  // nhau (NFC tổ hợp sẵn "ề" = U+1EC1, hoặc NFD "e" + dấu rời). Nếu nội dung
  // người dùng dán và DOM của FB khác chuẩn hoá Unicode thì String.includes sẽ
  // TRƯỢT dù nhìn y hệt. Bỏ dấu (NFD + xoá dấu tổ hợp + đ->d) khử hẳn khác biệt
  // này nên việc dò bình luận của ta đáng tin hơn nhiều.
  const deaccent = (s) =>
    String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D");
  const norm = (s) => deaccent(s).replace(/\s+/g, " ").trim().toLowerCase();
  const needle = norm(myCommentText).slice(0, 60);

  // SỰ THẬT VỀ DOM (theo buildCleanSample trong content.js): trong NHÓM NÀY bình
  // luận/trả lời KHÔNG phải [role="article"] lồng nhau, mà là các mục <li> trong
  // <ul> — mỗi mục chứa link `comment_id`. Một REPLY có link chứa CẢ
  // `comment_id=<bình luận cha>` VÀ `reply_comment_id=<chính nó>`. Đây là tín
  // hiệu DUY NHẤT đáng tin để biết reply thuộc bình luận NÀO -> bám chặt vào nó,
  // KHÔNG đoán theo cấu trúc lồng (sẽ vơ nhầm bình luận của người khác).

  // Đơn vị (mục) chứa một REPLY/bình luận: ưu tiên [role="article"] vì SỰ THẬT
  // DOM (xem captureMyComment) là mỗi bình luận/reply là MỘT [role="article"];
  // anchor reply_comment_id thường CHÍNH LÀ link THỜI GIAN ("4 ngày") nằm trong
  // một <li>/<span> TÍ HON -> nếu lấy closest('li') sẽ chỉ vớ được mẩu thời gian
  // (author="4 ngày", text="4 ngày") chứ không phải nội dung reply. Trèo lên
  // [role="article"] gần nhất để lấy ĐÚNG cả tác giả lẫn nội dung của reply đó.
  const unitOf = (el) => {
    if (!el || !el.closest) return el && el.parentElement;
    return el.closest('[role="article"]') || el.closest('li') || el.parentElement || el;
  };
  // Nhận diện text "thời gian tương đối" (4 ngày, 2 giờ, 5 phút, vừa xong,
  // 3d, 2h...) để KHÔNG nhầm là tên tác giả hay nội dung reply.
  const RELTIME_RE = /^(\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm|s|m|h|d|w|y)|vừa xong|just now|yesterday|hôm qua)\b/i;
  const authorOf = (unit) => {
    // Tên tác giả: link hồ sơ có text KHÔNG phải thời gian. Duyệt nhiều ứng viên
    // rồi lấy cái đầu tiên hợp lệ (bỏ link thời gian, link rỗng).
    const cands = unit.querySelectorAll(
      'a[href*="/user/"], a[href*="/profile.php"], a[href*="/groups/"][role="link"], strong a, h3 a, span a[role="link"]'
    );
    for (const a of cands) {
      const t = (a.textContent || "").trim();
      if (!t || t.length > 80) continue;
      if (RELTIME_RE.test(t)) continue; // bỏ link thời gian
      return t;
    }
    return "";
  };
  // Text của một reply: div[dir="auto"] dài nhất TRONG mục đó, bỏ qua những
  // đoạn chỉ là thời gian/nhãn ngắn để không trả về "4 ngày".
  const textOf = (unit) => {
    let best = "";
    for (const d of unit.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      const t = (d.textContent || "").trim();
      if (!t || RELTIME_RE.test(t)) continue;
      if (t.length > best.length) best = t;
    }
    if (!best) {
      // Dự phòng: gộp text mục rồi loại các token thời gian ở đầu/cuối.
      const raw = (unit.textContent || "").trim();
      best = RELTIME_RE.test(raw) ? "" : raw;
    }
    // Nới rộng giới hạn bóc text (tới ~200k ký tự) để bình luận/reply RẤT DÀI
    // không bị cắt cụt khi hiển thị luồng hội thoại và khi đưa cho AI soạn nháp.
    return best.slice(0, 200000);
  };

  // 1) Xác định comment_id của BÌNH LUẬN CỦA TA (parentId).
  //    - Nếu đã biết sẵn (qua job) thì dùng luôn.
  //    - Nếu chưa: dò theo nội dung bình luận của ta qua 2 tầng:
  //        a) KHỚP CHẶT: mục chứa anchor comment_id có chứa nguyên cụm needle.
  //        b) KHỚP MỀM (fallback): chấm điểm theo TỪ trùng nhau (token overlap),
  //           chọn mục điểm cao nhất nếu vượt ngưỡng. Lý do: FB hay chèn " · ",
  //           "Đã chỉnh sửa", emoji, hay cắt bớt text -> includes() có thể trượt
  //           dù đúng bình luận. Token overlap bền hơn với mấy nhiễu đó.
  //    Tokens dùng cho khớp mềm: bỏ từ quá ngắn để giảm trùng ngẫu nhiên.
  const tokensOf = (s) => norm(s).split(" ").filter((w) => w.length >= 2);
  const needleTokens = tokensOf(myCommentText).slice(0, 40);
  const needleSet = new Set(needleTokens);
  let parentId = myCommentId ? String(myCommentId) : null;
  // Chẩn đoán: đếm anchor + lưu vài mẫu text để báo khi dò trượt.
  let commentAnchors = 0;
  const sampleTexts = [];
  let bestSoft = { id: null, score: 0 };
  if (!parentId && (needle || needleSet.size)) {
    let bestLen = Infinity;
    for (const a of document.querySelectorAll('a[href*="comment_id"]')) {
      const href = a.href || a.getAttribute("href") || "";
      if (REPLY_RE.test(href)) continue; // bỏ link reply
      const cm = href.match(COMMENT_RE);
      if (!cm) continue;
      const unit = unitOf(a);
      if (!unit) continue;
      commentAnchors += 1;
      const full = norm(unit.textContent);
      if (sampleTexts.length < 5) sampleTexts.push(full.slice(0, 80));
      // a) Khớp chặt theo cụm.
      if (needle && full.includes(needle)) {
        if (full.length < bestLen) { bestLen = full.length; parentId = cm[1]; }
        continue;
      }
      // b) Khớp mềm theo tỉ lệ từ của needle xuất hiện trong mục.
      if (needleSet.size) {
        let hit = 0;
        for (const w of needleSet) if (full.includes(w)) hit++;
        const score = hit / needleSet.size;
        if (score > bestSoft.score) bestSoft = { id: cm[1], score };
      }
    }
    // Chỉ nhận khớp mềm khi chưa có khớp chặt VÀ đủ tin cậy (>=70% từ trùng).
    if (!parentId && bestSoft.id && bestSoft.score >= 0.7) {
      parentId = bestSoft.id;
    }
  }

  // Không xác định được bình luận của ta -> KHÔNG đoán, trả rỗng (kèm dữ liệu
  // chẩn đoán để báo người dùng vì sao trượt: bao nhiêu anchor, điểm mềm cao
  // nhất, vài mẫu text — giúp biết link sai trang hay text dán không khớp).
  if (!parentId) {
    return {
      ok: true,
      replies: [],
      parentId: null,
      noParent: true,
      diag: {
        commentAnchors,
        bestSoftScore: Math.round(bestSoft.score * 100),
        needlePreview: needle.slice(0, 60),
        samples: sampleTexts,
      },
    };
  }

  // Tên tác giả + NỘI DUNG của BÌNH LUẬN GỐC (của ta). Tác giả dùng để gắn cờ
  // `mine` cho từng reply; nội dung dùng để hiển thị "Bình luận của bạn" và làm
  // lượt MỞ ĐẦU của luồng hội thoại. Khi người dùng theo dõi bằng LINK có
  // comment_id (không dán text), `myComment` rỗng -> phải bóc nội dung gốc TỪ
  // trang để luồng có đủ hai phía. Tìm anchor comment_id===parentId mà KHÔNG
  // phải reply, lấy unit -> authorOf + textOf.
  let myAuthor = "";
  let myRootText = "";
  for (const a of document.querySelectorAll('a[href*="comment_id"]')) {
    const href = a.href || a.getAttribute("href") || "";
    if (REPLY_RE.test(href)) continue;
    const cm = href.match(COMMENT_RE);
    if (!cm || cm[1] !== parentId) continue;
    const u = unitOf(a);
    if (!u) continue;
    if (!myAuthor) myAuthor = authorOf(u);
    if (!myRootText) myRootText = textOf(u);
    if (myAuthor && myRootText) break;
  }
  const myAuthorN = norm(myAuthor);

  // 2) Gom REPLY thuộc ĐÚNG bình luận của ta: anchor có reply_comment_id VÀ
  //    comment_id === parentId. Khử trùng theo reply_comment_id.
  // Đếm chẩn đoán để biết VÌ SAO ra 0 reply: tổng anchor reply trên trang, số
  // anchor khớp đúng parentId, các parentId khác mà ta thấy (giúp phát hiện link
  // có comment_id KHÔNG khớp anchor reply trên trang — ví dụ FB đổi id).
  const byReplyId = new Map();
  let replyAnchorsTotal = 0;
  let replyAnchorsMatched = 0;
  const otherParents = new Set();
  for (const a of document.querySelectorAll('a[href*="reply_comment_id"]')) {
    const href = a.href || a.getAttribute("href") || "";
    const cm = href.match(COMMENT_RE);
    const rm = href.match(REPLY_RE);
    if (!cm || !rm) continue;
    replyAnchorsTotal += 1;
    if (cm[1] !== parentId) {
      otherParents.add(cm[1]); // reply của bình luận KHÁC -> ghi nhận để báo
      continue;
    }
    replyAnchorsMatched += 1;
    if (byReplyId.has(rm[1])) continue;
    const unit = unitOf(a);
    if (unit) byReplyId.set(rm[1], unit);
  }

  const out = [];
  for (const [replyId, unit] of byReplyId) {
    const author = authorOf(unit);
    const text = textOf(unit);
    if (!text) continue;
    // Bỏ nếu mục CHÍNH LÀ bình luận GỐC của ta (không phải reply) — tránh tự
    // nhân đôi bình luận gốc vào luồng. KHÔNG bỏ các reply của ta nữa: một hội
    // thoại thật là qua lại (khách hỏi -> ta đáp -> khách hỏi tiếp), nên ta
    // GIỮ cả lượt của ta để hiển thị đúng mạch, chỉ GẮN CỜ ai là người nói.
    const isMyRoot = needle && norm(text).includes(needle) && !myAuthorN;
    if (isMyRoot) continue;
    // `mine`: lượt này là của TA nếu tác giả trùng tác giả bình luận gốc.
    const mine = !!(myAuthorN && norm(author) === myAuthorN);
    out.push({ id: replyId, author, text, mine });
  }

  // Luôn kèm chẩn đoán: kể cả khi parentId đã biết (link có comment_id) mà vẫn
  // ra 0 reply, người dùng cần biết là trang KHÔNG có anchor reply nào khớp —
  // do reply chưa tải, hay comment_id của link không trùng anchor trên trang.
  return {
    ok: true,
    replies: out,
    parentId,
    // Tác giả + nội dung bình luận GỐC của ta. Caller dùng để backfill
    // `myComment` khi người dùng theo dõi bằng LINK (không dán text) -> thẻ
    // hội thoại mới có "Bình luận của bạn" làm lượt mở đầu.
    myAuthor,
    myRootText,
    diag: {
      parentId,
      commentAnchors,
      replyAnchorsTotal,
      replyAnchorsMatched,
      otherParents: [...otherParents].slice(0, 5),
    },
  };
}

/** Mở permalink bình luận của ta ở tab NỀN, quét reply, đóng tab. */
async function executeWatchReplies(conv) {
  const url = conv.myCommentUrl || conv.postUrl;
  if (!url) return { ok: false, error: "Thiếu link để theo dõi reply." };
  const meta = conv.meta || {};
  const tab = await new Promise((r) => chrome.tabs.create({ url, active: false }, r));
  await waitTabComplete(tab.id, 30000);
  await sleep(3500);
  let res;
  try {
    // ƯU TIÊN API: khi mở bài, FB sniff các gói UFI/list-reply -> fb-api-hook
    // đệm lại. content.js gom reply ĐÚNG bình luận cha (parentLegacyId) kèm cờ
    // `mine` theo authorId -> chuẩn hơn dò anchor DOM. Chỉ dùng khi đã biết
    // comment_id của ta (commentId). Nếu API ra reply thì dùng luôn; nếu không
    // có (chưa biết id / gói chưa sniff kịp) thì rơi xuống DOM fallback.
    if (conv.commentId) {
      try {
        const api = await chrome.tabs.sendMessage(tab.id, {
          type: "GET_COMMENT_REPLIES_API",
          parentLegacyId: conv.commentId,
          authorId: meta.myAuthorId || "",
          authorName: meta.myAuthorName || "",
        });
        if (api && api.ok && Array.isArray(api.replies) && api.replies.length) {
          return {
            ok: true,
            replies: api.replies.map((r) => ({
              id: r.id,
              author: r.author,
              text: r.text,
              mine: !!r.mine,
            })),
            parentId: conv.commentId,
            myAuthor: api.parentAuthor || "",
            myRootText: api.parentText || "",
            repliesSource: "api",
          };
        }
      } catch (_) {
        // content.js chưa sẵn sàng / không có gói API -> dùng DOM fallback.
      }
    }

    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runWatchRepliesInPage,
      args: [conv.commentId || null, conv.myComment || ""],
    });
  } catch (e) {
    return { ok: false, error: "Lỗi chạy script theo dõi reply: " + String(e) };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
  return (res && res[0] && res[0].result) || { ok: false, error: "Không có kết quả." };
}

/* --------------------- AUTOMATION: XOÁ BÀI ----------------------------- */

/**
 * Hàm tự-chứa: mở menu "Hành động khác" của bài rồi chọn xoá / chuyển vào
 * thùng rác và xác nhận. Best-effort, phụ thuộc DOM + ngôn ngữ giao diện FB.
 */
async function runDeletePostInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const lower = (e) => (e.textContent || "").trim().toLowerCase();
  const labelOf = (e) =>
    ((e.getAttribute && (e.getAttribute("aria-label") || e.getAttribute("aria-labelledby"))) || "").toLowerCase();

  // 1) Tìm bài chính trên trang permalink (bài đầu tiên).
  const article =
    document.querySelector('div[role="article"]') ||
    document.querySelector('[role="main"] div[role="article"]');
  const scope = article || document;

  // 2) Mở menu "..." (Hành động khác cho bài viết này / Actions for this post).
  const menuKeys = [
    "hành động khác", "actions for this post", "more options", "tùy chọn khác",
  ];
  const menuBtn = [...scope.querySelectorAll('div[role="button"], [aria-haspopup="menu"]')].find((b) => {
    const l = labelOf(b);
    return menuKeys.some((k) => l.includes(k));
  });
  if (!menuBtn) return { ok: false, error: "Không tìm thấy nút menu của bài (…)." };
  try { menuBtn.click(); } catch (e) {}
  await sleep(1800);

  // 3) Trong menu, tìm mục "Chuyển vào thùng rác" / "Xóa" / "Move to trash".
  const delKeys = [
    "chuyển vào thùng rác", "chuyển vào thùng rác", "thùng rác", "xóa bài viết",
    "xóa", "move to trash", "delete post", "delete", "remove",
  ];
  const findMenuItem = () =>
    [...document.querySelectorAll('div[role="menuitem"], [role="menuitem"], div[role="button"]')].find((it) => {
      const t = lower(it);
      return delKeys.some((k) => t === k || t.includes(k));
    });
  let item = findMenuItem();
  for (let i = 0; i < 4 && !item; i++) {
    await sleep(800);
    item = findMenuItem();
  }
  if (!item) return { ok: false, error: "Không tìm thấy mục Xóa trong menu." };
  try { item.click(); } catch (e) {}
  await sleep(1800);

  // 4) Hộp xác nhận: bấm nút "Chuyển" / "Xóa" / "Move" / "Delete".
  const confirmKeys = ["chuyển", "xóa", "move", "delete", "confirm", "ok"];
  const findConfirm = () => {
    const dlg = document.querySelector('div[role="dialog"]') || document;
    return [...dlg.querySelectorAll('div[role="button"], button')].find((b) => {
      const t = lower(b);
      return confirmKeys.some((k) => t === k);
    });
  };
  let confirm = findConfirm();
  for (let i = 0; i < 4 && !confirm; i++) {
    await sleep(700);
    confirm = findConfirm();
  }
  if (confirm) {
    try { confirm.click(); } catch (e) {}
    await sleep(2500);
  }
  return { ok: true };
}

/** Mở lại URL bài đã đăng và thực thi xoá trên Facebook. */
async function executeDeletePost(postUrl) {
  if (!postUrl) return { ok: false, error: "Không có link bài để xoá trên Facebook." };
  let tab;
  try {
    tab = await new Promise((r) => chrome.tabs.create({ url: postUrl, active: true }, r));
    await waitTabComplete(tab.id, 30000);
    await sleep(3500);
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runDeletePostInPage,
      args: [],
    });
    return (res && res[0] && res[0].result) || { ok: false, error: "Không có kết quả khi xoá bài." };
  } catch (e) {
    return { ok: false, error: "Lỗi chạy script xoá bài: " + String(e) };
  }
}

/** Chạy một job (đăng bài / bình luận) và cập nhật trạng thái vào DB. */
/** Đọc authUser hiện tại từ chrome.storage.local (cùng key với background.js). */
async function _getAuthUserId() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("webAuthUser", (r) => {
        void chrome.runtime.lastError;
        const u = r && r["webAuthUser"];
        resolve(u ? u.id || null : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function runJob(job) {
  await DB.updateJob(job.id, { status: "running", attempts: (job.attempts || 0) + 1, error: null });
  broadcast("JOB_UPDATE", { jobId: job.id });
  let result;
  try {
    result = job.type === "comment" ? await executeCommentJob(job) : await executePostJob(job);
  } catch (e) {
    result = { ok: false, error: String(e) };
  }
  if (result && result.ok) {
    await DB.updateJob(job.id, { status: "done", result, error: null });
    // Đăng bài thành công -> lưu lịch sử "nhóm hay đăng" (chỉ khi job có groupId).
    if (job.type !== "comment" && job.groupId) {
      try {
        const userId = await _getAuthUserId();
        if (userId) {
          await DB.recordPostedGroups(userId, [{
            groupId: job.groupId,
            groupName: job.batchName || job.groupId,
          }]);
        }
      } catch (e) {}
    }
    // Bình luận thành công -> tạo HỘI THOẠI để theo dõi reply về sau (chỉ THÊM,
    // không đụng dữ liệu cũ). Bọc try để không làm hỏng luồng job nếu lỗi.
    if (job.type === "comment") {
      try {
        const meta = job.meta || {};
        await DB.createConversation({
          status: "watching",
          jobId: job.id,
          postUrl: job.targetUrl || "",
          postId: meta.postId || "",
          groupId: meta.groupId || "",
          groupName: meta.groupName || "",
          myComment: job.content || "",
          myCommentUrl: result.commentUrl || "",
          commentId: result.commentId || null,
          postText: meta.postText || "",
        });
        broadcast("CONVERSATION_UPDATE", {});
      } catch (e) {}
    }
  } else {
    await DB.updateJob(job.id, { status: "error", error: (result && result.error) || "Thất bại." });
  }
  broadcast("JOB_UPDATE", { jobId: job.id });
  return result;
}

/* -------------------- LẬP LỊCH CHẠY JOB (alarms) ------------------------ */

let _processing = false;

async function processDueJobs() {
  if (_processing) return;
  _processing = true;
  try {
    // Khôi phục job bị KẸT ở "running" (service worker MV3 tắt giữa chừng) để
    // một mẻ lớn không bị đứng sau vài bài. Đưa job kẹt về "pending" rồi chạy.
    try { await DB.recoverStuckJobs(Date.now()); } catch (e) {}
    const due = await DB.getDueJobs(Date.now());
    for (const job of due) {
      await runJob(job);
      await sleep(5000); // giãn cách giữa các job để giảm rủi ro bị FB chặn
    }
  } catch (e) {
    // bỏ qua, chờ tick sau
  } finally {
    _processing = false;
  }
}

function scheduleTickSoon() {
  setTimeout(() => processDueJobs(), 1500);
}

/* -------------------- TỰ ĐỘNG CRAWL NỀN (alarms) ----------------------- */

/* ------------------- NGẮT MẠCH KHI BỊ FB CHẶN (circuit-breaker) --------- */
// Khi FB trả dấu hiệu chặn/checkpoint (429/401/403/5xx hoặc text checkpoint),
// đó thường là giới hạn TOÀN TÀI KHOẢN — crawl tiếp nhóm khác ngay sau đó gần
// như chắc chắn bị chặn lại, chỉ làm tăng rủi ro khoá. Vì vậy ta ghi một mốc
// "tạm ngưng tới" (blockedUntil) vào chrome.storage.local; auto-crawl kiểm tra
// mốc này TRƯỚC mỗi nhóm và bỏ qua toàn bộ chu kỳ khi còn trong thời gian nghỉ.
// Backoff luỹ thừa theo số lần bị chặn liên tiếp để càng bị chặn càng nghỉ lâu.
const CRAWL_BLOCK_KEY = "crawlBlockState";
const CRAWL_BLOCK_BASE_MS = 30 * 60 * 1000; // nghỉ tối thiểu 30 phút
const CRAWL_BLOCK_MAX_MS = 8 * 60 * 60 * 1000; // trần 8 giờ
// Nếu lần chặn mới cách lần trước quá xa (2x thời gian nghỉ tối đa) thì coi như
// đợt chặn cũ đã qua và đếm lại từ đầu, tránh cộng dồn backoff vô hạn.
const CRAWL_BLOCK_RESET_MS = 2 * CRAWL_BLOCK_MAX_MS;

/** Đọc trạng thái ngắt mạch hiện tại từ chrome.storage.local. */
function getCrawlBlockState() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(CRAWL_BLOCK_KEY, (r) => {
        void chrome.runtime.lastError;
        const s = (r && r[CRAWL_BLOCK_KEY]) || {};
        const blockedUntil = Number(s.blockedUntil) || 0;
        resolve({
          blocked: blockedUntil > Date.now(),
          blockedUntil,
          reason: s.reason || "",
          consecutive: Number(s.consecutive) || 0,
          since: Number(s.since) || 0,
        });
      });
    } catch (e) {
      resolve({ blocked: false, blockedUntil: 0, reason: "", consecutive: 0, since: 0 });
    }
  });
}

function _saveCrawlBlockState(state) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [CRAWL_BLOCK_KEY]: state }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

/**
 * Ghi nhận một lần bị FB chặn: tăng bộ đếm liên tiếp, tính thời gian nghỉ theo
 * backoff luỹ thừa (30' → 1h → 2h → … trần 8h) và lưu mốc blockedUntil.
 */
async function setCrawlBlock(reason) {
  const now = Date.now();
  const prev = await getCrawlBlockState();
  // Đợt chặn cũ đã qua lâu -> đếm lại từ đầu.
  const recent = prev.since && now - prev.since < CRAWL_BLOCK_RESET_MS;
  const consecutive = (recent ? prev.consecutive : 0) + 1;
  const cooldown = Math.min(
    CRAWL_BLOCK_MAX_MS,
    CRAWL_BLOCK_BASE_MS * Math.pow(2, consecutive - 1)
  );
  const state = {
    blockedUntil: now + cooldown,
    reason: String(reason || "FB chặn crawl."),
    consecutive,
    since: now,
  };
  await _saveCrawlBlockState(state);
  try {
    broadcast("CRAWL_BLOCK", { state });
  } catch (e) {}
  return state;
}

/** Xoá trạng thái ngắt mạch (khi một lượt crawl hoàn tất mà KHÔNG bị chặn). */
async function clearCrawlBlock() {
  const prev = await getCrawlBlockState();
  if (!prev.blockedUntil && !prev.consecutive) return;
  await _saveCrawlBlockState({ blockedUntil: 0, reason: "", consecutive: 0, since: 0 });
}

// Các cụm dấu hiệu chặn dùng chung giữa crawl.js (tabless) và content.js (in-tab)
// khi soi chuỗi `reason` trả về qua CRAWL_DONE để kích hoạt ngắt mạch.
const BLOCK_REASON_MARKERS = [
  "http 429",
  "http 401",
  "http 403",
  "checkpoint",
  "để bảo vệ tài khoản",
  "khoá tài khoản",
  "hết hạn hoặc bị chặn",
  "lỗi máy chủ (http 5",
];

/** true nếu chuỗi `reason` là dấu hiệu FB chặn (khớp một marker bất kỳ). */
function isBlockReason(reason) {
  const s = String(reason || "").toLowerCase();
  return BLOCK_REASON_MARKERS.some((m) => s.includes(m));
}

/**
 * Nhận `reason` từ CRAWL_DONE (kể cả nhánh in-tab qua content.js) -> nếu là dấu
 * hiệu chặn thì kích hoạt ngắt mạch. Dùng để đóng khoảng trống nhánh in-tab
 * (nơi block chỉ lộ ra ở message CRAWL_DONE, không có trong giá trị trả về).
 */
async function noteCrawlDoneReason(reason) {
  if (isBlockReason(reason)) {
    await setCrawlBlock(reason);
    return true;
  }
  return false;
}

const AUTOCRAWL_KEY = "autoCrawlConfig";
const AUTOCRAWL_ALARM = "autoCrawl";
const AUTOCRAWL_DEFAULT = {
  enabled: false,
  intervalMinutes: 30,
  // Tùy chọn truyền vào content.js khi crawl từng nhóm (giống dashboard).
  options: {},
};

/** Đọc cấu hình auto-crawl từ chrome.storage.local, trộn với mặc định. */
function getAutoCrawlConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(AUTOCRAWL_KEY, (r) => {
        const saved = (r && r[AUTOCRAWL_KEY]) || {};
        resolve({
          enabled: !!saved.enabled,
          intervalMinutes:
            Math.max(1, Math.min(1440, parseInt(saved.intervalMinutes, 10) || AUTOCRAWL_DEFAULT.intervalMinutes)),
          options: saved.options && typeof saved.options === "object" ? saved.options : {},
        });
      });
    } catch (e) {
      resolve({ ...AUTOCRAWL_DEFAULT });
    }
  });
}

/** Lưu cấu hình + (tái)tạo hoặc xóa alarm theo trạng thái bật/tắt. */
async function applyAutoCrawlConfig(input) {
  const current = await getAutoCrawlConfig();
  const next = {
    enabled: input.enabled != null ? !!input.enabled : current.enabled,
    intervalMinutes:
      input.intervalMinutes != null
        ? Math.max(1, Math.min(1440, parseInt(input.intervalMinutes, 10) || current.intervalMinutes))
        : current.intervalMinutes,
    options:
      input.options && typeof input.options === "object" ? input.options : current.options,
  };
  await new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [AUTOCRAWL_KEY]: next }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
  try {
    await chrome.alarms.clear(AUTOCRAWL_ALARM);
    if (next.enabled) {
      chrome.alarms.create(AUTOCRAWL_ALARM, { periodInMinutes: next.intervalMinutes });
    }
  } catch (e) {}
  return next;
}

let _autoCrawling = false;

// Số nguyên ngẫu nhiên trong [min, max].
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

/** Trộn mảng tại chỗ (Fisher–Yates) để mỗi chu kỳ crawl theo thứ tự khác nhau. */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Crawl TẤT CẢ nhóm đã lưu trong tab nền theo chu kỳ.
 * LUÔN chạy tuần tự 1 nhóm/lần (xem giải thích ÉP 1 LUỒNG bên dưới) — không có
 * tuỳ chọn số luồng song song.
 */
async function processAutoCrawl() {
  if (_autoCrawling) return;
  const cfg = await getAutoCrawlConfig();
  if (!cfg.enabled) return;
  _autoCrawling = true;
  try {
    // (5) NGẮT MẠCH: nếu đang trong thời gian nghỉ do bị FB chặn ở chu kỳ trước
    // thì bỏ qua CẢ chu kỳ này. Checkpoint/429 thường là giới hạn toàn tài khoản
    // nên cố crawl tiếp chỉ làm tăng rủi ro khoá.
    const blk0 = await getCrawlBlockState();
    if (blk0.blocked) {
      const mins = Math.ceil((blk0.blockedUntil - Date.now()) / 60000);
      broadcast("CRAWL_DONE", {
        result: {
          newCount: 0,
          reason: `Auto-crawl tạm ngưng ~${mins} phút do FB chặn: ${blk0.reason}`,
        },
      });
      return;
    }
    const groups = await DB.getGroups();
    // (4) Ngẫu nhiên thứ tự nhóm mỗi chu kỳ -> tránh mẫu "máy" crawl đúng một thứ tự.
    const order = shuffleInPlace((groups || []).slice()).filter(
      (g) => g && (g.groupId || g.id)
    );
    const opts = cfg.options || {};
    const isApi = opts.method === "api";
    // QUAN TRỌNG về số luồng — CẢ DOM lẫn API đều phải crawl TUẦN TỰ 1 nhóm/lần:
    // - DOM scroll: Facebook ảo hoá feed, chỉ mount bài khi tab đang hiển thị.
    // - API (sniff+replay GraphQL): pha CAPTURE template CẦN tab foreground để FB
    //   bắn GroupsCometFeedRegularStoriesPaginationQuery. Focus là tài nguyên
    //   SINGLETON => nhiều tab foreground song song sẽ cướp focus của nhau, chỉ
    //   nhóm được focus cuối cùng bắt được template. Đã XÁC MINH: 1 nhóm chạy tốt,
    //   2+ nhóm cùng lúc chỉ ăn 1 nhóm. Vì vậy ÉP 1 LUỒNG cho cả API.
    const threads = 1;
    const crawlFn = isApi ? crawlGroupApiSmart : crawlGroupInTab;

    let cursor = 0; // chỉ số nhóm kế tiếp cần xử lý (dùng chung giữa các worker)

    // Mỗi worker lần lượt nhận nhóm kế tiếp cho tới khi hết hàng đợi.
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= order.length) break;
        const g = order[idx];
        const gid = g && (g.groupId || g.id);
        if (!gid) continue;
        // Nhánh in-tab (API cần capture template) resolve gần NGAY khi mở tab —
        // block thật (nếu có) chỉ lộ ra SAU, qua message CRAWL_DONE mà
        // background.js relay vào setCrawlBlock(). Vì vậy kiểm tra lại trạng
        // thái ngắt mạch SAU MỖI nhóm (không chỉ dựa vào giá trị trả về của
        // crawlFn) để dừng cả chu kỳ ngay khi phát hiện block, kể cả khi nó tới
        // từ nhóm trước đó qua đường bất đồng bộ.
        const blk = await getCrawlBlockState();
        if (blk.blocked) break;
        try {
          await crawlFn(gid, opts);
        } catch (e) {
          // bỏ qua nhóm lỗi, tiếp tục nhóm sau
        }
        // (1) Jitter giữa các nhóm trong cùng worker: 20–90s để không đều như máy.
        if (cursor < order.length) {
          await sleep(randInt(20000, 90000));
        }
      }
    };

    // Khởi động các worker so le nhau vài giây để không mở N tab cùng một lúc.
    const runners = [];
    for (let i = 0; i < threads; i++) {
      if (i > 0) await sleep(randInt(1500, 4000));
      runners.push(worker());
    }
    await Promise.all(runners);
  } catch (e) {
    // bỏ qua, chờ chu kỳ sau
  } finally {
    _autoCrawling = false;
  }
}

/** Khôi phục alarm auto-crawl khi service worker khởi động lại. */
async function initAutoCrawl() {
  const cfg = await getAutoCrawlConfig();
  try {
    const existing = await chrome.alarms.get(AUTOCRAWL_ALARM);
    if (cfg.enabled && !existing) {
      chrome.alarms.create(AUTOCRAWL_ALARM, { periodInMinutes: cfg.intervalMinutes });
    } else if (!cfg.enabled && existing) {
      await chrome.alarms.clear(AUTOCRAWL_ALARM);
    }
  } catch (e) {}
}

/* -------------------- TỰ ĐỘNG ĐỒNG BỘ GIÁ (alarms) --------------------- */

const AUTOSYNC_KEY = "autoSyncConfig";
const AUTOSYNC_ALARM = "autoSync";
// Chỉ cho phép vài mốc chu kỳ rõ ràng (giờ) để tránh đập API bán lẻ quá dày.
const AUTOSYNC_INTERVALS = [6, 12, 24];
const AUTOSYNC_DEFAULT = { enabled: false, intervalHours: 12 };

// Ép chu kỳ về 1 trong các mốc hợp lệ; mặc định 12h nếu giá trị lạ.
function normalizeSyncHours(v) {
  const h = parseInt(v, 10);
  return AUTOSYNC_INTERVALS.includes(h) ? h : AUTOSYNC_DEFAULT.intervalHours;
}

/** Đọc cấu hình auto-sync từ chrome.storage.local, trộn với mặc định. */
function getAutoSyncConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(AUTOSYNC_KEY, (r) => {
        void chrome.runtime.lastError;
        const saved = (r && r[AUTOSYNC_KEY]) || {};
        resolve({
          enabled: !!saved.enabled,
          intervalHours: normalizeSyncHours(saved.intervalHours),
        });
      });
    } catch (e) {
      resolve({ ...AUTOSYNC_DEFAULT });
    }
  });
}

/** Lưu cấu hình + (tái)tạo hoặc xóa alarm theo trạng thái bật/tắt. */
async function applyAutoSyncConfig(input) {
  const current = await getAutoSyncConfig();
  const next = {
    enabled: input.enabled != null ? !!input.enabled : current.enabled,
    intervalHours:
      input.intervalHours != null
        ? normalizeSyncHours(input.intervalHours)
        : current.intervalHours,
  };
  await new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [AUTOSYNC_KEY]: next }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
  try {
    await chrome.alarms.clear(AUTOSYNC_ALARM);
    if (next.enabled) {
      chrome.alarms.create(AUTOSYNC_ALARM, {
        periodInMinutes: next.intervalHours * 60,
      });
    }
  } catch (e) {}
  return next;
}

let _autoSyncing = false;

/** Gọi đồng bộ TẤT CẢ nguồn giá khi tới chu kỳ (chống chạy chồng). */
async function processAutoSync() {
  if (_autoSyncing) return;
  const cfg = await getAutoSyncConfig();
  if (!cfg.enabled) return;
  _autoSyncing = true;
  try {
    await syncAllSources();
  } catch (e) {
    // bỏ qua, chờ chu kỳ sau
  } finally {
    _autoSyncing = false;
  }
}

/** Khôi phục alarm auto-sync khi service worker khởi động lại. */
async function initAutoSync() {
  const cfg = await getAutoSyncConfig();
  try {
    const existing = await chrome.alarms.get(AUTOSYNC_ALARM);
    if (cfg.enabled && !existing) {
      chrome.alarms.create(AUTOSYNC_ALARM, {
        periodInMinutes: cfg.intervalHours * 60,
      });
    } else if (!cfg.enabled && existing) {
      await chrome.alarms.clear(AUTOSYNC_ALARM);
    }
  } catch (e) {}
}

/* -------------------- THEO DÕI REPLY NỀN (alarms) ---------------------- */

const WATCH_KEY = "watchRepliesConfig";
const WATCH_ALARM = "watchReplies";
// Mặc định TẮT; chu kỳ tính bằng phút (kẹp 5..720 = 12 giờ). Mỗi chu kỳ quét
// các hội thoại đang "watching"/"replied" để gom reply mới của người khác.
const WATCH_DEFAULT = { enabled: false, intervalMinutes: 30, maxPerRun: 8 };

/** Đọc cấu hình theo-dõi-reply từ chrome.storage.local, trộn với mặc định. */
function getWatchConfig() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(WATCH_KEY, (r) => {
        void chrome.runtime.lastError;
        const saved = (r && r[WATCH_KEY]) || {};
        resolve({
          enabled: !!saved.enabled,
          intervalMinutes: Math.max(
            5,
            Math.min(720, parseInt(saved.intervalMinutes, 10) || WATCH_DEFAULT.intervalMinutes)
          ),
          maxPerRun: Math.max(1, Math.min(30, parseInt(saved.maxPerRun, 10) || WATCH_DEFAULT.maxPerRun)),
        });
      });
    } catch (e) {
      resolve({ ...WATCH_DEFAULT });
    }
  });
}

/** Lưu cấu hình + (tái)tạo hoặc xóa alarm theo trạng thái bật/tắt. */
async function applyWatchConfig(input) {
  const current = await getWatchConfig();
  const next = {
    enabled: input.enabled != null ? !!input.enabled : current.enabled,
    intervalMinutes:
      input.intervalMinutes != null
        ? Math.max(5, Math.min(720, parseInt(input.intervalMinutes, 10) || current.intervalMinutes))
        : current.intervalMinutes,
    maxPerRun:
      input.maxPerRun != null
        ? Math.max(1, Math.min(30, parseInt(input.maxPerRun, 10) || current.maxPerRun))
        : current.maxPerRun,
  };
  await new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [WATCH_KEY]: next }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
  try {
    await chrome.alarms.clear(WATCH_ALARM);
    if (next.enabled) {
      chrome.alarms.create(WATCH_ALARM, { periodInMinutes: next.intervalMinutes });
    }
  } catch (e) {}
  return next;
}

let _watching = false;

/**
 * Quét các hội thoại CHƯA đóng -> mở permalink bình luận của ta ở tab nền ->
 * gom reply mới -> MERGE (không ghi đè). Giãn cách giữa các hội thoại để giảm
 * rủi ro bị FB chặn. Chống chạy chồng bằng cờ _watching.
 */
async function processReplyWatch(opts = {}) {
  if (_watching) return { ok: false, error: "Đang theo dõi, bỏ qua lượt này." };
  const cfg = await getWatchConfig();
  // Khi gọi thủ công (manual=true) thì chạy kể cả khi alarm tắt.
  if (!cfg.enabled && !opts.manual) return { ok: false, error: "Theo dõi reply đang tắt." };
  _watching = true;
  let checked = 0, newReplies = 0, noParent = 0;
  // Lưu chẩn đoán của hội thoại GẦN NHẤT để báo người dùng vì sao ra ít/không
  // có reply: số anchor bình luận, số anchor reply tổng/khớp, các parentId khác
  // thấy trên trang, điểm khớp mềm, vài mẫu text. Giúp phân biệt "trang chưa
  // tải reply" với "comment_id của link không trùng anchor trên trang".
  let lastDiag = null;
  try {
    let convs = await DB.getConversations();
    // Chỉ theo dõi hội thoại chưa đóng và có link để mở.
    convs = (convs || []).filter(
      (c) => c && c.status !== "closed" && (c.myCommentUrl || c.postUrl)
    );
    const limit = Math.max(1, Math.min(30, parseInt(opts.maxPerRun, 10) || cfg.maxPerRun));
    convs = convs.slice(0, limit);
    for (let i = 0; i < convs.length; i++) {
      const c = convs[i];
      const res = await executeWatchReplies(c);
      checked += 1;
      // Không định vị được bình luận của ta trên trang -> đếm để báo rõ.
      if (res && res.ok && res.noParent) {
        noParent += 1;
      }
      // Lần đầu suy ra được comment_id của ta (comment thủ công) -> lưu lại để
      // các lượt quét sau chính xác và nhanh hơn.
      if (res && res.ok && res.parentId && !c.commentId) {
        try { await DB.updateConversation(c.id, { commentId: res.parentId }); } catch (e) {}
      }
      // Theo dõi bằng LINK có comment_id (không dán text) -> `myComment` rỗng.
      // Bóc nội dung bình luận GỐC từ trang để "Bình luận của bạn" và lượt MỞ
      // ĐẦU của luồng hội thoại có đủ, thay vì chỉ thấy mỗi reply của khách.
      if (res && res.ok && res.myRootText && !(c.myComment || "").trim()) {
        try {
          await DB.updateConversation(c.id, { myComment: res.myRootText });
          c.myComment = res.myRootText;
          broadcast("CONVERSATION_UPDATE", { id: c.id });
        } catch (e) {}
      }
      let added = 0;
      if (res && res.ok && Array.isArray(res.replies) && res.replies.length) {
        const m = await DB.mergeReplies(c.id, res.replies);
        if (m && m.added) {
          added = m.added;
          newReplies += m.added;
          broadcast("CONVERSATION_UPDATE", { id: c.id, added: m.added });
        }
      }
      // Giữ chẩn đoán khi KHÔNG có reply mới (kể cả lúc đã biết comment_id):
      // người dùng cần biết trang thấy bao nhiêu anchor reply, khớp mấy cái, có
      // parentId nào khác — để biết link sai trang hay reply chưa kịp tải.
      if (res && res.ok && res.diag && !added) lastDiag = res.diag;
      // Giãn cách 15–45s GIỮA các hội thoại (như jitter auto-crawl) — KHÔNG chờ
      // sau hội thoại CUỐI để lượt quét thủ công 1 mục trả kết quả ngay.
      if (i < convs.length - 1) await sleep(randInt(15000, 45000));
    }
  } catch (e) {
    // bỏ qua, chờ chu kỳ sau
  } finally {
    _watching = false;
  }
  return { ok: true, checked, newReplies, noParent, diag: lastDiag };
}

/** Khôi phục alarm theo-dõi-reply khi service worker khởi động lại. */
async function initReplyWatch() {
  const cfg = await getWatchConfig();
  try {
    const existing = await chrome.alarms.get(WATCH_ALARM);
    if (cfg.enabled && !existing) {
      chrome.alarms.create(WATCH_ALARM, { periodInMinutes: cfg.intervalMinutes });
    } else if (!cfg.enabled && existing) {
      await chrome.alarms.clear(WATCH_ALARM);
    }
  } catch (e) {}
}

export {
  CRAWL_TABS_KEY,
  withNewestSort,
  getCrawlTabs,
  addCrawlTab,
  removeCrawlTab,
  getCrawlBlockState,
  setCrawlBlock,
  clearCrawlBlock,
  isBlockReason,
  noteCrawlDoneReason,
  startCrawlInActiveTab,
  stopCrawlInActiveTab,
  crawlGroupInTab,
  crawlGroupApiInTab,
  crawlGroupApiTabless,
  crawlGroupApiSmart,
  scanJoinedGroups,
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
};
