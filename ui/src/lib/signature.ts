/**
 * signature.ts — Chữ ký cuối bài đăng (footer).
 *
 * VÌ SAO TÁCH RIÊNG MODULE THUẦN:
 * Chữ ký thường chứa số điện thoại, link, địa chỉ — thứ TUYỆT ĐỐI không được để
 * AI "xào nấu" lại. Nếu nhét chữ ký vào ô nội dung rồi đưa cả khối cho
 * AI_SPIN_CONTENT, mỗi nhóm sẽ nhận một biến thể số/link khác nhau (sai nghiệp
 * vụ, thậm chí mất khách). Vì vậy quy tắc là:
 *
 *   nội dung gốc -> AI viết / AI xào nấu -> RỒI MỚI dán chữ ký nguyên văn.
 *
 * Toàn bộ logic ở đây là hàm thuần (không DOM, không chrome API) để test được
 * bằng `node --test` mà không cần trình duyệt.
 */

/** Khoá lưu trong bảng `settings` theo từng user (/api/settings/:key). */
export const SIGNATURE_SETTING_KEY = "postSignature";

export interface SignatureConfig {
  /** Bật/tắt nhanh mà không mất nội dung chữ ký đã soạn. */
  enabled: boolean;
  /** Nội dung chữ ký, giữ nguyên văn (kể cả xuống dòng). */
  text: string;
}

export const DEFAULT_SIGNATURE: SignatureConfig = { enabled: false, text: "" };

/** Chuẩn hoá xuống dòng + bỏ khoảng trắng hai đầu để so sánh/ghép ổn định. */
function norm(s: string): string {
  return String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/**
 * Đọc giá trị thô từ settings (có thể là null, chuỗi cũ, hoặc object) thành
 * SignatureConfig hợp lệ. Chuỗi thuần được coi là chữ ký đã bật — người dùng
 * lưu được chữ ký thì mặc nhiên muốn dùng nó.
 */
export function normalizeSignature(raw: unknown): SignatureConfig {
  if (typeof raw === "string") {
    const text = norm(raw);
    return { enabled: text.length > 0, text };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SIGNATURE };
  const o = raw as Record<string, unknown>;
  const text = norm(typeof o.text === "string" ? o.text : "");
  // enabled chỉ có ý nghĩa khi có nội dung; thiếu cờ thì suy ra từ nội dung.
  const enabled = o.enabled == null ? text.length > 0 : o.enabled === true;
  return { enabled: enabled && text.length > 0, text };
}

/** Chữ ký có thực sự dùng được không (đã bật và có nội dung). */
export function isSignatureActive(sig: SignatureConfig | null | undefined): boolean {
  return !!sig && sig.enabled && norm(sig.text).length > 0;
}

/**
 * Dán chữ ký xuống dưới thân bài.
 *
 * BẤT BIẾN QUAN TRỌNG — idempotent: gọi nhiều lần trên cùng một chuỗi không
 * làm chữ ký lặp lại. Luồng Compose có thể build preview nhiều lần (sửa rồi
 * xem lại), và người dùng cũng có thể tự gõ sẵn chữ ký trong ô nội dung.
 *
 * @param body Thân bài (đã qua AI hoặc tự viết).
 * @param sig  Cấu hình chữ ký; null/tắt/rỗng -> trả lại thân bài đã trim.
 */
export function appendSignature(
  body: string,
  sig: SignatureConfig | null | undefined,
): string {
  const text = norm(body);
  if (!isSignatureActive(sig)) return text;
  const tail = norm(sig!.text);
  if (!text) return tail;
  if (text.endsWith(tail)) return text;
  // Một dòng trống ngăn cách để chữ ký không dính vào câu cuối.
  return text + "\n\n" + tail;
}
