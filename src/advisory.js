/**
 * advisory.js — TƯ VẤN AI (chào giá / hỗ trợ khách hàng).
 *
 * TRIẾT LÝ AN TOÀN (uy tín là trên hết):
 *  1) AI CHỈ được dùng GIÁ + SẢN PHẨM THẬT trong kho. KHÔNG bịa giá, KHÔNG bịa
 *     thông số, KHÔNG hứa khuyến mãi/quà tặng không có thật.
 *  2) Mọi phản hồi chỉ tạo NHÁP (status="pending"). Người duyệt mới gửi. Không
 *     bao giờ tự động bình luận.
 *  3) HẬU KIỂM bắt buộc: mọi con số tiền trong nháp phải khớp giá thật của sản
 *     phẩm đã dùng (hoặc ngân sách KH nêu). Lệch -> gắn cờ needsHumanCheck.
 *  4) Không có API key -> KHÔNG soạn nháp (thà không trả lời còn hơn trả lời sai).
 *  5) Chống spam: dedupe theo postId, giới hạn số nháp mỗi nhóm mỗi lần chạy.
 */

import * as DB from "./db.js";
import { getAIConfig, fetchWithTimeout, parseSelectorJson, broadcast } from "./util.js";
import { getActiveProfile, systemForClassify, systemForDraft } from "./prompts.js";

// Lọc thô bằng từ khóa: bài có dấu hiệu MUA hoặc HỎI mới đáng đưa cho AI phân
// loại (tiết kiệm token + tránh nhiễu). Bài không khớp gì -> bỏ qua sớm.
const ADVISORY_BUY_KEYWORDS = [
  "cần mua", "muốn mua", "tư vấn", "build pc", "build cấu hình", "ráp máy",
  "lắp máy", "cấu hình", "ngân sách", "tầm giá", "khoảng giá", "giá bao nhiêu",
  "báo giá", "bao nhiêu tiền", "ở đâu rẻ", "nên mua", "cần con", "đang tìm",
  "tìm mua", "có sẵn không", "còn hàng", "order", "đặt hàng", "chốt",
];
const ADVISORY_QUESTION_KEYWORDS = [
  "có nên", "loại nào", "con nào", "hãng nào", "so sánh", "khác gì",
  "dùng được không", "chạy được không", "hợp không", "tương thích",
  "tư vấn giúp", "hỏi", "thắc mắc", "review", "đánh giá", "có tốt",
  // Sự cố / hỏng hóc -> cần chẩn đoán (thường kèm ảnh).
  "bị lỗi", "bị hư", "bị hỏng", "lỗi gì", "hư gì", "hỏng gì", "bị sao",
  "bị làm sao", "không lên", "không vào", "không nhận", "không khởi động",
  "màn hình đen", "đèn đỏ", "tự tắt", "tự khởi động lại", "kêu bíp",
  "sửa", "khắc phục", "cách fix", "fix", "bị gì",
];

/** Lọc thô: trả "buy" | "question" | null (không có dấu hiệu). */
function advisoryPreFilter(text) {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return null;
  for (const k of ADVISORY_BUY_KEYWORDS) if (t.includes(k)) return "buy";
  for (const k of ADVISORY_QUESTION_KEYWORDS) if (t.includes(k)) return "question";
  return null;
}

/**
 * Trích ngân sách (VND) từ text nếu có. Hỗ trợ "10tr", "10 triệu", "15 củ",
 * "10.000.000", "10000000". Trả số VND hoặc null. CHỈ dùng làm gợi ý lọc giá,
 * KHÔNG dùng để bịa số trong nháp.
 */
function extractBudgetVnd(text) {
  const t = (text || "").toLowerCase();
  // "10tr", "10 triệu", "15 củ", "10tr5"
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:triệu|tr|củ)\b/);
  if (m) {
    const n = parseFloat(m[1].replace(",", "."));
    if (Number.isFinite(n) && n > 0 && n < 1000) return Math.round(n * 1e6);
  }
  // "10.000.000" hoặc "10,000,000" (có dấu phân nhóm nghìn)
  m = t.match(/(\d{1,3}(?:[.,]\d{3}){1,3})\s*(?:đ|vnd|₫)?/);
  if (m) {
    const n = Number(m[1].replace(/[.,]/g, ""));
    if (Number.isFinite(n) && n >= 100000) return n;
  }
  // "10000000" trần trụi
  m = t.match(/\b(\d{7,9})\s*(?:đ|vnd|₫)?\b/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 100000) return n;
  }
  return null;
}

/**
 * Trích các CON SỐ TIỀN trong một đoạn text. CHỈ bắt số có dạng tiền để tránh
 * nhầm với số model (RTX 4060, i5-12400, DDR5...):
 *   (a) có dấu phân nhóm nghìn: 3.599.000 / 3,599,000
 *   (b) có đuôi tiền tệ: 3500k, 12tr, 999000đ, 5 triệu
 * Trả mảng số VND đã chuẩn hóa.
 */
function extractMoneyFigures(text) {
  const out = [];
  const s = String(text || "");
  // (a) có phân nhóm nghìn
  const reGrouped = /\d{1,3}(?:[.,]\d{3}){1,4}/g;
  let m;
  while ((m = reGrouped.exec(s))) {
    const n = Number(m[0].replace(/[.,]/g, ""));
    if (Number.isFinite(n) && n >= 1000) out.push(n);
  }
  // (b) có đuôi tiền tệ
  const reUnit = /(\d+(?:[.,]\d+)?)\s*(triệu|tr|k|nghìn|ngàn|đ|vnd|₫)\b/gi;
  while ((m = reUnit.exec(s))) {
    let n = parseFloat(m[1].replace(",", "."));
    if (!Number.isFinite(n)) continue;
    const unit = m[2].toLowerCase();
    if (unit === "triệu" || unit === "tr") n *= 1e6;
    else if (unit === "k" || unit === "nghìn" || unit === "ngàn") n *= 1000;
    // đ/vnd/₫ -> giữ nguyên
    if (n >= 1000) out.push(Math.round(n));
  }
  return out;
}

/**
 * AI phân loại Ý ĐỊNH của bài viết: buy | question | ignore, kèm trích nhu cầu,
 * ngân sách, danh mục quan tâm. Trả { intent, needs, budget, categories,
 * keywords }. Lỗi/không key -> trả intent dựa trên lọc thô để vẫn chạy được.
 */
async function classifyIntent(text) {
  const clean = String(text || "").trim().slice(0, 1500);
  const pre = advisoryPreFilter(clean);
  const budgetHint = extractBudgetVnd(clean);
  const fallback = {
    intent: pre || "ignore",
    needs: "",
    budget: budgetHint,
    categories: [],
    keywords: "",
  };
  if (!clean) return { ...fallback, intent: "ignore" };

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) return fallback; // không key -> dùng lọc thô

  // Hồ sơ ngành đang kích hoạt (BE) -> dựng prompt phân loại theo đặc thù ngành.
  const profile = await getActiveProfile();
  const sys = systemForClassify(profile);
  const user = "BÀI ĐĂNG:\n" + clean + "\n\nTrả JSON phân loại theo đúng cấu trúc.";

  let resp;
  try {
    resp = await fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
          temperature: 0.1,
          max_tokens: 400,
          stream: false,
          response_format: { type: "json_object" },
        }),
      },
      20000
    );
  } catch (e) {
    return fallback;
  }
  if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
    try {
      resp = await fetchWithTimeout(
        apiBase + "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
            temperature: 0.1,
            max_tokens: 400,
            stream: false,
          }),
        },
        20000
      );
    } catch (e) {
      return fallback;
    }
  }
  if (!resp.ok) return fallback;

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return fallback;
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  const parsed = parseSelectorJson(content);
  if (!parsed) return fallback;

  const intent = ["buy", "question", "ignore"].includes(parsed.intent) ? parsed.intent : (pre || "ignore");
  let budget = Number(parsed.budget);
  if (!Number.isFinite(budget) || budget <= 0) budget = budgetHint;
  return {
    intent,
    needs: String(parsed.needs || "").slice(0, 200),
    budget: budget || null,
    categories: Array.isArray(parsed.categories) ? parsed.categories.slice(0, 8) : [],
    keywords: String(parsed.keywords || "").slice(0, 200),
  };
}

/**
 * Soạn NHÁP trả lời cho một bài, CHỈ dùng sản phẩm thật truyền vào (đã có giá).
 * Trả { reply, usedProducts, confidence, needsHumanCheck, checkNote, allowReply }.
 * - Gán mã ngắn cho từng sản phẩm (như buildConfigWithAI) để AI khỏi chép sai id.
 * - HẬU KIỂM: mọi con số tiền trong reply phải khớp giá thật / ngân sách, lệch
 *   -> needsHumanCheck=true (vẫn lưu nháp, nhưng buộc người duyệt soi kỹ).
 */
async function draftAdvisory(post, products, intentInfo) {
  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  // KHÔNG có key -> KHÔNG bịa. Thà không trả lời.
  if (!apiKey) return { allowReply: false, error: "no_api_key" };

  // Hồ sơ ngành đang kích hoạt (BE) -> dựng persona soạn trả lời theo đặc thù ngành.
  const profile = await getActiveProfile();

  const idMap = new Map(); // mã ngắn -> product thật
  let seq = 0;
  const slim = (products || []).slice(0, 18).map((p) => {
    const sid = String(++seq);
    idMap.set(sid, p);
    return {
      id: sid,
      name: p.name || "",
      price: Number(p.price) || null,
      buildPrice: Number(p.buildPrice) || null,
      store: p.sourceName || p.source || "",
      warranty: p.warranty || "",
      inStock: p.inStock !== false,
    };
  });

  const budgetTxt = intentInfo && intentInfo.budget ? (intentInfo.budget + " VND") : "(không nêu)";
  const sys = systemForDraft(profile);
  const user =
    "BÀI ĐĂNG / CÂU HỎI CỦA KHÁCH:\n" + String(post.text || "").slice(0, 200000) + "\n\n" +
    "Ý ĐỊNH: " + ((intentInfo && intentInfo.intent) || "buy") +
    " (buy = muốn mua/cần tư vấn cấu hình; question = hỏi đánh giá/kỹ thuật)\n" +
    "NHU CẦU (tóm tắt): " + ((intentInfo && intentInfo.needs) || "(tự đọc bài mà suy)") + "\n" +
    "NGÂN SÁCH KHÁCH NHẮC: " + budgetTxt + "\n" +
    "SẢN PHẨM THẬT BÊN MÌNH ĐANG CÓ (JSON, price/buildPrice là VND — chỉ dùng khi muốn chào thêm):\n" +
    JSON.stringify(slim) + "\n\n" +
    "Hãy trả lời khách như một người bán thật: bám đúng điều khách hỏi trước, nhận định trung thực, " +
    "ngắn gọn 1-3 câu, không emoji. Trả JSON đúng cấu trúc.";

  // Ảnh khách đính kèm -> gửi cho AI nhìn (vision). Lọc URL http(s), tối đa 4 ảnh.
  const imgUrls = Array.isArray(post.images)
    ? post.images.filter((u) => /^https?:\/\//i.test(String(u || ""))).slice(0, 4)
    : [];
  let userContent;
  if (imgUrls.length) {
    userContent = [{ type: "text", text: user }];
    for (const u of imgUrls) userContent.push({ type: "image_url", image_url: { url: u } });
  } else {
    userContent = user;
  }

  let resp;
  try {
    resp = await fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: userContent },
          ],
          temperature: 0.3,
          max_tokens: 700,
          stream: false,
          response_format: { type: "json_object" },
        }),
      },
      25000
    );
  } catch (e) {
    return { allowReply: false, error: "network" };
  }
  if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
    try {
      resp = await fetchWithTimeout(
        apiBase + "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: userContent },
            ],
            temperature: 0.3,
            max_tokens: 700,
            stream: false,
          }),
        },
        25000
      );
    } catch (e) {
      return { allowReply: false, error: "network" };
    }
  }
  if (!resp.ok) return { allowReply: false, error: "api_" + resp.status };

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return { allowReply: false, error: "parse" };
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  const parsed = parseSelectorJson(content);
  if (!parsed || parsed.allowReply === false || !parsed.reply) {
    return { allowReply: false, error: "no_reply" };
  }

  const reply = String(parsed.reply).trim().slice(0, 200000);
  const usedIds = Array.isArray(parsed.usedIds) ? parsed.usedIds.map((x) => String(x).trim()) : [];
  const usedProducts = [];
  for (const id of usedIds) {
    const p = idMap.get(id);
    if (p && !usedProducts.find((u) => u.productId === p.productId)) {
      usedProducts.push({
        productId: p.productId,
        name: p.name,
        price: Number(p.price) || null,
        buildPrice: Number(p.buildPrice) || null,
        source: p.sourceName || p.source || "",
        url: p.url || "",
      });
    }
  }

  // HẬU KIỂM GIÁ: mọi con số tiền trong reply phải khớp giá thật, ngân sách,
  // HOẶC con số mà CHÍNH KHÁCH đã nêu trong bài (được phép nhắc lại để tư vấn).
  const allowed = new Set();
  for (const p of usedProducts) {
    if (p.price) allowed.add(p.price);
    if (p.buildPrice) allowed.add(p.buildPrice);
  }
  if (intentInfo && intentInfo.budget) allowed.add(Number(intentInfo.budget));
  // Giá khách tự nêu trong bài đăng -> được phép tham chiếu.
  const customerFigures = new Set(extractMoneyFigures(String((post && post.text) || "")));
  for (const cf of customerFigures) allowed.add(cf);

  const figures = extractMoneyFigures(reply);
  const tol = 0; // yêu cầu khớp tuyệt đối (giá phải đúng từng đồng)
  const mismatched = [];
  for (const f of figures) {
    let ok = false;
    for (const a of allowed) {
      if (Math.abs(a - f) <= tol) { ok = true; break; }
    }
    if (!ok) mismatched.push(f);
  }
  let needsHumanCheck = false;
  const checkNotes = [];
  if (mismatched.length) {
    needsHumanCheck = true;
    checkNotes.push("Có số tiền không khớp giá thật: " + mismatched.join(", "));
  }
  // Chỉ cảnh báo "nêu giá mà không gắn sản phẩm" khi có con số KHÔNG phải giá
  // khách tự nêu (giá ta chào) nhưng lại không đính kèm sản phẩm thật.
  const nonCustomerFigures = figures.filter((f) => !customerFigures.has(f));
  if (nonCustomerFigures.length && !usedProducts.length) {
    needsHumanCheck = true;
    checkNotes.push("Nháp nêu giá nhưng không gắn sản phẩm thật nào.");
  }
  // AI nhắc id không có trong kho -> đã bị loại ở trên; nếu usedIds nhiều hơn map được
  if (usedIds.length > usedProducts.length) {
    needsHumanCheck = true;
    checkNotes.push("AI tham chiếu sản phẩm ngoài danh sách (đã loại).");
  }

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.5;

  return {
    allowReply: true,
    reply,
    usedProducts,
    confidence,
    needsHumanCheck,
    checkNote: checkNotes.join(" "),
  };
}

/**
 * Quét bài đã crawl -> lọc thô -> phân loại ý định -> tra kho sản phẩm thật ->
 * soạn nháp -> lưu (dedupe theo postId). Mặc định chỉ tạo NHÁP (status=pending).
 * opts: { groupId?, scanLimit?, maxPerGroup?, force? }
 */
async function generateAdvisories(opts = {}) {
  const cfg = await getAIConfig();
  if (!cfg.apiKey) {
    return { ok: false, error: "Chưa cấu hình API key AI. Vào tab 'Cài đặt' để nhập trước khi tạo tư vấn." };
  }

  const scanLimit = Math.max(1, Math.min(Number(opts.scanLimit) || 60, 300));
  const maxPerGroup = Math.max(1, Math.min(Number(opts.maxPerGroup) || 5, 50));
  const force = !!opts.force;

  let posts = await DB.getAllPosts(opts.groupId);
  posts = (posts || [])
    .slice()
    .sort((a, b) => (b.timestamp || b.crawledAt || 0) - (a.timestamp || a.crawledAt || 0))
    .slice(0, scanLimit);

  const allProducts = await DB.getProducts();
  const sellable = (allProducts || []).filter(
    (p) => (Number(p.price) || 0) > 0 && p.inStock !== false
  );

  const perGroupCount = new Map();
  let scanned = 0,
    created = 0,
    skippedExisting = 0,
    ignored = 0,
    noProduct = 0,
    flagged = 0;

  broadcast("ADVISORY_PROGRESS", { phase: "start", total: posts.length });

  for (const post of posts) {
    scanned += 1;
    broadcast("ADVISORY_PROGRESS", { phase: "scan", scanned, total: posts.length, created });

    if (!post || !post.postId) continue;

    // Dedupe: bài đã có nháp -> bỏ qua (trừ khi force).
    if (!force) {
      const existing = await DB.getAdvisory(post.postId);
      if (existing) {
        skippedExisting += 1;
        continue;
      }
    }

    // Lọc thô trước khi tốn token.
    const pre = advisoryPreFilter(post.text || "");
    if (!pre) {
      ignored += 1;
      continue;
    }

    // Giới hạn số nháp / nhóm.
    const gid = post.groupId || "_";
    if ((perGroupCount.get(gid) || 0) >= maxPerGroup) continue;

    const info = await classifyIntent(post.text || "");
    if (info.intent === "ignore") {
      ignored += 1;
      continue;
    }

    // Tra kho sản phẩm thật theo từ khóa + ngân sách.
    const query = (info.keywords || info.needs || "").trim();
    let matches = await DB.searchProducts({
      query,
      maxPrice: info.budget || undefined,
      limit: 18,
    });
    // Lọc còn hàng + có giá; nếu rỗng, nới ra (bỏ trần giá).
    matches = (matches || []).filter((p) => (Number(p.price) || 0) > 0 && p.inStock !== false);
    if (!matches.length && query) {
      matches = (await DB.searchProducts({ query, limit: 18 })).filter(
        (p) => (Number(p.price) || 0) > 0 && p.inStock !== false
      );
    }
    // Ý định MUA mà không có hàng thật để chào -> bỏ qua (không bịa sản phẩm).
    // Nhưng CÂU HỎI / nhờ đánh giá cấu hình - giá thì vẫn trả lời được bằng
    // kiến thức người bán, không cần đính kèm sản phẩm (truyền mảng rỗng).
    if (!matches.length && info.intent === "buy") {
      noProduct += 1;
      continue;
    }

    const draft = await draftAdvisory(post, matches, info);
    if (!draft || !draft.allowReply) continue;

    await DB.saveAdvisory({
      postId: post.postId,
      groupId: post.groupId || "",
      groupName: post.groupName || "",
      permalink: post.permalink || "",
      authorName: post.authorName || "",
      postText: String(post.text || "").slice(0, 1000),
      intent: info.intent,
      needs: info.needs,
      budget: info.budget || null,
      reply: draft.reply,
      usedProducts: draft.usedProducts || [],
      confidence: draft.confidence,
      needsHumanCheck: !!draft.needsHumanCheck,
      checkNote: draft.checkNote || "",
      status: "pending",
    });

    created += 1;
    if (draft.needsHumanCheck) flagged += 1;
    perGroupCount.set(gid, (perGroupCount.get(gid) || 0) + 1);
  }

  broadcast("ADVISORY_PROGRESS", { phase: "done", created, scanned });
  return {
    ok: true,
    scanned,
    created,
    skippedExisting,
    ignored,
    noProduct,
    flagged,
  };
}

/**
 * Phân tích MỘT bài theo yêu cầu người dùng (nút "AI phân tích" trên post card).
 * Khác generateAdvisories: KHÔNG lọc thô, KHÔNG dedupe, KHÔNG lưu DB — luôn cố
 * soạn một nháp trả lời cho đúng bài này rồi trả về để người dùng xem ngay.
 * Trả { ok, reply, intent, needs, budget, usedProducts, confidence,
 *       needsHumanCheck, checkNote }.
 */
async function analyzePost(post) {
  const cfg = await getAIConfig();
  if (!cfg.apiKey) {
    return { ok: false, error: "Chưa cấu hình API key AI. Vào tab 'Cài đặt' để nhập trước khi phân tích." };
  }
  if (!post || !String(post.text || "").trim()) {
    return { ok: false, error: "Bài không có nội dung để phân tích." };
  }

  // Phân loại ý định để tra kho cho đúng (nhưng không loại bài nào).
  const info = await classifyIntent(post.text || "");

  // Tra kho sản phẩm thật theo từ khóa + ngân sách (nếu có) để AI gợi ý đúng giá.
  let matches = [];
  const query = (info.keywords || info.needs || "").trim();
  if (query) {
    matches = await DB.searchProducts({
      query,
      maxPrice: info.budget || undefined,
      limit: 18,
    });
    matches = (matches || []).filter((p) => (Number(p.price) || 0) > 0 && p.inStock !== false);
    if (!matches.length) {
      matches = (await DB.searchProducts({ query, limit: 18 })).filter(
        (p) => (Number(p.price) || 0) > 0 && p.inStock !== false
      );
    }
  }

  const draft = await draftAdvisory(post, matches, info);
  if (!draft || !draft.allowReply) {
    return { ok: false, error: "AI chưa soạn được trả lời cho bài này (nội dung chưa rõ hoặc ngoài chuyên môn)." };
  }

  // Lưu nháp vào store advisories để nó xuất hiện trong tab Tư vấn AI và có thể
  // duyệt/sửa/gửi như mọi nháp khác. saveAdvisory dedupe theo postId (ghi đè).
  const saved = await DB.saveAdvisory({
    postId: post.postId,
    groupId: post.groupId || "",
    groupName: post.groupName || "",
    permalink: post.permalink || "",
    authorName: post.authorName || "",
    postText: String(post.text || "").slice(0, 1000),
    intent: info.intent,
    needs: info.needs,
    budget: info.budget || null,
    reply: draft.reply,
    usedProducts: draft.usedProducts || [],
    confidence: draft.confidence,
    needsHumanCheck: !!draft.needsHumanCheck,
    checkNote: draft.checkNote || "",
    status: "pending",
    source: "manual",
  });

  return {
    ok: true,
    saved: true,
    postId: post.postId,
    reply: draft.reply,
    intent: info.intent,
    needs: info.needs,
    budget: info.budget || null,
    usedProducts: draft.usedProducts || [],
    confidence: draft.confidence,
    needsHumanCheck: !!draft.needsHumanCheck,
    checkNote: draft.checkNote || "",
    advisory: saved,
  };
}

/**
 * Soạn NHÁP phản hồi cho một HỘI THOẠI (sau khi khách đã reply dưới bình luận
 * của ta). Tái dùng draftAdvisory: dựng một "post" tổng hợp ngữ cảnh (bài gốc +
 * bình luận của ta + các reply của khách) để AI trả lời ĐÚNG reply mới nhất,
 * theo đúng triết lý an toàn (chỉ NHÁP, hậu kiểm giá, không key -> không soạn).
 *
 * conv: bản ghi conversation từ DB (có postText, myComment, replies[]).
 * Trả về kết quả draftAdvisory (allowReply, reply, usedProducts, confidence...).
 */
async function draftConversationReply(conv, opts = {}) {
  const cfg = await getAIConfig();
  if (!cfg.apiKey) return { allowReply: false, error: "no_api_key" };
  if (!conv) return { allowReply: false, error: "no_conversation" };

  const replies = Array.isArray(conv.replies) ? conv.replies : [];
  if (!replies.length) return { allowReply: false, error: "no_replies" };

  // Lượt của KHÁCH (không phải của ta) là các ứng viên cần trả lời.
  const guestReplies = replies.filter((r) => !r.mine);
  const pool = guestReplies.length ? guestReplies : replies;
  // Chọn ĐÚNG người cần trả lời: nếu UI chỉ định targetReplyId (khi có NHIỀU
  // người cùng trả lời dưới bình luận của ta) thì trả lời đúng người đó; nếu
  // không -> mặc định trả lời lượt KHÁCH MỚI NHẤT.
  let target = null;
  if (opts && opts.targetReplyId != null && opts.targetReplyId !== "") {
    const tid = String(opts.targetReplyId);
    target = pool.find((r) => String(r.id) === tid) || replies.find((r) => String(r.id) === tid);
  }
  if (!target) target = pool[pool.length - 1];
  const latestText = String((target && target.text) || "");
  const targetAuthor = String((target && target.author) || "").trim();

  // Phân loại ý định dựa trên TOÀN bộ ngữ cảnh (bài gốc + reply mới) để tra kho.
  const intentText = [conv.postText || "", latestText].join("\n");
  const info = await classifyIntent(intentText);

  // Tra kho sản phẩm thật (giống generateAdvisories). Câu hỏi/hỗ trợ vẫn trả lời
  // được dù không có sản phẩm -> truyền mảng rỗng.
  const query = (info.keywords || info.needs || "").trim();
  let matches = await DB.searchProducts({
    query,
    maxPrice: info.budget || undefined,
    limit: 18,
  });
  matches = (matches || []).filter((p) => (Number(p.price) || 0) > 0 && p.inStock !== false);
  if (!matches.length && query) {
    matches = (await DB.searchProducts({ query, limit: 18 })).filter(
      (p) => (Number(p.price) || 0) > 0 && p.inStock !== false
    );
  }

  // Dựng "post" tổng hợp: AI sẽ đọc cả mạch hội thoại và trả lời reply mới nhất.
  // Giữ nguyên cơ chế hậu kiểm giá của draftAdvisory (dùng post.text).
  // CTX: nới rộng ngữ cảnh tối đa (~200k ký tự) để AI đọc TRỌN cuộc trò chuyện
  // (bài gốc + bình luận của ta + TẤT CẢ phản hồi qua lại) thay vì bị cắt cụt.
  const CTX = 200000;
  const thread =
    "BÀI ĐĂNG GỐC CỦA KHÁCH:\n" + String(conv.postText || "(không lưu)").slice(0, CTX) + "\n\n" +
    "BÌNH LUẬN TRƯỚC ĐÓ CỦA BẠN (người bán):\n" + String(conv.myComment || "").slice(0, CTX) + "\n\n" +
    "TOÀN BỘ PHẢN HỒI DƯỚI BÌNH LUẬN (theo thứ tự, mới nhất ở cuối):\n" +
    replies
      .map((r, i) => (i + 1) + ". " + (r.mine ? "[BẠN] " : "") + (r.author ? r.author + ": " : "") + String(r.text || "").slice(0, CTX))
      .join("\n") +
    "\n\nNGƯỜI CẦN TRẢ LỜI NGAY: " + (targetAuthor || "(khách)") +
    " — họ vừa nói: \"" + latestText.slice(0, CTX) + "\"\n" +
    "Hãy trả lời TRỰC TIẾP đúng người này, tiếp nối tự nhiên cuộc trò chuyện như " +
    "người bán thật đang nhắn tiếp. MỞ ĐẦU phản hồi bằng cách gọi/tag đúng tên họ " +
    "(\"@" + (targetAuthor || "bạn") + "\") rồi mới vào nội dung. Bám đúng điều người này vừa nói.";

  const pseudoPost = {
    text: thread,
    images: [],
    postId: conv.postId || "",
  };

  const result = await draftAdvisory(pseudoPost, matches, info);
  // Tag đúng người như human: nếu AI chưa gọi tên người cần trả lời ở ĐẦU phản
  // hồi thì tự thêm "@Tên " để phản hồi hướng đúng người (giống người bán thật
  // bấm trả lời đúng comment của họ). Kèm target để UI hiển thị/đăng đúng.
  if (result && result.allowReply && targetAuthor) {
    const r = String(result.reply || "");
    const head = r.slice(0, targetAuthor.length + 4).toLowerCase();
    if (!head.includes(targetAuthor.toLowerCase())) {
      result.reply = "@" + targetAuthor + " " + r;
    }
    result.targetAuthor = targetAuthor;
    result.targetReplyId = target && target.id ? String(target.id) : null;
  }
  return result;
}

/**
 * Duyệt một nháp -> tạo comment job (đăng bình luận vào permalink) -> đánh dấu
 * advisory status="sent". An toàn: chỉ chạy khi người dùng bấm duyệt.
 */
async function approveAdvisory(postId) {
  const adv = await DB.getAdvisory(postId);
  if (!adv) return { ok: false, error: "Không tìm thấy nháp tư vấn." };
  if (!adv.permalink) return { ok: false, error: "Nháp thiếu permalink, không thể tạo bình luận." };
  if (!adv.reply || !adv.reply.trim()) return { ok: false, error: "Nháp rỗng." };

  const job = await DB.createJob({
    type: "comment",
    targetUrl: adv.permalink,
    content: adv.reply,
    scheduledAt: Date.now(),
    meta: { postId, source: "advisory" },
  });
  await DB.updateAdvisory(postId, { status: "sent", jobId: job.id, sentAt: Date.now() });
  return { ok: true, jobId: job.id };
}

export {
  ADVISORY_BUY_KEYWORDS,
  ADVISORY_QUESTION_KEYWORDS,
  advisoryPreFilter,
  extractBudgetVnd,
  extractMoneyFigures,
  classifyIntent,
  draftAdvisory,
  draftConversationReply,
  generateAdvisories,
  analyzePost,
  approveAdvisory,
};
