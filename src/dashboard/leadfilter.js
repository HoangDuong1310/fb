/**
 * leadfilter.js — LỌC THÔNG MINH bài viết ngay trên máy (không gọi AI, không
 * tốn token). Mục tiêu: tìm KHÁCH CÓ NHU CẦU (cần mua) hoặc NGƯỜI CẦN HỖ TRỢ
 * (hỏi / gặp lỗi / hỏng hóc), đồng thời LOẠI người bán ra khỏi danh sách lead.
 *
 * Vì sao cần chấm điểm thay vì match từ khoá ngây thơ:
 *   Bài "cần BÁN RTX 4060 giá 5tr" và "cần MUA RTX tầm 5tr" đều chứa tên sản
 *   phẩm + giá. Match thô sẽ gom cả hai. Ta cần phân biệt người MUA với người
 *   BÁN, nên dùng tín hiệu đối nghịch + chấm điểm và chọn nhãn điểm cao nhất.
 *
 * Trả nhãn: "buy" | "support" | "seller" | "other".
 *
 * TỪ KHOÁ TÙY CHỈNH: ngoài bộ gốc bên dưới, người dùng có thể bổ sung từ khoá
 * (qua nút "Gợi ý từ khoá" → duyệt). Các từ này lưu ở DB dùng chung toàn hệ
 * thống (bảng learned_keywords) và được GỘP với bộ gốc khi phân loại. Nhãn
 * "seller" dùng chung type "sell" với mục "Từ khoá học (Bán)". Bộ gốc bên dưới
 * chỉ là fallback khi chưa đăng nhập / mất mạng. Mọi từ mới đều phải duyệt.
 */

import { bg } from "./core.js";
import { normForMatch, scoreHits, hasAnyKeyword } from "../keyword-match.js";

// Tín hiệu KHÁCH CẦN MUA (ý định mua, đi tìm hàng).
const BUY_BASE = [
  "cần mua", "muốn mua", "tìm mua", "đang tìm", "cần tư vấn", "tư vấn giúp",
  "tư vấn cho", "build pc", "build cấu hình", "build dàn", "ráp máy", "lắp máy",
  "lên cấu hình", "lên đời", "ngân sách", "tầm giá", "khoảng giá", "tầm tiền",
  "giá bao nhiêu", "bao nhiêu tiền", "báo giá", "ở đâu rẻ", "nên mua", "cần con",
  "có sẵn không", "còn hàng không", "shop nào", "chỗ nào bán", "mua ở đâu",
  "đặt hàng", "muốn lấy", "cần lấy",
];

// Tín hiệu CẦN HỖ TRỢ (hỏi kỹ thuật, so sánh, hoặc sự cố/hỏng hóc).
const SUPPORT_BASE = [
  "có nên", "loại nào", "con nào", "hãng nào", "so sánh", "khác gì",
  "dùng được không", "chạy được không", "hợp không", "tương thích",
  "có tốt không", "review", "đánh giá", "thắc mắc", "cho hỏi", "xin hỏi",
  "ai biết", "giúp với", "giúp em", "giúp mình", "cứu với", "bị lỗi", "bị hư",
  "bị hỏng", "lỗi gì", "hư gì", "hỏng gì", "bị sao", "bị làm sao", "không lên",
  "không vào", "không nhận", "không khởi động", "màn hình đen", "đèn đỏ",
  "tự tắt", "tự khởi động lại", "kêu bíp", "giật lag",
  // "sửa" trần bị loại (dễ dính THỢ/SHOP "nhận sửa chữa"); chỉ giữ cụm phía KHÁCH.
  "cần sửa", "sửa giúp", "sửa ở đâu", "khắc phục",
  "cách fix", "bị gì", "bị treo", "đơ máy",
];

// Shop/thợ chào dịch vụ (thu mua, nhận sửa, mua bán trao đổi...) -> BÊN BÁN,
// không phải khách cần hỗ trợ/cần mua. Ép cứng nhãn seller.
const SHOP_OFFER = [
  "thu mua", "nhận thu mua", "chuyên thu mua", "nhận sửa", "nhận sửa chữa",
  "chuyên sửa", "nhận bọc", "nhận thay", "nhận order", "nhận ký gửi",
  "nhận thanh lý", "trao đổi mua bán", "mua bán trao đổi", "chuyên mua bán",
  "nhận lên đời", "nhận vệ sinh",
];

// Tín hiệu NGƯỜI BÁN (để loại khỏi lead).
const SELLER_BASE = [
  "cần bán", "cần pass", "pass lại", "pass nhanh", "thanh lý", "thanh lí",
  "để lại", "nhượng lại", "bán nhanh", "bán gấp", "ra đi", "lên đời nên bán",
  "giá bán", "giá fix", "fix nhẹ", "fixnhẹ", "bớt lộc", "có fix",
  "đã qua sử dụng", "hàng còn bảo hành", "còn bảo hành", "còn bh", "fullbox",
  "full box", "newseal", "new seal", "like new", "likenew", "freeship",
  "free ship", "ship cod", "ship toàn quốc", "ib zalo", "inbox zalo",
  "liên hệ zalo", "call zalo", "alo zalo", "sđt", "số đt", "giao lưu", "gl",
  "bao test", "bao ship", "bảo hành shop", "shop mình", "bên mình có",
  "cửa hàng mình", "có hoá đơn", "xuất hoá đơn", "nhận order sỉ",
];

// Tín hiệu bán CHẮC CHẮN -> ép nhãn seller ngay (chặn người bán lọt vào lead).
const STRONG_SELLER = [
  "cần bán", "bán gấp", "bán nhanh", "thanh lý", "thanh lí",
  "cần pass", "pass lại", "pass nhanh", "nhượng lại", "nhận order sỉ",
];

// Nhãn lead nội bộ -> type trong DB. "seller" gộp chung type "sell".
const LABEL_TO_DB_TYPE = { buy: "buy", support: "support", seller: "sell" };

// Từ khoá nạp từ DB (gộp với bộ gốc khi phân loại). Rỗng khi chưa đăng nhập
// / mất mạng -> chỉ dùng bộ gốc làm fallback.
const DB_KW = { buy: [], support: [], seller: [] };

/** Bộ từ khoá hiệu lực = gốc + DB (loại trùng). */
function kw(label) {
  const base = label === "buy" ? BUY_BASE : label === "support" ? SUPPORT_BASE : SELLER_BASE;
  return [...new Set(base.concat(DB_KW[label] || []))];
}

/** Tất cả từ khoá đã biết (để loại khi khai phá ứng viên mới). */
function allKnown() {
  return new Set([...kw("buy"), ...kw("support"), ...kw("seller")]);
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Từ để hỏi, dạng KHÔNG DẤU (khớp trên `hay` đã deaccent). normForMatch bỏ hết
// dấu câu nên "?" phải dò trên text GỐC (xem classifyLead), không nhét vào đây.
const QUESTION_HINT = /(^|\s)(sao|tai sao|vi sao|lam sao|the nao|nhu nao|ntn)\b/;

/**
 * Phân loại một bài viết. Trả { label, score, signals }.
 *
 * Dùng matcher RANH GIỚI TỪ + BỎ DẤU + CHẤM ĐIỂM ĐẶC HIỆU (src/keyword-match.js):
 *   - "thanh ly" không dấu vẫn bắt được người bán;
 *   - "gl" không dính trong "google";
 *   - cụm dài (đặc hiệu) nặng hơn token đơn ngắn.
 * STRONG_SELLER / SHOP_OFFER ép cứng nhãn seller (người bán / shop chào dịch vụ).
 */
export function classifyLead(text) {
  const hay = normForMatch(text);
  if (!hay) return { label: "other", score: 0, signals: { buy: 0, support: 0, seller: 0 } };

  if (hasAnyKeyword(text, STRONG_SELLER) || hasAnyKeyword(text, SHOP_OFFER)) {
    const sel = scoreHits(text, kw("seller")).score;
    return { label: "seller", score: sel, signals: { buy: 0, support: 0, seller: sel } };
  }

  const buy = scoreHits(text, kw("buy")).score;
  let support = scoreHits(text, kw("support")).score;
  const seller = scoreHits(text, kw("seller")).score;
  // Câu hỏi = có "?" (dò trên text GỐC vì `hay` đã bỏ dấu câu) hoặc từ để hỏi.
  const isQuestion = /[?？]/.test(String(text ?? "")) || QUESTION_HINT.test(hay);
  if (isQuestion && buy === 0) support += 1;

  const signals = { buy, support, seller };

  if (seller >= 2 || (seller >= 1 && seller >= buy + support)) {
    return { label: "seller", score: seller, signals };
  }
  if (buy > 0 && buy >= support) {
    return { label: "buy", score: buy, signals };
  }
  if (support > 0) {
    return { label: "support", score: support, signals };
  }
  return { label: "other", score: 0, signals };
}

/** Nhãn hiển thị + màu badge cho từng loại lead. */
export const LEAD_META = {
  buy: { text: "Cần mua", cls: "lead-buy" },
  support: { text: "Cần hỗ trợ", cls: "lead-support" },
  seller: { text: "Người bán", cls: "lead-seller" },
  other: { text: "Khác", cls: "lead-other" },
};

export function matchLeadMode(label, mode) {
  if (mode === "all" || !mode) return true;
  if (mode === "lead") return label === "buy" || label === "support";
  return label === mode;
}

/* ====================== TỪ KHOÁ TÙY CHỈNH (DB) ======================== */

/**
 * Nạp từ khoá dùng chung từ DB vào bộ nhớ (gọi lúc init + sau khi duyệt thêm).
 * Mỗi nhãn lead lấy đúng type tương ứng (seller -> "sell"). Chỉ nạp từ đang bật.
 * Nếu chưa đăng nhập / lỗi mạng thì giữ DB_KW rỗng -> classifyLead dùng bộ gốc.
 */
export async function loadLeadKeywords() {
  const labels = ["buy", "support", "seller"];
  for (const label of labels) DB_KW[label] = [];
  try {
    const results = await Promise.all(
      labels.map((label) => bg("GET_KEYWORDS", { kwType: LABEL_TO_DB_TYPE[label] }))
    );
    labels.forEach((label, i) => {
      const rows = (results[i] && results[i].keywords) || [];
      DB_KW[label] = rows
        .filter((r) => r.enabled !== 0 && r.enabled !== false)
        .map((r) => norm(r.keyword))
        .filter(Boolean);
    });
  } catch (_) {
    /* fallback: giữ bộ gốc */
  }
  return DB_KW;
}

/**
 * Thêm 1 từ khoá đã duyệt vào nhóm (buy|support|seller) -> ghi xuống DB dùng
 * chung. Trả true nếu là từ mới (chưa có trong bộ gốc hoặc DB).
 */
export async function addLeadKeyword(label, phrase) {
  const p = norm(phrase);
  if (!p || !DB_KW[label]) return false;
  if (kw(label).includes(p)) return false; // đã có (gốc hoặc DB)
  try {
    await bg("ADD_KEYWORD", {
      keyword: p,
      kwType: LABEL_TO_DB_TYPE[label],
      enabled: true,
    });
  } catch (_) {
    return false;
  }
  DB_KW[label].push(p);
  return true;
}

/** Danh sách từ khoá DB hiện đã nạp (để hiển thị/quản lý). */
export function getCustomKeywords() {
  return { buy: [...DB_KW.buy], support: [...DB_KW.support], seller: [...DB_KW.seller] };
}

/* =================== KHAI PHÁ ỨNG VIÊN TỪ KHO BÀI ===================== */

// Từ dừng tiếng Việt + chung chung: loại để ứng viên không bị nhiễu.
const STOPWORDS = new Set([
  "và", "là", "của", "có", "cho", "các", "một", "những", "được", "này", "đó",
  "thì", "mà", "với", "ở", "ạ", "ad", "mn", "mọi", "người", "nhé", "nha", "không",
  "cũng", "rất", "đang", "đã", "sẽ", "khi", "nếu", "vì", "nên", "ra", "vào", "lên",
  "xuống", "đi", "lại", "về", "từ", "đến", "trong", "ngoài", "trên", "dưới", "bị",
  "em", "anh", "chị", "mình", "bạn", "ai", "gì", "sao", "thế", "ạ", "à", "ơi",
  "cái", "con", "chiếc", "bài", "mua", "bán", "giá", "tiền", "máy", "tính",
]);

const tokenize = (t) =>
  norm(t)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Sinh các cụm 1-2-3 từ từ một câu, bỏ cụm chứa toàn stopword. */
function ngramsOf(text) {
  const toks = tokenize(text);
  const out = [];
  for (let n = 1; n <= 3; n++) {
    for (let i = 0; i + n <= toks.length; i++) {
      const gram = toks.slice(i, i + n);
      // Cụm 1 từ phải không phải stopword; cụm dài hơn phải có ít nhất 1 từ "có nghĩa".
      if (gram.every((w) => STOPWORDS.has(w))) continue;
      if (n === 1 && (STOPWORDS.has(gram[0]) || gram[0].length < 3)) continue;
      out.push(gram.join(" "));
    }
  }
  return out;
}

/**
 * Quét kho bài đã crawl, đề xuất TỪ KHOÁ MỚI cho từng nhóm.
 *
 * Ý tưởng (không cần AI): dùng phân loại hiện tại chia bài thành buy/support/
 * seller. Một cụm từ là ứng viên TỐT cho nhóm X nếu nó xuất hiện NHIỀU ở nhóm X
 * và HIẾM ở các nhóm khác (đặc trưng - distinctive). Loại các từ đã biết.
 *
 * @param {Array} posts  mảng bài { text }
 * @param {object} opts  { minCount, maxPerGroup }
 * @returns {{buy:Array,support:Array,seller:Array}} mỗi phần tử {phrase,count,ratio,examples}
 */
export function mineKeywordCandidates(posts, opts = {}) {
  const minCount = opts.minCount || 3;
  const maxPerGroup = opts.maxPerGroup || 15;
  const known = allKnown();

  // Đếm tần suất cụm từ theo nhóm + lưu vài ví dụ.
  const freq = { buy: new Map(), support: new Map(), seller: new Map(), other: new Map() };
  const example = new Map(); // phrase -> 1 đoạn bài ví dụ

  for (const p of posts || []) {
    const text = p && p.text;
    if (!text) continue;
    const { label } = classifyLead(text);
    const grams = new Set(ngramsOf(text)); // mỗi bài tính 1 lần / cụm
    for (const g of grams) {
      if (known.has(g)) continue; // đã là từ khoá -> bỏ
      const m = freq[label];
      m.set(g, (m.get(g) || 0) + 1);
      if (!example.has(g)) example.set(g, String(text).slice(0, 120));
    }
  }

  const groups = ["buy", "support", "seller"];
  const result = { buy: [], support: [], seller: [] };

  for (const grp of groups) {
    const here = freq[grp];
    const cands = [];
    for (const [phrase, count] of here.entries()) {
      if (count < minCount) continue;
      // Tổng số lần ở các nhóm khác (kể cả "other").
      let other = 0;
      for (const g2 of ["buy", "support", "seller", "other"]) {
        if (g2 === grp) continue;
        other += freq[g2].get(phrase) || 0;
      }
      const ratio = count / (count + other); // càng gần 1 càng đặc trưng cho nhóm
      if (ratio < 0.6) continue; // không đủ đặc trưng -> bỏ (giảm nhiễu)
      cands.push({ phrase, count, ratio, examples: example.get(phrase) || "" });
    }
    // Ưu tiên đặc trưng cao + tần suất cao.
    cands.sort((a, b) => b.ratio - a.ratio || b.count - a.count);
    result[grp] = cands.slice(0, maxPerGroup);
  }

  return result;
}
