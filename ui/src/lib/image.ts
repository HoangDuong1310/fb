// Nén ảnh phía CLIENT trước khi biến thành base64 vào hàng đợi (jobs.data).
//
// LÝ DO: ảnh gốc từ điện thoại thường 2–5MB. Khi đọc thẳng bằng readAsDataURL,
// mỗi ảnh phình ~33% (base64) rồi được NHÚNG LẶP vào MỌI job (N ảnh × M nhóm),
// khiến cột `jobs.data` khổng lồ: GET /jobs vượt maxAllowedPacket (lỗi 500) và
// "Duyệt tất cả" chạy chậm tới mức service worker MV3 quá hạn phản hồi.
//
// Cách xử lý: vẽ ảnh xuống canvas, thu nhỏ theo cạnh dài tối đa rồi mã hoá lại
// JPEG. Một ảnh điện thoại thường giảm ~10–30× (còn ~100–300KB). Kết quả vẫn là
// data URL (chuỗi base64) nên KHÔNG đổi shape `job.images` mà crawl.js đang dùng,
// cũng không cần đổi schema.

export interface CompressOptions {
  /** Cạnh dài tối đa (px). Ảnh lớn hơn sẽ được thu nhỏ giữ tỉ lệ. */
  maxEdge?: number;
  /** Chất lượng JPEG (0..1). */
  quality?: number;
  /** Kích thước tối đa cho phép NÉN (byte). File lớn hơn vẫn nén bình thường. */
  maxInputBytes?: number;
}

const DEFAULTS: Required<CompressOptions> = {
  maxEdge: 1600,
  quality: 0.82,
  // Ảnh đã nhỏ hơn ~200KB thì nén lại thường không lợi; nhưng vẫn chuẩn hoá về
  // JPEG để đồng nhất. Ngưỡng này chỉ dùng để bỏ qua việc vẽ lại khi không cần.
  maxInputBytes: 0,
};

/** Đọc File thành data URL (không nén) — dùng làm fallback khi canvas lỗi. */
function readAsDataURL(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(file);
  });
}

/** Nạp một data URL / blob URL vào HTMLImageElement. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

/**
 * Nén MỘT file ảnh về data URL JPEG đã thu nhỏ. Nếu file không phải ảnh, hoặc
 * quá trình canvas thất bại, trả về data URL gốc (không nén) để không mất ảnh.
 */
export async function compressImageFile(
  file: File,
  opts: CompressOptions = {},
): Promise<string | null> {
  const o = { ...DEFAULTS, ...opts };

  // Không phải ảnh raster (vd: gif động, svg) -> giữ nguyên để tránh hỏng.
  if (!file.type.startsWith("image/") || file.type === "image/gif") {
    return readAsDataURL(file);
  }

  const original = await readAsDataURL(file);
  if (!original) return null;

  try {
    const img = await loadImage(original);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return original;

    const longEdge = Math.max(w, h);
    const scale = longEdge > o.maxEdge ? o.maxEdge / longEdge : 1;
    const outW = Math.max(1, Math.round(w * scale));
    const outH = Math.max(1, Math.round(h * scale));

    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return original;
    ctx.drawImage(img, 0, 0, outW, outH);

    const out = canvas.toDataURL("image/jpeg", o.quality);
    // Nếu vì lý do nào đó bản "nén" lại to hơn bản gốc thì giữ bản gốc.
    return out && out.length < original.length ? out : original;
  } catch {
    return original;
  }
}

/**
 * Nén danh sách file ảnh (từ input) -> mảng data URL đã tối ưu. Giữ nguyên thứ
 * tự, loại bỏ ảnh đọc lỗi. Thay thế trực tiếp cho readFiles cũ.
 */
export async function compressImageFiles(
  fileList: FileList | File[],
  opts: CompressOptions = {},
): Promise<string[]> {
  const files = [...fileList];
  const results = await Promise.all(files.map((f) => compressImageFile(f, opts)));
  return results.filter((x): x is string => !!x);
}
