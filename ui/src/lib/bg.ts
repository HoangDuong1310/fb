/**
 * bg.ts — Cầu nối tới service worker (MV3), port từ src/dashboard/core.js.
 *
 * Bọc chrome.runtime.sendMessage thành Promise, kèm logic thử lại khi gặp
 * "lỗi kênh tạm thời" của MV3 (service worker vừa bị Chrome cho ngủ). Đây là
 * lớp DATA DUY NHẤT của UI React: mọi view gọi bg("TÊN_LỆNH", payload) và nhận
 * lại đúng shape mà background.js trả về ({ ok, ... } hoặc { ok:false, error }).
 *
 * Giữ nguyên hành vi của bản vanilla để hai UI (cũ + mới) hoạt động như nhau
 * trong suốt quá trình migrate từng view một.
 */

/** Shape chung cho mọi phản hồi từ service worker. */
export interface BgResponse {
  ok: boolean;
  error?: string;
  /** Chỉ dùng nội bộ giữa sendOnce -> bg để nhận diện lỗi kênh. */
  _portError?: string;
  [key: string]: unknown;
}

// Lỗi kênh "tạm thời" của MV3: khi service worker đang ở giữa quá trình bị
// Chrome cho ngủ (suspend) thì message gửi tới nó hỏng NGAY với
// "The message port closed before a response was received." Đây KHÔNG phải
// lỗi đăng nhập hay lỗi backend — chỉ là đua thức/ngủ của SW. Gửi lại sau một
// nhịp ngắn để SW mới kịp khởi động và trả lời.
const TRANSIENT_PORT_ERRORS = [
  "message port closed",
  "Could not establish connection",
  "Receiving end does not exist",
];

function isTransientPortError(message: string | undefined): boolean {
  const m = String(message || "").toLowerCase();
  return TRANSIENT_PORT_ERRORS.some((s) => m.includes(s.toLowerCase()));
}

function sendOnce(type: string, payload: Record<string, unknown>): Promise<BgResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (res: BgResponse | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, _portError: err.message });
          return;
        }
        if (res === undefined) {
          // SW nhận message nhưng không trả lời (lệnh chưa tồn tại trong SW đang chạy).
          resolve({
            ok: false,
            error:
              'Service worker không phản hồi lệnh "' +
              type +
              '". Có thể đang chạy bản cũ — hãy Reload extension rồi mở lại Dashboard.',
          });
          return;
        }
        resolve(res);
      });
    } catch (e) {
      resolve({ ok: false, _portError: String(e) });
    }
  });
}

/**
 * Gửi một lệnh tới service worker và trả về phản hồi.
 * @param type  Tên lệnh (khớp switch trong background.js), vd "GET_CONVERSATIONS".
 * @param payload  Dữ liệu kèm theo lệnh.
 * @param retries  Số lần thử lại khi gặp lỗi kênh tạm thời (mặc định 2).
 */
export async function bg<T extends BgResponse = BgResponse>(
  type: string,
  payload: Record<string, unknown> = {},
  retries = 2,
): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await sendOnce(type, payload);
    // SW không phản hồi -> thử lại (SW có thể vừa bị Chrome tắt).
    if (!res) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        continue;
      }
      return {
        ok: false,
        error:
          'Service worker không phản hồi lệnh "' +
          type +
          '". Hãy Reload extension rồi mở lại Dashboard.',
      } as T;
    }
    // Lỗi kênh tạm thời và còn lượt thử: đợi SW mới thức dậy rồi gửi lại.
    if (res._portError !== undefined) {
      if (isTransientPortError(res._portError) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
        continue;
      }
      return {
        ok: false,
        error:
          "Mất kết nối tới tiện ích (" +
          res._portError +
          "). Hãy Reload extension trong chrome://extensions rồi mở lại Dashboard.",
      } as T;
    }
    // Thành công, hoặc lỗi "thật" (SW có trả lời nhưng ok:false) -> trả luôn.
    return res as T;
  }
  // Không bao giờ tới đây, nhưng để thỏa mãn kiểu trả về.
  return { ok: false, error: "Lỗi không xác định." } as T;
}
