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
  const POST_ID_PATTERNS = [
    /\/groups\/[^/]+\/posts\/(\d+)/,
    /\/groups\/[^/]+\/permalink\/(\d+)/,
    /multi_permalinks?=(\d+)/,
    /[?&]story_fbid=(\d+)/,
    /\/permalink\/(\d+)/,
    /\/posts\/(\d+)/,
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

  await new Promise((r) => chrome.storage.local.set({ fbSelectors: selectors }, r));
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
/* ===================  BUILD CẤU HÌNH PC BẰNG AI  ======================== */
/* ======================================================================== */

// Dashboard đã gom sẵn ứng viên theo từng danh mục (mỗi linh kiện đã có GIÁ THỰC,
// đánh dấu owned/cửa hàng nguồn). Ở đây ta chỉ nhờ AI CHỌN tổ hợp tốt nhất vừa
// ngân sách + nhu cầu. Nếu AI lỗi/parse hỏng -> fallback thuật toán tham lam.
//   payload = {
//     budget: number (VND),
//     needs: string (mô tả nhu cầu),
//     categories: ["CPU","Main",...]  (danh mục bắt buộc, theo thứ tự ưu tiên),
//     candidates: { "<category>": [{ id, name, price, store, owned }] }
//   }
//   trả: { ok, items:[{category,id,reason}], note, source:"ai"|"fallback" }
export async function buildConfigWithAI(payload) {
  const budget = Number(payload && payload.budget) || 0;
  const needs = (payload && payload.needs ? String(payload.needs) : "").trim();
  const categories = Array.isArray(payload && payload.categories) ? payload.categories : [];
  const candidates = (payload && payload.candidates) || {};

  if (!budget || budget <= 0) {
    return { ok: false, error: "Chưa nhập ngân sách hợp lệ." };
  }
  if (!categories.length) {
    return { ok: false, error: "Chưa chọn danh mục linh kiện nào." };
  }
  // Phải có ít nhất một ứng viên ở đâu đó.
  const totalCand = categories.reduce(
    (n, c) => n + ((candidates[c] && candidates[c].length) || 0),
    0
  );
  if (!totalCand) {
    return {
      ok: false,
      error: "Không có linh kiện nào trong kho/thị trường khớp danh mục đã chọn. Hãy nhập kho hoặc đồng bộ nguồn giá.",
    };
  }

  broadcast("BUILD_PROGRESS", { phase: "prepare", text: "Đang gom linh kiện ứng viên..." });

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";

  // Không có API key -> đi thẳng fallback thuật toán (vẫn cho ra cấu hình dùng được).
  if (!apiKey) {
    broadcast("BUILD_PROGRESS", { phase: "fallback", text: "Chưa có API key, dùng thuật toán tự chọn..." });
    const fb = fallbackBuild(budget, categories, candidates);
    fb.note = "Chưa có API key nên dùng thuật toán tự chọn (rẻ/cân đối). " + (fb.note || "");
    return fb;
  }

  // Rút gọn dữ liệu gửi AI: lấy MẪU TRẢI ĐỀU theo giá (rẻ nhất -> đắt nhất) để AI
  // thấy được cả linh kiện cao cấp, không chỉ hàng rẻ. Tối đa ~16 món/danh mục.
  const slim = {};
  // Mỗi ứng viên gửi cho AI được gán MỘT MÃ NGẮN (số thứ tự) thay vì productId dài
  // dạng "mystore::gid::slug". Lý do gốc của lỗi "AI bỏ sót": AI rất hay chép sai
  // chuỗi id dài/đặc biệt -> đối chiếu hụt -> danh mục bị coi là bỏ sót oan. Mã ngắn
  // dễ trả đúng, và ta tự map ngược về ứng viên thực + danh mục CHUẨN (không phụ
  // thuộc vào tên danh mục do AI tự gõ lại).
  const idMap = new Map(); // mã (ngắn HOẶC id thực) -> { category, realId }
  let seq = 0;
  for (const c of categories) {
    const sortedAll = (candidates[c] || [])
      .filter((x) => x && x.id)
      .slice()
      .sort((a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity));
    // Cắt món đắt hơn cả NGÂN SÁCH: 1 linh kiện không thể đắt hơn toàn bộ tiền
    // (VD ngân sách 25tr mà VGA 60tr) -> loại để AI khỏi chọn lệch & đỡ tốn token.
    // Luôn giữ ít nhất món rẻ nhất để danh mục không bị rỗng.
    const underBudget = sortedAll.filter((x) => (Number(x.price) || Infinity) <= budget);
    const full = underBudget.length ? underBudget : sortedAll.slice(0, 1);
    const CAP = 16;
    let chosenPool;
    if (full.length <= CAP) {
      chosenPool = full;
    } else {
      // Luôn giữ hàng trong kho (owned) + lấy mẫu trải đều phần còn lại theo giá.
      const ownedItems = full.filter((x) => x.owned);
      const rest = full.filter((x) => !x.owned);
      const keepIds = new Set(ownedItems.map((x) => String(x.id)));
      const slots = Math.max(1, CAP - keepIds.size);
      const step = rest.length / slots;
      const sampled = [];
      for (let i = 0; i < slots; i++) {
        const it = rest[Math.min(rest.length - 1, Math.floor(i * step))];
        if (it && !keepIds.has(String(it.id))) {
          keepIds.add(String(it.id));
          sampled.push(it);
        }
      }
      // Đảm bảo có cả món đắt nhất để AI biết trần hiệu năng.
      const top = rest[rest.length - 1];
      if (top && !keepIds.has(String(top.id))) sampled.push(top);
      chosenPool = ownedItems.concat(sampled)
        .sort((a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity));
    }
    slim[c] = chosenPool.map((x) => {
      const sid = String(++seq);
      const ref = { category: c, realId: x.id };
      idMap.set(sid, ref);          // mã ngắn AI cần trả về
      idMap.set(String(x.id), ref); // dự phòng nếu AI lỡ trả lại nguyên id thực
      return {
        id: sid,
        name: x.name || "",
        price: Number(x.price) || null,
        store: x.store || "",
        owned: !!x.owned,
      };
    });
  }

  const sys =
    "Bạn là KỸ SƯ BUILD PC cao cấp (senior system builder) với 10+ năm kinh nghiệm tại Việt Nam, " +
    "am hiểu sâu về tương thích phần cứng, nghẽn cổ chai và tối ưu hiệu năng/giá. " +
    "Khách đưa NGÂN SÁCH (VND) và NHU CẦU. Bạn nhận danh sách linh kiện ỨNG VIÊN theo từng danh mục " +
    "(mỗi món có id, name, price VND, store, owned=có sẵn trong kho). " +
    "NHIỆM VỤ: chọn đúng 1 linh kiện cho MỖI danh mục để tạo ra cấu hình TỐT NHẤT CÓ THỂ, theo các nguyên tắc của kỹ sư:\n" +
    "1) TƯƠNG THÍCH: CPU phải khớp socket/chipset của Mainboard (Intel LGA1700/1851, AMD AM4/AM5); RAM đúng chuẩn (DDR4/DDR5) theo Main; " +
    "Nguồn (PSU) phải đủ công suất cho VGA + CPU (cộng ~30% dự phòng); Vỏ case đủ chỗ cho VGA và tản nhiệt.\n" +
    "2) CÂN BẰNG, TRÁNH NGHẼN CỔ CHAI: CPU - VGA - RAM phải tương xứng nhau, không ghép CPU yếu với VGA quá mạnh hoặc ngược lại.\n" +
    "3) PHÂN BỔ NGÂN SÁCH THEO NHU CẦU: gaming -> dồn tiền cho VGA (40-50%), CPU vừa đủ; " +
    "đồ hoạ/render/AI -> ưu tiên CPU nhiều nhân + RAM dung lượng lớn + VGA mạnh; " +
    "văn phòng -> tối giản, bỏ VGA rời nếu CPU có iGPU, dồn vào SSD + RAM; " +
    "stream -> CPU nhiều nhân + VGA tầm trung + RAM lớn.\n" +
    "4) TIÊU TIỀN THÔNG MINH: HÃY DÙNG GẦN HẾT ngân sách để đạt hiệu năng cao nhất (không cố tình chọn hàng rẻ để dư tiền), " +
    "nhưng TUYỆT ĐỐI KHÔNG vượt ngân sách. Nếu dư nhiều, nâng cấp linh kiện quan trọng nhất theo nhu cầu.\n" +
    "5) ƯU TIÊN owned=true (hàng trong kho) khi hiệu năng/giá tương đương để bán được hàng tồn.\n" +
    "CHỈ trả JSON hợp lệ, KHÔNG giải thích ngoài JSON, KHÔNG bọc code fence. " +
    'Cấu trúc: {"items":[{"category":"<tên danh mục>","id":"<id linh kiện đã chọn>","reason":"<lý do kỹ thuật ngắn gọn vì sao chọn món này>"}],"note":"<đánh giá tổng thể cấu hình: điểm mạnh, mức hiệu năng kỳ vọng cho nhu cầu, 1-3 câu>"}. ' +
    'QUAN TRỌNG: trường "id" là MÃ SỐ NGẮN của ứng viên (đúng giá trị "id" trong danh sách ỨNG VIÊN, ví dụ "7"). CHÉP NGUYÊN VĂN mã đó, KHÔNG tự bịa, KHÔNG ghi tên linh kiện vào id. ' +
    "BẮT BUỘC mỗi danh mục được yêu cầu phải có đúng 1 item, id phải nằm trong danh sách ứng viên của danh mục đó.";

  const user =
    "NGÂN SÁCH: " + budget + " VND (hãy tận dụng tối đa, không vượt)\n" +
    "NHU CẦU: " + (needs || "(không nêu rõ, hãy cân đối đa dụng)") + "\n" +
    "DANH MỤC BẮT BUỘC (theo thứ tự ưu tiên): " + JSON.stringify(categories) + "\n" +
    "ỨNG VIÊN (JSON, đã sắp theo giá tăng dần):\n" + JSON.stringify(slim) + "\n" +
    "Hãy phân tích như một kỹ sư rồi trả JSON theo đúng cấu trúc đã mô tả. Tổng giá các món chọn phải <= ngân sách.";

  broadcast("BUILD_PROGRESS", { phase: "calling", text: "Đang hỏi kỹ sư AI để chọn cấu hình tốt nhất..." });

  const AI_TIMEOUT_MS = 25000;
  let resp;
  try {
    resp = await fetchWithTimeout(
      apiBase + "/chat/completions",
      {
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
          temperature: 0.2,
          max_tokens: 3000,
          stream: false,
          response_format: { type: "json_object" },
        }),
      },
      AI_TIMEOUT_MS
    );
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    broadcast("BUILD_PROGRESS", { phase: "fallback", text: "AI phản hồi chậm, chuyển sang thuật toán tự chọn..." });
    const fb = fallbackBuild(budget, categories, candidates);
    fb.note =
      (timedOut ? "AI phản hồi quá lâu (>25s)" : "Lỗi mạng khi gọi AI") +
      ", dùng thuật toán tự chọn. " +
      (fb.note || "");
    return fb;
  }

  // Một số endpoint không hỗ trợ response_format json_object -> trả 400/422.
  // Thử lại 1 lần KHÔNG kèm response_format trước khi bỏ cuộc về thuật toán.
  if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
    try {
      resp = await fetchWithTimeout(
        apiBase + "/chat/completions",
        {
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
            temperature: 0.2,
            max_tokens: 3000,
            stream: false,
          }),
        },
        AI_TIMEOUT_MS
      );
    } catch (e) {
      const timedOut = e && e.name === "AbortError";
      broadcast("BUILD_PROGRESS", { phase: "fallback", text: "AI phản hồi chậm, chuyển sang thuật toán tự chọn..." });
      const fb = fallbackBuild(budget, categories, candidates);
      fb.note =
        (timedOut ? "AI phản hồi quá lâu (>25s, lần 2)" : "Lỗi mạng khi gọi AI (lần 2)") +
        ", dùng thuật toán tự chọn. " +
        (fb.note || "");
      return fb;
    }
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const fb = fallbackBuild(budget, categories, candidates);
    fb.note =
      "API lỗi " + resp.status + " (" + body.slice(0, 120) + "), dùng thuật toán tự chọn. " +
      (fb.note || "");
    return fb;
  }

  broadcast("BUILD_PROGRESS", { phase: "parsing", text: "Đang phân tích lựa chọn của AI..." });

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    const fb = fallbackBuild(budget, categories, candidates);
    fb.note = "Không đọc được phản hồi AI, dùng thuật toán tự chọn. " + (fb.note || "");
    return fb;
  }

  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  const parsed = parseSelectorJson(content); // tái dùng: chịu được code fence / chữ thừa
  let items = parsed && Array.isArray(parsed.items) ? parsed.items : null;
  let salvagedNote = parsed && parsed.note ? String(parsed.note) : "";

  // Nếu JSON parse hỏng (thường do bị cắt cụt vì hết token) -> cứu vớt bằng regex:
  // bóc từng object {"category":..,"id":..,"reason":..} còn nguyên trong chuỗi.
  if (!items || !items.length) {
    items = salvageBuildItems(content);
  }

  if (!items || !items.length) {
    const fb = fallbackBuild(budget, categories, candidates);
    const snip = String(content || "").replace(/\s+/g, " ").slice(0, 160);
    fb.note =
      "AI trả về không đọc được (" + (snip || "rỗng") + "), dùng thuật toán tự chọn. " +
      (fb.note || "");
    return fb;
  }

  // Đối chiếu lựa chọn của AI qua idMap (mã ngắn -> {category, realId}).
  // KHÔNG tin tên danh mục AI tự gõ (it.category) vì AI hay đổi cách gọi
  // ("VGA" <-> "Card màn hình") làm tra trượt -> bỏ sót oan. Danh mục lấy
  // từ idMap (nhãn CHUẨN). Chỉ cần AI trả đúng MÃ là khớp được ứng viên thực.
  const chosen = [];
  const usedCats = new Set();
  for (const it of items) {
    if (!it || it.id == null) continue;
    const ref = idMap.get(String(it.id).trim());
    if (!ref) continue; // mã không có trong danh sách ứng viên -> bỏ (chống AI bịa)
    if (usedCats.has(ref.category)) continue;
    usedCats.add(ref.category);
    chosen.push({ category: ref.category, id: ref.realId, reason: (it.reason || "").slice(0, 200) });
  }
  // Danh mục nào AI bỏ sót -> lấp bằng món rẻ nhất còn lại (để cấu hình đủ bộ).
  for (const c of categories) {
    if (usedCats.has(c)) continue;
    const pool = (candidates[c] || [])
      .slice()
      .sort((a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity));
    if (pool.length) {
      chosen.push({ category: c, id: pool[0].id, reason: "Bổ sung tự động (AI bỏ sót)." });
      usedCats.add(c);
    }
  }

  if (!chosen.length) {
    const fb = fallbackBuild(budget, categories, candidates);
    fb.note = "AI không chọn được món hợp lệ, dùng thuật toán tự chọn. " + (fb.note || "");
    return fb;
  }

  return {
    ok: true,
    source: "ai",
    items: chosen,
    note: String(salvagedNote || "").slice(0, 400),
  };
}

// Cứu vớt khi JSON của AI bị cắt cụt: dùng regex bóc từng object linh kiện còn
// nguyên vẹn (có đủ category + id). Bỏ qua object dở dang ở cuối.
export function salvageBuildItems(text) {
  if (!text) return [];
  const out = [];
  const re = /\{[^{}]*?"category"\s*:\s*"([^"]*)"[^{}]*?"id"\s*:\s*"([^"]*)"[^{}]*?\}/g;
  let m;
  while ((m = re.exec(String(text)))) {
    const seg = m[0];
    const rMatch = seg.match(/"reason"\s*:\s*"([^"]*)"/);
    out.push({ category: m[1], id: m[2], reason: rMatch ? rMatch[1] : "" });
  }
  // Một số model đặt id trước category -> thử chiều ngược lại nếu chưa bóc được gì.
  if (!out.length) {
    const re2 = /\{[^{}]*?"id"\s*:\s*"([^"]*)"[^{}]*?"category"\s*:\s*"([^"]*)"[^{}]*?\}/g;
    while ((m = re2.exec(String(text)))) {
      const seg = m[0];
      const rMatch = seg.match(/"reason"\s*:\s*"([^"]*)"/);
      out.push({ category: m[2], id: m[1], reason: rMatch ? rMatch[1] : "" });
    }
  }
  return out;
}

// Thuật toán dự phòng: chọn món rẻ nhất mỗi danh mục, nếu còn dư ngân sách thì
// NÂNG CẤP dần các danh mục (theo thứ tự ưu tiên đã truyền) lên món đắt hơn kế
// tiếp mà vẫn nằm trong ngân sách. Không gọi mạng, luôn cho ra cấu hình đủ bộ.
export function fallbackBuild(budget, categories, candidates) {
  // Bước 1: nền tảng = món rẻ nhất mỗi danh mục.
  const sorted = {};
  const pick = {};
  let total = 0;
  for (const c of categories) {
    const pool = (candidates[c] || [])
      .filter((x) => x && x.id && Number(x.price) > 0)
      .slice()
      .sort((a, b) => Number(a.price) - Number(b.price));
    sorted[c] = pool;
    if (pool.length) {
      pick[c] = 0;
      total += Number(pool[0].price);
    } else {
      pick[c] = -1; // không có ứng viên có giá
    }
  }

  // Bước 2: nâng cấp tham lam theo thứ tự ưu tiên (danh mục đầu = quan trọng nhất).
  let improved = true;
  while (improved) {
    improved = false;
    for (const c of categories) {
      const pool = sorted[c];
      const idx = pick[c];
      if (idx < 0 || idx + 1 >= pool.length) continue;
      const delta = Number(pool[idx + 1].price) - Number(pool[idx].price);
      if (total + delta <= budget) {
        pick[c] = idx + 1;
        total += delta;
        improved = true;
      }
    }
  }

  const items = [];
  for (const c of categories) {
    const pool = sorted[c];
    const idx = pick[c];
    if (idx >= 0 && pool[idx]) {
      items.push({ category: c, id: pool[idx].id, reason: "Tự chọn cân đối theo ngân sách." });
    } else if ((candidates[c] || []).length) {
      // Có ứng viên nhưng không có giá -> vẫn đưa vào (giá sẽ hiển thị "chưa có").
      items.push({ category: c, id: candidates[c][0].id, reason: "Chưa có giá, đưa vào để tham khảo." });
    }
  }

  return {
    ok: true,
    source: "fallback",
    items,
    note:
      total > 0
        ? "Tổng tạm tính " + total.toLocaleString("vi-VN") + "₫ trong ngân sách " +
          budget.toLocaleString("vi-VN") + "₫."
        : "",
  };
}

/* ======================================================================== */
/* AI XÀO NẤU NỘI DUNG ĐĂNG BÀI (chống trùng lặp khi đăng nhiều nhóm)        */
/* ======================================================================== */

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

  const sys =
    "Bạn là TRỢ LÝ VIẾT NỘI DUNG MẠNG XÃ HỘI tiếng Việt. Người dùng có MỘT bài đăng gốc " +
    "và muốn đăng lên NHIỀU nhóm Facebook khác nhau. Để tránh bị Facebook gắn cờ trùng " +
    "nội dung, hãy viết lại thành " + count + " BIẾN THỂ KHÁC NHAU.\n" +
    "QUY TẮC BẮT BUỘC:\n" +
    "1) GIỮ NGUYÊN Ý ĐỊNH, THÔNG ĐIỆP, THÔNG TIN cốt lõi của bài gốc (sản phẩm, giá, " +
    "khuyến mãi, số điện thoại, link, lời kêu gọi hành động... không được bịa thêm hay bỏ sót).\n" +
    "2) Mỗi biến thể diễn đạt KHÁC NHAU rõ rệt: đổi câu chữ, thứ tự ý, cách mở đầu/kết, " +
    "lời chào, emoji, dấu xuống dòng. KHÔNG chỉ đổi vài từ.\n" +
    "3) Giữ giọng văn tự nhiên, phù hợp người Việt, độ dài tương đương bài gốc.\n" +
    "4) TUYỆT ĐỐI không thêm tiêu đề kiểu 'Biến thể 1', không giải thích.\n" +
    'CHỈ trả JSON hợp lệ, KHÔNG bọc code fence. Cấu trúc: {"variants":["nội dung 1","nội dung 2", ...]} ' +
    "với đúng " + count + " phần tử.";

  const user =
    "SỐ BIẾN THỂ CẦN: " + count + "\n" +
    "BÀI ĐĂNG GỐC:\n\"\"\"\n" + content + "\n\"\"\"\n" +
    "Hãy trả JSON đúng cấu trúc, mảng variants có đúng " + count + " biến thể khác nhau.";

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
      // Một số endpoint không hỗ trợ response_format -> thử lại không có.
      resp = await callOnce(false);
    }
  } catch (e) {
    return fallback();
  }

  if (!resp || !resp.ok) return fallback();

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return fallback();
  }
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : "";
  const obj = parseSelectorJson(text);
  let variants =
    obj && Array.isArray(obj.variants)
      ? obj.variants.map((v) => String(v || "").trim()).filter(Boolean)
      : [];

  if (!variants.length) return fallback();

  // Chuẩn hoá về đúng count: thiếu thì bù bằng nội dung gốc, thừa thì cắt bớt.
  if (variants.length < count) {
    for (let i = variants.length; i < count; i++) {
      variants.push(variants[i % variants.length] || content);
    }
  } else if (variants.length > count) {
    variants = variants.slice(0, count);
  }

  return { ok: true, variants, source: "ai" };
}
