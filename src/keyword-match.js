/**
 * keyword-match.js — SO KHỚP TỪ KHOÁ CHUẨN cho tiếng Việt (dùng chung).
 *
 * Vì sao tồn tại: trước đây leadfilter.js và group-prices.js đều so khớp bằng
 * `text.includes(keyword)` THÔ — không ranh giới từ, không bỏ dấu. Hệ quả:
 *   1) MISS khi người dùng gõ KHÔNG DẤU ("thanh ly", "giao luu") vì bộ từ khoá
 *      có dấu -> người bán lọt vào danh sách khách.
 *   2) FALSE POSITIVE khi từ khoá ngắn là CHUỖI CON của từ khác ("gl" trong mã
 *      sản phẩm, "order" trong "nhận order sỉ", "fix" trong "giá fix").
 *
 * Cách sửa (module này):
 *   - normForMatch: BỎ DẤU (NFD) + lowercase + thay MỌI ký tự không phải chữ/số
 *     bằng khoảng trắng + gộp trắng + CHÈN 1 space ở hai đầu. Nhờ đó ta so khớp
 *     theo RANH GIỚI TỪ: tìm " gl " thay vì "gl", nên "gl" chỉ khớp khi đứng
 *     riêng, còn "google" (-> " google ") không dính.
 *   - prepPhrase: chuẩn hoá y hệt cho cụm từ khoá rồi bọc 2 đầu bằng space.
 *   - scoreHits: CHẤM ĐIỂM THEO ĐỘ ĐẶC HIỆU thay vì đếm 1-1. Cụm >=2 từ (đặc
 *     hiệu, ít nhầm) nặng hơn token đơn ngắn ("fix", "gl", "bh" — dễ nhiễu).
 *
 * Module thuần (không import chrome / DOM) nên test trực tiếp bằng node --test.
 */

/** Bỏ dấu tiếng Việt: NFD tách dấu tổ hợp rồi xoá, đ->d. */
export function deaccent(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Chuẩn hoá text về DẠNG SO KHỚP THEO RANH GIỚI TỪ.
 * Trả chuỗi đã bỏ dấu + lowercase, mọi dấu câu/ký tự lạ thành khoảng trắng, và
 * được BỌC 1 space ở hai đầu (" ... "). Chuỗi rỗng nếu không còn ký tự nào.
 */
export function normForMatch(s) {
  const cleaned = deaccent(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? " " + cleaned + " " : "";
}

/**
 * Chuẩn hoá 1 CỤM TỪ KHOÁ về dạng bọc space (" cụm "). Trả "" nếu rỗng.
 * Dùng cùng phép chuẩn hoá với normForMatch để "gl " (có space thừa),
 * "thanh lý", "sđt" đều quy về token sạch, bỏ dấu.
 */
export function prepPhrase(keyword) {
  return normForMatch(keyword);
}

/**
 * Trọng số của một cụm theo độ đặc hiệu:
 *   - cụm >= 2 từ  -> 1.0  (đặc hiệu cao, hiếm nhầm: "cần bán", "giá bao nhiêu")
 *   - token đơn >= 4 ký tự -> 0.6  ("review", "freeship")
 *   - token đơn ngắn (< 4) -> 0.4  ("gl", "bh", "fix" — dễ nhiễu, tính yếu)
 * Nhận cụm ĐÃ chuẩn hoá (không dấu, đã trim; có thể còn bọc space).
 */
export function phraseWeight(preppedPhrase) {
  const toks = String(preppedPhrase).trim().split(/\s+/).filter(Boolean);
  if (toks.length === 0) return 0;
  if (toks.length >= 2) return 1;
  return toks[0].length >= 4 ? 0.6 : 0.4;
}

/**
 * Đếm/chấm điểm số cụm khớp trong text (theo ranh giới từ + trọng số đặc hiệu).
 *
 * @param {string} text      text gốc (chưa chuẩn hoá)
 * @param {string[]} keywords danh sách cụm từ khoá (thô, có/không dấu đều được)
 * @returns {{score:number, count:number, matched:string[]}}
 *   - score: tổng trọng số các cụm khớp (float)
 *   - count: số cụm khớp (nguyên)
 *   - matched: các cụm (dạng gốc) đã khớp
 */
export function scoreHits(text, keywords) {
  const hay = normForMatch(text);
  if (!hay || !Array.isArray(keywords) || keywords.length === 0) {
    return { score: 0, count: 0, matched: [] };
  }
  let score = 0;
  let count = 0;
  const matched = [];
  const seen = new Set(); // tránh tính trùng khi bộ gốc + DB có cụm giống nhau sau chuẩn hoá
  for (const raw of keywords) {
    const needle = prepPhrase(raw);
    if (!needle || seen.has(needle)) continue;
    if (hay.includes(needle)) {
      seen.add(needle);
      score += phraseWeight(needle);
      count += 1;
      matched.push(raw);
    }
  }
  return { score, count, matched };
}

/**
 * Có KHỚP ÍT NHẤT MỘT cụm không (theo ranh giới từ). Dùng cho lọc thô nhanh
 * như tier1Pass — không cần điểm, chỉ cần true/false.
 */
export function hasAnyKeyword(text, keywords) {
  const hay = normForMatch(text);
  if (!hay || !Array.isArray(keywords) || keywords.length === 0) return false;
  for (const raw of keywords) {
    const needle = prepPhrase(raw);
    if (needle && hay.includes(needle)) return true;
  }
  return false;
}
