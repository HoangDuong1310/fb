/**
 * content.js — Chạy trên trang nhóm Facebook.
 *
 * Nhiệm vụ:
 *  - Cuộn feed nhóm để tải thêm bài.
 *  - Bóc tách dữ liệu từng bài viết (DOM).
 *  - Crawl TĂNG DẦN: bỏ qua bài đã có trong IndexedDB; dừng sớm khi gặp nhiều
 *    bài đã biết liên tiếp (feed sắp theo thời gian => phần sau toàn bài cũ).
 *
 * Lưu ý quan trọng về độ bền:
 *  - Facebook random hoá class => KHÔNG bám class. Chỉ bám các "mỏ neo" ổn định:
 *    role="article", mẫu URL permalink, role="img", thẻ a chứa thời gian...
 *  - Mỗi bước bóc tách bọc try/catch để 1 bài lỗi không làm hỏng cả phiên.
 */

(() => {
  // Tránh nạp 2 lần (manifest + executeScript).
  if (window.__FB_GROUP_CRAWLER_LOADED__) return;
  window.__FB_GROUP_CRAWLER_LOADED__ = true;

  const state = {
    running: false,
    stopRequested: false,
  };

  // ---- Tiện ích ----------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Log chẩn đoán hiện NGAY trong Console của tab Facebook (content script chạy ở
  // "isolated world" => console.log này thuộc về tab, không cần gõ lệnh gì).
  // Muốn tắt: gõ ở Console của tab  ->  window.__FBC_DEBUG = false
  if (typeof window.__FBC_DEBUG === "undefined") window.__FBC_DEBUG = true;
  const dlog = (...args) => {
    if (window.__FBC_DEBUG) console.log("%c[FBC]", "color:#1877f2;font-weight:bold", ...args);
  };

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (res) => {
          // Bỏ qua lỗi "no receiver" khi popup đóng.
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function getGroupInfo() {
    const m = location.pathname.match(/\/groups\/([^/?#]+)/);
    const groupId = m ? m[1] : "unknown";
    let groupName = groupId;
    // Tiêu đề trang thường có dạng "Tên nhóm | Facebook".
    if (document.title) {
      groupName = document.title.replace(/\s*\|\s*Facebook\s*$/i, "").trim() || groupId;
    }
    // Thử lấy tên nhóm chính xác hơn từ heading đầu trang.
    const h = document.querySelector('h1');
    if (h && h.textContent && h.textContent.trim().length > 0) {
      groupName = h.textContent.trim();
    }
    return { groupId, groupName };
  }

  // ---- Trích postId & permalink -----------------------------------------

  // QUAN TRỌNG: Facebook hiện đại dùng token "pfbid..." (chữ + số) cho permalink
  // bài viết trong nhóm, ví dụ /groups/123/posts/pfbid0AbC.../ — KHÔNG còn là số
  // thuần. Regex cũ chỉ bắt (\d+) nên BỎ SÓT gần như toàn bộ bài => quét ra 0 ô.
  // Vì vậy mỗi pattern phải chấp nhận CẢ pfbid… LẪN id số cũ.
  const PID = "(pfbid[A-Za-z0-9]+|\\d+)";
  const POST_ID_PATTERNS = [
    new RegExp("/groups/[^/]+/posts/" + PID),
    new RegExp("/groups/[^/]+/permalink/" + PID),
    new RegExp("multi_permalinks?=" + PID),
    new RegExp("[?&]story_fbid=" + PID),
    // Bài có ẢNH: link ảnh lộ postId của BÀI qua "...&set=gm.{postId}"
    // (gm = group post/story id). Đây là nguồn postId TĨNH, không cần hover —
    // xử lý phần lớn bài rao bán (thường kèm ảnh) ngay lập tức.
    new RegExp("[?&]set=gm\\." + PID),
    new RegExp("/permalink/" + PID),
    new RegExp("/posts/" + PID),
  ];

  function extractPostIdFromUrl(url) {
    if (!url) return null;
    for (const re of POST_ID_PATTERNS) {
      const m = url.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  /** Tìm permalink + postId trong 1 article. */
  function findPermalink(article) {
    const anchors = article.querySelectorAll('a[href*="/groups/"], a[href*="story_fbid"], a[href*="permalink"], a[href*="/posts/"]');
    for (const a of anchors) {
      const href = a.href || a.getAttribute("href") || "";
      // QUAN TRỌNG: bỏ link BÌNH LUẬN (chứa comment_id). Link bình luận vẫn chứa
      // postId của BÀI CHA; nếu không lọc sẽ tưởng nhầm mỗi bình luận là 1 "bài"
      // và lưu đè dưới cùng postId => data ra toàn bình luận.
      if (/comment_id=|reply_comment_id=/i.test(href)) continue;
      const id = extractPostIdFromUrl(href);
      if (id) {
        // Chuẩn hoá về URL tuyệt đối, bỏ tham số rác.
        let clean = href;
        try {
          const u = new URL(href, location.origin);
          clean = u.origin + u.pathname;
        } catch (e) {}
        return { postId: id, permalink: clean };
      }
    }
    return { postId: null, permalink: null };
  }

  /** Lấy postId của BÀI từ bất kỳ link nào trong container (kể cả link bình luận,
   *  vì link bình luận vẫn chứa postId của BÀI CHA). */
  function getPostIdFrom(root) {
    if (!root || !root.querySelectorAll) return null;
    // Quét MỌI anchor (không chỉ /posts|/permalink|story_fbid|multi_permalink):
    // bài có ẢNH lộ postId qua link ảnh "...&set=gm.{id}". Link TÁC GIẢ
    // (/groups/{gid}/user/{uid}) KHÔNG khớp pattern nào nên không gây nhầm; link
    // BÌNH LUẬN (comment_id) bị loại để khỏi tưởng nhầm bình luận là bài.
    const anchors = root.querySelectorAll("a[href]");
    for (const a of anchors) {
      const href = a.href || a.getAttribute("href") || "";
      if (/comment_id=|reply_comment_id=/i.test(href)) continue;
      const id = extractPostIdFromUrl(href);
      if (id) return id;
    }
    return null;
  }

  /** Một ô con của feed có phải BÀI VIẾT không? Bài LUÔN có link tác giả dạng
   *  /groups/{gid}/user/{uid}/ — dùng làm dấu hiệu nhận diện kể cả khi permalink
   *  còn bị FB ẩn (chưa hover). Nhờ vậy không bỏ sót bài chỉ-chữ. */
  function isPostContainer(el) {
    if (!el || !el.querySelector) return false;
    if (getPostIdFrom(el)) return true;
    return !!el.querySelector('a[href*="/groups/"][href*="/user/"]');
  }

  /** Bài CHỈ-CHỮ (không ảnh) không lộ set=gm nên permalink bị FB ẩn: href ở thẻ
   *  thời gian chỉ được gắn khi hover (chống cào). Ta hover thử các ứng viên để
   *  FB nạp href thật rồi đọc lại postId. Best-effort, có timeout ngắn. */
  async function revealPostId(container) {
    if (!container || !container.querySelectorAll) return null;
    const fire = (el, type, Ctor) => {
      try {
        el.dispatchEvent(
          new Ctor(type, { bubbles: true, cancelable: true, view: window })
        );
      } catch (e) {}
    };
    // Ứng viên permalink: link có fragment "#", role=link, href rỗng/"#".
    const cands = [
      ...container.querySelectorAll(
        'a[href*="#"], a[role="link"], [role="link"], a[href="#"], a:not([href])'
      ),
    ].slice(0, 10);
    for (const el of cands) {
      fire(el, "pointerover", PointerEvent);
      fire(el, "pointerenter", PointerEvent);
      fire(el, "mouseover", MouseEvent);
      fire(el, "mouseenter", MouseEvent);
      fire(el, "mousemove", MouseEvent);
      if (typeof el.focus === "function") {
        try {
          el.focus();
        } catch (e) {}
      }
    }
    // Chờ FB gắn href (React re-render). Thử đọc lại tối đa ~0.75s.
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const id = getPostIdFrom(container);
      if (id) return id;
    }
    return null;
  }

  /** Dựng permalink chuẩn của bài từ groupId + postId. */
  function buildPermalink(groupId, postId) {
    return location.origin + "/groups/" + groupId + "/posts/" + postId + "/";
  }

  // ---- Vân tay nội dung (id dự phòng cho bài ẩn permalink) ---------------

  /** Băm chuỗi -> id ngắn ổn định (djb2, base36). Không cần mật mã, chỉ cần
   *  ĐỊNH DANH ỔN ĐỊNH giữa các lần quét. */
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; // h*33 + c, giữ 32-bit không dấu
    }
    return h.toString(36);
  }

  /** Tạo id "vân tay" cho bài CHỈ-CHỮ mà Facebook ẩn permalink (chỉ hiện khi
   *  hover). Cơ sở = tác giả + text + ảnh đầu, ĐÃ LOẠI timeText (vì thời gian
   *  tương đối trôi theo lúc quét, đưa vào sẽ làm id đổi mỗi lần). Nhờ vậy bài
   *  không có permalink vẫn được LƯU và DEDUP đúng giữa các phiên crawl. Trả
   *  null nếu không đủ dữ liệu (không text, không ảnh) để định danh. */
  function fingerprintId(groupId, authorName, text, images) {
    const norm = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const img0 = images && images[0] ? String(images[0]).split("?")[0] : "";
    if (!norm && !img0) return null; // không có gì để định danh ổn định
    const basis = String(authorName || "") + "|" + norm + "|" + img0;
    return "fp:" + groupId + ":" + hashStr(basis);
  }

  /**
   * Tìm danh sách "ô bài viết" trong feed.
   * QUAN TRỌNG (theo cấu trúc THỰC TẾ của nhóm này): BÀI VIẾT là MỘT Ô CON của
   * [role="feed"] (thẻ DIV), KHÔNG phải [role="article"]. Ngược lại, BÌNH LUẬN
   * mới là [role="article"] và nằm LỒNG bên trong ô bài. Vì vậy phải duyệt theo
   * feed-child rồi loại vùng bình luận, thay vì duyệt [role="article"].
   */
  function findPostContainers() {
    // CÓ THỂ có NHIỀU [role="feed"] trên trang (feed bài chính, sidebar nhóm,
    // danh sách "nổi bật"...). Lấy querySelector đầu tiên dễ trúng nhầm feed phụ
    // (sidebar/highlights) => quét ra 0 bài dù bài vẫn hiện. Vì vậy duyệt TẤT CẢ
    // feed và chọn tập ô-bài lớn nhất tìm được. Nhận diện ô bài bằng
    // isPostContainer (có link tác giả) THAY VÌ bắt buộc có postId: bài chỉ-chữ
    // ẩn permalink đến khi hover, nếu đòi postId ngay sẽ bỏ sót gần hết bài.
    const feeds = [...document.querySelectorAll('[role="feed"]')];
    let best = [];
    for (const feed of feeds) {
      const kids = [...feed.children].filter((c) => isPostContainer(c));
      if (kids.length > best.length) best = kids;
    }
    if (best.length) return best;
    // Fallback layout cũ: một số nhóm render BÀI bằng [role="article"] cấp cao nhất.
    return [...document.querySelectorAll('[role="article"]')].filter(
      (a) => !(a.parentElement && a.parentElement.closest('[role="article"]')) && isPostContainer(a)
    );
  }

  /** Tìm lại ô bài CÒN SỐNG trong DOM theo postId. Feed FB ảo hoá có thể gỡ
   *  (unmount) node cũ giữa lúc quét và lúc bóc tách => node đã detach, thân bài
   *  rỗng. Quét lại feed hiện tại để lấy node mới cho đúng postId. */
  function findContainerByPostId(postId) {
    if (!postId) return null;
    for (const c of findPostContainers()) {
      if (getPostIdFrom(c) === postId) return c;
    }
    return null;
  }

  // ---- Trích các trường dữ liệu -----------------------------------------

  function extractAuthor(article) {
    // Tác giả thường là link profile đầu tiên có chữ in đậm/strong nằm gần đầu bài.
    const candidates = article.querySelectorAll(
      'a[href*="/user/"], a[href*="/profile.php"], a[role="link"][href*="facebook.com"], strong a, h2 a, h3 a, h4 a'
    );
    for (const a of candidates) {
      if (belongsToComment(a, article)) continue; // bỏ tác giả của bình luận
      const text = (a.textContent || "").trim();
      const href = a.href || "";
      if (text && text.length > 1 && !/^https?:/i.test(text)) {
        let profile = href;
        try {
          const u = new URL(href, location.origin);
          profile = u.origin + u.pathname + (u.search.includes("id=") ? u.search : "");
        } catch (e) {}
        return { authorName: text, authorProfile: profile };
      }
    }
    return { authorName: null, authorProfile: null };
  }

  // Quy đổi text thời gian FB (tương đối hoặc tuyệt đối) -> epoch ms.
  // Tính theo MỐC HIỆN TẠI (lúc crawl) vì FB hiển thị thời gian tương đối.
  // Trả null nếu không nhận dạng được (vẫn giữ timeText để người dùng đọc).
  function parseRelativeTime(text) {
    if (!text) return null;
    const s = String(text).trim().toLowerCase();
    const now = Date.now();
    let m;
    if (/vừa xong|just now/.test(s)) return now;
    if ((m = s.match(/(\d+)\s*(giây|giay|sec|s\b)/))) return now - Number(m[1]) * 1000;
    if ((m = s.match(/(\d+)\s*(phút|phut|min|m\b)/))) return now - Number(m[1]) * 60000;
    if ((m = s.match(/(\d+)\s*(giờ|gio|hour|h\b)/))) return now - Number(m[1]) * 3600000;
    if ((m = s.match(/(\d+)\s*(tuần|tuan|week|w\b)/))) return now - Number(m[1]) * 604800000;
    if (/hôm qua|yesterday/.test(s)) return now - 86400000;
    if ((m = s.match(/(\d+)\s*(ngày|ngay|day|d\b)/))) return now - Number(m[1]) * 86400000;
    // Dạng tuyệt đối: "12 tháng 6" (ngày Tháng tháng), có thể kèm ", 2024" và "lúc 14:05".
    if ((m = s.match(/(\d{1,2})\s*tháng\s*(\d{1,2})(?:\s*,?\s*(\d{4}))?/))) {
      const day = Number(m[1]);
      const month = Number(m[2]) - 1;
      const year = m[3] ? Number(m[3]) : new Date().getFullYear();
      const tm = s.match(/(?:lúc|at)\s*(\d{1,2}):(\d{2})/);
      let ts = tm
        ? new Date(year, month, day, Number(tm[1]), Number(tm[2])).getTime()
        : new Date(year, month, day).getTime();
      // Nếu suy ra ngày trong tương lai (do mặc định năm hiện tại) -> lùi 1 năm.
      if (ts > now + 86400000) ts = new Date(year - 1, month, day).getTime();
      return ts;
    }
    return null;
  }

  function extractTimestamp(article) {
    // FB hiện không dùng <abbr>. Thời gian đăng nằm trong CHÍNH link permalink
    // của bài (ví dụ "5 giờ", "12 Tháng 6"). Ưu tiên đọc text của link đó.
    const TIME_RE =
      /(\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)|hôm qua|vừa xong|\d{1,2}\s*tháng|just now|yesterday|\d+\s*(s|m|h|d|w|y)\b|hour|min|day|week|month|year)/i;

    // Trường hợp cũ còn <abbr>.
    const abbr = article.querySelector("abbr[data-utime], abbr[title]");
    if (abbr) {
      const utime = abbr.getAttribute("data-utime");
      if (utime) return { timestamp: Number(utime) * 1000, timeText: abbr.getAttribute("title") || abbr.textContent || "" };
    }

    // Ưu tiên LINK THỜI GIAN CỦA CHÍNH BÀI: href chứa postId nhưng KHÔNG có
    // comment_id (link thời gian của bình luận luôn kèm comment_id).
    const postId = getPostIdFrom(article);
    const all = Array.from(
      article.querySelectorAll(
        'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[role="link"]'
      )
    );
    const own = [];
    const rest = [];
    for (const a of all) {
      const href = a.getAttribute("href") || "";
      if (postId && href.indexOf(postId) !== -1 && !/comment_id/.test(href)) own.push(a);
      else rest.push(a);
    }

    for (const a of own.concat(rest)) {
      if (belongsToComment(a, article)) continue; // bỏ link thời gian của bình luận
      const aria = (a.getAttribute("aria-label") || "").trim();
      if (aria && TIME_RE.test(aria)) return { timestamp: parseRelativeTime(aria), timeText: aria };
      const t = (a.innerText || a.textContent || "").trim();
      if (t && t.length <= 40 && TIME_RE.test(t)) return { timestamp: parseRelativeTime(t), timeText: t };
    }
    return { timestamp: null, timeText: null };
  }

  async function expandSeeMore(article) {
    // Bấm "Xem thêm" / "See more" của NỘI DUNG BÀI để lấy đủ text.
    // Khớp mềm (endsWith) vì FB hay nối "...Xem thêm" liền nội dung.
    // Bỏ qua nút thuộc bình luận lồng nhau và nút "Xem thêm bình luận".
    try {
      const buttons = article.querySelectorAll('div[role="button"], span[role="button"]');
      for (const s of buttons) {
        if (belongsToComment(s, article)) continue; // nút "Xem thêm" của bình luận

        const t = (s.textContent || "").trim().toLowerCase();
        if (!t) continue;

        const isSeeMore =
          t === "xem thêm" ||
          t === "see more" ||
          t.endsWith("xem thêm") ||
          t.endsWith("see more");
        const isComments =
          t.includes("bình luận") ||
          t.includes("comment") ||
          t.includes("trả lời") ||
          t.includes("repl");

        if (isSeeMore && !isComments) {
          try {
            s.click();
          } catch (e) {}
          await sleep(150);
        }
      }
    } catch (e) {}
  }

  function extractText(article) {
    // Ưu tiên "mỏ neo" đánh dấu phần NỘI DUNG bài (chất lượng cao, ít nhiễu UI).
    const messageSelectors = [
      '[data-ad-comet-preview="message"]',
      '[data-ad-preview="message"]',
      '[data-ad-rendering-role="story_message"]',
      'div[data-testid="post_message"]',
    ];
    for (const sel of messageSelectors) {
      for (const el of article.querySelectorAll(sel)) {
        if (belongsToComment(el, article)) continue; // bỏ mỏ neo thuộc bình luận
        const t = (el.innerText || el.textContent || "").trim();
        if (t) return t;
      }
    }

    // Fallback: gom text thuộc CHÍNH bài này (bỏ bình luận = article lồng nhau).
    // Bao gồm cả TIÊU ĐỀ h1/h2/h3 và [role="heading"]: Facebook render bài CHỈ CÓ
    // CHỮ NGẮN vào <h3><strong> chứ không phải div[dir="auto"] => phải bắt cả 2 kiểu.
    // KHÔNG lọc theo role="button": FB bọc nội dung bài trong phần tử clickable,
    // lọc nhầm sẽ làm RỖNG toàn bộ text (chính là lỗi trước đó).
    let best = "";
    const blocks = article.querySelectorAll(
      'div[dir="auto"], span[dir="auto"], h1, h2, h3, [role="heading"]'
    );
    for (const b of blocks) {
      if (belongsToComment(b, article)) continue; // bỏ text thuộc bình luận
      const t = (b.innerText || b.textContent || "").trim();
      if (t.length > best.length) best = t;
    }
    if (best) return best;

    // Cuối cùng: lấy toàn bộ innerText của bài (nhiều nhiễu nhưng không rỗng nếu
    // bài có nội dung hiển thị).
    return (article.innerText || article.textContent || "").trim();
  }

  function extractImages(article) {
    const urls = new Set();
    // Ảnh dạng <img> trong bài (bỏ ảnh thuộc bình luận = article lồng nhau).
    article.querySelectorAll("img").forEach((el) => {
      if (belongsToComment(el, article)) return;
      const src =
        el.currentSrc ||
        el.getAttribute("src") ||
        el.getAttribute("data-src") ||
        "";
      if (src && /scontent|fbcdn/i.test(src)) urls.add(src);
    });
    // Ảnh dạng background-image trên div.
    article.querySelectorAll('[style*="background-image"]').forEach((el) => {
      if (belongsToComment(el, article)) return;
      const style = el.getAttribute("style") || "";
      const m = style.match(/url\(["']?(.*?)["']?\)/);
      if (m && /scontent|fbcdn/i.test(m[1])) urls.add(m[1]);
    });
    return Array.from(urls);
  }

  function extractVideos(article) {
    const urls = new Set();
    article.querySelectorAll("video").forEach((v) => {
      if (v.src) urls.add(v.src);
      const source = v.querySelector("source");
      if (source && source.src) urls.add(source.src);
    });
    return Array.from(urls);
  }

  function extractExternalLinks(article, ownPermalink) {
    const links = new Set();
    article.querySelectorAll('a[href^="http"]').forEach((a) => {
      const href = a.href || "";
      // Bỏ link nội bộ facebook và chính permalink của bài.
      if (/facebook\.com|fb\.com|fbcdn|fb\.watch/i.test(href)) return;
      if (href === ownPermalink) return;
      links.add(href);
    });
    return Array.from(links);
  }

  function extractCounts(article) {
    let reactions = null;
    let comments = null;
    // Reaction: phần tử có aria-label dạng "120 lượt thích" / "120 reactions".
    const reactEl = article.querySelector('[aria-label*="action"], [aria-label*="cảm xúc"], [aria-label*="thích"]');
    if (reactEl) {
      const n = (reactEl.getAttribute("aria-label") || "").match(/[\d.,]+/);
      if (n) reactions = parseCount(n[0]);
    }
    // Comment: tìm text "bình luận" / "comments".
    const all = article.querySelectorAll("span, div");
    for (const el of all) {
      const t = (el.textContent || "").trim().toLowerCase();
      if (/\b\d[\d.,]*\s*(bình luận|comments?)\b/.test(t)) {
        const n = t.match(/[\d.,]+/);
        if (n) {
          comments = parseCount(n[0]);
          break;
        }
      }
    }
    return { reactions, comments };
  }

  function parseCount(s) {
    if (!s) return null;
    const clean = String(s).replace(/\./g, "").replace(/,/g, "");
    const n = parseInt(clean, 10);
    return Number.isNaN(n) ? null : n;
  }

  // ---- Crawl theo selector do AI khám phá (nếu có) -----------------------

  function readValue(el, attr) {
    if (!el) return null;
    if (!attr || attr === "text" || attr === "innerText" || attr === "textContent") {
      return (el.innerText || el.textContent || "").trim() || null;
    }
    if (attr === "href" && el.href) return el.href;
    if (attr === "src") return el.currentSrc || el.src || el.getAttribute("src") || null;
    const v = el.getAttribute(attr);
    return v ? v.trim() : null;
  }

  /** Lấy danh sách CSS selector ứng viên từ 1 spec (chấp nhận mảng hoặc chuỗi). */
  function specSelectors(spec) {
    if (!spec) return [];
    if (Array.isArray(spec.selectors)) return spec.selectors.filter(Boolean);
    if (typeof spec.selector === "string" && spec.selector) return [spec.selector];
    return [];
  }

  /**
   * True nếu phần tử nằm trong VÙNG BÌNH LUẬN (không thuộc thân bài đang xét).
   * Facebook render bình luận theo nhiều kiểu khác nhau giữa các nhóm:
   *   1) article lồng nhau ([role="article"] con).
   *   2) DANH SÁCH <ul> mà mỗi item chứa link comment_id (kiểu của nhóm này -
   *      lý do trước đây "toàn lấy comment" vì bộ lọc cũ chỉ bắt kiểu (1)).
   *   3) Ô soạn bình luận (role="textbox" / contenteditable).
   */
  function belongsToComment(el, article) {
    const owner = el.closest('[role="article"]');
    if (owner && owner !== article) return true;
    let node = el;
    while (node && node !== article) {
      if (
        node.tagName === "UL" &&
        node.querySelector('a[href*="comment_id"], a[href*="reply_comment_id"]')
      ) {
        return true;
      }
      if (node.getAttribute) {
        if (node.getAttribute("role") === "textbox") return true;
        if (node.getAttribute("contenteditable") === "true") return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  /**
   * Áp bộ selector (do AI bóc ra) lên 1 article rồi DÙNG SELECTOR ĐỂ LẤY DATA.
   * AI chỉ cung cấp selector; phần đọc giá trị hoàn toàn do code làm ở đây.
   * - Thử lần lượt từng selector ứng viên, lấy giá trị hợp lệ đầu tiên.
   * - Bỏ qua phần tử thuộc bình luận lồng nhau (tránh "toàn lấy comment").
   */
  function extractBySelectors(article, sel) {
    const out = {};
    if (!sel || typeof sel !== "object") return out;

    const one = (spec) => {
      for (const cssSel of specSelectors(spec)) {
        try {
          const els = article.querySelectorAll(cssSel);
          for (const el of els) {
            if (belongsToComment(el, article)) continue;
            const v = readValue(el, spec.attr);
            if (v) return v;
          }
        } catch (e) {}
      }
      return null;
    };
    const many = (spec) => {
      const arr = [];
      const seen = new Set();
      for (const cssSel of specSelectors(spec)) {
        try {
          article.querySelectorAll(cssSel).forEach((el) => {
            if (belongsToComment(el, article)) return;
            const v = readValue(el, spec.attr);
            if (v && !seen.has(v)) {
              seen.add(v);
              arr.push(v);
            }
          });
        } catch (e) {}
      }
      return arr;
    };

    if (sel.text) out.text = one(sel.text);
    if (sel.authorName) out.authorName = one(sel.authorName);
    if (sel.authorProfile) out.authorProfile = one(sel.authorProfile);
    if (sel.time) out.timeText = one(sel.time);
    if (sel.images) out.images = many(sel.images);
    if (sel.videos) out.videos = many(sel.videos);
    if (sel.reactions) out.reactions = parseCount(one(sel.reactions));
    if (sel.comments) out.comments = parseCount(one(sel.comments));
    return out;
  }

  function loadSelectors() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get("fbSelectors", (r) => {
          void chrome.runtime.lastError;
          resolve((r && r.fbSelectors) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /** Tìm Ô BÀI VIẾT đầu tiên (feed-child) để làm HTML mẫu cho AI. */
  function findFirstPostContainer() {
    const containers = findPostContainers();
    if (containers.length) return containers[0];
    // Trang chi tiết bài (URL đã chứa postId): dùng article top-level đầu tiên.
    if (extractPostIdFromUrl(location.href)) {
      const arts = [...document.querySelectorAll('[role="article"]')].filter(
        (a) => !(a.parentElement && a.parentElement.closest('[role="article"]'))
      );
      if (arts.length) return arts[0];
    }
    return null;
  }

  /**
   * Tạo HTML mẫu SẠCH để gửi AI: bỏ bình luận lồng nhau (article con) và các thẻ
   * nhiễu (script/style/svg/iframe/noscript). Nhờ vậy 50KB chứa đúng phần thân
   * bài + media + thanh reaction/comment, tránh việc AI chọn nhầm link bình luận.
   */
  function buildCleanSample(article) {
    let clone;
    try {
      clone = article.cloneNode(true);
    } catch (e) {
      return article.outerHTML;
    }
    // Bỏ mọi article con (bình luận lồng nhau - kiểu 1).
    clone.querySelectorAll('[role="article"]').forEach((el) => el.remove());
    // Bỏ DANH SÁCH BÌNH LUẬN dạng <ul> (kiểu 2 - nhóm này): mỗi <ul> bình luận
    // chứa link comment_id. <ul> liệt kê thường (bullet trong thân bài) KHÔNG có
    // link comment_id nên vẫn được giữ lại => không mất nội dung bài.
    clone.querySelectorAll("ul").forEach((ul) => {
      if (ul.querySelector('a[href*="comment_id"], a[href*="reply_comment_id"]')) {
        ul.remove();
      }
    });
    // Bỏ ô soạn bình luận (kiểu 3) để AI không suy nhầm selector.
    clone
      .querySelectorAll('[role="textbox"], [contenteditable="true"]')
      .forEach((el) => el.remove());
    // Bỏ thẻ nhiễu không cần cho việc suy selector.
    clone.querySelectorAll("script, style, svg, noscript, iframe, link").forEach((el) => el.remove());
    return clone.outerHTML;
  }

  // Kiểm tra một chuỗi có "giống thời gian đăng" không (để chặn selector AI sai,
  // ví dụ AI trả về link bình luận chứa comment_id).
  const TIME_TEXT_RE =
    /(\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)|hôm qua|vừa xong|just now|yesterday|\d{1,2}\s*tháng|\bhour|\bmin|\bday|\bweek|\bmonth|\byear|\d+\s*[smhdwy]\b)/i;

  function looksLikeTime(t) {
    if (!t) return false;
    const s = String(t).trim();
    if (s.length > 40) return false;
    if (/comment_id|reply/i.test(s)) return false;
    return TIME_TEXT_RE.test(s);
  }

  // ---- Bóc tách 1 article thành object bài viết --------------------------

  async function extractPost(article, groupInfo, selectors, knownPostId) {
    // postId THẬT (pfbid/số) nếu lấy được. Bài chỉ-chữ ẩn permalink => có thể
    // null ở đây; ta KHÔNG bỏ bài mà rơi xuống "vân tay nội dung" bên dưới.
    let postId = knownPostId || getPostIdFrom(article);
    // Node có thể đã bị feed ảo hoá gỡ khỏi DOM giữa lúc quét và lúc bóc tách.
    // Nếu vậy, tìm lại node còn sống theo postId để không bóc tách trên DOM chết.
    if (postId && !article.isConnected) {
      const live = findContainerByPostId(postId);
      if (live) article = live;
    }

    // QUAN TRỌNG: feed Facebook render lười. Bài ngoài tầm nhìn chỉ có phần
    // header (link tác giả/permalink), thân bài (text, ảnh) chưa render =>
    // mọi trường rỗng. Cuộn bài vào giữa màn hình và chờ render trước khi bóc tách.
    // Chỉ cuộn bài vào tầm nhìn khi nó CHƯA hiện đủ. Cuộn-căn-giữa MỌI bài làm
    // viewport "giật" lên/xuống liên tục => feed ảo hoá gỡ (unmount) các bài lân
    // cận chưa kịp quét trong cùng nhịp => mất bài. Tránh giật khi đã thấy bài.
    try {
      const r = article.getBoundingClientRect();
      const vh = window.innerHeight || 800;
      const mostlyInView = r.height > 0 && r.top >= 0 && r.top < vh * 0.85;
      if (!mostlyInView) article.scrollIntoView({ block: "center" });
    } catch (e) {}
    await sleep(450);

    await expandSeeMore(article);
    await sleep(120);

    // Heuristic làm nền (luôn chạy, để không bao giờ rỗng nếu DOM có nội dung).
    const author = extractAuthor(article);
    const time = extractTimestamp(article);
    const counts = extractCounts(article);
    const base = {
      authorName: author.authorName,
      authorProfile: author.authorProfile,
      timeText: time.timeText,
      text: extractText(article),
      images: extractImages(article),
      videos: extractVideos(article),
      reactions: counts.reactions,
      comments: counts.comments,
    };

    // Selector AI GHI ĐÈ khi có giá trị (ưu tiên "crawl theo phần tử").
    const ai = extractBySelectors(article, selectors);
    const pick = (a, b) => (a !== null && a !== undefined && a !== "" ? a : b);
    const pickArr = (a, b) => (Array.isArray(a) && a.length ? a : b);

    // Chặn selector thời gian sai (vd link bình luận): chỉ nhận khi giống thời gian.
    const aiTimeText = looksLikeTime(ai.timeText) ? ai.timeText : null;

    const finalAuthor = pick(ai.authorName, base.authorName);
    const finalText = pick(ai.text, base.text);
    const finalImages = pickArr(ai.images, base.images);

    // CHỐT ĐỊNH DANH: ưu tiên postId THẬT; nếu bài chỉ-chữ ẩn permalink (không
    // lấy được id), dùng VÂN TAY nội dung -> KHÔNG bỏ sót bài và dedup ổn định.
    if (!postId) {
      postId = fingerprintId(groupInfo.groupId, finalAuthor, finalText, finalImages);
    }
    if (!postId) return null; // không đủ dữ liệu để định danh => bỏ qua
    const permalink =
      postId.indexOf("fp:") === 0 ? null : buildPermalink(groupInfo.groupId, postId);

    return {
      postId,
      groupId: groupInfo.groupId,
      groupName: groupInfo.groupName,
      permalink,
      authorName: finalAuthor,
      authorProfile: pick(ai.authorProfile, base.authorProfile),
      timestamp: time.timestamp,
      timeText: pick(aiTimeText, base.timeText),
      text: finalText,
      images: finalImages,
      videos: pickArr(ai.videos, base.videos),
      links: extractExternalLinks(article, permalink),
      reactions: pick(ai.reactions, base.reactions),
      comments: pick(ai.comments, base.comments),
      crawledAt: Date.now(),
    };
  }

  // ---- Lớp dự phòng: bấm UI chọn "Bài viết mới" -------------------------
  // URL ?sorting_setting=CHRONOLOGICAL là cách CHÍNH (đặt ở background). Nhưng đôi
  // khi FB bỏ qua tham số (đã có cookie sort, A/B layout...). Hàm này bấm trực tiếp
  // control sắp xếp trên trang để chốt chế độ "Bài viết mới". Best-effort, bọc
  // try/catch để không bao giờ làm hỏng phiên crawl nếu FB đổi DOM.
  const SORT_NEWEST_LABELS = [
    "bài viết mới", "mới nhất", "new posts", "recent posts", "most recent",
  ];
  const SORT_TRIGGER_LABELS = [
    "phù hợp nhất", "hoạt động gần đây", "bài viết mới", "mới nhất",
    "top posts", "most relevant", "recent activity", "new posts", "sắp xếp", "sort",
  ];
  const norm = (s) => (s || "").trim().toLowerCase();

  function findClickable(labels) {
    const nodes = document.querySelectorAll(
      '[role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], span, div'
    );
    for (const el of nodes) {
      // Chỉ xét node lá để tránh khớp container lớn bao text con.
      if (el.querySelector && el.querySelector("*")) {
        // vẫn cho qua nếu text ngắn (nút thật), loại container dài.
      }
      const t = norm(el.textContent);
      if (!t || t.length > 40) continue;
      if (labels.some((l) => t === l || t.startsWith(l))) {
        const clickable = el.closest('[role="button"], [role="menuitem"], [role="menuitemradio"], [role="option"], a') || el;
        return clickable;
      }
    }
    return null;
  }

  async function ensureNewestSort() {
    try {
      // Nếu URL đã CHRONOLOGICAL và feed đã có bài thì coi như xong, khỏi đụng UI.
      if (/[?&]sorting_setting=CHRONOLOGICAL/i.test(location.href)) return true;

      // 1) Mở menu sắp xếp: tìm control hiển thị chế độ sort hiện tại.
      const trigger = findClickable(SORT_TRIGGER_LABELS);
      if (!trigger) return false;
      trigger.click();
      await sleep(700);

      // 2) Chọn "Bài viết mới" trong menu vừa mở.
      const option = findClickable(SORT_NEWEST_LABELS);
      if (!option) {
        // Đóng menu nếu lỡ mở mà không thấy lựa chọn phù hợp.
        document.body.click();
        return false;
      }
      option.click();
      await sleep(1500); // chờ feed tải lại theo chế độ mới
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- Vòng lặp crawl chính ---------------------------------------------

  async function runCrawl(options) {
    if (state.running) return { ok: false, error: "Đang chạy crawl rồi." };
    state.running = true;
    state.stopRequested = false;

    const opts = {
      maxNewPosts: options.maxNewPosts || 100,      // dừng khi đủ N bài mới
      stopAfterKnown: options.stopAfterKnown || 8,  // dừng sau N bài đã biết liên tiếp
      maxScrolls: options.maxScrolls || 200,        // chặn vô hạn
      scrollDelay: options.scrollDelay || 1500,     // ms chờ tải sau mỗi lần cuộn
      safeMode: options.safeMode !== false,         // bật mô phỏng người dùng để tránh spam/checkpoint
      fromTs: options.fromTs || 0,                  // chỉ lấy bài từ mốc thời gian này trở đi (0 = không giới hạn)
      ...options,
    };

    // Số ngẫu nhiên trong [min, max].
    const rand = (min, max) => min + Math.random() * (max - min);
    // Độ trễ có nhiễu: dao động quanh base để không đều như máy.
    const jitterDelay = (base) => {
      if (!opts.safeMode) return base;
      const factor = rand(0.7, 1.6);            // 70%..160% so với base
      return Math.round(base * factor);
    };
    // Cuộn TỪNG ĐOẠN NHỎ (KHÔNG nhảy xuống đáy). Feed Facebook ảo hoá: nhảy thẳng
    // xuống document.body.scrollHeight sẽ gỡ (unmount) hàng loạt bài chưa kịp quét,
    // nên mỗi nhịp chỉ tiến dưới 1 màn hình rồi để vòng lặp quét lại phần vừa hiện.
    const humanScroll = async () => {
      const vh = window.innerHeight || 800;
      if (!opts.safeMode) {
        // Chế độ nhanh: vẫn cuộn từng đoạn (~0.9 màn hình), tuyệt đối không nhảy đáy.
        window.scrollBy(0, Math.round(vh * 0.9));
        return;
      }
      const steps = Math.floor(rand(1, 3));     // 1..2 nhịp cuộn nhỏ
      for (let i = 0; i < steps; i++) {
        if (state.stopRequested) break;
        const dy = Math.round(rand(0.45, 0.75) * vh); // tổng < 1 màn hình
        window.scrollBy(0, dy);
        await sleep(Math.round(rand(180, 520)));
      }
    };
    // Thỉnh thoảng "nghỉ" lâu hơn như người dùng dừng đọc.
    let nextRestAt = Math.floor(rand(6, 11));   // sau 6..10 lần cuộn sẽ nghỉ

    const groupInfo = getGroupInfo();

    // Lấy tập ID đã biết để lọc bài mới.
    const knownRes = await send("GET_KNOWN_IDS", { groupId: groupInfo.groupId });
    const known = new Set((knownRes && knownRes.ok && knownRes.ids) || []);

    // Nạp bộ selector AI một lần cho cả phiên (nếu đã khám phá trước đó).
    const selectors = await loadSelectors();

    const seenThisRun = new Set();
    let newCount = 0;
    let consecutiveKnown = 0;
    let consecutiveOld = 0; // số bài cũ hơn "fromTs" gặp liên tiếp (feed mới->cũ)
    let scrolls = 0;
    let idleScrolls = 0;    // số nhịp cuộn liên tiếp không có bài mới & trang không cao thêm
    let batch = [];
    // Bộ đếm chẩn đoán: làm RÕ mỗi bài "biến mất" về đâu, thay vì im lặng bỏ.
    let dropNoContent = 0;   // bóc tách xong nhưng không định danh/không có nội dung
    let dropError = 0;       // extractPost ném lỗi
    let usedFingerprint = 0; // số bài phải dùng id vân tay (FB ẩn permalink)

    const flush = async () => {
      if (batch.length === 0) return;
      const toSave = batch;
      batch = [];
      await send("SAVE_POSTS", { posts: toSave });
    };

    const reportProgress = (extra = {}) => {
      const progress = {
        groupId: groupInfo.groupId,
        groupName: groupInfo.groupName,
        newCount,
        scrolls,
        seen: seenThisRun.size, // tổng bài đã quét (chẩn đoán: so với newCount để thấy tỉ lệ)
        knownHits: consecutiveKnown,
        ...extra,
      };
      // Log thẳng ra Console của tab Facebook để dễ theo dõi (không cần mở background).
      dlog(
        `${progress.status || "tick"} | mới=${newCount} đã-quét=${seenThisRun.size}` +
          ` cuộn=${scrolls} known-liên-tiếp=${consecutiveKnown}` +
          (extra.lastAuthor ? ` | ${extra.lastAuthor}` : "")
      );
      send("CRAWL_PROGRESS", { progress });
    };

    reportProgress({ status: "started" });

    // Trước khi quét: đảm bảo feed đang ở chế độ "Bài viết mới" (mới->cũ).
    // Lớp CHÍNH là URL ?sorting_setting=CHRONOLOGICAL (đặt ở background); đây là
    // lớp DỰ PHÒNG bấm UI phòng khi FB bỏ qua tham số. Best-effort, không chặn crawl.
    try {
      await ensureNewestSort();
    } catch (e) {}

    try {
      while (!state.stopRequested && scrolls < opts.maxScrolls && newCount < opts.maxNewPosts) {
        const seenBefore = seenThisRun.size;
        const containers = findPostContainers();
        // Chẩn đoán nhẹ: nếu KHÔNG thấy ô bài nào, in nhanh trạng thái DOM để biết
        // vì sao (tab nền không render? feed chưa tải?). visibilityState quan trọng:
        // tab ẩn => Facebook ảo hoá không mount bài => quét ra 0.
        if (!containers.length) {
          const feeds = [...document.querySelectorAll('[role="feed"]')];
          const arts = document.querySelectorAll('[role="article"]');
          let feed = null;
          for (const f of feeds) {
            if (!feed || f.children.length > feed.children.length) feed = f;
          }
          dlog(
            `quét nhịp #${scrolls}: thấy 0 ô bài | visibility=${document.visibilityState}` +
              ` feeds=${feeds.length} feedChildren=${feed ? feed.children.length : 0}` +
              ` articles=${arts.length} bodyH=${document.body.scrollHeight}`
          );
        } else {
          dlog(`quét nhịp #${scrolls}: thấy ${containers.length} ô bài trong feed`);
        }

        for (const article of containers) {
          if (state.stopRequested || newCount >= opts.maxNewPosts) break;

          // BƯỚC 1 — thử lấy postId THẬT (rẻ) để bỏ qua SỚM bài đã quét/đã biết
          // mà khỏi bóc tách nặng. Bài chỉ-chữ ẩn permalink => hover để FB nạp
          // href. QUAN TRỌNG: nếu vẫn không có id, KHÔNG bỏ bài ở đây nữa — sẽ
          // bóc tách rồi dùng VÂN TAY nội dung làm id (trong extractPost).
          let realId = getPostIdFrom(article);
          if (!realId) realId = await revealPostId(article);

          if (realId) {
            if (seenThisRun.has(realId)) continue;
            if (known.has(realId)) {
              seenThisRun.add(realId);
              consecutiveKnown += 1;
              if (consecutiveKnown >= opts.stopAfterKnown) {
                await flush();
                reportProgress({ status: "stopped_known" });
                state.running = false;
                send("CRAWL_DONE", {
                  result: { newCount, reason: "Đã gặp đủ bài cũ liên tiếp — coi như hết bài mới." },
                });
                return { ok: true, newCount, reason: "known_limit" };
              }
              continue;
            }
          }

          // BƯỚC 2 — bóc tách đầy đủ. extractPost tự CHỐT id (thật hoặc vân tay).
          let post = null;
          try {
            post = await extractPost(article, groupInfo, selectors, realId);
          } catch (e) {
            dropError += 1;
          }
          if (!post || !post.postId) {
            // Không định danh được / không có nội dung. Nếu có id thật thì đánh
            // dấu để khỏi lặp lại bài này ở các nhịp sau; đếm lại để chẩn đoán.
            if (realId) seenThisRun.add(realId);
            dropNoContent += 1;
            continue;
          }

          const id = post.postId;
          if (seenThisRun.has(id)) continue;
          seenThisRun.add(id);
          if (id.indexOf("fp:") === 0) usedFingerprint += 1;

          // Bài đã có trong kho (kể cả khớp theo id vân tay) -> xử như "đã biết".
          if (known.has(id)) {
            consecutiveKnown += 1;
            if (consecutiveKnown >= opts.stopAfterKnown) {
              await flush();
              reportProgress({ status: "stopped_known" });
              state.running = false;
              send("CRAWL_DONE", {
                result: { newCount, reason: "Đã gặp đủ bài cũ liên tiếp — coi như hết bài mới." },
              });
              return { ok: true, newCount, reason: "known_limit" };
            }
            continue;
          }

          // Bài MỚI -> reset chuỗi known.
          consecutiveKnown = 0;

          // Lọc theo "Crawl từ ngày": feed mới->cũ nên khi gặp đủ bài cũ hơn mốc
          // liên tiếp thì coi như đã vượt khoảng cần lấy -> dừng. Bài không xác
          // định được thời gian (timestamp rỗng) vẫn được giữ.
          if (opts.fromTs && post.timestamp && post.timestamp < opts.fromTs) {
            consecutiveOld += 1;
            if (consecutiveOld >= opts.stopAfterKnown) {
              await flush();
              reportProgress({ status: "stopped_old" });
              state.running = false;
              send("CRAWL_DONE", {
                result: { newCount, reason: "Đã tới bài cũ hơn ngày bắt đầu — dừng theo bộ lọc ngày." },
              });
              return { ok: true, newCount, reason: "date_limit" };
            }
            continue; // bỏ qua bài cũ hơn mốc, không lưu
          }
          consecutiveOld = 0;
          batch.push(post);
          newCount += 1;
          if (batch.length >= 10) await flush();
          reportProgress({ status: "crawling", lastAuthor: post.authorName });
        }

        await flush();

        // Nhịp này có quét được postId MỚI nào không (kể cả bài đã biết/cũ)?
        // Dùng để phân biệt "đang còn bài chưa quét" với "đã thật sự hết feed".
        const grewNew = seenThisRun.size > seenBefore;

        // Cuộn từng đoạn để tải thêm bài (humanScroll KHÔNG nhảy xuống đáy nữa).
        const beforeH = document.body.scrollHeight;
        await humanScroll();
        scrolls += 1;
        await sleep(jitterDelay(opts.scrollDelay));

        // Thỉnh thoảng nghỉ lâu hơn như người thật dừng đọc => giảm rủi ro spam/checkpoint.
        if (opts.safeMode && scrolls >= nextRestAt) {
          reportProgress({ status: "resting" });
          await sleep(jitterDelay(Math.round(opts.scrollDelay * rand(2.5, 4))));
          nextRestAt = scrolls + Math.floor(rand(6, 11)); // hẹn lần nghỉ kế tiếp
        }

        // Phát hiện hết feed một cách an toàn: CHỈ coi là hết khi ĐỒNG THỜI
        // (1) không có bài mới nào xuất hiện, (2) trang không cao thêm, và
        // (3) đã cuộn sát đáy — và phải lặp lại vài nhịp liên tiếp để loại trừ
        // trường hợp Facebook tải chậm. Nhờ vậy không dừng sớm khi giữa feed.
        const afterH = document.body.scrollHeight;
        const grewH = afterH > beforeH;
        const nearBottom = window.innerHeight + window.scrollY >= afterH - 600;
        if (!grewNew && !grewH && nearBottom) {
          idleScrolls += 1;
          await sleep(jitterDelay(opts.scrollDelay)); // chờ thêm 1 nhịp phòng tải chậm
          if (document.body.scrollHeight <= beforeH && scrolls > 2 && idleScrolls >= 3) {
            dlog("Đã chạm đáy feed thật sự (3 nhịp liên tiếp không có gì mới) -> dừng.");
            break; // thực sự hết bài để tải
          }
        } else {
          idleScrolls = 0; // còn bài mới hoặc trang còn cao thêm => tiếp tục cuộn
        }
      }

      await flush();
      const reason = state.stopRequested
        ? "Đã dừng theo yêu cầu."
        : newCount >= opts.maxNewPosts
        ? "Đã đạt giới hạn số bài mới."
        : "Đã cuộn hết feed khả dụng.";

      dlog(
        `HOÀN TẤT: ${reason} | mới-lưu=${newCount} đã-quét=${seenThisRun.size}` +
          ` nhịp-cuộn=${scrolls} | dùng-vân-tay=${usedFingerprint}` +
          ` bỏ-không-nội-dung=${dropNoContent} bỏ-lỗi=${dropError}`
      );
      reportProgress({ status: "done" });
      send("CRAWL_DONE", { result: { newCount, reason } });
      state.running = false;
      return { ok: true, newCount, reason };
    } catch (err) {
      await flush();
      state.running = false;
      send("CRAWL_DONE", { result: { newCount, reason: "Lỗi: " + String(err) } });
      return { ok: false, error: String(err), newCount };
    }
  }

  // =======================================================================
  // CHẾ ĐỘ DÒ API (GraphQL nội bộ FB) — phối hợp với fb-api-hook.js (MAIN
  // world). content.js (isolated world) giữ logic dedup + lưu + replay phân
  // trang. Ưu điểm so với cuộn DOM: request mạng KHÔNG bị "ảo hoá theo tầm
  // nhìn" => lấy đủ bài kể cả khi tab nền, và có thể replay nhanh nhiều trang.
  // =======================================================================

  // Bộ nhớ phiên dò API.
  const apiSniff = {
    // Mẫu request feed nhóm GẦN NHẤT bắt được (để replay phân trang).
    // { url, raw, friendly, fb_dtsg, doc_id, lsd, variables }
    template: null,
    // Chunks JSON của response feed nhóm gần nhất (dùng cho TRANG 1 + CAPTURE).
    lastChunks: [],
    // Số gói GraphQL feed nhóm đã thấy (chẩn đoán).
    feedCount: 0,
    // Cờ đang chạy crawl API.
    apiRunning: false,
    // Map id -> callback chờ kết quả replay.
    replayWaiters: new Map(),
  };

  // Import động gql-parse.js (web_accessible_resources). Cache lại sau lần đầu.
  let _gqlMod = null;
  async function loadGqlModule() {
    if (_gqlMod) return _gqlMod;
    const url = chrome.runtime.getURL("src/gql-parse.js");
    _gqlMod = await import(url);
    return _gqlMod;
  }

  // Nhờ MAIN world fetch hộ (để dùng đúng credential/header của trang), chờ
  // kết quả theo id. fb-api-hook.js trả __FBC_GQL_REPLAY_RES.
  function replayViaPage({ url, body, friendly }, timeoutMs = 20000) {
    return new Promise((resolve) => {
      const id = "rp_" + Date.now() + "_" + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        apiSniff.replayWaiters.delete(id);
        resolve({ ok: false, error: "replay timeout" });
      }, timeoutMs);
      apiSniff.replayWaiters.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      window.postMessage({ __FBC_GQL_REPLAY: 1, id, url, body, friendly }, "*");
    });
  }

  // Yêu cầu MAIN world hook PHÁT LẠI mọi gói GraphQL đã đệm. Cần vì hook chạy
  // ở document_start (bắt feed FB rất sớm) còn content.js chỉ chạy ở
  // document_idle => gói feed đầu tiên có thể đã bắn TRƯỚC khi listener này gắn.
  // Gọi pull để "kéo" lại các gói đó thay vì chờ FB tự bắn lại (không xảy ra
  // trong tab nền/ẩn bị throttle).
  function pullBufferedGql() {
    try {
      window.postMessage({ __FBC_GQL_PULL: 1 }, "*");
    } catch (e) {}
  }

  // Dựng body replay: GIỮ NGUYÊN body gốc (mọi field FB cần), chỉ thay
  // 'variables' bằng bản đã gắn cursor. Bền hơn việc tự dựng lại từ đầu.
  function buildReplayBody(tpl, vars) {
    const p = new URLSearchParams(tpl.raw || "");
    p.set("variables", JSON.stringify(vars));
    return p.toString();
  }

  // Gắn cursor phân trang vào variables. Feed nhóm thường dùng 'cursor'; vài
  // query dùng 'after'. Đặt cả hai nếu có để chắc ăn.
  function setCursorInVariables(vars, cursor) {
    if (!vars || cursor == null) return;
    if ("after" in vars) vars.after = cursor;
    // 'cursor' là tên phổ biến nhất của feed nhóm => luôn đặt.
    vars.cursor = cursor;
  }

  // Lắng nghe message từ MAIN world hook.
  // LƯU: KHÔNG check `ev.source !== window` — vì MAIN world và isolated world
  // có 2 đối tượng `window` khác nhau. Khi MAIN world postMessage, ev.source
  // là page window còn `window` ở đây là isolated window => check đó LUÔN
  // đúng => listener return sớm => MẤT HẾT message từ hook. Chỉ cần check
  // ev.data có đúng "dấu hiệu" (__FBC_GQL / __FBC_GQL_REPLAY_RES) là đủ.
  window.addEventListener("message", async (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object") return;

    // (1) Gói GraphQL bắt thụ động từ trang.
    if (d.__FBC_GQL === 1) {
      try {
        const mod = await loadGqlModule();
        const req = mod.parseGqlRequestBody(d.reqBody);
        if (mod.isGroupFeedRequest(req.friendly, req.variables)) {
          apiSniff.feedCount += 1;
          // Chỉ giữ mẫu MỚI NHẤT (fb_dtsg/cursor xoay vòng theo thời gian).
          apiSniff.template = {
            url: d.url,
            raw: req.raw,
            friendly: req.friendly,
            fb_dtsg: req.fb_dtsg,
            doc_id: req.doc_id,
            lsd: req.lsd,
            variables: req.variables,
          };
          apiSniff.lastChunks = Array.isArray(d.chunks) ? d.chunks : [];
          // Lưu mẫu ra chrome.storage.local để background service worker dùng lại
          // cho CRAWL KHÔNG-TAB (Mức B): POST /api/graphql/ trực tiếp. Token
          // fb_dtsg/lsd sẽ được làm mới (lấy từ HTML nhóm) lúc crawl, nên ở đây
          // chỉ cần lưu doc_id/friendly/raw/variables làm khuôn.
          try {
            chrome.storage.local.set({
              fbcGqlTemplate: {
                url: d.url,
                raw: req.raw,
                friendly: req.friendly,
                fb_dtsg: req.fb_dtsg,
                doc_id: req.doc_id,
                lsd: req.lsd,
                variables: req.variables,
                capturedAt: Date.now(),
              },
            });
          } catch (e) {}
          dlog(
            `[API] bắt feed nhóm #${apiSniff.feedCount}` +
              ` | friendly=${req.friendly} doc_id=${req.doc_id}`
          );
        }
      } catch (e) {}
      return;
    }

    // (2) Kết quả replay trả về từ MAIN world.
    if (d.__FBC_GQL_REPLAY_RES === 1) {
      const cb = apiSniff.replayWaiters.get(d.id);
      if (cb) {
        apiSniff.replayWaiters.delete(d.id);
        cb({ ok: !!d.ok, chunks: d.chunks || [], error: d.error });
      }
      return;
    }
  });

  // Chạy crawl qua API: TRANG 1 dùng chunks đã sniff, các trang sau replay
  // bằng end_cursor cho tới khi đủ maxNewPosts hoặc hết trang.
  async function runApiCrawl(options) {
    if (apiSniff.apiRunning) return { ok: false, error: "Đang chạy API crawl rồi." };
    apiSniff.apiRunning = true;
    state.stopRequested = false;

    const opts = {
      maxNewPosts: options.maxNewPosts || 100, // dừng khi đủ N bài mới
      maxPages: options.maxPages || 60,        // chặn vô hạn
      pageDelay: options.pageDelay || 800,     // ms nghỉ giữa các trang replay
      ...options,
    };

    const groupInfo = getGroupInfo();
    const origin = location.origin;

    const apiReport = (extra = {}) => {
      const progress = {
        groupId: groupInfo.groupId,
        groupName: groupInfo.groupName,
        mode: "api",
        ...extra,
      };
      dlog(
        `[API] ${progress.status || "tick"}` +
          ` | mới=${progress.newCount ?? "?"} trang=${progress.pages ?? "?"}`
      );
      send("CRAWL_PROGRESS", { progress });
    };

    try {
      const mod = await loadGqlModule();

      // Lấy ID đã biết để lọc trùng (giống DOM crawl => lưu cùng pipeline).
      const knownRes = await send("GET_KNOWN_IDS", { groupId: groupInfo.groupId });
      const known = new Set((knownRes && knownRes.ok && knownRes.ids) || []);

      apiReport({ status: "started", newCount: 0, pages: 0 });

      // Kéo lại các gói feed hook đã đệm TRƯỚC khi content.js gắn listener
      // (hook chạy document_start, content.js chạy document_idle => dễ lỡ gói
      // feed đầu tiên). Đây là mấu chốt để tab ẩn/nền vẫn có template mà crawl.
      pullBufferedGql();

      // Cần mẫu request đã sniff để replay. Nếu chưa có, chờ FB tự bắn feed request.
      // FB thường mất 3-8s sau khi load trang nhóm mới gọi feed request đầu tiên
      // (đặc biệt với nhóm lớn hoặc mạng chậm). Ta chờ tối đa ~15s, mỗi 1.5s
      // cuộn nhẹ 1 lần để kích hoạt lazy load. Nếu vẫn không có thì thử click
      // nút "Mới nhất" để ép FB gọi lại feed request. Cuối cùng mới báo lỗi.
      const TEMPLATE_WAIT_MS = 15000;
      const TEMPLATE_POLL_MS = 1500;
      const tplStart = Date.now();
      let tplScrolls = 0;
      let tplTriedSort = false;
      while (
        (!apiSniff.template || !apiSniff.template.doc_id) &&
        Date.now() - tplStart < TEMPLATE_WAIT_MS
      ) {
        if (tplScrolls < 6) {
          window.scrollBy(0, Math.round((window.innerHeight || 800) * 0.6));
          tplScrolls += 1;
        }
        // Sau ~6s không có template, thử click "Mới nhất" để ép FB gọi feed request.
        if (
          !tplTriedSort &&
          Date.now() - tplStart > 6000 &&
          typeof ensureNewestSort === "function"
        ) {
          tplTriedSort = true;
          try {
            await ensureNewestSort();
          } catch (_) {}
        }
        await sleep(TEMPLATE_POLL_MS);
      }
      if (!apiSniff.template || !apiSniff.template.doc_id) {
        apiSniff.apiRunning = false;
        apiReport({
          status: "error",
          error:
            "Chưa bắt được request feed nhóm sau " +
            Math.round(TEMPLATE_WAIT_MS / 1000) +
            "s. Hãy cuộn feed 1-2 nhịp rồi chạy lại.",
        });
        send("CRAWL_DONE", {
          result: { newCount: 0, reason: "Chưa có mẫu request API." },
        });
        return { ok: false, error: "no template" };
      }

      const seenThisRun = new Set();
      let newCount = 0;
      let pages = 0;
      let batch = [];

      const flush = async () => {
        if (batch.length === 0) return;
        const toSave = batch;
        batch = [];
        await send("SAVE_POSTS", { posts: toSave });
      };

      // Bóc bài từ 1 mảng chunk -> dedup (trong phiên + với DB) -> xếp vào batch.
      // Trả pageInfo để biết cursor trang kế.
      const ingestChunks = (chunks) => {
        const { posts, pageInfo } = mod.extractPostsFromChunks(chunks, {
          groupId: groupInfo.groupId,
          groupName: groupInfo.groupName,
          origin,
        });
        // Log mẫu bài đầu tiên mỗi trang để kiểm tra API thực tế có trả reactions/comments/timestamp không.
        if (posts.length > 0) {
          const s = posts[0];
          dlog(
            `[API] sample post: reactions=${s.reactions} comments=${s.comments}` +
            ` ts=${s.timestamp} timeText=${s.timeText}` +
            ` postId=${s.postId} text="${(s.text || "").slice(0, 50)}"`
          );
        }
        for (const p of posts) {
          if (seenThisRun.has(p.postId)) continue;
          seenThisRun.add(p.postId);
          if (known.has(p.postId)) continue; // đã có trong DB => bỏ
          batch.push(p);
          newCount += 1;
        }
        return pageInfo;
      };

      // TRANG 1: dùng luôn chunks bắt được gần nhất (khỏi gọi lại mạng).
      let cursor = null;
      if (apiSniff.lastChunks && apiSniff.lastChunks.length) {
        const pi = ingestChunks(apiSniff.lastChunks);
        cursor = pi.endCursor;
        pages += 1;
        await flush();
        apiReport({ status: "page", newCount, pages, hasNext: pi.hasNext });
      }

      // CÁC TRANG SAU: replay với cursor tăng dần.
      const tpl = apiSniff.template;
      while (
        !state.stopRequested &&
        newCount < opts.maxNewPosts &&
        pages < opts.maxPages
      ) {
        if (!cursor) {
          dlog("[API] không có cursor cho trang kế => dừng.");
          break;
        }
        const vars = JSON.parse(JSON.stringify(tpl.variables || {}));
        setCursorInVariables(vars, cursor);
        const body = buildReplayBody(tpl, vars);

        const res = await replayViaPage({ url: tpl.url, body, friendly: tpl.friendly });
        if (!res.ok) {
          dlog("[API] replay lỗi:", res.error);
          break;
        }
        const pi = ingestChunks(res.chunks);
        pages += 1;
        await flush();
        apiReport({ status: "page", newCount, pages, hasNext: pi.hasNext });

        if (!pi.hasNext || !pi.endCursor || pi.endCursor === cursor) {
          dlog("[API] hết trang (không còn cursor mới).");
          break;
        }
        cursor = pi.endCursor;
        await sleep(opts.pageDelay);
      }

      await flush();
      const reason = state.stopRequested
        ? "Đã dừng theo yêu cầu."
        : newCount >= opts.maxNewPosts
        ? "Đã đạt giới hạn số bài mới."
        : "Đã hết trang feed (API).";
      dlog(`[API] HOÀN TẤT: ${reason} | mới-lưu=${newCount} trang=${pages}`);
      apiReport({ status: "done", newCount, pages });
      send("CRAWL_DONE", { result: { newCount, reason } });
      apiSniff.apiRunning = false;
      return { ok: true, newCount, reason };
    } catch (err) {
      apiSniff.apiRunning = false;
      send("CRAWL_DONE", { result: { newCount: 0, reason: "Lỗi API: " + String(err) } });
      return { ok: false, error: String(err) };
    }
  }

  // ---- Lắng nghe lệnh từ background/popup --------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "START_CRAWL") {
      // Trả lời ngay rằng đã nhận; tiến độ gửi qua CRAWL_PROGRESS.
      runCrawl(msg.options || {});
      sendResponse({ ok: true, started: true });
      return false;
    }

    if (msg.type === "START_API_CRAWL") {
      // Quét qua API nội bộ của FB (sniff + replay). Tiến độ gửi qua CRAWL_PROGRESS.
      runApiCrawl(msg.options || {});
      sendResponse({ ok: true, started: true, mode: "api" });
      return false;
    }

    if (msg.type === "STOP_CRAWL") {
      state.stopRequested = true;
      sendResponse({ ok: true, stopping: true });
      return false;
    }

    if (msg.type === "GET_SAMPLE_HTML") {
      // Trả outerHTML của 1 bài mẫu (đã cuộn vào tầm nhìn + mở "Xem thêm")
      // để background gửi cho AI khám phá selector.
      (async () => {
        const article = findFirstPostContainer();
        if (!article) {
          sendResponse({ ok: false, error: "Không tìm thấy bài viết nào trên trang. Hãy cuộn tới phần feed của nhóm." });
          return;
        }
        try {
          article.scrollIntoView({ block: "center" });
        } catch (e) {}
        await sleep(700);
        await expandSeeMore(article);
        await sleep(250);
        const groupInfo = getGroupInfo();
        const postId = getPostIdFrom(article);
        const permalink = postId ? buildPermalink(groupInfo.groupId, postId) : null;
        sendResponse({ ok: true, html: buildCleanSample(article), postId, permalink });
      })();
      return true; // giữ kênh mở cho phản hồi bất đồng bộ
    }

    if (msg.type === "PING") {
      sendResponse({ ok: true, running: state.running });
      return false;
    }

    return false;
  });
})();
