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
import { API_BASE_URL } from "./config.js";

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

/* ---------------------- CÔNG TẮC FOCUS TAB ----------------------------- */
// Người dùng phàn nàn "tab cứ nhảy" khi chạy nhiệm vụ: chỗ mở nền, chỗ lại
// focus khiến trình duyệt nhảy sang tab mới, không ở nguyên tab tool. Thêm 1
// công tắc bật/tắt (focusTabs) lưu ở chrome.storage.local — đây là preference
// theo THIẾT BỊ (cửa sổ trình duyệt cục bộ mà setting này điều khiển), đọc được
// từ service worker, KHÔNG dùng DB.setSetting (route /api/settings server chưa
// có nên sẽ nuốt lỗi & luôn rơi về mặc định — không đáng tin để lưu pref này).
//
// MẶC ĐỊNH = false  => MỌI tab nhiệm vụ mở ở NỀN (active:false), không chiếm
//                      focus, người dùng ở nguyên tab tool.
// Bật (true)        => tab nhiệm vụ mở & focus như trước.
//
// LƯU Ý QUAN TRỌNG: openHiddenCrawlTab (crawl API GQL) BẮT BUỘC foreground vì
// Chrome throttle rAF/IntersectionObserver ở tab nền => KHÔNG áp công tắc cho
// path đó (nó tự quản active:true + focusWindow riêng).
const FOCUS_TABS_KEY = "focusTabs";

async function shouldFocusTabs() {
  try {
    const r = await chrome.storage.local.get(FOCUS_TABS_KEY);
    return r[FOCUS_TABS_KEY] === true;
  } catch (e) {
    return false;
  }
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
  // Mở tab theo công tắc focusTabs (mặc định NỀN để không nhảy tab); tiến trình phát qua broadcast.
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url, active }, r));
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
 * THAM SỐ `active`:
 *  - active=true  => tab foreground + cửa sổ được focus. BẮT BUỘC cho lần đầu
 *    BẮT KHUÔN GQL: khi tab KHÔNG foreground, Chrome throttle
 *    requestAnimationFrame / IntersectionObserver-batching — đúng cơ chế
 *    Facebook Comet dùng để lazy-load feed khi cuộn => feed không tải thêm,
 *    KHÔNG có GroupsCometFeedRegularStoriesPaginationQuery để bắt khuôn.
 *  - active=false => tab mở NỀN, KHÔNG chiếm focus, KHÔNG giật tab người dùng.
 *    Chỉ an toàn khi ĐÃ CÓ khuôn: lúc đó content.js replay bằng fetch (KHÔNG bị
 *    throttle ở tab nền) nên crawl vẫn chạy đủ trang.
 *  KHÔNG bao giờ ép `state` cửa sổ (không resize/un-maximize cửa sổ người dùng).
 *
 * Trả về { tab, windowId, kind:"tab" } khi thành công, hoặc { error } khi thất bại.
 */
async function openHiddenCrawlTab(url, active = true) {
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
  // active=true => tab foreground (không bị throttle) — cho lần bắt khuôn.
  // active=false => tab mở NỀN, không chiếm focus của người dùng.
  const tabOpts = { url, active: active === true };
  if (target && target.id) tabOpts.windowId = target.id;

  let lastErr = "";
  for (let round = 0; round < 2; round++) {
    const { tab, err } = await createTab(tabOpts);
    if (err) lastErr = err;
    if (tab) {
      // CHỈ ép cửa sổ lên foreground khi mở tab active. Mở nền => giữ nguyên
      // cửa sổ/tab hiện tại của người dùng.
      if (active === true) await focusWindow(tab.windowId);
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
 *
 * `active` quyết định tab mở foreground hay NỀN:
 *  - active=true  => tab foreground (bắt buộc cho lần bắt khuôn GQL đầu tiên vì
 *    tab nền bị Chrome throttle rAF/IntersectionObserver => feed không lazy-load).
 *  - active=false => tab mở NỀN, KHÔNG chiếm focus của người dùng. An toàn khi
 *    ĐÃ CÓ khuôn: content.js replay bằng fetch (không bị throttle ở tab nền).
 */
async function crawlGroupApiInTab(groupId, options, active = true) {
  if (!groupId) return { ok: false, error: "Thiếu groupId." };
  // Ép feed về "Bài viết mới" (CHRONOLOGICAL) để replay phân trang lấy đúng thứ tự.
  const url = withNewestSort("https://www.facebook.com/groups/" + groupId + "/");
  // Mở 1 tab nhóm trong cửa sổ hiện tại (không popup riêng). content.js replay
  // NGAY TRONG TRANG => request mang cookie/IP/header THẬT do trang FB phát ra
  // (không giả mạo qua declarativeNetRequest) => ít bị nghi ngờ nhất.
  // Vì crawl API chạy TUẦN TỰ nên chỉ 1 tab tại một thời điểm.
  const opened = await openHiddenCrawlTab(url, active);
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
 * BỘ ĐỊNH TUYẾN crawl API — LUÔN dùng TIER-2 (replay-TRONG-TRANG) cho AN TOÀN
 * TỐI ĐA. Chỉ khác nhau ở chỗ tab mở FOREGROUND hay NỀN:
 *
 *  - Công tắc "Focus tab khi chạy nhiệm vụ" BẬT => mở tab foreground (nhảy lên
 *    trước mặt người dùng như cũ).
 *  - Công tắc TẮT (mặc định) + ĐÃ CÓ khuôn GQL => mở tab NỀN (active:false,
 *    KHÔNG chiếm focus). MẤU CHỐT: ở tab nền Chrome ĐÓNG BĂNG
 *    requestAnimationFrame/IntersectionObserver (cơ chế lazy-load của FB) nên
 *    FB KHÔNG tự bắn feed request => KHÔNG thể sniff khuôn kiểu cũ (treo tới khi
 *    bấm vào tab). Cách vá: content.js SEED lại khuôn đã lưu trong storage, chỉ
 *    làm mới fb_dtsg/lsd từ HTML trang (DOM vẫn có sẵn dù lazy-load bị băng),
 *    rồi replay TRANG 1 + các trang sau bằng MAIN-world fetch. fetch KHÔNG bị
 *    Chrome throttle ở tab nền nên crawl chạy đủ. Người dùng chỉ thấy 1 tab mở
 *    ngầm phía sau, không bị giật màn hình.
 *  - Công tắc TẮT nhưng CHƯA CÓ khuôn (lần crawl đầu tiên, storage trống) =>
 *    buộc mở 1 tab FOREGROUND DUY NHẤT 1 lần để FB lazy-load feed mà hook bắt
 *    khuôn (tab nền bị throttle rAF/IntersectionObserver nên KHÔNG lazy-load
 *    được). Sau khi có khuôn, các lần/nhóm sau tự chuyển sang tab nền (seed).
 *
 * TIER-3 = crawlGroupApiTabless (service worker fetch + DNR ghi đè header) CHỈ
 * chạy khi người gọi CHỦ ĐỘNG bật cờ preferTabless. Nhẹ hơn nhưng rủi ro hơn vì
 * header do extension dựng lại, không phải do trang FB phát ra => KHÔNG dùng mặc
 * định nữa.
 *
 * LƯU Ý về crawl hàng loạt (Tools.tsx: advanceQueue): tab nền giữ nguyên
 * dashboard ở foreground nên setTimeout hàng đợi KHÔNG bị throttle => crawl
 * chạy hết mọi nhóm thay vì dừng sau nhóm đầu.
 */
async function crawlGroupApiSmart(groupId, options) {
  if (!groupId) return { ok: false, error: "Thiếu groupId." };
  const opts = options || {};

  // Người gọi CHỦ ĐỘNG chọn tabless (TIER-3) => tôn trọng.
  if (opts.preferTabless === true) {
    return crawlGroupApiTabless(groupId, options);
  }

  let focusOn = false;
  try {
    focusOn = (await shouldFocusTabs()) === true;
  } catch (_) {
    focusOn = false; // đọc setting lỗi => coi như focus TẮT (mặc định)
  }

  // Focus BẬT => tab foreground như cũ.
  if (focusOn) {
    return crawlGroupApiInTab(groupId, options, true);
  }

  // Focus TẮT: nếu ĐÃ CÓ khuôn => mở tab NỀN (không chiếm focus). Chưa có khuôn
  // => buộc mở foreground 1 lần để bắt khuôn (tab nền bị throttle không lazy-load
  // được feed).
  const tpl = await getStoredGqlTemplate();
  const active = !(tpl && tpl.doc_id);
  return crawlGroupApiInTab(groupId, options, active);
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
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url, active }, r));
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
          // QUAN TRỌNG: giữ lại query string (u.search). Với bài đăng trang cá
          // nhân, FB dùng permalink.php?story_fbid=...&id=... — path đơn thuần
          // "/permalink.php" không mang thông tin nhận diện bài gì cả, thông
          // tin đó nằm hết trong query. Nếu chỉ lấy origin+pathname như trước
          // sẽ mất story_fbid/id, hỏng cả link (đây chính là nguyên nhân link
          // "quét phản hồi ngay" bị sai với bài đăng trang cá nhân).
          return u.origin + u.pathname + u.search;
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
            // Giữ nguyên các query param khác mà FB đã gắn sẵn trong href (ví dụ
            // story_fbid, id trên bài đăng trang cá nhân dùng permalink.php) —
            // chỉ ghi đè/thêm comment_id, không bỏ hết query như trước (khiến
            // link hỏng, không xác định được bài với permalink.php dạng query).
            const u = new URL(a, location.origin);
            u.searchParams.set("comment_id", m[1]);
            clean = u.toString();
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

// job.images GIỜ chứa URL "/uploads/..." (không còn base64) để jobs.data không
// phình. Nhưng code bơm ảnh vào trang FB (dataUrlToFile/attachImages) vẫn cần
// data URL. Nên NGAY TRƯỚC executeScript ta tải mỗi URL -> data URL. Phần DOM
// giữ nguyên. Ảnh nào là data URL sẵn (bản cũ / template cũ) thì để nguyên.

// Chuẩn hoá "/uploads/..." -> URL tuyệt đối tới backend để fetch được từ SW.
function toAbsoluteImageUrl(u) {
  const s = String(u == null ? "" : u).trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) return API_BASE_URL + s;
  return s;
}

// Tải MỘT URL ảnh -> data URL (base64). Dùng arrayBuffer + btoa để không phụ
// thuộc FileReader (an toàn trong service worker MV3).
async function imageUrlToDataUrl(url) {
  const abs = toAbsoluteImageUrl(url);
  const res = await fetchWithTimeout(abs, {}, 20000);
  if (!res || !res.ok) throw new Error("HTTP " + (res && res.status));
  const buf = await res.arrayBuffer();
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return "data:" + mime + ";base64," + btoa(binary);
}

// Chuyển mảng job.images (URL hoặc data URL) -> mảng data URL để bơm vào trang.
// Ảnh tải lỗi bị bỏ qua (không chặn cả job); giữ nguyên thứ tự các ảnh còn lại.
async function resolveJobImages(images) {
  const arr = Array.isArray(images) ? images.filter(Boolean) : [];
  const out = [];
  for (const it of arr) {
    const s = String(it == null ? "" : it).trim();
    if (!s) continue;
    if (s.startsWith("data:")) {
      out.push(s);
      continue;
    }
    try {
      out.push(await imageUrlToDataUrl(s));
    } catch (_) {
      // Bỏ qua ảnh tải lỗi để job vẫn chạy với các ảnh còn lại (hoặc chỉ text).
    }
  }
  return out;
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
  const images = await resolveJobImages(job.images);
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url, active }, r));
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
  const images = await resolveJobImages(job.images);
  const meta = job.meta || {};
  // CHẠY NGẦM: mở tab ở NỀN (active:false) để KHÔNG chiếm màn hình người dùng;
  // waitTabComplete chỉ nghe tabs.onUpdated nên không cần tab active. Đóng tab
  // sau khi xong để không để lại tab rác.
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url, active }, r));
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
          // Lưu ĐÚNG tác giả bình luận gốc (chính là ta) để khâu theo dõi reply
          // gắn cờ `mine` theo authorId — chuẩn hơn khớp tên tác giả.
          if (cap.authorId) out.myAuthorId = String(cap.authorId);
          if (cap.authorName) out.myAuthorName = String(cap.authorName);
        }
      } catch (_) {
        // content.js chưa sẵn sàng / không có gói API -> giữ commentId từ DOM (nếu có).
      }
    }
    // LUÔN dựng lại commentUrl từ URL BÀI GỐC (url = job.targetUrl), KHÔNG tin
    // href mà FB tự render trong DOM (captureMyComment trả về). Lý do gốc rễ:
    // với bài đăng TRANG CÁ NHÂN (permalink.php?story_fbid=...&id=...), CHÍNH FB
    // khi render thẻ <a href> cho bình luận CHỈ gắn "permalink.php?comment_id=
    // ..." — tự FB đã bỏ mất story_fbid/id ngay trong href, KHÔNG phải do code
    // ta cắt query. Vì vậy dù ta có cố giữ query khi build từ href đó thì href
    // vốn đã không còn story_fbid/id -> link vẫn hỏng. Chỉ URL GỐC của bài
    // (url, chính là tab đã mở) mới chắc chắn còn đủ story_fbid/id. Do đó lấy
    // URL gốc làm nền rồi GHI ĐÈ/THÊM comment_id lên trên là cách DUY NHẤT đúng
    // cho cả bài nhóm lẫn bài trang cá nhân.
    if (out.commentId) {
      try {
        const u = new URL(url);
        u.searchParams.set("comment_id", String(out.commentId));
        out.commentUrl = u.toString();
      } catch (_) {}
    }
  } catch (e) {
    return { ok: false, error: "Lỗi chạy script bình luận: " + String(e) };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
  return out;
}

/* ----------- GỬI TIN NHẮN CHÀO HÀNG (INBOX MESSENGER) ----------------- */

/**
 * Hàm tự-chứa chạy TRONG TAB Messenger (/messages/t/<id>): tìm ô soạn tin,
 * dán nội dung rồi bấm Enter để GỬI. Khác ô bình luận ở chỗ với Messenger phím
 * Enter = GỬI (đúng ý muốn), còn Shift+Enter mới xuống dòng. Vì vậy khi cần
 * xuống dòng trong nội dung ta dùng execCommand insertLineBreak (không Enter).
 * Trả về { ok, error? } — best-effort theo DOM Messenger hiện hành.
 */
async function runMessageInPage(text, images) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const body = String(text == null ? "" : text).trim();
  const imgs = Array.isArray(images) ? images.filter(Boolean) : [];
  if (!body && !imgs.length) return { ok: false, error: "Nội dung tin nhắn rỗng." };

  // Ô soạn tin của Messenger là contenteditable role=textbox. Chờ và cuộn nhẹ
  // để giao diện kịp render (tab nền có thể tải chậm).
  const findBox = () =>
    document.querySelector('div[role="textbox"][contenteditable="true"]') ||
    document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
  let box = findBox();
  for (let i = 0; i < 6 && !box; i++) {
    await sleep(1500);
    box = findBox();
  }
  if (!box) return { ok: false, error: "Không tìm thấy ô soạn tin (có thể chưa đăng nhập Messenger hoặc không mở được hội thoại)." };

  box.focus();
  await sleep(400);

  // Chuyển dataURL -> File để gắn vào input[type=file] của Messenger.
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
  // Gắn ảnh vào ô soạn tin Messenger: tìm input[type=file], nếu chưa có thì thử
  // bấm nút "Đính kèm tệp"/"Attach a file" để Messenger render input, rồi set
  // files + dispatch change. Chờ ảnh upload xong (hiện preview) trước khi gửi.
  const attachImages = async () => {
    if (!imgs.length) return;
    const lower = (e) => (e.getAttribute("aria-label") || e.textContent || "").trim().toLowerCase();
    let input = document.querySelector('input[type="file"][accept*="image"]') ||
      document.querySelector('input[type="file"]');
    if (!input) {
      const attachBtn = [...document.querySelectorAll('div[role="button"], span[role="button"]')].find((e) => {
        const t = lower(e);
        return t.includes("đính kèm tệp") || t.includes("attach a file") ||
          t.includes("đính kèm") || t.includes("attach") || t.includes("ảnh") || t.includes("photo");
      });
      if (attachBtn) {
        try { attachBtn.click(); } catch (e) {}
        await sleep(1200);
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
    // Ảnh cần thời gian upload/hiện preview trong ô soạn trước khi Enter gửi.
    await sleep(4500);
    box.focus();
  };

  // Dán qua ClipboardEvent (Lexical tôn trọng paste text/plain, không tự gửi).
  const pasteInto = (el, str) => {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", str);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return true;
    } catch (e) {
      return false;
    }
  };
  // Dự phòng: gõ từng dòng bằng insertText + insertLineBreak (KHÔNG Enter vì
  // Enter sẽ GỬI ngay khi mới gõ được 1 dòng).
  const typeFallback = (raw) => {
    const lines = String(raw == null ? "" : raw).split(/\r\n|\r|\n/);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        let broke = false;
        try { broke = document.execCommand("insertLineBreak"); } catch (e) {}
        if (!broke) { try { document.execCommand("insertParagraph"); } catch (e) {} }
      }
      if (lines[i]) { try { document.execCommand("insertText", false, lines[i]); } catch (e) {} }
    }
  };

  if (body) {
    pasteInto(box, body);
    await sleep(500);
    if (!((box.textContent || "").trim())) {
      try { typeFallback(body); } catch (e) { try { box.textContent = body; } catch (_) {} }
    }
    await sleep(1000);
    if (!((box.textContent || "").trim())) {
      return { ok: false, error: "Không nhập được nội dung vào ô soạn tin." };
    }
  }

  // Gắn ảnh (nếu có) SAU khi đã nhập text, TRƯỚC khi Enter gửi.
  await attachImages();

  // GỬI bằng Enter (Messenger: Enter = gửi). Bắn đủ keydown/keypress/keyup.
  const fire = (type) =>
    box.dispatchEvent(
      new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })
    );
  fire("keydown");
  fire("keypress");
  fire("keyup");
  await sleep(2500);

  // Xác nhận đã gửi: ô soạn tin thường bị xoá rỗng sau khi gửi thành công.
  const cleared = !((box.textContent || "").trim());
  return { ok: true, sent: cleared };
}

async function executeMessageJob(job) {
  const url = job.targetUrl;
  if (!url) return { ok: false, error: "Thiếu link hội thoại Messenger để gửi tin." };
  // Mở tab Messenger ở NỀN (active:false) để không chiếm màn hình; Messenger
  // cần thời gian tải lười nên chờ lâu hơn chút so với bình luận.
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url, active }, r));
  await waitTabComplete(tab.id, 30000);
  await sleep(4500);
  // Ảnh job giờ là URL "/uploads/..."; tải về -> data URL để bơm vào trang
  // (runMessageInPage giữ nguyên, vẫn nhận data URL như trước).
  const images = await resolveJobImages(job.images);
  let res;
  let out = { ok: false, error: "Không có kết quả." };
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runMessageInPage,
      args: [job.content || "", images],
    });
    out = (res && res[0] && res[0].result) || out;
  } catch (e) {
    return { ok: false, error: "Lỗi chạy script gửi tin: " + String(e) };
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
  // `authorName` (nếu có): tên tác giả ĐÃ xác định của mục này, dùng để LOẠI
  // phần tử dir="auto" CHÍNH LÀ tên tác giả khỏi việc chọn "text dài nhất".
  // BUG THỰC TẾ: khi nội dung reply RẤT NGẮN (VD "hihi") nhưng tên tác giả DÀI
  // (VD "Trung Trung"), nếu không loại trừ thì div chứa TÊN TÁC GIẢ (dài hơn)
  // bị nhận lầm thành NỘI DUNG reply -> hiển thị sai hoàn toàn (thấy tên tác
  // giả lặp lại làm nội dung, đúng như báo lỗi: reply "hihi" của "Trung Trung"
  // lại hiện text là "Trung Trung").
  const textOf = (unit, authorName) => {
    const authorN = norm(authorName || "");
    let best = "";
    for (const d of unit.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      const t = (d.textContent || "").trim();
      if (!t || RELTIME_RE.test(t)) continue;
      if (authorN && norm(t) === authorN) continue; // bỏ phần tử = tên tác giả
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
    if (!myRootText) myRootText = textOf(u, myAuthor);
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
    const text = textOf(unit, author);
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
  // LUÔN ưu tiên dựng lại link từ postUrl (bài GỐC) + comment_id. Lý do: với bài
  // trang cá nhân dạng permalink.php, danh tính bài nằm HẾT ở query string
  // (story_fbid & id). Facebook lại tự render href bình luận chỉ còn
  // permalink.php?comment_id=X (mất story_fbid/id) nên myCommentUrl đã LƯU của
  // các hội thoại cũ bị hỏng. postUrl vẫn giữ đủ story_fbid/id -> ghép comment_id
  // vào đó mới ra link mở được. Nếu thiếu postUrl/commentId thì mới rơi về
  // myCommentUrl || postUrl như cũ.
  let url = conv.myCommentUrl || conv.postUrl;
  if (conv.postUrl && conv.commentId) {
    try {
      const u = new URL(conv.postUrl);
      u.searchParams.set("comment_id", String(conv.commentId));
      url = u.toString();
    } catch (_) {}
  }
  if (!url) return { ok: false, error: "Thiếu link để theo dõi reply." };
  const meta = conv.meta || {};
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url, active }, r));
  await waitTabComplete(tab.id, 30000);
  // NGẮT MẠCH (đồng bộ với feed/inbox): nếu FB đá tab sang trang
  // checkpoint/đăng nhập thì coi như tài khoản đang bị chặn -> đóng tab và báo
  // blockReason để processReplyWatch arm ngắt mạch chung, không mở thêm tab.
  try {
    const cur = await new Promise((r) =>
      chrome.tabs.get(tab.id, (t) => {
        void chrome.runtime.lastError;
        r(t);
      })
    );
    const landed = String((cur && (cur.url || cur.pendingUrl)) || "").toLowerCase();
    if (
      landed.includes("/checkpoint") ||
      landed.includes("/login/") ||
      landed.includes("/login.php") ||
      landed.includes("login_required")
    ) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
      return {
        ok: false,
        blocked: true,
        blockReason:
          "FB yêu cầu xác minh/đăng nhập lại (checkpoint). Đã dừng để tránh rủi ro khoá tài khoản.",
      };
    }
  } catch (e) {}
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
          // ƯU TIÊN author id đã LƯU trên hội thoại (bắt lúc đăng bình luận) —
          // chuẩn nhất; nếu chưa có thì mới rơi về meta.
          authorId: conv.myAuthorId || meta.myAuthorId || "",
          authorName: conv.myAuthorName || meta.myAuthorName || "",
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
            // author id của bình luận cha (của ta) -> để backfill myAuthorId khi
            // hội thoại chưa lưu, giúp các lần theo dõi sau khớp `mine` theo id.
            myAuthorId: api.parentAuthorId || "",
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
    const active = await shouldFocusTabs();
    tab = await new Promise((r) => chrome.tabs.create({ url: postUrl, active }, r));
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
    result =
      job.type === "message"
        ? await executeMessageJob(job)
        : job.type === "comment"
        ? await executeCommentJob(job)
        : await executePostJob(job);
  } catch (e) {
    result = { ok: false, error: String(e) };
  }
  if (result && result.ok) {
    await DB.updateJob(job.id, { status: "done", result, error: null });
    // Đăng bài thành công -> lưu lịch sử "nhóm hay đăng" (chỉ job đăng bài có groupId).
    if (job.type === "post" && job.groupId) {
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
    // Bình luận thành công -> xử lý HỘI THOẠI. Bọc try để không làm hỏng luồng
    // job nếu lỗi.
    if (job.type === "comment") {
      try {
        const meta = job.meta || {};
        if (meta.source === "conversation" && meta.conversationId) {
          // Đây là REP TIẾP trong 1 hội thoại có sẵn (do APPROVE_CONV_REPLY tạo).
          // KHÔNG tạo hội thoại mới (tránh trùng) — merge reply của mình vào đúng
          // hội thoại cũ, reset nháp, đưa về "watching" để tiếp tục theo dõi.
          await DB.mergeReplies(meta.conversationId, [{
            id: result.commentId || "self-" + job.id,
            commentId: result.commentId || null,
            mine: true,
            author: result.myAuthorName || "",
            text: job.content || "",
            seenAt: Date.now(),
          }]);
          const patch = {
            draft: null,
            status: "watching",
            lastReplyJobId: job.id,
          };
          if (result.commentUrl) patch.myCommentUrl = result.commentUrl;
          await DB.updateConversation(meta.conversationId, patch);
        } else {
          // Bình luận GỐC mới -> tạo HỘI THOẠI để theo dõi reply về sau (chỉ THÊM,
          // không đụng dữ liệu cũ).
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
            // Lưu ĐÚNG author id/tên của ta (bắt từ API lúc đăng bình luận) để
            // khâu theo dõi reply gắn cờ `mine` theo id — chuẩn hơn khớp tên.
            myAuthorId: result.myAuthorId || "",
            myAuthorName: result.myAuthorName || "",
            postText: meta.postText || "",
          });
        }
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

/**
 * Ghi một khoá cấu hình theo TÀI KHOẢN lên server (upsert), NUỐT lỗi mạng để
 * alarm vẫn được (tái)tạo theo giá trị đã tính.
 */
async function writeSetting(key, value) {
  try {
    await DB.setSetting(key, value);
  } catch (e) {
    // Bỏ qua lỗi ghi.
  }
}

/** Đọc cấu hình auto-crawl từ server theo tài khoản, trộn với mặc định. */
async function getAutoCrawlConfig() {
  const saved = (await DB.getSetting(AUTOCRAWL_KEY)) || {};
  return {
    enabled: !!saved.enabled,
    intervalMinutes: Math.max(
      1,
      Math.min(1440, parseInt(saved.intervalMinutes, 10) || AUTOCRAWL_DEFAULT.intervalMinutes)
    ),
    options: saved.options && typeof saved.options === "object" ? saved.options : {},
  };
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
  await writeSetting(AUTOCRAWL_KEY, next);
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

/** Đọc cấu hình auto-sync từ server theo tài khoản, trộn với mặc định. */
async function getAutoSyncConfig() {
  const saved = (await DB.getSetting(AUTOSYNC_KEY)) || {};
  return {
    enabled: !!saved.enabled,
    intervalHours: normalizeSyncHours(saved.intervalHours),
  };
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
  await writeSetting(AUTOSYNC_KEY, next);
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

/** Đọc cấu hình theo-dõi-reply từ server theo tài khoản, trộn với mặc định. */
async function getWatchConfig() {
  const saved = (await DB.getSetting(WATCH_KEY)) || {};
  return {
    enabled: !!saved.enabled,
    intervalMinutes: Math.max(
      5,
      Math.min(720, parseInt(saved.intervalMinutes, 10) || WATCH_DEFAULT.intervalMinutes)
    ),
    maxPerRun: Math.max(1, Math.min(30, parseInt(saved.maxPerRun, 10) || WATCH_DEFAULT.maxPerRun)),
  };
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
  await writeSetting(WATCH_KEY, next);
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
  // NGẮT MẠCH CHUNG (feed/inbox/comment): đang trong thời gian nghỉ vì FB chặn
  // thì bỏ qua lượt này để bảo vệ tài khoản, không mở tab nào cả.
  const blockState = await getCrawlBlockState();
  if (blockState && blockState.blocked) {
    return {
      ok: false,
      blocked: true,
      error: blockState.reason || "Đang tạm nghỉ vì FB chặn crawl.",
      blockedUntil: blockState.blockedUntil,
    };
  }
  _watching = true;
  let checked = 0, newReplies = 0, noParent = 0;
  let blocked = false;
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
      // Phát hiện FB chặn (redirect checkpoint/login) -> arm ngắt mạch chung và
      // dừng lượt ngay, không mở thêm tab cho các hội thoại còn lại.
      if (res && res.blocked && res.blockReason) {
        await setCrawlBlock(res.blockReason);
        blocked = true;
        break;
      }
      // Không định vị được bình luận của ta trên trang -> đếm để báo rõ.
      if (res && res.ok && res.noParent) {
        noParent += 1;
      }
      // Lần đầu suy ra được comment_id của ta (comment thủ công) -> lưu lại để
      // các lượt quét sau chính xác và nhanh hơn.
      if (res && res.ok && res.parentId && !c.commentId) {
        try { await DB.updateConversation(c.id, { commentId: res.parentId }); } catch (e) {}
      }
      // Lần đầu bắt được author id của ta (từ API bình luận cha) mà hội thoại
      // chưa lưu -> backfill để các lượt sau khớp cờ `mine` theo id (chuẩn nhất).
      if (res && res.ok && res.myAuthorId && !c.myAuthorId) {
        try {
          await DB.updateConversation(c.id, { myAuthorId: res.myAuthorId });
          c.myAuthorId = res.myAuthorId;
        } catch (e) {}
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
  // Lượt hoàn tất mà KHÔNG bị chặn -> reset ngắt mạch (đồng bộ với feed/inbox:
  // một lượt sạch coi như bằng chứng tài khoản chưa bị khoá). Gate ở đầu hàm đã
  // bảo đảm không bao giờ xoá nhầm một đợt chặn còn hiệu lực.
  if (!blocked && checked > 0) {
    try { await clearCrawlBlock(); } catch (e) {}
  }
  return { ok: true, checked, newReplies, noParent, blocked, diag: lastDiag };
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

/* -------------------- NUÔI TÀI KHOẢN (WARMING, alarms) ---------------- */
//
// AN TOÀN TÀI KHOẢN — "nuôi" = mô phỏng hành vi người dùng thật một cách THỤ
// ĐỘNG để giữ tài khoản "ấm" (đáng tin) trước/xen kẽ các tác vụ đăng bài & nhắn
// tin. TẤT CẢ hành động đều READ-ONLY (cuộn feed, xem video vài giây, mở thông
// báo) — KHÔNG like/comment/share/gửi để tránh bị gắn cờ spam.
//
//  - Chỉ mở 1 tab nền/lần, làm xong ĐÓNG ngay (như watch/inbox).
//  - Dùng chung NGẮT MẠCH: đang bị FB chặn thì bỏ qua CẢ lượt, không mở tab nào.
//  - Giãn cách ngẫu nhiên giữa các hành động để không đều như máy.
//  - Mỗi hành động ghi NHẬT KÝ lên SERVER theo tài khoản qua
//    DB.recordWarmingActivity (KHÔNG dùng chrome.storage.local).

const WARMING_KEY = "warmingConfig";
const WARMING_ALARM = "warming";
// Các loại hành động hợp lệ. 3 loại đầu + scrollGroups là THỤ ĐỘNG (READ-ONLY).
// reactPost là hành động GHI (thả cảm xúc) — chỉ chạy xác suất thấp, xem
// WARMING_REACT_CHANCE bên dưới.
const WARMING_ACTIONS = [
  "scrollFeed",
  "watchVideo",
  "openNotifications",
  "scrollGroups",
  "scrollReels",
  "reactPost",
  "reactReels",
];

// Các hành động GHI (tương tác thật). Chúng KHÔNG được tính vào việc bốc read-only
// và mỗi loại chỉ chạy theo xác suất thấp, tối đa 1 tương tác/lượt. reactReels =
// thả cảm xúc cho Reels (thước phim). Rất dễ dính checkpoint nếu lạm dụng.
const WARMING_WRITE_ACTIONS = ["reactPost", "reactReels"];

// reactPost/reactReels RẤT dễ khiến tài khoản mới dính checkpoint nếu thả cảm xúc
// liên tục. Vì vậy dù người dùng có bật, mỗi lượt CHỈ ~30% khả năng thực sự thả,
// và tối đa 1 tương tác/loại. Đây là điểm mấu chốt để "giống người".
const WARMING_REACT_CHANCE = 0.3;

// Biên độ dao động thời gian giữa các lượt (±40%). Người thật không vào FB đúng
// mỗi X phút như máy -> mỗi lần lệch ngẫu nhiên trong khoảng này.
const WARMING_JITTER = 0.4;

// Khung "giờ ngủ" (giờ địa phương): bỏ qua/lùi lượt rơi vào khoảng này cho giống
// nhịp sinh hoạt người thật. [0h, 6h).
const WARMING_QUIET_START = 0;
const WARMING_QUIET_END = 6;

// Mặc định TẮT; chu kỳ tính bằng phút (kẹp 15..1440 = 24 giờ). `actionsPerRun`
// KHÔNG còn là "làm đúng N việc" mà là SỐ VIỆC TỐI ĐA mỗi lượt — mỗi lượt bốc
// ngẫu nhiên từ 1..N việc trong số các loại đã bật (mỗi loại nhiều nhất 1 lần).
// Mặc định chỉ bật các hành động READ-ONLY; reactPost để người dùng tự chọn.
const WARMING_DEFAULT = {
  enabled: false,
  intervalMinutes: 90,
  actionsPerRun: 3,
  actions: ["scrollFeed", "watchVideo", "openNotifications", "scrollGroups", "scrollReels"],
};

/** Lọc danh sách hành động về các loại hợp lệ; luôn còn tối thiểu 1 loại. */
function normalizeWarmingActions(list) {
  const arr = Array.isArray(list) ? list.filter((a) => WARMING_ACTIONS.includes(a)) : [];
  const uniq = Array.from(new Set(arr));
  return uniq.length ? uniq : WARMING_DEFAULT.actions.slice();
}

/** Đọc cấu hình nuôi tài khoản từ server theo tài khoản, trộn với mặc định. */
async function getWarmingConfig() {
  const saved = (await DB.getSetting(WARMING_KEY)) || {};
  return {
    enabled: !!saved.enabled,
    intervalMinutes: Math.max(
      15,
      Math.min(1440, parseInt(saved.intervalMinutes, 10) || WARMING_DEFAULT.intervalMinutes)
    ),
    actionsPerRun: Math.max(
      1,
      Math.min(8, parseInt(saved.actionsPerRun, 10) || WARMING_DEFAULT.actionsPerRun)
    ),
    actions: normalizeWarmingActions(saved.actions),
  };
}

/**
 * Tính độ trễ (phút) cho LƯỢT KẾ TIẾP theo kiểu người thật:
 *  - Lệch ngẫu nhiên quanh chu kỳ gốc ±WARMING_JITTER (vd 90' -> 54'..126').
 *  - Nếu thời điểm bắn rơi vào "giờ ngủ" [0h,6h) -> lùi tới ~7-8h sáng.
 * Trả về số phút (>= 15) để dùng với chrome.alarms { delayInMinutes }.
 */
function warmingNextDelayMinutes(baseMinutes, now = new Date()) {
  const base = Math.max(15, Math.min(1440, baseMinutes || WARMING_DEFAULT.intervalMinutes));
  const factor = 1 + (Math.random() * 2 - 1) * WARMING_JITTER; // 0.6..1.4
  let delay = Math.max(15, Math.round(base * factor));
  // Kiểm tra giờ bắn dự kiến; nếu rơi vào khung ngủ thì lùi tới sáng.
  const fireAt = new Date(now.getTime() + delay * 60000);
  const h = fireAt.getHours();
  const inQuiet =
    WARMING_QUIET_START <= WARMING_QUIET_END
      ? h >= WARMING_QUIET_START && h < WARMING_QUIET_END
      : h >= WARMING_QUIET_START || h < WARMING_QUIET_END;
  if (inQuiet) {
    // Lùi tới WARMING_QUIET_END giờ sáng + 0..90' ngẫu nhiên (tránh mọi máy bật
    // cùng lúc). Cộng dồn từ thời điểm bắn dự kiến.
    const wake = new Date(fireAt);
    wake.setHours(WARMING_QUIET_END, 0, 0, 0);
    if (wake.getTime() <= fireAt.getTime()) wake.setDate(wake.getDate() + 1);
    wake.setTime(wake.getTime() + Math.floor(Math.random() * 90) * 60000);
    delay = Math.max(15, Math.round((wake.getTime() - now.getTime()) / 60000));
  }
  return delay;
}

/**
 * Đặt lịch cho LƯỢT KẾ TIẾP bằng alarm MỘT-LẦN (delayInMinutes) thay vì
 * periodInMinutes cố định. Sau mỗi lần bắn, caller phải gọi lại hàm này để tự
 * lên lịch lượt sau -> lịch trình dao động, không máy móc. Nếu đã tắt -> xóa
 * alarm.
 */
async function scheduleNextWarming() {
  const cfg = await getWarmingConfig();
  try {
    await chrome.alarms.clear(WARMING_ALARM);
    if (cfg.enabled) {
      const delay = warmingNextDelayMinutes(cfg.intervalMinutes);
      chrome.alarms.create(WARMING_ALARM, { delayInMinutes: delay });
    }
  } catch (e) {}
}

/** Lưu cấu hình + đặt lại lịch (một-lần, có dao động) theo trạng thái bật/tắt. */
async function applyWarmingConfig(input) {
  const current = await getWarmingConfig();
  const next = {
    enabled: input.enabled != null ? !!input.enabled : current.enabled,
    intervalMinutes:
      input.intervalMinutes != null
        ? Math.max(
            15,
            Math.min(1440, parseInt(input.intervalMinutes, 10) || current.intervalMinutes)
          )
        : current.intervalMinutes,
    actionsPerRun:
      input.actionsPerRun != null
        ? Math.max(1, Math.min(8, parseInt(input.actionsPerRun, 10) || current.actionsPerRun))
        : current.actionsPerRun,
    actions: input.actions != null ? normalizeWarmingActions(input.actions) : current.actions,
  };
  await writeSetting(WARMING_KEY, next);
  await scheduleNextWarming();
  return next;
}

/**
 * IN-PAGE: cuộn feed như người thật đang lướt — cuộn xuống nhiều nhịp có nghỉ,
 * thỉnh thoảng cuộn ngược lên chút. READ-ONLY, không bấm gì. Chạy trong ngữ
 * cảnh trang qua chrome.scripting.executeScript nên PHẢI tự chứa (định nghĩa
 * sleep/rnd cục bộ, không dùng import).
 */
async function runScrollFeedInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  // Rê "chuột" ảo tới vài toạ độ ngẫu nhiên -> phát mousemove/mouseover như
  // người thật. READ-ONLY: không click vào nội dung.
  const moveMouse = (n) => {
    for (let i = 0; i < n; i++) {
      const x = rnd(0, Math.max(1, window.innerWidth - 1));
      const y = rnd(0, Math.max(1, window.innerHeight - 1));
      const el = document.elementFromPoint(x, y) || document.body;
      for (const type of ["mousemove", "mouseover"]) {
        try {
          el.dispatchEvent(
            new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
          );
        } catch (e) {}
      }
    }
  };
  let scrolls = 0;
  const rounds = rnd(5, 10);
  for (let i = 0; i < rounds; i++) {
    const before = window.scrollY;
    window.scrollBy({ top: rnd(400, 900), left: 0, behavior: "smooth" });
    scrolls += 1;
    moveMouse(rnd(1, 3));
    await sleep(rnd(1200, 3600));
    // Thỉnh thoảng dừng "đọc" một bài lâu hơn.
    if (Math.random() < 0.3) await sleep(rnd(1500, 4000));
    // Thỉnh thoảng cuộn ngược lên một chút như người đọc lại.
    if (Math.random() < 0.25) {
      window.scrollBy({ top: -rnd(150, 350), left: 0, behavior: "smooth" });
      await sleep(rnd(800, 1800));
    }
    // Chạm đáy nội dung đã tải (không cuộn thêm được) -> dừng sớm.
    if (window.scrollY <= before + 5 && i > 1) break;
  }
  return { ok: true, scrolls };
}

/**
 * IN-PAGE: xem 1 video trong khung nhìn vài giây (tắt tiếng). READ-ONLY: chỉ
 * play/pause phần tử <video> + rê chuột/hover, không bấm like/theo dõi. Tự chứa.
 */
async function runWatchVideoInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  // Cuộn nhẹ cho trang tải video rồi tìm 1 video đang trong khung nhìn.
  window.scrollBy({ top: rnd(200, 500), left: 0, behavior: "smooth" });
  await sleep(rnd(1200, 2400));
  const vids = Array.from(document.querySelectorAll("video"));
  let target = null;
  for (const v of vids) {
    const r = v.getBoundingClientRect();
    if (r.width > 100 && r.height > 100 && r.top < window.innerHeight && r.bottom > 0) {
      target = v;
      break;
    }
  }
  if (!target && vids.length) target = vids[0];
  if (!target) return { ok: true, watchedMs: 0, note: "no-video" };
  try {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(rnd(800, 1600));
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const type of ["mousemove", "mouseover"]) {
      try {
        target.dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: cx, clientY: cy })
        );
      } catch (e) {}
    }
    target.muted = true; // giữ im lặng, tránh phát tiếng bất ngờ
    const p = target.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {}
  const watchedMs = rnd(5000, 15000);
  await sleep(watchedMs);
  try {
    target.pause();
  } catch (e) {}
  return { ok: true, watchedMs };
}

/**
 * IN-PAGE: đọc thông báo thật — cuộn danh sách thông báo và hover vào từng mục
 * vài giây như người đang xem. READ-ONLY: chỉ hover/scroll, KHÔNG click mở thông
 * báo. Tự chứa (không import).
 */
async function runNotificationsInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const hover = (el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + Math.min(Math.max(1, r.width - 1), rnd(5, 40));
    const cy = r.top + Math.min(Math.max(1, r.height - 1), rnd(5, 20));
    for (const type of ["mousemove", "mouseover"]) {
      try {
        el.dispatchEvent(
          new MouseEvent(type, { bubbles: true, clientX: cx, clientY: cy })
        );
      } catch (e) {}
    }
  };
  const collect = () =>
    Array.from(
      document.querySelectorAll('[role="main"] a[role="link"], [role="listitem"]')
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 30;
    });
  let items = collect();
  let hovered = 0;
  const rounds = rnd(3, 6);
  for (let i = 0; i < rounds; i++) {
    const el = items[i];
    if (el) {
      try {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch (e) {}
      await sleep(rnd(500, 1200));
      hover(el);
      hovered += 1;
      await sleep(rnd(900, 2200));
    } else {
      window.scrollBy({ top: rnd(300, 600), left: 0, behavior: "smooth" });
      await sleep(rnd(900, 1800));
      items = collect(); // nạp thêm mục sau khi cuộn
    }
  }
  return { ok: true, hovered };
}

/**
 * IN-PAGE: lướt bảng tin của các NHÓM (groups feed) như người thật — cùng nhịp
 * cuộn/rê chuột/nghỉ như lướt feed chính. READ-ONLY, không bấm gì. Tự chứa.
 */
async function runScrollGroupsInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const moveMouse = (n) => {
    for (let i = 0; i < n; i++) {
      const x = rnd(0, Math.max(1, window.innerWidth - 1));
      const y = rnd(0, Math.max(1, window.innerHeight - 1));
      const el = document.elementFromPoint(x, y) || document.body;
      for (const type of ["mousemove", "mouseover"]) {
        try {
          el.dispatchEvent(
            new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
          );
        } catch (e) {}
      }
    }
  };
  let scrolls = 0;
  const rounds = rnd(5, 10);
  for (let i = 0; i < rounds; i++) {
    const before = window.scrollY;
    window.scrollBy({ top: rnd(400, 900), left: 0, behavior: "smooth" });
    scrolls += 1;
    moveMouse(rnd(1, 3));
    await sleep(rnd(1200, 3600));
    if (Math.random() < 0.3) await sleep(rnd(1500, 4000));
    if (Math.random() < 0.25) {
      window.scrollBy({ top: -rnd(150, 350), left: 0, behavior: "smooth" });
      await sleep(rnd(800, 1800));
    }
    if (window.scrollY <= before + 5 && i > 1) break;
  }
  return { ok: true, scrolls };
}

/**
 * IN-PAGE: THẢ CẢM XÚC cho 1 bài viết (hành động GHI — dễ dính checkpoint nếu
 * lạm dụng). Vì vậy hàm này RẤT thận trọng:
 *  - Chỉ thao tác tối đa 1 bài / lần gọi.
 *  - Cuộn nhẹ như đang đọc, tìm 1 nút "Thích/Like" đang TRONG khung nhìn và
 *    CHƯA được thả (aria-pressed != true) để tránh gỡ react cũ.
 *  - Rê chuột/hover vào nút trước rồi mới bấm (giống người), chỉ bấm 1 lần
 *    (react mặc định = Thích), KHÔNG mở thanh chọn cảm xúc để hạn chế rủi ro.
 *  - Việc CÓ chạy hàm này hay không do caller quyết định theo xác suất ~30%.
 * Tự chứa (không import). Trả { ok, reacted }.
 */
async function runReactPostInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const LIKE_MARKERS = ["thích", "like"];
  const isLikeBtn = (el) => {
    const l = (el.getAttribute("aria-label") || "").toLowerCase().trim();
    if (!l) return false;
    // Khớp CHÍNH XÁC nhãn "Thích"/"Like" để tránh trúng "Đã thích", "Lượt
    // thích", "Bạn và N người khác"... (những nhãn đó thường là trạng thái/mô
    // tả, không phải nút bấm thả cảm xúc mới).
    return LIKE_MARKERS.includes(l);
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 30 &&
      r.height > 15 &&
      r.top >= 0 &&
      r.bottom <= (window.innerHeight || document.documentElement.clientHeight)
    );
  };
  const findLike = () =>
    Array.from(document.querySelectorAll('div[role="button"], [aria-label]')).find(
      (el) =>
        isLikeBtn(el) &&
        el.getAttribute("aria-pressed") !== "true" &&
        inView(el)
    ) || null;
  // Cuộn tối đa vài nhịp để đưa một nút Thích chưa react vào khung nhìn.
  let btn = findLike();
  let tries = 0;
  while (!btn && tries < 4) {
    window.scrollBy({ top: rnd(350, 700), left: 0, behavior: "smooth" });
    await sleep(rnd(1200, 2600));
    btn = findLike();
    tries += 1;
  }
  if (!btn) return { ok: true, reacted: false, note: "no-like-button" };
  try {
    btn.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(rnd(800, 1800));
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Hover trước như người đang rê tới nút.
    for (const type of ["mousemove", "mouseover", "mouseenter"]) {
      try {
        btn.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })
        );
      } catch (e) {}
    }
    await sleep(rnd(600, 1500));
    // Bấm 1 lần (Thích mặc định). KHÔNG giữ để mở thanh cảm xúc.
    for (const type of ["mousedown", "mouseup", "click"]) {
      try {
        btn.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })
        );
      } catch (e) {}
    }
    await sleep(rnd(700, 1600));
  } catch (e) {
    return { ok: false, reacted: false, error: String(e) };
  }
  return { ok: true, reacted: true };
}

/**
 * IN-PAGE: LƯỚT REELS (thước phim) — hành động THỤ ĐỘNG (READ-ONLY). Reels là
 * video dọc, chuyển reel bằng cuộn/phím mũi tên. Hàm tự tắt tiếng video đang
 * phát rồi xem + chuyển vài reel như người xem lướt. Tự chứa (không import).
 * Trả { ok, scrolls }.
 */
async function runScrollReelsInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const muteVideos = () => {
    for (const v of Array.from(document.querySelectorAll("video"))) {
      try {
        v.muted = true;
      } catch (e) {}
    }
  };
  const nextReel = () => {
    // Ưu tiên phím mũi tên xuống (điều hướng Reels chuẩn của FB); đồng thời cuộn
    // một khoảng lớn để phòng khi phím không ăn.
    try {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          keyCode: 40,
          which: 40,
          bubbles: true,
        })
      );
    } catch (e) {}
    window.scrollBy({
      top: rnd(500, Math.max(600, window.innerHeight)),
      left: 0,
      behavior: "smooth",
    });
  };
  let scrolls = 0;
  const rounds = rnd(4, 8);
  for (let i = 0; i < rounds; i++) {
    muteVideos();
    // Xem mỗi reel một lúc như người thật rồi mới lướt tiếp.
    await sleep(rnd(2500, 6000));
    nextReel();
    scrolls += 1;
    await sleep(rnd(800, 1800));
    if (Math.random() < 0.25) await sleep(rnd(1500, 3500));
  }
  muteVideos();
  return { ok: true, scrolls };
}

/**
 * IN-PAGE: THẢ CẢM XÚC cho 1 Reel (thước phim) — hành động GHI, RẤT thận trọng
 * y như runReactPostInPage:
 *  - Chỉ thao tác tối đa 1 Reel/lần gọi.
 *  - Tìm nút "Thích/Like" đang TRONG khung nhìn và CHƯA thả (aria-pressed !=
 *    true) để không gỡ react cũ.
 *  - Hover trước rồi bấm 1 lần (Thích mặc định), KHÔNG mở thanh chọn cảm xúc.
 *  - Việc CÓ chạy hàm này hay không do caller quyết định theo xác suất ~30%.
 * Tự chứa (không import). Trả { ok, reacted }.
 */
async function runReactReelsInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const LIKE_MARKERS = ["thích", "like"];
  const isLikeBtn = (el) => {
    const l = (el.getAttribute("aria-label") || "").toLowerCase().trim();
    if (!l) return false;
    return LIKE_MARKERS.includes(l);
  };
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return (
      r.width > 20 &&
      r.height > 15 &&
      r.top >= 0 &&
      r.bottom <= (window.innerHeight || document.documentElement.clientHeight)
    );
  };
  const findLike = () =>
    Array.from(document.querySelectorAll('div[role="button"], [aria-label]')).find(
      (el) =>
        isLikeBtn(el) &&
        el.getAttribute("aria-pressed") !== "true" &&
        inView(el)
    ) || null;
  let btn = findLike();
  let tries = 0;
  while (!btn && tries < 3) {
    // Reels: thử chuyển reel để nút Thích của reel hiện tại vào khung nhìn.
    try {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          code: "ArrowDown",
          keyCode: 40,
          which: 40,
          bubbles: true,
        })
      );
    } catch (e) {}
    await sleep(rnd(1500, 3000));
    btn = findLike();
    tries += 1;
  }
  if (!btn) return { ok: true, reacted: false, note: "no-like-button" };
  try {
    btn.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(rnd(800, 1800));
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Hover trước như người đang rê tới nút.
    for (const type of ["mousemove", "mouseover", "mouseenter"]) {
      try {
        btn.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })
        );
      } catch (e) {}
    }
    await sleep(rnd(600, 1500));
    // Bấm 1 lần (Thích mặc định). KHÔNG giữ để mở thanh cảm xúc.
    for (const type of ["mousedown", "mouseup", "click"]) {
      try {
        btn.dispatchEvent(
          new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy })
        );
      } catch (e) {}
    }
    await sleep(rnd(700, 1600));
  } catch (e) {
    return { ok: false, reacted: false, error: String(e) };
  }
  return { ok: true, reacted: true };
}

/**
 * IN-PAGE: ĐIỀU HƯỚNG MỀM trong SPA của Facebook — tìm & click link điều hướng
 * (Trang chủ / Watch / Nhóm) hoặc nút chuông Thông báo, thay vì đổi URL cứng.
 * Giống người thật bấm chuyển mục, giữ nguyên phiên. Trả { navigated } để caller
 * biết có cần fallback hay không. `target` ∈ {home, watch, notifications, groups}.
 */
async function warmingSoftNavigateInPage(target) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const lowerLabel = (el) => (el.getAttribute("aria-label") || "").toLowerCase();
  const clickEl = (el) => {
    if (!el) return false;
    try {
      el.scrollIntoView({ block: "center" });
    } catch (e) {}
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (const type of ["mousemove", "mouseover", "mousedown", "mouseup", "click"]) {
      try {
        el.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: cx,
            clientY: cy,
          })
        );
      } catch (e) {}
    }
    return true;
  };
  const pick = (selList) => {
    for (const sel of selList) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  let el = null;
  if (target === "home") {
    el = pick([
      'a[href="/"]',
      'a[href="https://www.facebook.com/"]',
      'a[aria-label="Facebook"]',
    ]);
  } else if (target === "watch") {
    el = pick(['a[href^="/watch"]', 'a[href*="/watch/"]']);
    if (!el) {
      el =
        Array.from(document.querySelectorAll('a[role="link"]')).find((a) => {
          const l = lowerLabel(a);
          return l.includes("watch") || l.includes("video");
        }) || null;
    }
  } else if (target === "notifications") {
    // Nút chuông mở panel jewel — người thật hay bấm vào đây hơn là mở nguyên
    // trang /notifications.
    el =
      Array.from(document.querySelectorAll('[role="link"],[role="button"]')).find(
        (a) => {
          const l = lowerLabel(a);
          return l.includes("notification") || l.includes("thông báo");
        }
      ) || null;
    if (!el) el = pick(['a[href^="/notifications"]']);
  } else if (target === "groups") {
    el = pick(['a[href^="/groups/feed"]', 'a[href="/groups/"]', 'a[href^="/groups"]']);
    if (!el) {
      el =
        Array.from(document.querySelectorAll('a[role="link"]')).find((a) => {
          const l = lowerLabel(a);
          return l.includes("group") || l.includes("nhóm");
        }) || null;
    }
  } else if (target === "reels") {
    el = pick(['a[href^="/reel"]', 'a[href*="/reels/"]', 'a[href*="/reel/"]']);
    if (!el) {
      el =
        Array.from(document.querySelectorAll('a[role="link"]')).find((a) => {
          const l = lowerLabel(a);
          return l.includes("reel") || l.includes("thước phim");
        }) || null;
    }
  }
  if (!el) return { ok: false, navigated: false, note: "no-nav-link" };
  await sleep(rnd(300, 900));
  clickEl(el);
  await sleep(rnd(1500, 3200)); // chờ SPA render nội dung mới
  return { ok: true, navigated: true, target, url: location.href };
}

// URL mở cho từng loại hành động nuôi tài khoản. Chỉ dùng khi CHƯA có tab FB
// nào đang mở (phải tự mở 1 tab nền) hoặc khi điều hướng mềm trong SPA thất bại
// và buộc phải đổi URL cứng để hành động vẫn có ý nghĩa.
const WARMING_ACTION_URLS = {
  scrollFeed: "https://www.facebook.com/",
  watchVideo: "https://www.facebook.com/watch/",
  openNotifications: "https://www.facebook.com/notifications",
  scrollGroups: "https://www.facebook.com/groups/feed/",
  scrollReels: "https://www.facebook.com/reel/",
  reactPost: "https://www.facebook.com/",
  reactReels: "https://www.facebook.com/reel/",
};

// Mỗi loại hành động ứng với 1 mục điều hướng mềm trong SPA (bấm link/nút thay vì
// đổi URL). Dùng cho warmingSoftNavigateInPage.
const WARMING_NAV_TARGET = {
  scrollFeed: "home",
  watchVideo: "watch",
  openNotifications: "notifications",
  scrollGroups: "groups",
  scrollReels: "reels",
  reactPost: "home",
  reactReels: "reels",
};

// Mỗi loại hành động ứng với 1 hàm chạy-trong-trang. Đa số THỤ ĐỘNG (READ-ONLY);
// reactPost/reactReels là hành động GHI (chỉ chạy theo xác suất thấp).
const WARMING_IN_PAGE_FN = {
  scrollFeed: runScrollFeedInPage,
  watchVideo: runWatchVideoInPage,
  openNotifications: runNotificationsInPage,
  scrollGroups: runScrollGroupsInPage,
  scrollReels: runScrollReelsInPage,
  reactPost: runReactPostInPage,
  reactReels: runReactReelsInPage,
};

// Chuỗi dấu hiệu FB đá sang checkpoint/đăng nhập lại.
function warmingUrlIsBlocked(rawUrl) {
  const u = String(rawUrl || "").toLowerCase();
  return (
    u.includes("/checkpoint") ||
    u.includes("/login/") ||
    u.includes("/login.php") ||
    u.includes("login_required")
  );
}

const WARMING_BLOCK_REASON =
  "FB yêu cầu xác minh/đăng nhập lại (checkpoint). Đã dừng để tránh rủi ro khoá tài khoản.";

// Đọc URL hiện tại của tab (an toàn với lastError).
async function getTabUrl(tabId) {
  try {
    const cur = await new Promise((r) =>
      chrome.tabs.get(tabId, (t) => {
        void chrome.runtime.lastError;
        r(t);
      })
    );
    return String((cur && (cur.url || cur.pendingUrl)) || "");
  } catch (e) {
    return "";
  }
}

/**
 * HƯỚNG B+A — Lấy 1 tab Facebook để nuôi tài khoản:
 *  1) Ưu tiên BÁM vào tab facebook.com người dùng đang mở (owned=false -> KHÔNG
 *     đóng sau khi xong, giữ nguyên phiên làm việc của họ).
 *  2) Nếu không có -> tự mở 1 tab NỀN sống lâu (owned=true -> đóng khi kết thúc
 *     lượt), dùng lại cho MỌI hành động trong lượt thay vì mở tab mỗi hành động.
 * Trả { tabId, owned } hoặc { blocked, blockReason } nếu tab đã ở checkpoint,
 * hoặc { error } nếu không mở được.
 */
async function acquireWarmingTab() {
  // (1) Tìm tab facebook.com đang mở sẵn.
  try {
    const tabs = await new Promise((r) =>
      chrome.tabs.query({ url: ["*://*.facebook.com/*"] }, (list) => {
        void chrome.runtime.lastError;
        r(Array.isArray(list) ? list : []);
      })
    );
    // Bỏ qua tab đang ở checkpoint/login — không an toàn để thao tác.
    const usable = tabs.find((t) => t && t.id != null && !warmingUrlIsBlocked(t.url));
    const blockedTab = tabs.find((t) => t && warmingUrlIsBlocked(t.url));
    if (!usable && blockedTab) {
      return { blocked: true, blockReason: WARMING_BLOCK_REASON };
    }
    if (usable) return { tabId: usable.id, owned: false };
  } catch (e) {}
  // (2) Chưa có tab FB -> tự mở 1 tab nền sống lâu (theo công tắc focusTabs).
  const active = await shouldFocusTabs();
  let tab;
  try {
    tab = await new Promise((r) =>
      chrome.tabs.create({ url: WARMING_ACTION_URLS.scrollFeed, active }, (t) => {
        void chrome.runtime.lastError;
        r(t);
      })
    );
  } catch (e) {
    return { error: "Không mở được tab nuôi tài khoản: " + String(e) };
  }
  if (!tab || tab.id == null) return { error: "Không mở được tab nuôi tài khoản." };
  await addCrawlTab(tab.id); // đánh dấu tab do extension mở để dọn đúng tab
  await waitTabComplete(tab.id, 30000);
  if (warmingUrlIsBlocked(await getTabUrl(tab.id))) {
    try {
      await chrome.tabs.remove(tab.id);
    } catch (e) {}
    await removeCrawlTab(tab.id);
    return { blocked: true, blockReason: WARMING_BLOCK_REASON };
  }
  return { tabId: tab.id, owned: true };
}

// Đóng tab nuôi nếu (và chỉ nếu) chính extension đã mở nó (owned=true). Tab của
// người dùng (owned=false) được giữ nguyên.
async function releaseWarmingTab(tabId, owned) {
  if (!owned || tabId == null) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {}
  await removeCrawlTab(tabId);
}

/**
 * Thực hiện 1 hành động nuôi trên tab ĐÃ CÓ (dùng lại, không mở/đóng tab):
 *  - Điều hướng MỀM trong SPA tới mục tương ứng (bấm link/nút). Nếu không tìm
 *    thấy link -> đổi URL cứng làm phương án dự phòng để hành động vẫn có ý nghĩa.
 *  - Phát hiện checkpoint/login sau điều hướng -> báo blockReason.
 *  - Chạy hàm THỤ ĐỘNG (scroll/watch/notifications) đúng loại.
 * Trả { ok, action, detail } hoặc { blocked, blockReason }.
 */
async function executeWarmingAction(action, tabId) {
  const inPageFn = WARMING_IN_PAGE_FN[action];
  if (!inPageFn) return { ok: false, error: "Hành động nuôi không hợp lệ: " + action };
  const navTarget = WARMING_NAV_TARGET[action] || "home";
  // (a) Điều hướng mềm: bấm link/nút trong SPA, giữ nguyên phiên.
  let navigated = false;
  try {
    const navRes = await chrome.scripting.executeScript({
      target: { tabId },
      func: warmingSoftNavigateInPage,
      args: [navTarget],
    });
    navigated = !!(navRes && navRes[0] && navRes[0].result && navRes[0].result.navigated);
  } catch (e) {}
  // (b) Dự phòng: không thấy link điều hướng -> đổi URL cứng rồi chờ tải xong.
  if (!navigated) {
    const url = WARMING_ACTION_URLS[action] || WARMING_ACTION_URLS.scrollFeed;
    try {
      await new Promise((r) =>
        chrome.tabs.update(tabId, { url }, () => {
          void chrome.runtime.lastError;
          r();
        })
      );
      await waitTabComplete(tabId, 30000);
    } catch (e) {}
  }
  // (c) NGẮT MẠCH: sau điều hướng mà rơi vào checkpoint/login -> báo block.
  if (warmingUrlIsBlocked(await getTabUrl(tabId))) {
    return { ok: false, blocked: true, blockReason: WARMING_BLOCK_REASON };
  }
  await sleep(randInt(2000, 4500)); // chờ nội dung ổn định, nhịp như người
  // (d) Chạy hành động thụ động đúng loại trong trang.
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId },
      func: inPageFn,
    });
  } catch (e) {
    return { ok: false, action, error: "Lỗi chạy script nuôi tài khoản: " + String(e) };
  }
  const out = (res && res[0] && res[0].result) || { ok: false };
  return { ok: out.ok !== false, action, detail: out };
}

let _warming = false;
// Cờ YÊU CẦU DỪNG: khi người dùng bấm nút Dừng, background gọi stopWarming()
// đặt cờ này lên true. Vòng lặp trong processWarming kiểm tra cờ trước mỗi
// hành động và trong warmingSleep để thoát ngay giữa chừng.
let _warmingStop = false;

/** Yêu cầu dừng lượt nuôi tài khoản đang chạy (nếu có). An toàn khi gọi lúc rảnh. */
function stopWarming() {
  if (_warming) _warmingStop = true;
  return { ok: true, running: _warming };
}

/**
 * Ngủ `ms` mili-giây nhưng CÓ THỂ NGẮT: chia nhỏ thành lát ~500ms, sau mỗi lát
 * kiểm tra cờ _warmingStop. Trả về true nếu ngủ trọn vẹn, false nếu bị ngắt.
 */
async function warmingSleep(ms) {
  const step = 500;
  let left = Math.max(0, ms);
  while (left > 0) {
    if (_warmingStop) return false;
    const slice = Math.min(step, left);
    await sleep(slice);
    left -= slice;
  }
  return !_warmingStop;
}

/**
 * Chạy 1 lượt nuôi tài khoản theo kiểu NGƯỜI THẬT:
 *  - `actionsPerRun` là SỐ VIỆC TỐI ĐA; mỗi lượt bốc ngẫu nhiên 1..N việc trong
 *    số các loại READ-ONLY đã bật (mỗi loại nhiều nhất 1 lần — KHÔNG lặp).
 *  - reactPost (thả cảm xúc, hành động GHI) chỉ được thêm với xác suất
 *    ~WARMING_REACT_CHANCE (30%) và tối đa 1 bài/lượt, đặt ở CUỐI kế hoạch.
 *  - Trộn thứ tự nhóm READ-ONLY, giãn cách 20–75s giữa các việc (ngắt được).
 * Chống chạy chồng bằng cờ _warming; tôn trọng NGẮT MẠCH chung và cờ DỪNG;
 * ghi nhật ký MỖI hành động lên server. Gọi thủ công truyền { manual:true }.
 */
async function processWarming(opts = {}) {
  if (_warming) return { ok: false, error: "Đang nuôi tài khoản, bỏ qua lượt này." };
  const cfg = await getWarmingConfig();
  // Khi gọi thủ công (manual=true) thì chạy kể cả khi alarm tắt.
  if (!cfg.enabled && !opts.manual) return { ok: false, error: "Nuôi tài khoản đang tắt." };
  // NGẮT MẠCH CHUNG (feed/inbox/comment/watch): đang nghỉ vì FB chặn thì bỏ qua
  // CẢ lượt để bảo vệ tài khoản.
  const blockState = await getCrawlBlockState();
  if (blockState && blockState.blocked) {
    return {
      ok: false,
      blocked: true,
      error: blockState.reason || "Đang tạm nghỉ vì FB chặn.",
      blockedUntil: blockState.blockedUntil,
    };
  }
  _warming = true;
  _warmingStop = false;
  let done = 0;
  let blocked = false;
  let stopped = false;
  // Tab dùng CHUNG cho cả lượt (Hướng B+A): bám tab FB đang mở hoặc mở 1 tab
  // nền sống lâu. `owned` = true nếu chính extension mở (phải tự đóng khi xong).
  let warmTabId = null;
  let ownedTab = false;
  try {
    // Lấy tab MỘT LẦN cho cả lượt thay vì mở/đóng tab mỗi hành động.
    const acq = await acquireWarmingTab();
    if (acq && acq.blocked && acq.blockReason) {
      // Tab người dùng đang ở checkpoint (hoặc tab nền vừa mở bị đá) -> arm ngắt
      // mạch chung, ghi log rồi dừng lượt (không có hành động nào chạy).
      await setCrawlBlock(acq.blockReason);
      blocked = true;
      try {
        await DB.recordWarmingActivity({
          type: "session",
          status: "blocked",
          data: { reason: acq.blockReason },
        });
      } catch (e) {}
      broadcast("WARMING_PROGRESS", {
        action: "session",
        status: "blocked",
        done: 0,
        total: 0,
      });
      return { ok: true, done: 0, blocked: true };
    }
    if (!acq || acq.tabId == null) {
      // Không mở được tab -> bỏ lượt, chờ chu kỳ sau (không đụng ngắt mạch).
      return { ok: false, error: (acq && acq.error) || "Không lấy được tab nuôi tài khoản." };
    }
    warmTabId = acq.tabId;
    ownedTab = !!acq.owned;

    const enabled = normalizeWarmingActions(cfg.actions);
    const perRun = Math.max(
      1,
      Math.min(8, parseInt(opts.actionsPerRun, 10) || cfg.actionsPerRun)
    );
    // Tách nhóm GHI (reactPost/reactReels) khỏi nhóm READ-ONLY. Nhóm GHI chỉ
    // được thêm theo xác suất thấp, KHÔNG tính vào phần chạy của read-only.
    const readonlyPool = enabled.filter((a) => !WARMING_WRITE_ACTIONS.includes(a));
    const writeEnabled = enabled.filter((a) => WARMING_WRITE_ACTIONS.includes(a));
    // Trộn nhóm read-only rồi CHẠY HẾT các việc đã tích (đúng ý "tích 4 thì làm
    // cả 4", KHÔNG bốc ngẫu nhiên 1 việc rồi bỏ phần còn lại), mỗi loại nhiều
    // nhất 1 lần. Lượt TỰ ĐỘNG: kẹp theo perRun để không dồn quá nhiều. Lượt
    // CHẠY THỬ thủ công (manual): chạy HẾT để người dùng quan sát từng việc.
    shuffleInPlace(readonlyPool);
    const plan = [];
    const readCap = opts.manual
      ? readonlyPool.length
      : Math.min(perRun, readonlyPool.length);
    for (let i = 0; i < readCap; i++) plan.push(readonlyPool[i]);
    // Nhóm GHI (reactPost/reactReels): mỗi loại ~30% khả năng mỗi lượt, tối đa 1
    // tương tác/loại, luôn ở CUỐI (sau khi đã "khởi động" bằng vài hành động thụ
    // động cho giống người thật). Khi CHẠY THỬ thủ công thì BUỘC chạy để người
    // dùng kiểm chứng được hành động ghi.
    for (const wa of writeEnabled) {
      if (opts.manual || Math.random() < WARMING_REACT_CHANCE) plan.push(wa);
    }
    // Trường hợp hiếm: chỉ bật mỗi hành động GHI và lần này không trúng 30% ->
    // lượt rỗng. Vẫn coi là lượt sạch (không làm gì cũng là "giống người").
    for (let i = 0; i < plan.length; i++) {
      // Người dùng bấm Dừng -> thoát ngay, KHÔNG chạy thêm hành động nào.
      if (_warmingStop) {
        stopped = true;
        break;
      }
      // Kiểm tra ngắt mạch TRƯỚC mỗi hành động (block có thể tới bất đồng bộ).
      const blk = await getCrawlBlockState();
      if (blk && blk.blocked) {
        blocked = true;
        break;
      }
      const action = plan[i];
      let res;
      try {
        res = await executeWarmingAction(action, warmTabId);
      } catch (e) {
        res = { ok: false, error: String(e) };
      }
      // FB chặn giữa chừng -> arm ngắt mạch chung, ghi log rồi dừng lượt.
      if (res && res.blocked && res.blockReason) {
        await setCrawlBlock(res.blockReason);
        blocked = true;
        try {
          await DB.recordWarmingActivity({
            type: action,
            status: "blocked",
            data: { reason: res.blockReason },
          });
        } catch (e) {}
        broadcast("WARMING_PROGRESS", {
          action,
          status: "blocked",
          done,
          total: plan.length,
        });
        break;
      }
      done += 1;
      // Ghi nhật ký lên SERVER cho từng hành động (BE, không dùng storage local).
      try {
        await DB.recordWarmingActivity({
          type: action,
          status: res && res.ok ? "done" : "error",
          data: (res && res.detail) || {},
        });
      } catch (e) {}
      broadcast("WARMING_PROGRESS", {
        action,
        status: res && res.ok ? "done" : "error",
        done,
        total: plan.length,
      });
      // Giãn cách 20–75s GIỮA các hành động (không chờ sau hành động cuối). Ngủ
      // NGẮT ĐƯỢC: nếu người dùng bấm Dừng giữa lúc chờ thì thoát ngay.
      if (i < plan.length - 1) {
        const full = await warmingSleep(randInt(20000, 75000));
        if (!full) {
          stopped = true;
          break;
        }
      }
    }
  } catch (e) {
    // bỏ qua, chờ chu kỳ sau
  } finally {
    // Chỉ đóng tab nếu chính extension đã mở nó; tab của người dùng giữ nguyên.
    await releaseWarmingTab(warmTabId, ownedTab);
    _warming = false;
    _warmingStop = false;
  }
  // Người dùng chủ động dừng -> ghi log 1 dòng "stopped" để UI hiển thị rõ.
  if (stopped) {
    try {
      await DB.recordWarmingActivity({
        type: "session",
        status: "stopped",
        data: { done },
      });
    } catch (e) {}
    broadcast("WARMING_PROGRESS", {
      action: "session",
      status: "stopped",
      done,
      total: done,
    });
  }
  // Lượt sạch (không bị chặn, làm ít nhất 1 hành động) -> reset ngắt mạch, đồng
  // bộ với feed/inbox/watch.
  if (!blocked && !stopped && done > 0) {
    try {
      await clearCrawlBlock();
    } catch (e) {}
  }
  return { ok: true, done, blocked, stopped };
}

/** Khôi phục alarm nuôi tài khoản khi service worker khởi động lại. */
async function initWarming() {
  const cfg = await getWarmingConfig();
  try {
    const existing = await chrome.alarms.get(WARMING_ALARM);
    if (cfg.enabled && !existing) {
      // Dùng alarm MỘT-LẦN có dao động thay vì periodInMinutes cố định.
      await scheduleNextWarming();
    } else if (!cfg.enabled && existing) {
      await chrome.alarms.clear(WARMING_ALARM);
    }
  } catch (e) {}
}

/* ================= HỘP THƯ MESSENGER (đọc hội thoại có sẵn) ============== */
//
// AN TOÀN TÀI KHOẢN — nguyên tắc:
//  - CHỈ chạy khi người dùng CHỦ ĐỘNG bấm (không có vòng lặp nền tự quét).
//  - Quét là READ-ONLY (chỉ đọc DOM), KHÔNG bấm/gửi gì trong lúc quét.
//  - Mở tab Messenger ở NỀN (active:false), quét xong ĐÓNG ngay.
//  - Có trần số hội thoại đọc mỗi lượt + giãn cách giữa các thread để giống
//    người thật, giảm rủi ro bị gắn cờ.
//  - Việc GỬI trả lời KHÔNG nằm ở đây: đi qua "message" job (đã có kill-switch,
//    trần ngày, chống trùng, giãn cách) và luôn chờ người dùng DUYỆT.

// Số thread tối đa đọc chi tiết trong một lượt quét (bảo thủ cho an toàn).
const INBOX_SCAN_MAX_THREADS = 20;

// ── Lịch đọc thông minh (tránh "quét acc lâu năm load mãi không xong") ──────
// Mỗi LƯỢT quét chỉ MỞ ĐỌC tối đa ngần này thread. Thread ưu tiên (có tin mới)
// luôn được đọc trước; phần "backfill" (thread cũ chưa từng đọc) rải dần qua
// nhiều lượt để không bao giờ mở hàng trăm tab một lúc.
const INBOX_READ_BUDGET = 8;
// Trần thời gian THỰC cho pha đọc chi tiết một lượt (ms). Chạm trần thì dừng
// sớm, các thread còn lại để lượt sau — không treo vô hạn.
const INBOX_READ_TIME_CAP_MS = 90 * 1000;
// Số lần đọc HỤT (lỗi/rỗng) tối đa trước khi coi thread là "chịu thua" và ngừng
// thử lại (tránh vòng lặp kẹt đúng một thread hỏng mỗi lượt quét).
const INBOX_MAX_READ_ATTEMPTS = 4;

/**
 * Tính BACKOFF (ms) cho lần đọc lại một thread đọc hụt, theo số lần đã hụt.
 * Tăng dần: 5' → 15' → 45' → 2h (chặn trên) — giãn để không spam mở tab.
 */
function inboxBackoffMs(attempts) {
  const steps = [5, 15, 45, 120];
  const i = Math.min(Math.max(0, (Number(attempts) || 1) - 1), steps.length - 1);
  return steps[i] * 60 * 1000;
}

/**
 * HÀM THUẦN (test được): từ danh sách thread quét được + trạng thái ĐÃ LƯU,
 * quyết định thread nào cần MỞ ĐỌC lượt này, theo thứ tự ưu tiên và trong hạn
 * mức. KHÔNG chạm DOM/tab — chỉ suy luận trên metadata lấy thụ động.
 *
 * Phân loại mỗi thread:
 *  - deferred: đang trong cửa sổ backoff (nextReadAt > now) HOẶC đã hụt quá số
 *    lần cho phép -> BỎ QUA lượt này.
 *  - fresh (ưu tiên 0): có tín hiệu TIN MỚI — unread, hoặc preview đổi so với
 *    bản đã lưu. Luôn đọc trước.
 *  - retry (ưu tiên 1): từng đọc nhưng ra RỖNG (emptyReads>0) và chưa tới trần
 *    -> thử lại (có backoff), sau fresh.
 *  - backfill (ưu tiên 2): CHƯA TỪNG đọc (không có readAt & chưa có tin) -> rải
 *    dần. Đây là case acc lâu năm: hàng trăm thread cũ, mỗi lượt chỉ nhặt vài.
 *  - unchanged: đã đọc, không có tin mới -> KHÔNG đọc lại.
 *
 * @returns {{toRead:Array, skipped:number, deferred:number, counts:object}}
 */
function planInboxReads(listThreads, storedById, opts, now) {
  const list = Array.isArray(listThreads) ? listThreads : [];
  const stored = storedById instanceof Map ? storedById : new Map();
  const o = opts || {};
  const budget = Math.max(1, Number(o.budget) || INBOX_READ_BUDGET);
  const maxAttempts = Math.max(1, Number(o.maxAttempts) || INBOX_MAX_READ_ATTEMPTS);
  const t = Number(now) || Date.now();
  const norm = (s) => String(s || "").trim().toLowerCase();

  const fresh = [];
  const retry = [];
  const backfill = [];
  let deferred = 0;
  let unchanged = 0;

  for (const th of list) {
    const id = String((th && th.threadId) || "");
    if (!id) continue;
    const prev = stored.get(id);
    const hasStored =
      prev && Array.isArray(prev.messages) && prev.messages.length > 0;
    const attempts = Number(prev && prev.readAttempts) || 0;
    const empties = Number(prev && prev.emptyReads) || 0;
    const nextReadAt = Number(prev && prev.nextReadAt) || 0;
    const everRead = !!(prev && (prev.readAt || hasStored));

    // Tín hiệu tin mới (thụ động từ list-scan). CHỈ tính "preview đổi" khi ĐÃ có
    // bản ghi cũ để so — lượt quét ĐẦU TIÊN (chưa từng thấy thread) KHÔNG được
    // coi preview khác rỗng là "tin mới", nếu không mọi thread acc lâu năm sẽ bị
    // xếp fresh và mở hết. Thread mới toanh mà không unread -> để "backfill".
    const previewChanged =
      !!prev &&
      norm(th.preview) &&
      norm(th.preview) !== norm(prev.preview);
    const hasNew = !!th.unread || previewChanged;

    // Đã "chịu thua" (hụt quá nhiều) và KHÔNG có tin mới -> thôi thử.
    if (attempts >= maxAttempts && !hasNew) {
      deferred += 1;
      continue;
    }
    // Trong cửa sổ backoff và KHÔNG có tin mới -> hoãn. (Tin mới thì đọc ngay,
    // bỏ qua backoff, vì đó là thứ người dùng cần nhất.)
    if (nextReadAt > t && !hasNew) {
      deferred += 1;
      continue;
    }

    if (hasNew) {
      fresh.push(th);
    } else if (!everRead) {
      backfill.push(th);
    } else if (empties > 0) {
      retry.push(th);
    } else {
      unchanged += 1;
    }
  }

  // Ưu tiên: fresh -> retry -> backfill. Cắt theo budget.
  const ordered = fresh.concat(retry).concat(backfill);
  const toRead = ordered.slice(0, budget);
  const considered = fresh.length + retry.length + backfill.length;
  const skipped = list.length - toRead.length;
  return {
    toRead,
    skipped,
    deferred,
    counts: {
      fresh: fresh.length,
      retry: retry.length,
      backfill: backfill.length,
      unchanged,
      considered,
    },
  };
}

/**
 * Hàm TỰ-CHỨA chạy trong TAB /messages: quét DANH SÁCH hội thoại ở cột trái.
 * Trả về { ok, threads:[{threadId,name,threadUrl,preview,unread}] }.
 * KHÔNG mở/không bấm vào hội thoại nào — chỉ đọc các link /messages/t/<id>.
 */
async function runScanInboxListInPage(maxThreads) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cap = Math.max(1, Math.min(50, Number(maxThreads) || 20));

  // Chờ danh sách hội thoại render (tab nền tải lười).
  const findLinks = () =>
    Array.from(document.querySelectorAll('a[href*="/messages/t/"], a[href*="/messages/e2ee/t/"]'));
  let links = findLinks();
  for (let i = 0; i < 8 && links.length === 0; i++) {
    await sleep(1500);
    links = findLinks();
  }
  if (links.length === 0) {
    return { ok: false, error: "Không thấy danh sách hội thoại (có thể chưa đăng nhập Messenger hoặc trang chưa tải xong)." };
  }

  const idOf = (href) => {
    const m = String(href || "").match(/\/messages\/(?:e2ee\/)?t\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  };
  const seen = new Set();
  const threads = [];
  for (const a of links) {
    const href = a.href || a.getAttribute("href") || "";
    const threadId = idOf(href);
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);

    // Tên + preview: FB xếp trong các span dir="auto" bên trong link/row.
    // LƯU Ý: span ĐẦU thường KHÔNG phải tên hội thoại mà là nhãn phụ trợ cho
    // trình đọc màn hình / biểu tượng (vd "Thông báo", "Đang hoạt động"), nên
    // lấy span[0] làm tên sẽ ra sai (mọi thread thành "Thông báo"). Cần LỌC bỏ
    // các nhãn hệ thống chung rồi mới chọn tên; nếu bí thì dùng aria-label.
    const GENERIC_LABEL =
      /^(thông báo|notifications?|đang hoạt động|active( now)?|hoạt động|marketplace|đã xem|seen|sent|đã gửi|đã nhận|delivered|you|bạn|mới|new)$/i;
    const isTimeish = (s) =>
      /^\d/.test(s) || /^(vài|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười)\b/i.test(s);
    const spans = Array.from(a.querySelectorAll('span[dir="auto"], span'))
      .map((s) => (s.textContent || "").trim())
      .filter(Boolean);
    // Ứng viên tên: bỏ nhãn hệ thống, bỏ chuỗi thời gian, cần đủ dài.
    const meaningful = spans.filter(
      (s) => !GENERIC_LABEL.test(s) && !isTimeish(s) && s.length >= 2
    );
    let name = meaningful[0] || "";
    // Dự phòng: aria-label của link/row thường bắt đầu bằng tên hội thoại.
    if (!name || GENERIC_LABEL.test(name)) {
      const ariaName = (a.getAttribute("aria-label") || "").trim();
      if (ariaName) name = ariaName.split(/[,·\n]|\s{2,}/)[0].trim();
    }
    // Preview: chuỗi có nghĩa dài nhất KHÁC tên.
    let preview = "";
    for (const s of meaningful) {
      if (s !== name && s.length > preview.length) preview = s;
    }
    // Chưa đọc: FB hay gắn aria-label chứa "chưa đọc"/"unread", hoặc chữ đậm.
    const aria = (a.getAttribute("aria-label") || "").toLowerCase();
    const row = a.closest('[role="row"], [role="gridcell"], li') || a;
    const unread =
      /unread|chưa đọc/.test(aria) ||
      !!(row.querySelector && row.querySelector('[aria-label*="Unread"], [aria-label*="chưa đọc"]'));

    threads.push({
      threadId,
      name: name.slice(0, 200),
      threadUrl: "https://www.facebook.com/messages/t/" + threadId,
      preview: preview.slice(0, 400),
      unread,
    });
    if (threads.length >= cap) break;
  }
  return { ok: true, threads };
}

/**
 * Hàm TỰ-CHỨA chạy trong TAB /messages/t/<id>: đọc CÁC TIN NHẮN trong hội thoại
 * đang mở. Trả về { ok, messages:[{mine,text}], name }.
 * READ-ONLY: không gõ, không gửi.
 */
async function runReadThreadInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ── Tín hiệu VÀNG (đã kiểm chứng bằng DOM thật): mỗi tin nhắn trong hội thoại
  //    mang một [role="button"] có aria-label dạng:
  //      "Nhập, Tin nhắn do {NGƯỜI} gửi lúc {GIỜ}: {NỘI DUNG}"
  //    "do Bạn gửi" => của mình; "do <tên khác> gửi" => của đối phương.
  //    Đây là 1 nút / 1 tin, KHÔNG dính thanh bên trái, panel phải hay dấu giờ.
  const MSG_ARIA =
    /tin nhắn do .+? gửi|message .*sent by|you sent|bạn đã gửi/i;
  const findMsgBtns = () =>
    Array.from(document.querySelectorAll('[role="button"][aria-label]')).filter(
      (b) => MSG_ARIA.test(b.getAttribute("aria-label") || "")
    );

  let btns = findMsgBtns();
  for (let i = 0; i < 8 && btns.length === 0; i++) {
    await sleep(1500);
    btns = findMsgBtns();
  }

  // Nhãn UI/hệ thống KHÔNG được dùng làm tên hội thoại (tránh lỗi "tên biến
  // thành 'Đoạn chat'"). heading trên Messenger thường là "Đoạn chat".
  const GENERIC_NAME =
    /^(đoạn chat|thông báo|notifications?|đang hoạt động|active( now)?|messenger|tin nhắn|messages?|chat|menu|trang chủ|home|marketplace)$/i;
  const cleanName = (raw) => {
    const s = (raw || "").trim();
    if (!s || GENERIC_NAME.test(s)) return "";
    return s.slice(0, 200);
  };

  // Tách "mine" + "text" + "sender" từ aria-label. Nội dung nằm sau dấu ": "
  // (colon+space) ĐẦU TIÊN — vì giờ ("21:40ch") dùng ":" KHÔNG kèm khoảng trắng
  // nên không lẫn. Tên người gửi nằm giữa "do " và " gửi".
  const parseAria = (ariaRaw) => {
    const aria = String(ariaRaw || "");
    const mine = /tin nhắn do bạn gửi|bạn đã gửi|you sent/i.test(aria);
    const parts = aria.split(/:\s+/);
    const text = parts.length > 1 ? parts.slice(1).join(": ").trim() : "";
    let sender = "";
    const sm = aria.match(/do\s+(.+?)\s+gửi/i) || aria.match(/sent by\s+(.+?)(?:\s+at|:|$)/i);
    if (sm && sm[1]) sender = sm[1].trim();
    return { mine, text, sender };
  };

  const messages = [];
  let name = "";
  for (const b of btns) {
    const { mine, text, sender } = parseAria(b.getAttribute("aria-label"));
    // Tên hội thoại = tên người gửi KHÁC "Bạn" (đối phương trong chat 1:1).
    if (!name && !mine && sender) {
      const n = cleanName(sender);
      if (n && !/^bạn$/i.test(n)) name = n;
    }
    if (!text) continue; // tin chỉ có ảnh/sticker (không có phần text) -> bỏ.
    messages.push({ mine: mine === true, text: text.slice(0, 8000) });
  }

  // Dự phòng tên: heading trên cùng, nhưng loại nhãn UI chung.
  if (!name) {
    const h = document.querySelector(
      '[role="main"] h1, [role="main"] h2, [aria-label] h1, h1 span'
    );
    if (h) name = cleanName(h.textContent || "");
  }

  // Khử trùng lặp liên tiếp.
  const dedupOf = (list) => {
    const d = [];
    for (const m of list) {
      const prev = d[d.length - 1];
      if (prev && prev.text === m.text && prev.mine === m.mine) continue;
      d.push(m);
    }
    return d.slice(-60);
  };

  const viaAria = dedupOf(messages);
  if (viaAria.length > 0) {
    return { ok: true, messages: viaAria, name };
  }

  // ── DỰ PHÒNG (khi FB đổi aria-label): đọc theo VỊ TRÍ bong bóng trong
  //    [role="main"]. FB căn tin của MÌNH lệch phải, của người khác lệch trái.
  const mainEl = document.querySelector('[role="main"]') || document.body;
  const mainRect = mainEl.getBoundingClientRect();
  const midX = mainRect.left + mainRect.width / 2;
  const SYS_LABEL =
    /^(đang hoạt động|active now|seen|đã xem|sent|đã gửi|delivered|đã nhận|enter|được mã hóa|·|\d{1,2}:\d{2})/i;

  const posMsgs = [];
  const bubbles = Array.from(mainEl.querySelectorAll('div[dir="auto"]')).filter(
    (d) => {
      const t = (d.textContent || "").trim();
      if (!t || SYS_LABEL.test(t) || t.startsWith("Nhập")) return false;
      const r = d.getBoundingClientRect();
      return r.width > 0;
    }
  );
  for (const b of bubbles) {
    const text = (b.textContent || "").trim();
    let mine = false;
    try {
      const r = b.getBoundingClientRect();
      const gapLeft = r.left - mainRect.left;
      const gapRight = mainRect.right - r.right;
      if (gapLeft - gapRight > 40) mine = true;
      else if (gapRight - gapLeft > 40) mine = false;
      else mine = r.left + r.width / 2 >= midX;
    } catch (e) {}
    posMsgs.push({ mine, text: text.slice(0, 8000) });
  }
  return { ok: true, messages: dedupOf(posMsgs), name };
}

/**
 * QUÉT DANH SÁCH hội thoại: mở tab /messages ở nền, đọc cột trái, đóng tab.
 * Nếu deep=true thì đọc luôn chi tiết tin của tối đa INBOX_SCAN_MAX_THREADS
 * thread (giãn cách giữa các thread). Trả về { ok, threads } hoặc { ok:false }.
 */
async function scanInbox(options) {
  const opts = options || {};
  const deep = !!opts.deep;
  const maxThreads = Math.max(1, Math.min(INBOX_SCAN_MAX_THREADS, Number(opts.maxThreads) || INBOX_SCAN_MAX_THREADS));

  // Chốt chặn kill-switch: nếu hệ thống đang bị FB chặn thì không quét.
  try {
    const blockState = await getCrawlBlockState();
    if (blockState && blockState.blocked) {
      return { ok: false, error: "Hệ thống đang tạm dừng do phát hiện rủi ro (kill-switch). Lý do: " + (blockState.reason || "không rõ") + "." };
    }
  } catch (e) {}

  const listUrl = "https://www.facebook.com/messages/";
  // Phát tiến độ THỜI GIAN THỰC cho dashboard: mở khung tiến trình ngay khi bắt
  // đầu để người dùng biết đang chạy (không phải spinner "đứng đơ" vô định).
  try { broadcast("INBOX_PROGRESS", { phase: "list", status: "scanning", text: "Đang mở hộp thư…" }); } catch (e) {}
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url: listUrl, active }, r));
  let listThreads = [];
  let via = "api";
  try {
    await waitTabComplete(tab.id, 30000);
    await sleep(4000);

    // ƯU TIÊN API (tier-2 replay-trong-trang): content.js đã tự chèn ở
    // /messages/* nên chỉ cần nhắn lệnh. An toàn hơn DOM (không tạo click giả),
    // và lấy được ĐẦY ĐỦ nhờ phân trang cursor. Nếu chưa bắt được gói API thì
    // rơi xuống DOM dự phòng bên dưới.
    let apiOut = null;
    try {
      apiOut = await chrome.tabs.sendMessage(tab.id, {
        type: "START_INBOX_API_SCAN",
        options: { maxThreads },
      });
    } catch (e) {
      apiOut = null; // content.js chưa sẵn sàng / trang chưa khớp
    }
    if (apiOut && apiOut.ok && Array.isArray(apiOut.threads) && apiOut.threads.length) {
      listThreads = apiOut.threads.map((t) => ({
        threadId: t.threadId,
        name: t.name || "",
        threadUrl: t.threadUrl || (listUrl + "t/" + encodeURIComponent(t.threadId)),
        preview: t.preview || "",
        unread: !!t.unread,
      }));
    } else {
      // DOM DỰ PHÒNG: đọc danh sách hội thoại từ giao diện.
      via = "dom";
      let res;
      try {
        res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: runScanInboxListInPage,
          args: [maxThreads],
        });
      } catch (e) {
        return { ok: false, error: "Lỗi chạy script quét hộp thư: " + String(e) };
      }
      const out = (res && res[0] && res[0].result) || { ok: false, error: "Không có kết quả." };
      if (!out.ok) return out;
      listThreads = Array.isArray(out.threads) ? out.threads : [];
    }
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }

  // Chụp trạng thái ĐÃ LƯU trước khi upsert (upsert sẽ ghi preview mới), để phát
  // hiện thread KHÔNG đổi mà bỏ qua việc mở đọc lại.
  const storedById = new Map();
  try {
    const existing = await DB.getInboxThreads();
    for (const t of existing) storedById.set(String(t.threadId), t);
  } catch (e) {}

  // Lưu danh sách (chưa có messages) — UPSERT giữ nháp/tin cũ.
  try { await DB.upsertInboxThreads(listThreads); } catch (e) {}

  // Báo đã quét xong danh sách (kèm tổng số) để UI đổi từ "đang mở" sang có số.
  try {
    broadcast("INBOX_PROGRESS", {
      phase: "list",
      status: "done",
      total: listThreads.length,
      text: "Đã tìm thấy " + listThreads.length + " hội thoại.",
    });
  } catch (e) {}

  if (!deep || listThreads.length === 0) {
    try { broadcast("INBOX_PROGRESS", { phase: "done", read: 0, failed: 0, text: "Xong." }); } catch (e) {}
    return { ok: true, threads: listThreads, deep: false, via };
  }

  // TỐI ƯU AN TOÀN + LỊCH ĐỌC THÔNG MINH: tin nhắn Messenger MÃ HOÁ ĐẦU-CUỐI
  // (Labyrinth V1_1) nên text chỉ lấy được từ DOM sau khi trang tự giải mã
  // (API/IndexedDB đều là ciphertext "maw_ear"). Vì mỗi thread phải MỞ 1 TAB để
  // đọc, KHÔNG được mở tất cả — nhất là acc lâu năm có hàng trăm hội thoại cũ.
  // planInboxReads() phân loại & xếp ưu tiên: tin mới (unread/preview đổi) đọc
  // trước, kế đến thử-lại thread từng rỗng, rồi "backfill" thread cũ chưa từng
  // đọc — tất cả trong HẠN MỨC budget mỗi lượt. Thread đã đọc & không đổi thì bỏ
  // qua; thread đọc hụt nhiều lần bị giãn (backoff) rồi thôi. Nhờ vậy quét acc
  // lâu năm KHÔNG "load mãi": mỗi lượt chỉ mở vài tab, phần còn lại rải lượt sau.
  const readBudget = Math.max(1, Number(opts.readBudget) || INBOX_READ_BUDGET);
  const slice = listThreads.slice(0, maxThreads);
  const plan = planInboxReads(slice, storedById, { budget: readBudget }, Date.now());

  const detailed = [];
  const startedAt = Date.now();
  const total = plan.toRead.length;
  let read = 0;
  let failed = 0;
  let timedOut = false;
  // Báo bắt đầu pha đọc chi tiết kèm tổng số thread sẽ đọc lượt này.
  try {
    broadcast("INBOX_PROGRESS", {
      phase: "read",
      status: "start",
      done: 0,
      total,
      text: "Chuẩn bị đọc " + total + " hội thoại…",
    });
  } catch (e) {}
  for (const th of plan.toRead) {
    // Trần thời gian THỰC: chạm trần thì dừng, thread còn lại để lượt sau.
    if (Date.now() - startedAt > INBOX_READ_TIME_CAP_MS) {
      timedOut = true;
      break;
    }
    const id = String(th.threadId);
    const prev = storedById.get(id) || {};
    // Phát tiến độ TRƯỚC mỗi lần đọc: người dùng thấy "Đang đọc 3/12 — <tên>".
    const doneSoFar = read + failed;
    try {
      broadcast("INBOX_PROGRESS", {
        phase: "read",
        status: "reading",
        done: doneSoFar,
        total,
        threadId: id,
        name: th.name || prev.name || "",
        text:
          "Đang đọc " + (doneSoFar + 1) + "/" + total +
          (th.name || prev.name ? " — " + (th.name || prev.name) : "") + "…",
      });
    } catch (e) {}
    const one = await readInboxThread(id, { silent: true });
    const gotMsgs =
      one &&
      one.ok &&
      one.thread &&
      Array.isArray(one.thread.messages) &&
      one.thread.messages.length > 0;

    if (gotMsgs) {
      // Thành công: reset bộ đếm hụt, đóng dấu đã đọc.
      read += 1;
      detailed.push(one.thread);
      try {
        await DB.upsertInboxThreads([
          {
            threadId: id,
            readAt: Date.now(),
            readAttempts: 0,
            emptyReads: 0,
            nextReadAt: null,
            lastReadError: null,
          },
        ]);
      } catch (e) {}
    } else {
      // Hụt (lỗi hoặc rỗng): tăng bộ đếm + đặt backoff để không kẹt lượt sau.
      failed += 1;
      const attempts = (Number(prev.readAttempts) || 0) + 1;
      const isEmpty = one && one.ok; // ok nhưng 0 tin => parse rỗng
      const emptyReads = (Number(prev.emptyReads) || 0) + (isEmpty ? 1 : 0);
      try {
        await DB.upsertInboxThreads([
          {
            threadId: id,
            readAt: Date.now(),
            readAttempts: attempts,
            emptyReads,
            nextReadAt: Date.now() + inboxBackoffMs(attempts),
            lastReadError: isEmpty
              ? "Đọc ra 0 tin (có thể chỉ có ảnh/sticker hoặc DOM chưa render)."
              : String((one && one.error) || "Đọc hụt."),
          },
        ]);
      } catch (e) {}
    }
    // Phát tiến độ SAU mỗi lần đọc (đếm đã hoàn tất) để thanh tiến trình nhích.
    try {
      broadcast("INBOX_PROGRESS", {
        phase: "read",
        status: "progress",
        done: read + failed,
        total,
        threadId: id,
      });
    } catch (e) {}
    await sleep(3500);
  }

  try {
    broadcast("INBOX_PROGRESS", {
      phase: "done",
      read,
      failed,
      total,
      timedOut,
      text: "Xong: đọc " + read + ", hụt " + failed + (timedOut ? " (chạm trần thời gian)" : "") + ".",
    });
  } catch (e) {}

  const threads = await DB.getInboxThreads();
  return {
    ok: true,
    threads,
    deep: true,
    read,
    failed,
    skipped: plan.skipped,
    deferred: plan.deferred,
    pending: Math.max(0, plan.counts.considered - plan.toRead.length),
    timedOut,
    counts: plan.counts,
    via,
  };
}

/**
 * MỞ & ĐỌC một hội thoại theo threadId: mở tab /messages/t/<id> ở nền, đọc tin,
 * đóng tab, UPSERT vào store. Trả về { ok, thread } hoặc { ok:false, error }.
 */
async function readInboxThread(threadId, readOpts) {
  const id = String(threadId || "").trim();
  if (!id) return { ok: false, error: "Thiếu mã hội thoại." };

  // silent: khi được scanInbox gọi trong vòng lặp, KHÔNG tự phát tiến độ (vòng
  // lặp đã phát nhịp "read N/total" rồi). Khi người dùng bấm mở 1 hội thoại,
  // silent=false để phát open→reading→done cho spinner có phản hồi thực.
  const silent = !!(readOpts && readOpts.silent);
  const emit = (payload) => {
    if (silent) return;
    try { broadcast("INBOX_PROGRESS", { threadId: id, ...payload }); } catch (e) {}
  };

  try {
    const blockState = await getCrawlBlockState();
    if (blockState && blockState.blocked) {
      emit({ phase: "thread", status: "error", text: "Hệ thống đang tạm dừng (kill-switch)." });
      return { ok: false, error: "Hệ thống đang tạm dừng (kill-switch): " + (blockState.reason || "không rõ") + "." };
    }
  } catch (e) {}

  emit({ phase: "thread", status: "opening", text: "Đang mở hội thoại…" });

  const url = "https://www.facebook.com/messages/t/" + encodeURIComponent(id);
  const active = await shouldFocusTabs();
  const tab = await new Promise((r) => chrome.tabs.create({ url, active }, r));
  let out = { ok: false, error: "Không có kết quả." };
  let name = "";
  try {
    await waitTabComplete(tab.id, 30000);
    // Chờ ngắn cho khung chat khởi tạo; runReadThreadInPage tự poll thêm
    // (8×1500ms) đến khi tin render, nên không cần chờ cố định lâu ở đây.
    emit({ phase: "thread", status: "reading", text: "Đang giải mã & đọc tin…" });
    await sleep(1500);

    // DOM-FIRST (đã kiểm chứng bằng dữ liệu bắt thật): tin nhắn Messenger được
    // MÃ HOÁ ĐẦU-CUỐI (Labyrinth V1_1). API mạng chỉ trả METADATA mã hoá
    // (sender_id/sort_order_ms), KHÔNG có text; IndexedDB cũng là ciphertext
    // ("maw_ear"). Vì vậy DOM sau khi trang tự giải mã là nguồn text DUY NHẤT.
    // Đọc thẳng DOM theo aria-label (đã cho cả text lẫn tên người gửi) — bỏ
    // luôn bước chờ template API ~15s vốn không bao giờ ra text cho thread E2EE.
    let res;
    try {
      res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: runReadThreadInPage,
      });
    } catch (e) {
      emit({ phase: "thread", status: "error", text: "Lỗi chạy script đọc hội thoại." });
      return { ok: false, error: "Lỗi chạy script đọc hội thoại: " + String(e) };
    }
    out = (res && res[0] && res[0].result) || out;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
  if (!out.ok) {
    emit({ phase: "thread", status: "error", text: String(out.error || "Đọc hụt.") });
    return out;
  }

  const messages = Array.isArray(out.messages) ? out.messages : [];
  name = out.name || "";
  await DB.upsertInboxThreads([
    {
      threadId: id,
      name,
      threadUrl: url,
      messages,
      unread: false, // vừa đọc xong -> coi như đã đọc trong app
    },
  ]);
  const thread = await DB.getInboxThread(id);
  emit({
    phase: "thread",
    status: "done",
    text: "Đã đọc " + messages.length + " tin.",
    count: messages.length,
  });
  return { ok: true, thread };
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
  scanInbox,
  readInboxThread,
  planInboxReads,
  inboxBackoffMs,
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
};
