// On-device lead classification, ported verbatim from src/dashboard/leadfilter.js.
// Client-side keyword base only (no DB keywords) — matches the vanilla dashboard
// behaviour where DB_KW is empty on the client.
//
// Matching uses WORD-BOUNDARY + DEACCENT scoring (mirror of src/keyword-match.js),
// so accent-less input ("thanh ly") still catches sellers and short tokens
// ("gl") never match inside larger words ("google").

const BUY_BASE = [
  "cần mua", "muốn mua", "tìm mua", "đang tìm", "cần tư vấn", "tư vấn giúp",
  "tư vấn cho", "build pc", "build cấu hình", "build dàn", "ráp máy", "lắp máy",
  "lên cấu hình", "lên đời", "ngân sách", "tầm giá", "khoảng giá", "tầm tiền",
  "giá bao nhiêu", "bao nhiêu tiền", "báo giá", "ở đâu rẻ", "nên mua", "cần con",
  "có sẵn không", "còn hàng không", "shop nào", "chỗ nào bán", "mua ở đâu",
  "đặt hàng", "muốn lấy", "cần lấy",
];

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
// không phải khách cần hỗ trợ/cần mua. Ép cứng nhãn seller (mirror src/).
const SHOP_OFFER = [
  "thu mua", "nhận thu mua", "chuyên thu mua", "nhận sửa", "nhận sửa chữa",
  "chuyên sửa", "nhận bọc", "nhận thay", "nhận order", "nhận ký gửi",
  "nhận thanh lý", "trao đổi mua bán", "mua bán trao đổi", "chuyên mua bán",
  "nhận lên đời", "nhận vệ sinh",
];

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

export type LeadLabel = "buy" | "support" | "seller" | "other";

export type LeadMode = "all" | "lead" | "buy" | "support" | "seller";

export interface LeadResult {
  label: LeadLabel;
  score: number;
  signals: { buy: number; support: number; seller: number };
}

// ---- matcher (mirror of src/keyword-match.js) ---------------------------

function deaccent(s: string | undefined | null): string {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

// Deaccent + lowercase + non-alnum -> space, collapse, wrap with 1 space.
function normForMatch(s: string | undefined | null): string {
  const cleaned = deaccent(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? " " + cleaned + " " : "";
}

function phraseWeight(prepped: string): number {
  const toks = prepped.trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return 0;
  if (toks.length >= 2) return 1;
  return toks[0].length >= 4 ? 0.6 : 0.4;
}

function scoreHits(text: string | undefined | null, keywords: string[]): number {
  const hay = normForMatch(text);
  if (!hay || keywords.length === 0) return 0;
  let score = 0;
  const seen = new Set<string>();
  for (const raw of keywords) {
    const needle = normForMatch(raw);
    if (!needle || seen.has(needle)) continue;
    if (hay.includes(needle)) {
      seen.add(needle);
      score += phraseWeight(needle);
    }
  }
  return score;
}

function hasAnyKeyword(text: string | undefined | null, keywords: string[]): boolean {
  const hay = normForMatch(text);
  if (!hay || keywords.length === 0) return false;
  for (const raw of keywords) {
    const needle = normForMatch(raw);
    if (needle && hay.includes(needle)) return true;
  }
  return false;
}

// Từ để hỏi, dạng KHÔNG DẤU (khớp trên `hay` đã deaccent). normForMatch bỏ hết
// dấu câu nên "?" phải dò trên text GỐC (xem classifyLead), không nhét vào đây.
const QUESTION_HINT =
  /(^|\s)(sao|tai sao|vi sao|lam sao|the nao|nhu nao|ntn)\b/;

export function classifyLead(text: string | undefined | null): LeadResult {
  const hay = normForMatch(text);
  if (!hay) return { label: "other", score: 0, signals: { buy: 0, support: 0, seller: 0 } };

  if (hasAnyKeyword(text, STRONG_SELLER) || hasAnyKeyword(text, SHOP_OFFER)) {
    const sel = scoreHits(text, SELLER_BASE);
    return { label: "seller", score: sel, signals: { buy: 0, support: 0, seller: sel } };
  }

  const buy = scoreHits(text, BUY_BASE);
  let support = scoreHits(text, SUPPORT_BASE);
  const seller = scoreHits(text, SELLER_BASE);
  // Câu hỏi = có "?" (dò trên text GỐC vì `hay` đã bỏ dấu câu) hoặc từ để hỏi.
  const isQuestion = /[?？]/.test(String(text ?? "")) || QUESTION_HINT.test(hay);
  if (isQuestion && buy === 0) support += 1;
  const signals = { buy, support, seller };
  if (seller >= 2 || (seller >= 1 && seller >= buy + support)) {
    return { label: "seller", score: seller, signals };
  }
  if (buy > 0 && buy >= support) return { label: "buy", score: buy, signals };
  if (support > 0) return { label: "support", score: support, signals };
  return { label: "other", score: 0, signals };
}

export const LEAD_META: Record<LeadLabel, { text: string; tone: "green" | "accent" | "amber" | "muted" }> = {
  buy: { text: "Cần mua", tone: "green" },
  support: { text: "Cần hỗ trợ", tone: "accent" },
  seller: { text: "Người bán", tone: "amber" },
  other: { text: "Khác", tone: "muted" },
};

export function matchLeadMode(label: LeadLabel, mode: LeadMode): boolean {
  if (mode === "all" || !mode) return true;
  if (mode === "lead") return label === "buy" || label === "support";
  return label === mode;
}
