/**
 * group-prices.js — TRÍCH GIÁ từ bài đã crawl trong group bằng PHỄU 3 TẦNG.
 *
 * Mục tiêu: từ kho `posts` (đã crawl, lấy qua DB.getAllPosts) lọc ra các bài RAO
 * BÁN có giá thật rồi trích thành các dòng giá (group_prices) để tham khảo mặt
 * bằng giá. KHÔNG bịa số: AI chỉ TRÍCH từ text bài, mọi giá phải HẬU KIỂM khớp
 * với text gốc trước khi lưu.
 *
 * PHỄU 3 TẦNG (tiết kiệm token + chống nhiễu + chống bịa):
 *   Tầng 1 — tier1Pass(text, sellKeywords): lọc thô. Chỉ giữ bài có ĐỒNG THỜI
 *     (a) một con số TIỀN (reuse extractMoneyFigures của advisory.js) và
 *     (b) một từ khóa DẤU HIỆU BÁN. Bài "cần mua ... giá bao nhiêu" tuy có số
 *     model nhưng KHÔNG có money figure / sell signal -> loại.
 *   Tầng 2 — selectForAI(posts, sellKeywords): chỉ bài CHƯA parse (không có
 *     parsedAt) VÀ qua tier1 mới được đưa lên AI. Parse xong đánh dấu parsedAt
 *     để lần sau không gửi lại (khử trùng + tăng dần).
 *   Tầng 2.5 — localExtract(post): BỘ TRÍCH CỤC BỘ (0 token, 0 network). Đọc
 *     text theo TỪNG DÒNG: quét con số tiền kèm VỊ TRÍ (scanMoney), lấy phần
 *     text TRƯỚC con số làm tên (gọt tiền tố rao bán "bán/pass/thanh lý/giá"),
 *     suy ra tình trạng (detectCondition) + bảo hành (detectWarranty). Nếu bộ
 *     cục bộ đọc TRỌN VẸN một bài (mọi con số tiền đều được gán vào item, không
 *     có mẫu nhập nhằng kiểu "2tr8" hay "5-6tr") thì bài đó KHÔNG cần lên AI.
 *     Nhập nhằng/không đọc được -> nhường cho tầng 3 chứ KHÔNG đoán bừa.
 *   Tầng 3 — extractBatch(posts, aiCall): gọi AI MỘT lần cho mỗi ~10-15 bài;
 *     AI trả per-post { items:[{name,price,condition,warranty,category}],
 *     new_keywords:[...] }. AI KHÔNG tự chế regex, chỉ trích từ text được cấp.
 *   Hậu kiểm — verifyExtraction(post, items): bỏ item nào có price KHÔNG xuất
 *     hiện trong text bài (so khớp sau khi chuẩn hóa) — chống bịa giá. Áp dụng
 *     cho CẢ item cục bộ lẫn item AI (một cửa duy nhất để vào DB).
 *
 * Orchestration — runGroupPriceExtraction(deps): nạp sell keywords từ
 *   GET /api/keywords?type=sell, lấy posts, selectForAI, extractBatch, verify,
 *   POST /api/group-prices, đánh dấu posts parsedAt, và POST /api/keywords cho
 *   mọi new_keywords (addedBy:'ai', enabled:true).
 *
 * KIỂM THỬ ĐƯỢC: các hàm thuần (tier1Pass/selectForAI/verifyExtraction) và
 * extractBatch (nhận aiCall tiêm vào) chạy không cần network. runGroupPriceExtraction
 * nhận deps (apiFetch, getAllPosts, aiCall, markParsed) để test mock toàn bộ.
 *
 * Module ES (import/export), khớp phong cách advisory.js / db.js.
 */

import { extractMoneyFigures } from "./advisory.js";
import { hasAnyKeyword, deaccent } from "./keyword-match.js";
import { apiFetch as realApiFetch } from "./api.js";
import * as DB from "./db.js";
import { getAIConfig, fetchWithTimeout, parseSelectorJson } from "./util.js";
import { getActiveProfile, systemForExtract } from "./prompts.js";

// Số bài tối đa gửi AI trong MỘT lần gọi (phễu tầng 3). ~10-15 theo plan.
const BATCH_SIZE = 15;

/* =============================== TẦNG 1 ================================== */

// TÍN HIỆU MUA/HỎI GIÁ — nếu bài chứa bất kỳ cụm nào thì đó là NGƯỜI MUA đang
// hỏi, KHÔNG phải rao bán. Loại thẳng để giá của người mua ("cần mua ... tầm
// 5tr") không lọt vào mặt bằng giá thị trường. Khớp theo ranh giới từ + bỏ dấu.
const BUY_GUARD = [
  "cần mua", "muốn mua", "tìm mua", "cần con", "ai bán", "ai pass",
  "giá bao nhiêu", "bao nhiêu tiền", "tầm giá", "tầm tiền", "ngân sách",
  "ai dư", "có ai bán", "chỗ nào bán", "mua ở đâu",
];

/**
 * tier1Pass(text, sellKeywords) — lọc thô tầng 1.
 * TRUE chỉ khi text có ĐỒNG THỜI: (a) một con số tiền (extractMoneyFigures) và
 * (b) ít nhất một từ khóa dấu hiệu BÁN — SO KHỚP THEO RANH GIỚI TỪ + BỎ DẤU
 * (dùng chung keyword-match.js) nên "banh" không dính "ban", "thanh ly" không
 * dấu vẫn khớp "thanh lý".
 * FALSE cho bài hỏi/mua: (a) không có money figure, HOẶC (b) dính BUY_GUARD
 * ("cần mua ... tầm 5tr, ai pass") dù có số tiền + từ "pass".
 */
export function tier1Pass(text, sellKeywords) {
  const s = String(text || "");
  if (!s.trim()) return false;
  const keywords = Array.isArray(sellKeywords) ? sellKeywords : [];
  if (keywords.length === 0) return false;
  const hasMoney = extractMoneyFigures(s).length > 0;
  if (!hasMoney) return false;
  // Người mua đang hỏi giá -> loại (chống ô nhiễm mặt bằng giá).
  if (hasAnyKeyword(s, BUY_GUARD)) return false;
  return hasAnyKeyword(s, keywords);
}

/* =============================== TẦNG 2 ================================== */

/**
 * selectForAI(posts, sellKeywords) — lọc tầng 2 (khử trùng + tăng dần).
 * Chỉ giữ bài CHƯA parse (không có parsedAt) VÀ qua tier1Pass. Bài đã có
 * parsedAt (đã trích trước đó) bị loại để không gửi lại AI.
 */
export function selectForAI(posts, sellKeywords) {
  if (!Array.isArray(posts)) return [];
  return posts.filter((p) => {
    if (!p) return false;
    // Đã parse rồi -> bỏ. Coi null/undefined/"" là CHƯA parse.
    if (p.parsedAt) return false;
    return tier1Pass(p.text, sellKeywords);
  });
}

/* ============================== HẬU KIỂM ================================= */

/**
 * Chuẩn hóa một chuỗi/biểu diễn giá về DẠNG SO KHỚP: trả về tập các "khóa số"
 * có thể có để dò trong text. Dùng extractMoneyFigures để quy mọi biểu diễn
 * ("5.000.000", "5,000,000", "5tr", 5000000) về cùng GIÁ TRỊ VND, nhờ đó
 * "5tr" trong bài khớp với "5.000.000" mà AI trả về.
 *
 * Trả về một Set<number> các giá trị VND đã chuẩn hóa từ chuỗi đầu vào.
 */
function priceToVndSet(price) {
  const out = new Set();
  if (price == null) return out;
  if (typeof price === "number" && Number.isFinite(price)) {
    out.add(Math.round(price));
    return out;
  }
  const s = String(price);
  // Thử trích như tiền (bắt cả "5tr", "5.000.000", "5,000,000").
  for (const n of extractMoneyFigures(s)) out.add(n);
  // Dự phòng: chuỗi toàn số dạng "5000000" không có dấu phân nhóm -> tự parse.
  const digits = s.replace(/[^\d]/g, "");
  if (digits) {
    const n = Number(digits);
    if (Number.isFinite(n) && n >= 1000) out.add(n);
  }
  return out;
}

/**
 * verifyExtraction(post, items) — HẬU KIỂM chống bịa giá.
 * Bỏ mọi item có price KHÔNG khớp bất kỳ con số tiền nào trong text bài (sau
 * khi chuẩn hóa cả hai về VND). Giữ những item có giá thật trong bài.
 */
export function verifyExtraction(post, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const text = String((post && post.text) || "");
  // Tập giá trị VND xuất hiện trong text bài (chuẩn để so khớp).
  const postVnd = new Set(extractMoneyFigures(text));
  if (postVnd.size === 0) return [];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const candidates = priceToVndSet(it.price);
    let matched = null;
    for (const v of candidates) {
      if (postVnd.has(v)) {
        matched = v;
        break;
      }
    }
    if (matched != null) {
      // QUAN TRỌNG: trả GIÁ TRỊ VND đã chuẩn hóa (số nguyên) thay vì chuỗi thô
      // AI trả về. Cột group_prices.price là BIGINT; nếu ghi "5.000.000" MySQL
      // sẽ cắt còn 5, phá vỡ ORDER BY/lọc giá và khóa idempotent uq_gp_line.
      out.push({ ...it, price: matched });
    }
  }
  return out;
}

/* ========================= TẦNG 2.5 — CỤC BỘ ============================= */

// Ngưỡng giá hợp lý cho một dòng hàng (VND). Dưới ngưỡng thường là phí ship/
// cọc/giá phụ kiện lẻ nhắc ngang; trên ngưỡng là số điện thoại/năm/nhầm đơn vị.
const LOCAL_MIN_PRICE = 10000;
const LOCAL_MAX_PRICE = 2000000000;

// Tiền tố "rao bán" cần GỌT khỏi tên hàng (đã bỏ dấu, chỉ còn chữ/số).
const LEAD_NOISE = new Set([
  "ban", "can", "pass", "xa", "kho", "gl", "giao", "luu", "thanh", "ly",
  "gia", "con", "hang", "new", "sale", "up", "hot", "fs", "freeship", "cod",
  "sang", "nhuong", "ship", "co", "ai", "em", "minh", "shop", "nay", "them",
]);

// Hậu tố cần GỌT (phần đứng ngay trước con số tiền): "... giá", "... bao test".
const TAIL_NOISE = new Set([
  "gia", "chi", "con", "only", "fix", "nhe", "cuoi", "chot", "thoi", "la",
  "luon", "nhanh", "bao", "test", "cho", "ai", "can", "gion", "net", "ban",
]);

// Mẫu NHẬP NHẰNG: bộ regex tiền dùng chung (extractMoneyFigures) đọc "2tr8"
// thành 2.000.000 — SAI (đúng là 2.800.000). Thà nhường AI còn hơn ghi sai số.
const RE_MIXED_UNIT = /\d\s*(?:tr|trieu|cu)\s*\d/;
// Khoảng giá "5-6tr", "3~4 triệu": không có MỘT giá xác định -> nhường AI.
const RE_PRICE_RANGE = /\d\s*[-–~]\s*\d+\s*(?:tr|trieu|k|d|vnd)\b/;

/**
 * scanMoney(text) — quét các CON SỐ TIỀN kèm VỊ TRÍ trong text.
 *
 * Dùng ĐÚNG hai regex của extractMoneyFigures (advisory.js) nên mọi giá trị
 * scanMoney trả về là TẬP CON của extractMoneyFigures -> item do bộ trích cục
 * bộ dựng LUÔN đi qua được hậu kiểm verifyExtraction (một cửa vào DB).
 *
 * Trả [{ start, end, raw, value }] đã sắp theo vị trí và KHÔNG chồng lấn
 * (giữ khớp dài hơn khi hai regex cùng bắt một đoạn).
 */
export function scanMoney(text) {
  const s = String(text || "");
  const hits = [];
  let m;

  // (a) có dấu phân nhóm nghìn: 3.599.000 / 3,599,000
  const reGrouped = /\d{1,3}(?:[.,]\d{3}){1,4}/g;
  while ((m = reGrouped.exec(s))) {
    const n = Number(m[0].replace(/[.,]/g, ""));
    if (Number.isFinite(n) && n >= 1000) {
      hits.push({ start: m.index, end: m.index + m[0].length, raw: m[0], value: n });
    }
  }
  // (b) có đuôi tiền tệ: 3500k, 12tr, 999000đ, 5 triệu
  const reUnit = /(\d+(?:[.,]\d+)?)\s*(triệu|tr|k|nghìn|ngàn|đ|vnd|₫)\b/gi;
  while ((m = reUnit.exec(s))) {
    let n = parseFloat(m[1].replace(",", "."));
    if (!Number.isFinite(n)) continue;
    const unit = m[2].toLowerCase();
    if (unit === "triệu" || unit === "tr") n *= 1e6;
    else if (unit === "k" || unit === "nghìn" || unit === "ngàn") n *= 1000;
    if (n >= 1000) {
      hits.push({
        start: m.index,
        end: m.index + m[0].length,
        raw: m[0],
        value: Math.round(n),
      });
    }
  }

  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  for (const h of hits) {
    if (out.some((k) => h.start < k.end && k.start < h.end)) continue; // chồng lấn
    out.push(h);
  }
  return out;
}

/** Chuẩn hóa một token về dạng so khớp noise: bỏ dấu + chỉ giữ chữ/số. */
function normToken(t) {
  return deaccent(String(t || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * cleanItemName(raw) — gọt một đoạn text thành TÊN HÀNG dùng được, hoặc "" nếu
 * không đủ tin cậy. Gọt token nhiễu ở HAI ĐẦU (giữ nguyên dấu/chữ hoa của phần
 * còn lại), bỏ dấu câu rìa, và từ chối đoạn quá dài (giống một câu văn) hoặc
 * không còn chữ cái nào.
 */
export function cleanItemName(raw) {
  const tokens = String(raw || "").split(/\s+/).filter(Boolean);
  let a = 0;
  let b = tokens.length;
  while (a < b) {
    const t = normToken(tokens[a]);
    if (!t || LEAD_NOISE.has(t)) {
      a += 1;
      continue;
    }
    break;
  }
  while (b > a) {
    const t = normToken(tokens[b - 1]);
    if (!t || TAIL_NOISE.has(t)) {
      b -= 1;
      continue;
    }
    break;
  }
  const kept = tokens.slice(a, b);
  if (kept.length === 0 || kept.length > 12) return "";
  const name = kept
    .join(" ")
    .replace(/^[\s\-–—:.,;|/*+~=>#]+/, "")
    .replace(/[\s\-–—:.,;|/*+~=<]+$/, "")
    .trim();
  if (name.length < 2 || name.length > 90) return "";
  if (!/\p{L}/u.test(name)) return ""; // toàn số -> không phải tên hàng
  return name;
}

/**
 * detectCondition(text) — suy ra tình trạng máy: "mới" | "likenew" | "cũ" | null.
 * CHỈ nhận các dấu hiệu ĐẶC HIỆU; mơ hồ thì trả null (thà thiếu còn hơn sai).
 * Không dùng token trần "mới"/"cũ" vì sau khi bỏ dấu chúng đụng "mời", "củ"
 * (đơn vị tiền: "5 củ"), "mọi".
 */
export function detectCondition(text) {
  const s = deaccent(String(text || "")).toLowerCase();
  if (/\b9[5-9]\s*%/.test(s) || /\blike\s*new\b/.test(s) || /\blikenew\b/.test(s)) {
    return "likenew";
  }
  if (
    /\bmoi\s*100\s*%?/.test(s) ||
    /\bfull\s*box\b/.test(s) ||
    /\bfullbox\b/.test(s) ||
    /\bnguyen\s*(seal|box|hop|tem)\b/.test(s) ||
    /\bchua\s*(boc|khui|khai|su\s*dung)\b/.test(s) ||
    /\bbrand\s*new\b/.test(s) ||
    /\bmoi\s*keng\b/.test(s) ||
    /\bhang\s*moi\b/.test(s)
  ) {
    return "mới";
  }
  if (
    /\b(hang|may|do|em|con)\s*cu\b/.test(s) ||
    /\b(da\s*)?qua\s*su\s*dung\b/.test(s) ||
    /\bsecond\s*hand\b/.test(s) ||
    /\bsecondhand\b/.test(s) ||
    /\b2nd\b/.test(s) ||
    /\b9[0-4]\s*%/.test(s)
  ) {
    return "cũ";
  }
  return null;
}

/**
 * detectWarranty(text) — suy ra bảo hành: "6 tháng" | "1 năm" | "hết bảo hành"
 * | "bảo hành hãng" | null.
 */
export function detectWarranty(text) {
  const s = deaccent(String(text || "")).toLowerCase();
  if (/\b(het|khong|ko|k)\s*(bh|bao\s*hanh)\b/.test(s)) return "hết bảo hành";
  let m = s.match(/\b(?:bh|bao\s*hanh)[^\d\n]{0,10}?(\d{1,2})\s*(thang|nam|t\b|n\b)/);
  if (!m) m = s.match(/\b(\d{1,2})\s*(thang|nam)\s*(?:bh|bao\s*hanh)\b/);
  if (m) {
    const n = Number(m[1]);
    const unit = String(m[2]).startsWith("n") ? "năm" : "tháng";
    if (Number.isFinite(n) && n > 0 && n <= 60) return n + " " + unit;
  }
  if (/\b(?:bh|bao\s*hanh)\s*(hang|chinh\s*hang|shop|dai\s*ly|cua\s*hang)\b/.test(s)) {
    return "bảo hành hãng";
  }
  return null;
}

/**
 * localExtract(post) — TRÍCH GIÁ KHÔNG CẦN AI.
 *
 * Đọc từng dòng; một dòng chỉ sinh item khi có ĐÚNG MỘT con số tiền và phần
 * text quanh nó gọt được thành tên hàng. Trả:
 *   { items, complete }
 *     items    — [{ name, price(VND int), condition, warranty, category:null, confidence }]
 *     complete — TRUE khi MỌI con số tiền trong bài đều đã được gán vào item và
 *                không gặp mẫu nhập nhằng. `complete === true` là điều kiện để
 *                BỎ HẲN lượt gọi AI cho bài này.
 */
export function localExtract(post) {
  const text = String((post && post.text) || "");
  const items = [];
  let unconsumed = 0;
  let ambiguous = false;

  const condition = detectCondition(text);
  const warranty = detectWarranty(text);

  for (const line of text.split(/[\r\n]+/)) {
    const hits = scanMoney(line).filter(
      (h) => h.value >= LOCAL_MIN_PRICE && h.value <= LOCAL_MAX_PRICE
    );
    if (hits.length === 0) continue;

    const flat = deaccent(line).toLowerCase();
    if (RE_MIXED_UNIT.test(flat) || RE_PRICE_RANGE.test(flat)) {
      ambiguous = true;
      unconsumed += hits.length;
      continue;
    }
    // Nhiều giá trên cùng dòng ("giá 5tr, ship 30k" / "i5 2tr i7 3tr"): không
    // chắc số nào thuộc món nào -> nhường AI.
    if (hits.length > 1) {
      unconsumed += hits.length;
      continue;
    }

    const hit = hits[0];
    const before = line.slice(0, hit.start);
    const after = line.slice(hit.end);
    let name = cleanItemName(before);
    let fromBefore = true;
    if (!name) {
      name = cleanItemName(after); // dòng mở đầu bằng giá: "5.000.000 laptop Dell"
      fromBefore = false;
    }
    if (!name) {
      unconsumed += 1;
      continue;
    }

    // Có tín hiệu "giá" ngay trước con số -> độ tin cậy cao hơn.
    const beforeFlat = deaccent(before).toLowerCase();
    const cued =
      /(?:gia|price|only|chi|con)\s*[:=\-~]?\s*$/.test(beforeFlat) ||
      /[:=\-–~]\s*$/.test(before);

    items.push({
      name,
      price: hit.value,
      condition,
      warranty,
      category: null,
      confidence: fromBefore ? (cued ? 0.85 : 0.7) : 0.6,
    });
  }

  return { items, complete: items.length > 0 && unconsumed === 0 && !ambiguous };
}

/* =============================== TẦNG 3 ================================== */

/**
 * Chia mảng thành các lô tối đa `size` phần tử.
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * extractBatch(posts, aiCall) — tầng 3.
 * Gọi `aiCall(batch)` MỘT lần cho mỗi lô ~10-15 bài. `aiCall` nhận mảng bài và
 * trả về mảng per-post { postId, items, new_keywords }. Gộp kết quả mọi lô lại
 * và trả về một mảng phẳng (một entry/bài). `aiCall` được TIÊM VÀO để test mock.
 */
export async function extractBatch(posts, aiCall) {
  if (!Array.isArray(posts) || posts.length === 0) return [];
  if (typeof aiCall !== "function") {
    throw new Error("extractBatch: aiCall phải là một hàm.");
  }
  const results = [];
  for (const batch of chunk(posts, BATCH_SIZE)) {
    const out = await aiCall(batch);
    if (Array.isArray(out)) {
      for (const entry of out) results.push(entry);
    }
  }
  return results;
}

/* ====================== AI CALLER MẶC ĐỊNH (THẬT) ======================== */

/**
 * defaultAiCall(batch, sellKeywords) — AI caller THẬT (OpenAI-compatible), theo
 * đúng pattern classifyIntent của advisory.js (getAIConfig + fetchWithTimeout).
 * Trả mảng per-post { postId, items, new_keywords }. Lỗi/không key -> trả mảng
 * rỗng cho từng bài (an toàn: thà không trích còn hơn trích sai).
 */
async function defaultAiCall(batch, sellKeywords) {
  const empty = batch.map((p) => ({ postId: p.postId, items: [], new_keywords: [] }));

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) return empty; // không key -> không trích

  // Hồ sơ ngành đang kích hoạt (BE) -> dựng prompt trích giá theo đặc thù ngành.
  const profile = await getActiveProfile();
  const sys = systemForExtract(profile);

  const knownKeywords = Array.isArray(sellKeywords) ? sellKeywords.join(", ") : "";
  const postsBlock = batch
    .map(
      (p, i) =>
        "### BÀI " + (i + 1) + " (postId=" + p.postId + "):\n" +
        String(p.text || "").slice(0, 1200)
    )
    .join("\n\n");
  const user =
    "DANH SÁCH TỪ KHÓA BÁN ĐÃ BIẾT: " + (knownKeywords || "(trống)") + "\n\n" +
    "CÁC BÀI CẦN TRÍCH (" + batch.length + " bài):\n\n" + postsBlock +
    "\n\nTrả JSON theo đúng cấu trúc, mỗi bài MỘT entry trong results với postId tương ứng.";

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
          max_tokens: 1500,
          stream: false,
          response_format: { type: "json_object" },
        }),
      },
      30000
    );
  } catch (e) {
    return empty;
  }
  if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
    // Một số endpoint không hỗ trợ response_format -> thử lại không có nó.
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
            max_tokens: 1500,
            stream: false,
          }),
        },
        30000
      );
    } catch (e) {
      return empty;
    }
  }
  if (!resp.ok) return empty;

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return empty;
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  const parsed = parseSelectorJson(content);
  const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
  if (!results) return empty;

  // Chuẩn hóa: đảm bảo mỗi bài có entry; map theo postId AI trả về.
  const byId = new Map();
  for (const r of results) {
    if (r && r.postId != null) byId.set(String(r.postId), r);
  }
  return batch.map((p) => {
    const r = byId.get(String(p.postId));
    return {
      postId: p.postId,
      items: r && Array.isArray(r.items) ? r.items : [],
      new_keywords: r && Array.isArray(r.new_keywords) ? r.new_keywords : [],
    };
  });
}

/* ============================ ORCHESTRATION ============================= */

/**
 * runGroupPriceExtraction(deps) — chạy toàn bộ phễu 3 tầng.
 *
 * deps (tất cả tùy chọn, mặc định dùng module thật — test tiêm mock):
 *   - apiFetch:    hàm gọi API (mặc định api.js#apiFetch).
 *   - getAllPosts: () => Promise<post[]> (mặc định DB.getAllPosts).
 *   - aiCall:      (batch, sellKeywords) => Promise<entry[]> (mặc định defaultAiCall).
 *   - markParsed:  (postIds[]) => Promise<void> đánh dấu parsedAt (xem ghi chú).
 *
 * Luồng:
 *   1) GET /api/keywords?type=sell -> chỉ lấy keyword enabled.
 *   2) getAllPosts() -> selectForAI -> các bài đủ điều kiện.
 *   2.5) localExtract từng bài: bài nào đọc TRỌN VẸN (complete) thì chốt luôn
 *        bằng parser 'local' và KHÔNG gửi lên AI (0 token). Phần còn lại (bài
 *        nhập nhằng / không đọc được) mới xuống tầng 3.
 *   3) extractBatch(rest, aiCall) -> kết quả AI per-post.
 *   4) verifyExtraction từng bài (cả local lẫn AI) -> bỏ item bịa giá.
 *   5) POST /api/group-prices các dòng đã hậu kiểm (parser:'local'|'ai').
 *   6) markParsed(các postId đã xử lý) -> đánh dấu parsedAt.
 *   7) POST /api/keywords cho mọi new_keywords (addedBy:'ai', enabled:true, type:'sell').
 *
 * Trả { processed, inserted, newKeywords, localPosts, aiPosts } để UI báo cáo
 * (localPosts = số bài xử lý miễn phí, aiPosts = số bài thực sự tốn token).
 */
export async function runGroupPriceExtraction(deps = {}) {
  const apiFetch = deps.apiFetch || realApiFetch;
  const getAllPosts = deps.getAllPosts || DB.getAllPosts;
  const aiCall = deps.aiCall || defaultAiCall;
  const markParsed = deps.markParsed || defaultMarkParsed(apiFetch);
  // Cho phép tắt tầng cục bộ (test so sánh / debug), mặc định BẬT.
  const useLocal = deps.useLocal !== false;

  // 1) Nạp sell keywords đang bật.
  const kwResp = await apiFetch("/api/keywords?type=sell");
  const sellKeywords = (kwResp && Array.isArray(kwResp.keywords) ? kwResp.keywords : [])
    .filter((k) => k && k.enabled)
    .map((k) => String(k.keyword || "").toLowerCase())
    .filter(Boolean);

  // 2) Lấy posts -> lọc phễu tầng 1+2.
  const posts = (await getAllPosts()) || [];
  const eligible = selectForAI(posts, sellKeywords);
  if (eligible.length === 0) {
    return { processed: 0, inserted: 0, newKeywords: 0, localPosts: 0, aiPosts: 0 };
  }

  // Tra cứu bài theo postId để hậu kiểm + dựng dòng giá.
  const postById = new Map(eligible.map((p) => [String(p.postId), p]));

  const rows = [];
  const processedIds = [];
  const newKeywordSet = new Set();

  // Dựng 1 dòng group_prices từ item đã hậu kiểm.
  const toRow = (post, it, parser) => ({
    postId: post.postId,
    name: it.name ?? null,
    price: it.price ?? null,
    condition: it.condition ?? null,
    warranty: it.warranty ?? null,
    category: it.category ?? null,
    sellerName: post.authorName ?? null,
    sellerProfile: post.authorProfile ?? null,
    groupId: post.groupId ?? null,
    postedAt: post.timestamp ?? null,
    parser,
    confidence: it.confidence ?? null,
  });

  // 2.5) TẦNG CỤC BỘ — chốt các bài đọc trọn vẹn, phần còn lại đẩy sang AI.
  const rest = [];
  let localPosts = 0;
  for (const post of eligible) {
    if (!useLocal) {
      rest.push(post);
      continue;
    }
    let local = null;
    try {
      local = localExtract(post);
    } catch (e) {
      local = null;
    }
    // Chỉ tự quyết khi đọc TRỌN VẸN; nhập nhằng -> nhường AI.
    if (!local || !local.complete) {
      rest.push(post);
      continue;
    }
    // Vẫn đi qua đúng một cửa hậu kiểm như AI (không có đường tắt vào DB).
    const verified = verifyExtraction(post, local.items);
    if (verified.length === 0) {
      rest.push(post);
      continue;
    }
    localPosts += 1;
    processedIds.push(post.postId);
    for (const it of verified) rows.push(toRow(post, it, "local"));
  }

  // 3) Gọi AI cho phần còn lại (có thể rỗng -> 0 request).
  const aiResults =
    rest.length > 0 ? await extractBatch(rest, (batch) => aiCall(batch, sellKeywords)) : [];

  // 4) Hậu kiểm + dựng payload group-prices cho nhánh AI.
  let aiPosts = 0;
  for (const r of aiResults) {
    if (!r || r.postId == null) continue;
    const post = postById.get(String(r.postId));
    if (!post) continue;
    aiPosts += 1;
    processedIds.push(post.postId);

    const verified = verifyExtraction(post, r.items);
    for (const it of verified) rows.push(toRow(post, it, "ai"));

    if (Array.isArray(r.new_keywords)) {
      for (const kw of r.new_keywords) {
        const w = String(kw || "").trim();
        if (w) newKeywordSet.add(w);
      }
    }
  }

  // 5) Lưu các dòng giá đã hậu kiểm.
  let inserted = 0;
  if (rows.length > 0) {
    const resp = await apiFetch("/api/group-prices", {
      method: "POST",
      body: JSON.stringify({ groupPrices: rows }),
    });
    inserted = resp && typeof resp.inserted === "number" ? resp.inserted : rows.length;
  }

  // 6) Đánh dấu các bài đã xử lý là parsedAt (kể cả bài AI trả 0 item -> không
  // gửi lại lần sau). markParsed có thể là thin call (xem defaultMarkParsed).
  if (processedIds.length > 0 && typeof markParsed === "function") {
    await markParsed(processedIds);
  }

  // 7) Học từ khóa bán mới do AI phát hiện. Chạy song song có giới hạn: số
  //    keyword mới mỗi mẻ thường nhỏ nhưng gửi tuần tự vẫn cộng dồn độ trễ vô
  //    ích ở cuối luồng, sau khi mọi việc thật đã xong.
  const newKeywords = [...newKeywordSet];
  if (newKeywords.length > 0) {
    const CONCURRENCY = 6;
    let next = 0;
    const worker = async () => {
      while (next < newKeywords.length) {
        const kw = newKeywords[next++];
        await apiFetch("/api/keywords", {
          method: "POST",
          body: JSON.stringify({ keyword: kw, type: "sell", addedBy: "ai", enabled: true }),
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, newKeywords.length) }, () => worker())
    );
  }

  return {
    processed: processedIds.length,
    inserted,
    newKeywords: newKeywordSet.size,
    localPosts,
    aiPosts,
  };
}

/**
 * defaultMarkParsed(apiFetch) — đánh dấu parsedAt cho CẢ MẺ bài bằng
 * POST /api/posts/bulk-update (một request cho mỗi lô 500 bài).
 *
 * Trước đây gọi PATCH /api/posts/:id lần lượt cho từng bài; một mẻ trích giá
 * vài trăm bài nghĩa là vài trăm vòng HTTP nối tiếp, chạy sau khi công việc
 * thật đã xong. Nuốt lỗi như cũ để không chặn luồng trích giá chính — bài chưa
 * đánh dấu được sẽ được xử lại ở lần sau (insert giá vốn idempotent).
 */
function defaultMarkParsed(apiFetch) {
  const CHUNK = 500;
  return async (postIds) => {
    const ids = (postIds || []).filter(Boolean);
    const parsedAt = new Date().toISOString();
    for (let i = 0; i < ids.length; i += CHUNK) {
      const updates = ids.slice(i, i + CHUNK).map((postId) => ({ postId, parsedAt }));
      try {
        await apiFetch("/api/posts/bulk-update", {
          method: "POST",
          body: JSON.stringify({ updates }),
          idempotent: true,
        });
      } catch (e) {
        // Best-effort: bài vẫn có thể được tái xử lý lần sau.
      }
    }
  };
}
