/**
 * crawl.js — Crawl theo nhóm, quét nhóm đã tham gia, automation đăng bài/bình
 * luận, lập lịch chạy job (jobTick), tự động crawl nền (autoCrawl) và tự động
 * đồng bộ giá (autoSync). Tách từ background.js (B3 — chia module theo domain).
 */
import * as DB from "./db.js";
import { getActiveTab, waitTabComplete, sleep, broadcast } from "./util.js";
import { syncAllSources } from "./prices.js";

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
  const url = "https://www.facebook.com/groups/" + groupId + "/";
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
  const map = {};
  document.querySelectorAll('a[href*="/groups/"]').forEach((a) => {
    const href = a.href || "";
    const m = href.match(/\/groups\/([^/?#]+)/);
    if (!m) return;
    const id = m[1];
    if (RESERVED.has(id)) return;
    const name = (a.textContent || "").trim();
    if (name && name.length > 1 && !/^https?:/i.test(name) && !map[id]) {
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
  try {
    document.execCommand("insertText", false, text);
  } catch (e) {
    box.textContent = text;
  }
  await sleep(1600);

  // 2b) Đính kèm ảnh (nếu có).
  const dialogScope = box.closest('div[role="dialog"]') || document;
  try {
    await attachImages(dialogScope);
  } catch (e) {}

  // 3) Bấm nút Đăng.
  const scope = box.closest('div[role="dialog"]') || document;
  const btns = [...scope.querySelectorAll('div[role="button"], button')];
  let postBtn = btns.find((b) => {
    const t = lower(b);
    return t === "đăng" || t === "post";
  });
  if (!postBtn) return { ok: false, error: "Không tìm thấy nút Đăng." };
  // Chờ nút hết disabled.
  for (let i = 0; i < 8 && postBtn.getAttribute("aria-disabled") === "true"; i++) {
    await sleep(700);
  }
  try { postBtn.click(); } catch (e) {}
  await sleep(3200);

  // 4) Cố gắng bắt permalink của ĐÚNG bài vừa đăng (best-effort).
  //    QUAN TRỌNG: dùng ĐÚNG cách đã chứng minh trong content.js. Trong NHÓM,
  //    BÀI VIẾT là Ô CON của [role="feed"] (DIV), KHÔNG phải [role="article"]
  //    (đó là BÌNH LUẬN). Phải duyệt feed-child + lọc link bình luận, nếu không
  //    sẽ không bao giờ bắt được link bài => modal xoá-trên-FB không hiện.
  const findPostUrl = () => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const needle = norm(text).slice(0, 60);
    const PATTERNS = [
      /\/groups\/[^/]+\/posts\/(\d+)/,
      /\/groups\/[^/]+\/permalink\/(\d+)/,
      /multi_permalinks?=(\d+)/,
      /[?&]story_fbid=(\d+)/,
      /\/permalink\/(\d+)/,
      /\/posts\/(\d+)/,
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
  try {
    document.execCommand("insertText", false, text);
  } catch (e) {
    box.textContent = text;
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
  }
  return (res && res[0] && res[0].result) || { ok: false, error: "Không có kết quả." };
}

async function executeCommentJob(job) {
  const url = job.targetUrl;
  if (!url) return { ok: false, error: "Thiếu link bài viết để bình luận." };
  const images = Array.isArray(job.images) ? job.images : [];
  // CHẠY NGẦM: mở tab ở NỀN (active:false) để KHÔNG chiếm màn hình người dùng;
  // waitTabComplete chỉ nghe tabs.onUpdated nên không cần tab active. Đóng tab
  // sau khi xong để không để lại tab rác.
  const tab = await new Promise((r) => chrome.tabs.create({ url, active: false }, r));
  await waitTabComplete(tab.id, 30000);
  await sleep(3500);
  let res;
  try {
    res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runCommentInPage,
      args: [job.content || "", images],
    });
  } catch (e) {
    return { ok: false, error: "Lỗi chạy script bình luận: " + String(e) };
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch (e) {}
  }
  return (res && res[0] && res[0].result) || { ok: false, error: "Không có kết quả." };
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
  // Cuộn nhẹ để FB tải khu vực bình luận.
  try { window.scrollTo(0, Math.floor(document.body.scrollHeight / 3)); } catch (e) {}
  await sleep(2000);

  // Bấm "Xem thêm bình luận / Xem các câu trả lời" để lộ reply ẩn (best-effort).
  const moreKeys = [
    "xem thêm bình luận", "xem các câu trả lời", "xem tất cả", "trả lời",
    "view more comments", "view more replies", "view all", "replies",
  ];
  for (let pass = 0; pass < 2; pass++) {
    const btns = [...document.querySelectorAll('div[role="button"], span[role="button"], a[role="link"]')];
    let clicked = 0;
    for (const b of btns) {
      const t = (b.textContent || "").trim().toLowerCase();
      if (!t || t.length > 40) continue;
      if (moreKeys.some((k) => t.includes(k))) {
        try { b.click(); clicked++; } catch (e) {}
        if (clicked >= 6) break;
      }
    }
    if (!clicked) break;
    await sleep(1800);
  }

  const REPLY_RE = /[?&]reply_comment_id=(\d+)/;
  const COMMENT_RE = /[?&]comment_id=(\d+)/;
  // Chuẩn hoá khoảng trắng để khớp text bền hơn (FB hay chèn xuống dòng/space).
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const needle = norm(myCommentText).slice(0, 50);

  // SỰ THẬT VỀ DOM (theo buildCleanSample trong content.js): trong NHÓM NÀY bình
  // luận/trả lời KHÔNG phải [role="article"] lồng nhau, mà là các mục <li> trong
  // <ul> — mỗi mục chứa link `comment_id`. Một REPLY có link chứa CẢ
  // `comment_id=<bình luận cha>` VÀ `reply_comment_id=<chính nó>`. Đây là tín
  // hiệu DUY NHẤT đáng tin để biết reply thuộc bình luận NÀO -> bám chặt vào nó,
  // KHÔNG đoán theo cấu trúc lồng (sẽ vơ nhầm bình luận của người khác).

  // Đơn vị (mục) chứa một anchor bình luận: ưu tiên <li>, rồi [role="article"].
  const unitOf = (el) => {
    if (!el || !el.closest) return el && el.parentElement;
    return el.closest('li') || el.closest('[role="article"]') || el.parentElement || el;
  };
  const authorOf = (unit) => {
    const a = unit.querySelector('a[href*="/user/"], a[href*="/profile.php"], strong a, h3 a, a[role="link"][href*="facebook.com"]');
    return a ? (a.textContent || "").trim() : "";
  };
  // Text của một mục reply: div[dir="auto"] dài nhất trong mục đó.
  const textOf = (unit) => {
    let best = "";
    for (const d of unit.querySelectorAll('div[dir="auto"], span[dir="auto"]')) {
      const t = (d.textContent || "").trim();
      if (t.length > best.length) best = t;
    }
    if (!best) best = (unit.textContent || "").trim();
    return best.slice(0, 1500);
  };

  // 1) Xác định comment_id của BÌNH LUẬN CỦA TA (parentId).
  //    - Nếu đã biết sẵn (qua job) thì dùng luôn.
  //    - Nếu chưa: tìm anchor có comment_id NHƯNG KHÔNG có reply_comment_id (=>
  //      là bình luận CHA, không phải reply) mà mục chứa nó khớp nội dung của ta.
  let parentId = myCommentId ? String(myCommentId) : null;
  if (!parentId && needle) {
    let bestLen = Infinity;
    for (const a of document.querySelectorAll('a[href*="comment_id"]')) {
      const href = a.href || a.getAttribute("href") || "";
      if (REPLY_RE.test(href)) continue; // bỏ link reply
      const cm = href.match(COMMENT_RE);
      if (!cm) continue;
      const unit = unitOf(a);
      if (!unit) continue;
      const full = norm(unit.textContent);
      if (!full.includes(needle)) continue;
      // Mục nhỏ nhất (theo full text) còn chứa needle = sát bình luận ta nhất.
      if (full.length < bestLen) { bestLen = full.length; parentId = cm[1]; }
    }
  }

  // Không xác định được bình luận của ta -> KHÔNG đoán, trả rỗng (kèm cờ để chẩn đoán).
  if (!parentId) {
    return { ok: true, replies: [], parentId: null, noParent: true };
  }

  // 2) Gom REPLY thuộc ĐÚNG bình luận của ta: anchor có reply_comment_id VÀ
  //    comment_id === parentId. Khử trùng theo reply_comment_id.
  const byReplyId = new Map();
  for (const a of document.querySelectorAll('a[href*="reply_comment_id"]')) {
    const href = a.href || a.getAttribute("href") || "";
    const cm = href.match(COMMENT_RE);
    const rm = href.match(REPLY_RE);
    if (!cm || !rm) continue;
    if (cm[1] !== parentId) continue; // reply của bình luận KHÁC -> bỏ
    if (byReplyId.has(rm[1])) continue;
    const unit = unitOf(a);
    if (unit) byReplyId.set(rm[1], unit);
  }

  const out = [];
  for (const [replyId, unit] of byReplyId) {
    const author = authorOf(unit);
    const text = textOf(unit);
    if (!text) continue;
    // Bỏ nếu mục chính là bình luận của ta (an toàn).
    if (needle && norm(text).includes(needle)) continue;
    out.push({ id: replyId, author, text });
  }

  return { ok: true, replies: out, parentId };
}

/** Mở permalink bình luận của ta ở tab NỀN, quét reply, đóng tab. */
async function executeWatchReplies(conv) {
  const url = conv.myCommentUrl || conv.postUrl;
  if (!url) return { ok: false, error: "Thiếu link để theo dõi reply." };
  const tab = await new Promise((r) => chrome.tabs.create({ url, active: false }, r));
  await waitTabComplete(tab.id, 30000);
  await sleep(3500);
  let res;
  try {
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
 * Tôn trọng "Số luồng tối đa" (options.maxThreads): chạy song song tối đa N nhóm
 * cùng lúc bằng một pool worker, thay vì mở tuần tự từng tab một.
 */
async function processAutoCrawl() {
  if (_autoCrawling) return;
  const cfg = await getAutoCrawlConfig();
  if (!cfg.enabled) return;
  _autoCrawling = true;
  try {
    const groups = await DB.getGroups();
    // (4) Ngẫu nhiên thứ tự nhóm mỗi chu kỳ -> tránh mẫu "máy" crawl đúng một thứ tự.
    const order = shuffleInPlace((groups || []).slice()).filter(
      (g) => g && (g.groupId || g.id)
    );
    const opts = cfg.options || {};
    // Số luồng song song: kẹp trong [1, 20] và không vượt quá số nhóm.
    const threads = Math.max(
      1,
      Math.min(20, parseInt(opts.maxThreads, 10) || 1, order.length || 1)
    );

    let cursor = 0; // chỉ số nhóm kế tiếp cần xử lý (dùng chung giữa các worker)

    // Mỗi worker lần lượt nhận nhóm kế tiếp cho tới khi hết hàng đợi.
    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= order.length) break;
        const g = order[idx];
        const gid = g && (g.groupId || g.id);
        if (!gid) continue;
        try {
          await crawlGroupInTab(gid, opts);
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
  try {
    let convs = await DB.getConversations();
    // Chỉ theo dõi hội thoại chưa đóng và có link để mở.
    convs = (convs || []).filter(
      (c) => c && c.status !== "closed" && (c.myCommentUrl || c.postUrl)
    );
    const limit = Math.max(1, Math.min(30, parseInt(opts.maxPerRun, 10) || cfg.maxPerRun));
    convs = convs.slice(0, limit);
    for (const c of convs) {
      const res = await executeWatchReplies(c);
      checked += 1;
      // Không định vị được bình luận của ta trên trang -> đếm để báo rõ.
      if (res && res.ok && res.noParent) noParent += 1;
      // Lần đầu suy ra được comment_id của ta (comment thủ công) -> lưu lại để
      // các lượt quét sau chính xác và nhanh hơn.
      if (res && res.ok && res.parentId && !c.commentId) {
        try { await DB.updateConversation(c.id, { commentId: res.parentId }); } catch (e) {}
      }
      if (res && res.ok && Array.isArray(res.replies) && res.replies.length) {
        const m = await DB.mergeReplies(c.id, res.replies);
        if (m && m.added) {
          newReplies += m.added;
          broadcast("CONVERSATION_UPDATE", { id: c.id, added: m.added });
        }
      }
      // Giãn cách 15–45s giữa các hội thoại (như jitter auto-crawl).
      await sleep(randInt(15000, 45000));
    }
  } catch (e) {
    // bỏ qua, chờ chu kỳ sau
  } finally {
    _watching = false;
  }
  return { ok: true, checked, newReplies, noParent };
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
  getCrawlTabs,
  addCrawlTab,
  removeCrawlTab,
  startCrawlInActiveTab,
  stopCrawlInActiveTab,
  crawlGroupInTab,
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
