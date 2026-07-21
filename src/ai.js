/**
 * src/ai.js — Lớp AI: dò CSS selector từ bài mẫu + build cấu hình PC bằng AI.
 *
 * Tách ra từ background.js (B3.1d). Mọi helper dùng chung (getAIConfig,
 * getActiveTab, parseSelectorJson, fetchWithTimeout, broadcast) được import từ
 * util.js để tránh trùng lặp. Các hàm export ra cho router (background.js) gọi.
 */

import {
  getAIConfig,
  getActiveTab,
  parseSelectorJson,
  fetchWithTimeout,
  broadcast,
} from "./util.js";
import { getActiveProfile } from "./prompts.js";
import * as DB from "./db.js";
/**
 * Hàm TỰ-CHỨA chạy trong NGỮ CẢNH TRANG (func injection).
 * BẮT BUỘC không tham chiếu biến/hàm ngoài — mọi thứ định nghĩa bên trong, vì
 * hàm này được serialize rồi chạy trong tab. Trả về { ok, html, postId, permalink }.
 *
 * Tự cuộn-thử-lại để kích hoạt feed render lười, rồi lấy Ô BÀI (feed-child) đầu
 * tiên có postId, dựng HTML mẫu sạch (bỏ bình luận) để gửi AI suy selector.
 */
export async function grabSampleHtmlInPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Facebook hiện đại dùng token "pfbid..." (chữ + số) cho permalink bài viết,
  // không còn là số thuần. Mỗi pattern phải chấp nhận CẢ pfbid… LẪN id số cũ.
  const PID = "(pfbid[A-Za-z0-9]+|\\d+)";
  const POST_ID_PATTERNS = [
    new RegExp("/groups/[^/]+/posts/" + PID),
    new RegExp("/groups/[^/]+/permalink/" + PID),
    new RegExp("multi_permalinks?=" + PID),
    new RegExp("[?&]story_fbid=" + PID),
    new RegExp("/permalink/" + PID),
    new RegExp("/posts/" + PID),
  ];
  const extractPostId = (url) => {
    if (!url) return null;
    for (const re of POST_ID_PATTERNS) {
      const m = url.match(re);
      if (m && m[1]) return m[1];
    }
    return null;
  };
  const getPostIdFrom = (root) => {
    if (!root || !root.querySelectorAll) return null;
    const anchors = root.querySelectorAll(
      'a[href*="/posts/"], a[href*="/permalink/"], a[href*="story_fbid"], a[href*="multi_permalink"]'
    );
    for (const a of anchors) {
      const href = a.href || a.getAttribute("href") || "";
      const id = extractPostId(href);
      if (id) return id;
    }
    return null;
  };
  const findContainers = () => {
    const feed = document.querySelector('[role="feed"]');
    if (feed) {
      const kids = [...feed.children].filter((c) => c && getPostIdFrom(c));
      if (kids.length) return kids;
    }
    return [...document.querySelectorAll('[role="article"]')].filter(
      (a) => !(a.parentElement && a.parentElement.closest('[role="article"]')) && getPostIdFrom(a)
    );
  };

  // Cuộn-thử-lại tối đa ~6 lần để feed lazy render xong (ô đầu feed hay rỗng).
  let containers = findContainers();
  for (let i = 0; i < 6 && containers.length === 0; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(900);
    containers = findContainers();
  }
  if (containers.length === 0) {
    return { ok: false, error: "Không tìm thấy bài viết nào trên trang. Hãy cuộn tới phần feed của nhóm." };
  }

  const article = containers[0];
  try { article.scrollIntoView({ block: "center" }); } catch (e) {}
  await sleep(700);

  // Mở "Xem thêm" của NỘI DUNG BÀI (bỏ nút thuộc bình luận lồng nhau).
  try {
    const buttons = article.querySelectorAll('div[role="button"], span[role="button"]');
    for (const s of buttons) {
      const owner = s.closest('[role="article"]');
      if (owner && owner !== article && article.contains(owner)) continue;
      const t = (s.textContent || "").trim().toLowerCase();
      if (!t) continue;
      const isSeeMore =
        t === "xem thêm" || t === "see more" || t.endsWith("xem thêm") || t.endsWith("see more");
      const isComments =
        t.includes("bình luận") || t.includes("comment") || t.includes("trả lời") || t.includes("repl");
      if (isSeeMore && !isComments) {
        try { s.click(); } catch (e) {}
        await sleep(150);
      }
    }
  } catch (e) {}
  await sleep(250);

  // Dựng HTML mẫu SẠCH: bỏ bình luận (article lồng + ul comment_id), ô soạn, thẻ nhiễu.
  let html;
  let clone = null;
  try { clone = article.cloneNode(true); } catch (e) { clone = null; }
  if (clone) {
    clone.querySelectorAll('[role="article"]').forEach((el) => el.remove());
    clone.querySelectorAll("ul").forEach((ul) => {
      if (ul.querySelector('a[href*="comment_id"], a[href*="reply_comment_id"]')) ul.remove();
    });
    clone.querySelectorAll('[role="textbox"], [contenteditable="true"]').forEach((el) => el.remove());
    clone.querySelectorAll("script, style, svg, noscript, iframe, link").forEach((el) => el.remove());
    html = clone.outerHTML;
  } else {
    html = article.outerHTML;
  }

  const gm = location.pathname.match(/\/groups\/([^/?#]+)/);
  const groupId = gm ? gm[1] : "unknown";
  const postId = getPostIdFrom(article);
  const permalink = postId
    ? location.origin + "/groups/" + groupId + "/posts/" + postId + "/"
    : null;
  return { ok: true, html, postId, permalink };
}

/**
 * Lấy HTML 1 bài mẫu từ trang -> gửi cho AI -> nhận lại bộ CSS selector cho
 * từng trường -> lưu vào chrome.storage. Crawl sau đó dùng selector này.
 */
export async function discoverSelectors() {
  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";

  if (!apiKey) {
    return { ok: false, error: "Chưa nhập API key. Hãy điền ở mục Cấu hình AI rồi lưu." };
  }

  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: "Không tìm thấy tab đang mở." };
  if (!/https:\/\/(www|web)\.facebook\.com\/groups\//.test(tab.url || "")) {
    return { ok: false, error: "Tab hiện tại không phải trang nhóm Facebook." };
  }

  // Lấy HTML mẫu bằng cách CHẠY THẲNG một hàm tự-chứa trong trang (func injection),
  // KHÔNG qua message listener của content.js. Lý do:
  //  - Tránh lỗi "script cũ kẹt": chốt window.__FB_GROUP_CRAWLER_LOADED__ ở
  //    content.js làm bản mới tiêm vào bị thoát sớm => listener mới không đăng ký.
  //    func injection luôn chạy code mới mỗi lần gọi, miễn nhiễm với chốt đó.
  //  - Có vòng CUỘN-THỬ-LẠI để kích hoạt feed render lười (ô đầu feed thường rỗng
  //    cho tới khi cuộn tới).
  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: grabSampleHtmlInPage,
    });
  } catch (e) {
    return { ok: false, error: "Không chạy được trên tab. Hãy F5 trang nhóm rồi thử lại. " + String(e) };
  }
  const sample = injection && injection[0] ? injection[0].result : null;
  if (!sample || !sample.ok) {
    return { ok: false, error: (sample && sample.error) || "Không lấy được bài viết mẫu." };
  }

  // HTML đã được content script làm sạch (bỏ bình luận + script/svg) nên gọn hơn
  // nhiều. Cho ngân sách rất rộng (1 triệu ký tự) để KHÔNG cắt mất phần thân bài
  // / media / thanh reaction => tránh AI suy selector sai do thiếu ngữ cảnh.
  // LƯU Ý: 1tr ký tự ~250-300K token, VƯỢT context của gpt-4o (~128K token) và
  // claude-3-5-sonnet (~200K token); chỉ model context lớn (vd gemini-2.5-pro)
  // mới nhận trọn. Nếu mẫu quá lớn với model nhỏ, API sẽ báo lỗi context.
  const MAX = 1000000;
  let html = sample.html || "";
  if (html.length > MAX) html = html.slice(0, MAX) + "\n<!-- TRUNCATED -->";

  const sys =
    "Bạn là chuyên gia phân tích DOM. Cho HTML của MỘT bài viết trong nhóm Facebook " +
    "(đã loại bỏ phần bình luận), hãy suy ra CSS selector (TƯƠNG ĐỐI so với phần tử article gốc) để lấy từng trường. " +
    "Code sẽ DÙNG SELECTOR NÀY để tự đọc dữ liệu (bạn KHÔNG cần trả về dữ liệu, chỉ trả selector). " +
    "Tránh class ngẫu nhiên của Facebook; ưu tiên thuộc tính bền (role, dir, data-*, aria-label, tên thẻ như h1/h2/h3/strong). " +
    "Với mỗi trường, hãy đưa MẢNG nhiều selector ỨNG VIÊN xếp theo độ ưu tiên (code sẽ thử lần lượt, lấy cái khớp đầu tiên). " +
    "CHỈ trả về JSON hợp lệ, KHÔNG giải thích, KHÔNG bọc code fence. " +
    'Cấu trúc: {"text":{"selectors":["",""],"attr":"text"},"authorName":{"selectors":[""],"attr":"text"},' +
    '"authorProfile":{"selectors":[""],"attr":"href"},"time":{"selectors":[""],"attr":"text"},' +
    '"images":{"selectors":[""],"attr":"src"},"videos":{"selectors":[""],"attr":"src"},' +
    '"reactions":{"selectors":[""],"attr":"aria-label"},"comments":{"selectors":[""],"attr":"text"}}. ' +
    'attr là một trong: "text" (innerText), "href", "src", hoặc tên thuộc tính (vd "aria-label"). ' +
    "Hướng dẫn theo trường: " +
    "- text: NỘI DUNG bài. LƯU Ý có 2 kiểu render: bài dài nằm trong div[dir=\"auto\"]; bài CHỮ NGẮN nằm trong h1/h2/h3 (thường có <strong>). " +
    "Hãy đưa cả hai kiểu vào mảng selectors (vd [\"div[dir=\\\"auto\\\"]\",\"h1\",\"h2\",\"h3\"]). " +
    "- time: LINK THỜI GIAN ĐĂNG BÀI gần tên tác giả ở đầu bài, text dạng '5 giờ','2 ngày','12 Tháng 6'. " +
    "TUYỆT ĐỐI KHÔNG dùng link chứa 'comment_id'. Có thể dùng attr='aria-label' nếu nhãn chứa ngày giờ. " +
    "- reactions: cụm số lượt cảm xúc ở thanh dưới bài (aria-label chứa số + 'cảm xúc'/'reactions'/'thích'); attr='aria-label'. " +
    "- comments: cụm '\\d+ bình luận'/'\\d+ comments' ở thanh dưới bài. " +
    "- images: selector 'img' trỏ ảnh nội dung (src chứa scontent/fbcdn). " +
    "Nếu không tìm được trường nào, để selectors là mảng rỗng [].";

  const user =
    "HTML bài viết (đã bỏ bình luận):\n```html\n" + html + "\n```\nTrả JSON selector theo đúng cấu trúc đã mô tả.";

  let resp;
  try {
    resp = await fetch(apiBase + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 1200,
        stream: false,
      }),
    });
  } catch (e) {
    return { ok: false, error: "Lỗi mạng khi gọi API AI: " + String(e) };
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, error: "API trả lỗi " + resp.status + ": " + body.slice(0, 300) };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: "Không đọc được JSON phản hồi từ API." };
  }

  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  if (!content) return { ok: false, error: "Phản hồi AI rỗng." };

  const selectors = parseSelectorJson(content);
  if (!selectors) {
    return { ok: false, error: "Không parse được JSON selector từ phản hồi AI:\n" + content.slice(0, 300) };
  }

  await DB.setSetting("fbSelectors", selectors);
  return { ok: true, selectors, postId: sample.postId };
}

// Lấy danh sách model khả dụng từ endpoint (GET /models). Dùng để đổ vào dropdown
// trong phần Cấu hình AI. Trả { ok, models:[id...] } hoặc { ok:false, error }.
export async function listModels() {
  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  if (!apiKey) {
    return { ok: false, error: "Chưa nhập API key. Hãy nhập key rồi lưu trước khi tải danh sách model." };
  }
  let resp;
  try {
    resp = await fetchWithTimeout(
      apiBase + "/models",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
      },
      15000
    );
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    return { ok: false, error: timedOut ? "Quá thời gian khi tải danh sách model." : "Lỗi mạng khi tải danh sách model." };
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    return { ok: false, error: "API lỗi " + resp.status + " (" + body.slice(0, 120) + ")" };
  }
  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: "Không đọc được phản hồi danh sách model." };
  }
  const arr = data && Array.isArray(data.data) ? data.data : [];
  const models = arr
    .map((m) => (m && m.id ? String(m.id) : ""))
    .filter(Boolean);
  if (!models.length) {
    return { ok: false, error: "Endpoint không trả về model nào." };
  }
  return { ok: true, models };
}

/* ======================================================================== */
/* AI XÀO NẤU NỘI DUNG ĐĂNG BÀI (chống trùng lặp khi đăng nhiều nhóm)        */
/* ======================================================================== */

/** Số biến thể mỗi lô gọi provider (server/client mirror). */
export const SPIN_BATCH_SIZE = 6;
/**
 * Số biến thể tối đa mỗi HTTP request tới `/api/ai/spin-post`.
 * Phải ≤ proxy idle timeout (~60s): mỗi request chỉ chứa 1 lô AI (~30s),
 * không giữ một kết nối cho 20–50 nhóm (trước đây gây API 500/504).
 */
export const SPIN_HTTP_CHUNK_SIZE = 6;
const SPIN_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Chia `count` thành các kích thước HTTP chunk tuần tự (không gọi mạng).
 * @param {number} count
 * @param {number} [chunkSize]
 * @returns {number[]}
 */
export function planSpinHttpChunks(count, chunkSize = SPIN_HTTP_CHUNK_SIZE) {
  const n = Math.max(1, Math.min(50, Number(count) || 1));
  const size = Math.max(1, Math.min(10, Number(chunkSize) || SPIN_HTTP_CHUNK_SIZE));
  const chunks = [];
  for (let offset = 0; offset < n; offset += size) {
    chunks.push(Math.min(size, n - offset));
  }
  return chunks;
}

/**
 * Gộp kết quả từng HTTP chunk spin thành một response thống nhất cho UI.
 * `chunkResults[i]` = body JSON từ server hoặc `null` khi request ném lỗi.
 *
 * @param {string} content
 * @param {number} count
 * @param {Array<{ok?: boolean, variants?: string[], source?: string, note?: string}|null|undefined>} chunkResults
 * @param {number[]} chunkSizes
 */
export function mergeSpinHttpChunks(content, count, chunkResults, chunkSizes) {
  const safeCount = Math.max(1, Math.min(50, Number(count) || 1));
  const base = String(content || "").trim();
  const variants = [];
  let failedChunks = 0;
  let anyAi = false;
  let anyPartial = false;
  /** @type {string[]} */
  const notes = [];

  const sizes = Array.isArray(chunkSizes) && chunkSizes.length
    ? chunkSizes
    : planSpinHttpChunks(safeCount);

  for (let i = 0; i < sizes.length; i += 1) {
    const size = sizes[i];
    const result = chunkResults && chunkResults[i];
    if (result && result.ok && Array.isArray(result.variants) && result.variants.length) {
      for (let j = 0; j < size; j += 1) {
        variants.push(String(result.variants[j] || base).trim() || base);
      }
      if (result.source === "ai") anyAi = true;
      else if (result.source === "partial-ai") {
        anyAi = true;
        anyPartial = true;
      } else if (result.source === "fallback") {
        failedChunks += 1;
        anyPartial = true;
      } else if (result.source === "original") {
        // count=1 path; treat as success without AI
      } else {
        anyAi = true;
      }
      if (result.note) notes.push(String(result.note));
    } else {
      failedChunks += 1;
      for (let j = 0; j < size; j += 1) variants.push(base);
    }
  }

  while (variants.length < safeCount) variants.push(base);

  const allFailed = failedChunks > 0 && !anyAi;
  const source = allFailed
    ? "fallback"
    : anyPartial || failedChunks
      ? "partial-ai"
      : anyAi
        ? "ai"
        : "original";

  return {
    ok: true,
    variants: variants.slice(0, safeCount),
    source,
    note:
      source === "fallback"
        ? "Không thể gọi AI — trả về bản gốc."
        : source === "partial-ai"
          ? notes[0] ||
            "Một phần nội dung chưa xào nấu được bằng AI và đang dùng bản gốc."
          : undefined,
  };
}

/**
 * Chạy tuần tự các lô nhỏ để không ép provider sinh hàng chục bài trong một
 * response. Mỗi lô lỗi tạm thời được thử lại một lần; lô vẫn lỗi mới fallback.
 */
export async function runSpinBatches({
  content,
  count,
  batchSize = SPIN_BATCH_SIZE,
  generateBatch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const variants = [];
  let failedBatches = 0;
  const safeBatchSize = Math.max(1, Math.min(10, Number(batchSize) || SPIN_BATCH_SIZE));

  for (let offset = 0; offset < count; offset += safeBatchSize) {
    const size = Math.min(safeBatchSize, count - offset);
    let generated = null;
    for (let attempt = 0; attempt < 2 && !generated; attempt += 1) {
      try {
        const batch = await generateBatch(size, offset);
        if (Array.isArray(batch) && batch.length) generated = batch;
      } catch (error) {
        const status = Number(error && error.status) || 0;
        const retryable = !status || SPIN_RETRYABLE_STATUSES.has(status);
        if (attempt === 0 && retryable) {
          await sleepFn(500);
          continue;
        }
        break;
      }
    }

    if (!generated) {
      failedBatches += 1;
      generated = Array.from({ length: size }, () => content);
    }
    for (let i = 0; i < size; i += 1) {
      variants.push(String(generated[i] || content).trim() || content);
    }
    if (offset + size < count) await sleepFn(250);
  }

  return { variants, failedBatches };
}

/**
 * Sinh N biến thể của một nội dung gốc để đăng lên nhiều nhóm khác nhau, tránh
 * bị Facebook gắn cờ trùng nội dung. YÊU CẦU CỐT LÕI: giữ nguyên Ý ĐỊNH / THÔNG
 * ĐIỆP gốc, chỉ thay đổi cách diễn đạt (câu chữ, thứ tự ý, emoji, lời chào...).
 *
 *   payload = { content: string, count: number }
 *   trả: { ok, variants: string[], source:"ai"|"fallback", note? }
 *
 * Nếu không có API key hoặc AI lỗi -> fallback: lặp lại nội dung gốc (an toàn,
 * người dùng vẫn xem/sửa được ở bước preview trước khi tạo việc).
 */
export async function spinPostContent(payload) {
  const content = (payload && payload.content ? String(payload.content) : "").trim();
  const count = Math.max(1, Math.min(50, parseInt(payload && payload.count, 10) || 1));

  if (!content) return { ok: false, error: "Chưa có nội dung gốc để xào nấu." };

  // Chỉ cần 1 biến thể -> trả nguyên gốc, không tốn gọi AI.
  if (count === 1) return { ok: true, variants: [content], source: "original" };

  const fallback = () => {
    // Không gọi được AI: trả về nội dung gốc cho tất cả (người dùng tự sửa ở preview).
    const variants = [];
    for (let i = 0; i < count; i++) variants.push(content);
    return {
      ok: true,
      variants,
      source: "fallback",
      note: "Chưa xào nấu được bằng AI nên tạm dùng nội dung gốc cho mọi nhóm. Bạn có thể sửa từng biến thể ở bước xem trước.",
    };
  };

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) {
    const fb = fallback();
    fb.note = "Chưa cấu hình API key AI (tab Cài đặt) nên chưa xào nấu được. " + (fb.note || "");
    return fb;
  }

  const buildPrompts = (batchCount, offset) => {
    const sys =
    "Bạn là TRỢ LÝ VIẾT NỘI DUNG MẠNG XÃ HỘI tiếng Việt. Người dùng có MỘT bài đăng gốc " +
    "và muốn đăng lên NHIỀU nhóm Facebook khác nhau. Để tránh bị Facebook gắn cờ trùng " +
    "nội dung, hãy viết lại thành " + batchCount + " BIẾN THỂ KHÁC NHAU.\n" +
    "QUY TẮC BẮT BUỘC:\n" +
    "1) GIỮ NGUYÊN Ý ĐỊNH, THÔNG ĐIỆP, THÔNG TIN cốt lõi của bài gốc (sản phẩm, giá, " +
    "khuyến mãi, số điện thoại, link, lời kêu gọi hành động... không được bịa thêm hay bỏ sót).\n" +
    "2) Mỗi biến thể diễn đạt KHÁC NHAU rõ rệt: đổi câu chữ, thứ tự ý, cách mở đầu/kết, " +
    "lời chào, emoji, dấu xuống dòng. KHÔNG chỉ đổi vài từ.\n" +
    "3) Giữ giọng văn tự nhiên, phù hợp người Việt, độ dài tương đương bài gốc.\n" +
    "4) TUYỆT ĐỐI không thêm tiêu đề kiểu 'Biến thể 1', không giải thích.\n" +
    'CHỈ trả JSON hợp lệ, KHÔNG bọc code fence. Cấu trúc: {"variants":["nội dung 1","nội dung 2", ...]} ' +
    "với đúng " + batchCount + " phần tử.";

    const user =
      "ĐÂY LÀ LÔ " + (Math.floor(offset / SPIN_BATCH_SIZE) + 1) + ".\n" +
      "SỐ BIẾN THỂ CẦN: " + batchCount + "\n" +
      "BÀI ĐĂNG GỐC:\n\"\"\"\n" + content + "\n\"\"\"\n" +
      "Hãy trả JSON đúng cấu trúc, mảng variants có đúng " + batchCount + " biến thể khác nhau.";
    return { sys, user };
  };

  const AI_TIMEOUT_MS = 30000;
  // Đồng bộ server: 6 biến thể bài dài dễ vượt 4000 token output.
  const SPIN_MAX_TOKENS = 8000;
  const callOnce = async (batchCount, offset, useJsonFormat) => {
    const { sys, user } = buildPrompts(batchCount, offset);
    const body = {
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.9,
      max_tokens: SPIN_MAX_TOKENS,
      stream: false,
    };
    if (useJsonFormat) body.response_format = { type: "json_object" };
    return fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body),
      },
      AI_TIMEOUT_MS
    );
  };

  const generateBatch = async (batchCount, offset) => {
    let resp = await callOnce(batchCount, offset, true);
    if (resp && (resp.status === 400 || resp.status === 422)) {
      // Một số endpoint không hỗ trợ response_format -> thử lại không có.
      resp = await callOnce(batchCount, offset, false);
    }
    if (!resp || !resp.ok) {
      const error = new Error("AI trả lỗi HTTP " + (resp ? resp.status : "?"));
      error.status = resp ? resp.status : 0;
      throw error;
    }

    const data = await resp.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    const obj = parseSelectorJson(text);
    const variants =
      obj && Array.isArray(obj.variants)
        ? obj.variants.map((v) => String(v || "").trim()).filter(Boolean)
        : [];
    if (!variants.length) throw new Error("AI trả mảng variants rỗng");
    return variants;
  };

  const result = await runSpinBatches({ content, count, generateBatch });
  return {
    ok: true,
    variants: result.variants,
    source: result.failedBatches ? "partial-ai" : "ai",
    note: result.failedBatches
      ? `${result.failedBatches} lô AI bị lỗi; chỉ các bài thuộc lô đó tạm dùng nội dung gốc.`
      : undefined,
  };
}

/* ======================================================================== */
/* AI TỰ VIẾT NỘI DUNG ĐĂNG BÀI (sinh mới từ YÊU CẦU của người dùng)         */
/* ======================================================================== */

const POST_TONE_SPECS = {
  "than-thien":
    "thân thiện, gần gũi như đang trò chuyện với bạn bè.",
  "chuyen-nghiep":
    "chuyên nghiệp, chỉn chu, tập trung vào lợi ích và uy tín.",
  "nang-dong":
    "trẻ trung, năng động, bắt trend, câu ngắn tạo năng lượng.",
  "khan-truong":
    "thúc đẩy chốt đơn, nhấn mạnh khuyến mãi/giới hạn thời gian, kêu gọi hành động mạnh.",
};

/**
 * Dựng ĐOẠN NGỮ CẢNH NGÀNH từ hồ sơ đang kích hoạt, để nhét vào system prompt của
 * generatePostContent. Nhờ đó AI viết bài đúng ngành của người dùng (điện thoại, thời
 * trang, bất động sản...) thay vì mặc định ngành máy tính. Trả về "" nếu không có hồ sơ.
 */
function buildIndustryContext(profile) {
  if (!profile || typeof profile !== "object") return "";
  const name = String(profile.name || "").trim();
  const cats = Array.isArray(profile.categories)
    ? profile.categories.map((c) => String(c || "").trim()).filter(Boolean)
    : [];
  if (!name && !cats.length) return "";
  let s = "NGÀNH HÀNG CỦA NGƯỜI DÙNG";
  if (name) s += ': "' + name + '"';
  s += ". Viết bài đúng bối cảnh, thuật ngữ và cách khách hàng của ngành này quen dùng";
  if (cats.length) s += " (nhóm sản phẩm thường gặp: " + cats.join(", ") + ")";
  s += ". TUYỆT ĐỐI không mặc định là ngành máy tính/linh kiện trừ khi yêu cầu nói vậy.\n";
  return s;
}

/**
 * Sinh MỚI N biến thể bài đăng bán hàng dựa trên YÊU CẦU (brief) của người dùng.
 * Khác với spinPostContent (xào nấu nội dung có sẵn), hàm này TỰ VIẾT nội dung
 * từ mô tả yêu cầu — sản phẩm, ưu đãi, thông tin liên hệ... do người dùng nêu.
 *
 *   payload = { brief: string, tone?: string, count?: number }
 *   trả: { ok, variants: string[], source:"ai" } hoặc { ok:false, error }
 *
 * Không có fallback "nội dung gốc" vì bản chất là sinh mới: nếu AI lỗi / chưa có
 * API key thì trả ok:false để UI báo rõ, tránh tạo hàng loạt bài rỗng.
 */
export async function generatePostContent(payload) {
  const brief = (payload && payload.brief ? String(payload.brief) : "").trim();
  const count = Math.max(1, Math.min(50, parseInt(payload && payload.count, 10) || 1));
  const toneKey = payload && payload.tone ? String(payload.tone) : "";
  const toneSpec = POST_TONE_SPECS[toneKey] || POST_TONE_SPECS["than-thien"];

  if (!brief) return { ok: false, error: "Chưa nhập yêu cầu nội dung để AI viết bài." };

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) {
    return {
      ok: false,
      error: "Chưa cấu hình API key AI (tab Cài đặt) nên chưa tự viết được nội dung.",
    };
  }

  // Lấy HỒ SƠ NGÀNH đang kích hoạt để AI viết đúng "giọng" & đặc thù ngành của
  // người dùng, thay vì gán cứng ngành máy tính. Lỗi -> hồ sơ máy tính mặc định.
  const profile = await getActiveProfile();
  const industry = buildIndustryContext(profile);

  const multi =
    count > 1
      ? "Vì sẽ đăng lên " + count + " nhóm khác nhau, hãy viết " + count +
        " BIẾN THỂ KHÁC NHAU RÕ RỆT (đổi câu chữ, cách mở đầu/kết, thứ tự ý) " +
        "để tránh bị Facebook gắn cờ trùng nội dung — nhưng CÙNG bán một sản phẩm/thông điệp.\n"
      : "Hãy viết 1 bài đăng hoàn chỉnh.\n";

  const sys =
    "Bạn là CHUYÊN GIA VIẾT CONTENT BÁN HÀNG trên Facebook, tiếng Việt. Người dùng " +
    "mô tả YÊU CẦU (sản phẩm, ưu đãi, thông tin cần có) và bạn TỰ VIẾT bài đăng bán " +
    "hàng hoàn chỉnh, sẵn sàng đăng lên nhóm.\n" +
    industry +
    "QUY TẮC BẮT BUỘC:\n" +
    "1) Bám sát YÊU CẦU: đầy đủ thông tin người dùng nêu (sản phẩm, giá, khuyến mãi, " +
    "số điện thoại, link...). KHÔNG bịa số liệu/giá/liên hệ nếu người dùng không cung cấp.\n" +
    "2) Giọng văn: " + toneSpec + "\n" +
    "3) Cấu trúc hấp dẫn: mở đầu thu hút → lợi ích/điểm nổi bật → lời kêu gọi hành động (CTA). " +
    "Dùng xuống dòng để dễ đọc trên Facebook.\n" +
    "4) TUYỆT ĐỐI KHÔNG dùng emoji/icon/ký tự đặc biệt trang trí. Chỉ dùng chữ, số và dấu câu thông thường.\n" +
    "5) TUYỆT ĐỐI không thêm tiêu đề kiểu 'Biến thể 1', không giải thích ngoài lề.\n" +
    multi +
    'CHỈ trả JSON hợp lệ, KHÔNG bọc code fence. Cấu trúc: {"variants":["nội dung 1","nội dung 2", ...]} ' +
    "với đúng " + count + " phần tử.";

  const user =
    "SỐ BÀI CẦN VIẾT: " + count + "\n" +
    "YÊU CẦU NỘI DUNG:\n\"\"\"\n" + brief + "\n\"\"\"\n" +
    'Hãy trả JSON đúng cấu trúc, mảng variants có đúng ' + count + " bài đăng hoàn chỉnh.";

  const AI_TIMEOUT_MS = 30000;
  const callOnce = async (useJsonFormat) => {
    const body = {
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.9,
      max_tokens: 4000,
      stream: false,
    };
    if (useJsonFormat) body.response_format = { type: "json_object" };
    return fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body),
      },
      AI_TIMEOUT_MS
    );
  };

  let resp;
  try {
    resp = await callOnce(true);
    if (resp && (resp.status === 400 || resp.status === 422)) {
      resp = await callOnce(false);
    }
  } catch (e) {
    return { ok: false, error: "Gọi AI thất bại: " + String(e) };
  }
  if (!resp || !resp.ok) {
    return { ok: false, error: "AI trả lỗi (HTTP " + (resp ? resp.status : "?") + ")." };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: "Không đọc được phản hồi AI." };
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  const obj = parseSelectorJson(text);
  let variants =
    obj && Array.isArray(obj.variants)
      ? obj.variants.map((v) => String(v || "").trim()).filter(Boolean)
      : [];

  // AI có thể trả thẳng 1 đoạn văn (không JSON) khi chỉ cần 1 bài.
  if (!variants.length) {
    const raw = String(text || "").trim();
    if (raw) variants = [raw];
  }
  if (!variants.length) return { ok: false, error: "AI không viết được nội dung." };

  // Chuẩn hoá về đúng count: thiếu thì nhân bản luân phiên, thừa thì cắt.
  if (variants.length < count) {
    for (let i = variants.length; i < count; i++) {
      variants.push(variants[i % variants.length]);
    }
  } else if (variants.length > count) {
    variants = variants.slice(0, count);
  }

  return { ok: true, variants, source: "ai" };
}

/**
 * generateProfileFull — Dùng AI sinh TOÀN BỘ hồ sơ ngành từ MỘT mô tả/yêu cầu
 * bằng lời của người dùng. Thay cho việc sinh lẻ từng trường: AI đọc yêu cầu +
 * ngữ cảnh hồ sơ (nếu có) rồi trả về cả 4 đoạn hướng dẫn đặc thù ngành cùng lúc
 * (classifyIntro, draftPersona, extractIntro, buildPersona) và, khi còn trống,
 * gợi ý luôn tên / mô tả / danh mục. CHỈ sinh phần nội dung đặc thù ngành —
 * KHÔNG sinh khung JSON (khung này do code tự nối ở prompts.js nên không vỡ luồng).
 *
 * payload: { request, profile:{ name, description, categories } }
 *   request  — mô tả ngành + yêu cầu bằng lời của người dùng (bắt buộc)
 * trả: { ok, fields:{ name?, description?, categories?, classifyIntro,
 *        draftPersona, extractIntro, buildPersona }, source } hoặc { ok:false, error }
 */
export async function generateProfileFull(payload) {
  const request = String((payload && payload.request) || "").trim();
  const profile = (payload && payload.profile) || {};
  const name = String(profile.name || "").trim();
  const description = String(profile.description || "").trim();
  const categories = Array.isArray(profile.categories)
    ? profile.categories.map((c) => String(c || "").trim()).filter(Boolean)
    : [];

  if (!request && !name && !description && !categories.length) {
    return {
      ok: false,
      error: "Hãy mô tả ngành hàng + yêu cầu của bạn để AI có ngữ cảnh sinh hồ sơ.",
    };
  }

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) {
    return { ok: false, error: "Chưa cấu hình API key AI (tab Cài đặt) nên chưa sinh được nội dung." };
  }

  // Mô tả ý nghĩa từng trường để AI viết đúng "phần đặc thù ngành".
  const FIELD_SPECS =
    "- classifyIntro: hướng dẫn AI PHÂN LOẠI Ý ĐỊNH của bài/bình luận trong nhóm " +
    "(khách MUỐN MUA, khách CHỈ HỎI, hay BỎ QUA), nêu dấu hiệu nhận biết theo đặc thù ngành.\n" +
    "- draftPersona: mô tả VAI TRÒ + QUY TẮC khi AI SOẠN TRẢ LỜI khách (giọng văn, thái độ, " +
    "xưng hô, nên/không nên nói, cách dẫn dắt chốt đơn) — như mô tả một nhân sự bán hàng giỏi.\n" +
    "- extractIntro: hướng dẫn AI TRÍCH GIÁ / thông tin sản phẩm từ bài RAO BÁN (lấy trường nào, " +
    "lưu ý đơn vị / khoảng giá / cách viết tắt thường gặp của ngành).\n" +
    "- buildPersona: hướng dẫn AI GHÉP BỘ / tư vấn theo NGÂN SÁCH của khách; nếu ngành không có " +
    "khái niệm ghép bộ thì viết ngắn gọn cách gợi ý sản phẩm theo ngân sách.";

  const ctx =
    "NGỮ CẢNH HỒ SƠ HIỆN CÓ (có thể trống):\n" +
    "- Tên: " + (name || "(chưa đặt)") + "\n" +
    "- Mô tả: " + (description || "(chưa có)") + "\n" +
    "- Danh mục sản phẩm: " + (categories.length ? categories.join(", ") : "(chưa có)") + "\n\n" +
    "YÊU CẦU CỦA NGƯỜI DÙNG:\n" + (request || "(người dùng không mô tả thêm — hãy suy luận từ ngữ cảnh hồ sơ)") + "\n";

  const sys =
    "Bạn là CHUYÊN GIA THIẾT KẾ PROMPT cho trợ lý bán hàng AI tiếng Việt. Người dùng " +
    "đang tạo 'hồ sơ ngành' để áp tool cho ngành của họ. Nhiệm vụ: đọc yêu cầu + ngữ cảnh " +
    "rồi viết NỘI DUNG đặc thù ngành cho CẢ 4 phần hướng dẫn (skill) cùng lúc.\n" +
    "CÁC PHẦN CẦN VIẾT:\n" + FIELD_SPECS + "\n" +
    "QUY TẮC:\n" +
    "1) Viết tiếng Việt tự nhiên, rõ ràng, đúng đặc thù ngành theo yêu cầu người dùng.\n" +
    "2) CHỈ viết phần nội dung hướng dẫn, KHÔNG kèm khung JSON mẫu, KHÔNG ví dụ JSON, " +
    "KHÔNG tiêu đề thừa, KHÔNG giải thích ngoài lề trong từng trường.\n" +
    "3) Mỗi trường độ dài vừa phải (vài câu đến một đoạn), dùng gạch đầu dòng khi cần.\n" +
    "4) LUÔN đề xuất name (ngắn gọn), description (một câu súc tích), categories (mảng chuỗi " +
    "các danh mục sản phẩm chính) suy ra từ yêu cầu người dùng — kể cả khi ngữ cảnh hồ sơ đã " +
    "có sẵn giá trị (khi đã có, hãy tinh chỉnh cho sát yêu cầu). KHÔNG bỏ trống 3 trường này.\n" +
    "CHỈ trả JSON hợp lệ, KHÔNG bọc code fence. Cấu trúc:\n" +
    '{"name":"<tên>","description":"<mô tả>","categories":["..."],' +
    '"classifyIntro":"...","draftPersona":"...","extractIntro":"...","buildPersona":"..."}';

  const user =
    ctx + "\n" +
    'Hãy trả JSON đúng cấu trúc đã nêu, điền đủ 4 trường skill và (nếu cần) name/description/categories.';

  const AI_TIMEOUT_MS = 45000;
  const callOnce = async (useJsonFormat) => {
    const body = {
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.7,
      max_tokens: 3000,
      stream: false,
    };
    if (useJsonFormat) body.response_format = { type: "json_object" };
    return fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body),
      },
      AI_TIMEOUT_MS
    );
  };

  let resp;
  try {
    resp = await callOnce(true);
    if (resp && (resp.status === 400 || resp.status === 422)) {
      resp = await callOnce(false);
    }
  } catch (e) {
    return { ok: false, error: "Gọi AI thất bại: " + String(e) };
  }
  if (!resp || !resp.ok) {
    return { ok: false, error: "AI trả lỗi (HTTP " + (resp ? resp.status : "?") + ")." };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: "Không đọc được phản hồi AI." };
  }
  const raw = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  const obj = parseSelectorJson(raw);
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "AI trả về không đúng định dạng, hãy thử lại." };
  }

  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const fields = {
    name: str(obj.name),
    description: str(obj.description),
    categories: Array.isArray(obj.categories)
      ? obj.categories.map((c) => str(c)).filter(Boolean)
      : [],
    classifyIntro: str(obj.classifyIntro),
    draftPersona: str(obj.draftPersona),
    extractIntro: str(obj.extractIntro),
    buildPersona: str(obj.buildPersona),
  };
  // Coi là thành công nếu AI sinh được ít nhất 1 trong 4 trường skill.
  const hasSkill =
    fields.classifyIntro || fields.draftPersona || fields.extractIntro || fields.buildPersona;
  if (!hasSkill) return { ok: false, error: "AI không sinh được nội dung, hãy thử lại." };

  return { ok: true, fields, source: "ai" };
}

/**
 * draftPitch — Soạn MỘT tin nhắn CHÀO HÀNG riêng (inbox/DM) gửi tới một khách tiềm
 * năng đã phát hiện từ bài đăng trong nhóm. Khác với generatePostContent (viết bài
 * đăng công khai) và draftConversationReply (trả lời công khai dưới bình luận): đây là
 * lời chào hàng NGẮN, mang tính CÁ NHÂN, gửi thẳng hộp thư của khách.
 *
 *   payload = {
 *     postText:   string,   // nội dung bài đăng của khách (ngữ cảnh nhu cầu) — nên có
 *     authorName: string?,  // tên khách để xưng hô cho tự nhiên
 *     groupName:  string?,  // tên nhóm (ngữ cảnh)
 *     userPitch:  string?,  // NỘI DUNG NGƯỜI DÙNG TỰ ĐIỀN — nếu có, AI dựa/bám theo
 *   }
 *   trả: { ok, message: string, source:"ai" } hoặc { ok:false, error }
 *
 * Lấy HỒ SƠ NGÀNH đang kích hoạt (giọng văn + đặc thù ngành) qua draftPersona để tin
 * nhắn đúng "chất" người dùng. Nếu có userPitch: AI dựa trên ý người dùng, chỉ tinh
 * chỉnh/cá nhân hoá cho khớp bài đăng, KHÔNG bịa thêm thông tin. Không có fallback nội
 * dung để tránh gửi tin rỗng: AI lỗi / chưa có API key -> ok:false để UI báo rõ.
 */
export async function draftPitch(payload) {
  const postText = String((payload && payload.postText) || "").trim();
  const authorName = String((payload && payload.authorName) || "").trim();
  const groupName = String((payload && payload.groupName) || "").trim();
  const userPitch = String((payload && payload.userPitch) || "").trim();

  if (!postText && !userPitch) {
    return {
      ok: false,
      error: "Thiếu ngữ cảnh: cần nội dung bài đăng của khách hoặc nội dung bạn tự điền.",
    };
  }

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) {
    return {
      ok: false,
      error: "Chưa cấu hình API key AI (tab Cài đặt) nên chưa soạn được tin chào hàng.",
    };
  }

  // Hồ sơ ngành đang kích hoạt -> giọng văn + đặc thù ngành (draftPersona) + ngữ cảnh ngành.
  const profile = await getActiveProfile();
  const industry = buildIndustryContext(profile);
  const persona = String((profile && profile.draftPersona) || "").trim();

  const guidance = userPitch
    ? "NGƯỜI DÙNG ĐÃ ĐIỀN SẴN Ý CHÀO HÀNG dưới đây. Hãy BÁM SÁT ý đó, chỉ tinh chỉnh câu " +
      "chữ và CÁ NHÂN HOÁ cho khớp nhu cầu trong bài đăng của khách. KHÔNG bịa thêm sản phẩm, " +
      "giá, khuyến mãi hay thông tin liên hệ mà người dùng không nêu.\n"
    : "Hãy TỰ SOẠN một lời chào hàng phù hợp nhu cầu khách nêu trong bài đăng, đúng ngành hàng, " +
      "KHÔNG bịa số liệu/giá/liên hệ cụ thể nếu không có dữ liệu.\n";

  const sys =
    "Bạn là NHÂN VIÊN BÁN HÀNG giỏi, đang NHẮN TIN RIÊNG (inbox) cho một khách tiềm năng " +
    "vừa đăng bài trong nhóm Facebook. Nhiệm vụ: soạn MỘT tin nhắn chào hàng đầu tiên.\n" +
    industry +
    (persona ? "VAI TRÒ & GIỌNG VĂN CỦA BẠN:\n" + persona + "\n" : "") +
    guidance +
    "QUY TẮC BẮT BUỘC:\n" +
    "1) NGẮN GỌN (2-5 câu), thân thiện, tự nhiên như người thật nhắn tin — KHÔNG rập khuôn spam.\n" +
    "2) Mở đầu chào và nhắc khéo tới nhu cầu khách vừa đăng để thấy bạn đã đọc bài của họ.\n" +
    "3) Gợi mở rằng bạn có thể hỗ trợ/cung cấp thứ họ cần và mời khách trao đổi thêm (CTA nhẹ nhàng).\n" +
    "4) TUYỆT ĐỐI KHÔNG dùng emoji/icon/ký tự trang trí. Chỉ dùng chữ, số và dấu câu thông thường.\n" +
    "5) KHÔNG chèn link, KHÔNG xin số điện thoại dồn dập, KHÔNG hối thúc gây khó chịu.\n" +
    "6) KHÔNG thêm tiêu đề, KHÔNG giải thích ngoài lề, chỉ trả đúng nội dung tin nhắn.\n" +
    (authorName ? '7) Xưng hô lịch sự, có thể gọi khách theo tên "' + authorName + '" nếu tự nhiên.\n' : "") +
    'CHỈ trả JSON hợp lệ, KHÔNG bọc code fence. Cấu trúc: {"message":"<nội dung tin nhắn>"}';

  const ctx =
    (authorName ? "TÊN KHÁCH: " + authorName + "\n" : "") +
    (groupName ? "NHÓM: " + groupName + "\n" : "") +
    (postText ? 'BÀI ĐĂNG CỦA KHÁCH:\n"""\n' + postText + '\n"""\n' : "") +
    (userPitch ? 'Ý CHÀO HÀNG NGƯỜI DÙNG TỰ ĐIỀN:\n"""\n' + userPitch + '\n"""\n' : "");

  const user =
    ctx + "\n" +
    'Hãy trả JSON đúng cấu trúc {"message":"..."} với một tin nhắn chào hàng riêng hoàn chỉnh.';

  const AI_TIMEOUT_MS = 30000;
  const callOnce = async (useJsonFormat) => {
    const body = {
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.8,
      max_tokens: 1200,
      stream: false,
    };
    if (useJsonFormat) body.response_format = { type: "json_object" };
    return fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body),
      },
      AI_TIMEOUT_MS
    );
  };

  let resp;
  try {
    resp = await callOnce(true);
    if (resp && (resp.status === 400 || resp.status === 422)) {
      resp = await callOnce(false);
    }
  } catch (e) {
    return { ok: false, error: "Gọi AI thất bại: " + String(e) };
  }
  if (!resp || !resp.ok) {
    return { ok: false, error: "AI trả lỗi (HTTP " + (resp ? resp.status : "?") + ")." };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: "Không đọc được phản hồi AI." };
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  const obj = parseSelectorJson(text);
  let message = obj && typeof obj.message === "string" ? obj.message.trim() : "";

  // AI có thể trả thẳng đoạn văn (không JSON).
  if (!message) {
    const raw = String(text || "").trim();
    if (raw) message = raw;
  }
  if (!message) return { ok: false, error: "AI không soạn được tin chào hàng, hãy thử lại." };

  return { ok: true, message, source: "ai" };
}

/**
 * Soạn NHÁP trả lời cho một HỘI THOẠI CÓ SẴN trong Messenger (khác draftPitch:
 * đây là TRẢ LỜI khách đang nhắn với mình, dựa trên lịch sử tin nhắn thật).
 *
 * payload = {
 *   contactName: string,            // tên người đang chat với mình
 *   messages: [{ mine:boolean, text:string }],  // lịch sử tin nhắn (cũ -> mới)
 *   userHint?: string,              // gợi ý/ý người dùng muốn trả lời (tuỳ chọn)
 * }
 * Trả về { ok, message, source } hoặc { ok:false, error }.
 */
export async function draftInboxReply(payload) {
  const contactName = String((payload && payload.contactName) || "").trim();
  const userHint = String((payload && payload.userHint) || "").trim();
  const history = Array.isArray(payload && payload.messages) ? payload.messages : [];

  // Cần ít nhất một tin của KHÁCH để có gì mà trả lời.
  const hasIncoming = history.some((m) => m && !m.mine && String(m.text || "").trim());
  if (!hasIncoming && !userHint) {
    return {
      ok: false,
      error: "Chưa có tin nhắn nào của khách để trả lời (hoặc hãy nhập ý bạn muốn nhắn).",
    };
  }

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) {
    return {
      ok: false,
      error: "Chưa cấu hình API key AI (tab Cài đặt) nên chưa soạn được câu trả lời.",
    };
  }

  const profile = await getActiveProfile();
  const industry = buildIndustryContext(profile);
  const persona = String((profile && profile.draftPersona) || "").trim();

  const guidance = userHint
    ? "NGƯỜI DÙNG ĐÃ GỢI Ý Ý TRẢ LỜI dưới đây. Hãy BÁM SÁT ý đó, chỉ tinh chỉnh câu chữ cho " +
      "tự nhiên, lịch sự và khớp mạch hội thoại. KHÔNG bịa thêm sản phẩm/giá/khuyến mãi/liên hệ " +
      "mà người dùng không nêu.\n"
    : "Hãy soạn câu trả lời phù hợp NGỮ CẢNH hội thoại và tin nhắn gần nhất của khách. Nếu khách " +
      "hỏi thông tin bạn không chắc (giá cụ thể, tồn kho, chính sách), hãy trả lời khéo là sẽ kiểm " +
      "tra/xác nhận lại thay vì bịa số liệu.\n";

  const sys =
    "Bạn là NHÂN VIÊN CHĂM SÓC KHÁCH HÀNG đang TRẢ LỜI TIN NHẮN riêng (Messenger) với một khách. " +
    "Nhiệm vụ: soạn MỘT tin nhắn trả lời tiếp theo trong mạch hội thoại.\n" +
    industry +
    (persona ? "VAI TRÒ & GIỌNG VĂN CỦA BẠN:\n" + persona + "\n" : "") +
    guidance +
    "QUY TẮC BẮT BUỘC:\n" +
    "1) NGẮN GỌN, thân thiện, tự nhiên như người thật đang nhắn — KHÔNG rập khuôn, KHÔNG spam.\n" +
    "2) Trả lời ĐÚNG câu hỏi/nhu cầu gần nhất của khách; giữ mạch hội thoại liền lạc.\n" +
    "3) TUYỆT ĐỐI KHÔNG dùng emoji/icon/ký tự trang trí. Chỉ dùng chữ, số và dấu câu thông thường.\n" +
    "4) KHÔNG bịa số liệu/giá/tồn kho/chính sách nếu không có dữ liệu; nói sẽ xác nhận lại.\n" +
    "5) KHÔNG thêm tiêu đề hay giải thích ngoài lề, chỉ trả đúng nội dung tin nhắn.\n" +
    (contactName ? '6) Có thể xưng hô với khách theo tên "' + contactName + '" nếu tự nhiên.\n' : "") +
    'CHỈ trả JSON hợp lệ, KHÔNG bọc code fence. Cấu trúc: {"message":"<nội dung trả lời>"}';

  // Dựng lại lịch sử hội thoại (giới hạn 20 tin gần nhất để tiết kiệm token).
  const recent = history.slice(-20);
  const transcript = recent
    .map((m) => (m && m.mine ? "TÔI: " : "KHÁCH: ") + String((m && m.text) || "").trim())
    .filter((line) => line.length > 5)
    .join("\n");

  const ctx =
    (contactName ? "TÊN KHÁCH: " + contactName + "\n" : "") +
    (transcript ? 'LỊCH SỬ HỘI THOẠI (cũ -> mới):\n"""\n' + transcript + '\n"""\n' : "") +
    (userHint ? 'Ý NGƯỜI DÙNG MUỐN TRẢ LỜI:\n"""\n' + userHint + '\n"""\n' : "");

  const user =
    ctx + "\n" +
    'Hãy trả JSON đúng cấu trúc {"message":"..."} với MỘT tin nhắn trả lời tiếp theo hoàn chỉnh.';

  const AI_TIMEOUT_MS = 30000;
  const callOnce = async (useJsonFormat) => {
    const body = {
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.8,
      max_tokens: 1200,
      stream: false,
    };
    if (useJsonFormat) body.response_format = { type: "json_object" };
    return fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify(body),
      },
      AI_TIMEOUT_MS
    );
  };

  let resp;
  try {
    resp = await callOnce(true);
    if (resp && (resp.status === 400 || resp.status === 422)) {
      resp = await callOnce(false);
    }
  } catch (e) {
    return { ok: false, error: "Gọi AI thất bại: " + String(e) };
  }
  if (!resp || !resp.ok) {
    return { ok: false, error: "AI trả lỗi (HTTP " + (resp ? resp.status : "?") + ")." };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { ok: false, error: "Không đọc được phản hồi AI." };
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  const obj = parseSelectorJson(text);
  let message = obj && typeof obj.message === "string" ? obj.message.trim() : "";
  if (!message) {
    const raw = String(text || "").trim();
    if (raw) message = raw;
  }
  if (!message) return { ok: false, error: "AI không soạn được câu trả lời, hãy thử lại." };

  return { ok: true, message, source: "ai" };
}
