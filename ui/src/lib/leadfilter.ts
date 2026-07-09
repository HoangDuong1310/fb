// On-device lead classification, ported verbatim from src/dashboard/leadfilter.js.
// Client-side keyword base only (no DB keywords) — matches the vanilla dashboard
// behaviour where DB_KW is empty on the client.

const BUY_BASE = [
  "cần mua", "muốn mua", "tìm mua", "đang tìm", "cần tư vấn", "tư vấn giúp",
  "tư vấn cho", "build pc", "build cấu hình", "build dàn", "ráp máy", "lắp máy",
  "lên cấu hình", "lên đời", "ngân sách", "tầm giá", "khoảng giá", "tầm tiền",
  "giá bao nhiêu", "bao nhiêu tiền", "báo giá", "ở đâu rẻ", "nên mua", "cần con",
  "có sẵn không", "còn hàng không", "shop nào", "chỗ nào bán", "mua ở đâu",
  "order", "đặt hàng", "muốn lấy", "cần lấy",
];

const SUPPORT_BASE = [
  "có nên", "loại nào", "con nào", "hãng nào", "so sánh", "khác gì",
  "dùng được không", "chạy được không", "hợp không", "tương thích",
  "có tốt không", "review", "đánh giá", "thắc mắc", "cho hỏi", "xin hỏi",
  "ai biết", "giúp với", "giúp em", "giúp mình", "cứu với", "bị lỗi", "bị hư",
  "bị hỏng", "lỗi gì", "hư gì", "hỏng gì", "bị sao", "bị làm sao", "không lên",
  "không vào", "không nhận", "không khởi động", "màn hình đen", "đèn đỏ",
  "tự tắt", "tự khởi động lại", "kêu bíp", "giật lag", "sửa", "khắc phục",
  "cách fix", "fix", "bị gì", "bị treo", "đơ máy",
];

const SELLER_BASE = [
  "cần bán", "cần pass", "pass lại", "pass nhanh", "thanh lý", "thanh lí",
  "để lại", "nhượng lại", "bán nhanh", "bán gấp", "ra đi", "lên đời nên bán",
  "giá bán", "giá fix", "fix nhẹ", "fixnhẹ", "bớt lộc", "có fix",
  "đã qua sử dụng", "hàng còn bảo hành", "còn bảo hành", "còn bh", "fullbox",
  "full box", "newseal", "new seal", "like new", "likenew", "freship",
  "free ship", "ship cod", "ship toàn quốc", "ib zalo", "inbox zalo",
  "liên hệ zalo", "call zalo", "alo zalo", "sđt", "số đt", "giao lưu", "gl ",
  "bao test", "bao ship", "bảo hành shop", "shop mình", "bên mình có",
  "cửa hàng mình", "có hoá đơn", "xuất hoá đơn", "nhận order sỉ",
];

export type LeadLabel = "buy" | "support" | "seller" | "other";

export type LeadMode = "all" | "lead" | "buy" | "support" | "seller";

export interface LeadResult {
  label: LeadLabel;
  score: number;
  signals: { buy: number; support: number; seller: number };
}

const norm = (s: string | undefined | null): string =>
  String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

function countHits(text: string, keywords: string[]): number {
  let n = 0;
  for (const k of keywords) {
    if (k && text.includes(k)) n++;
  }
  return n;
}

const QUESTION_HINT =
  /[?？]|(^|\s)(sao|tại sao|vì sao|làm sao|thế nào|như nào|ntn)\b/;

export function classifyLead(text: string | undefined | null): LeadResult {
  const t = norm(text);
  if (!t) return { label: "other", score: 0, signals: { buy: 0, support: 0, seller: 0 } };
  const buy = countHits(t, BUY_BASE);
  let support = countHits(t, SUPPORT_BASE);
  const seller = countHits(t, SELLER_BASE);
  if (QUESTION_HINT.test(t) && buy === 0) support += 1;
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
