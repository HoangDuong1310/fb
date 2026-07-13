// upload.ts — Nén ảnh phía CLIENT rồi ĐẨY LÊN STORAGE, trả về URL công khai.
//
// LÝ DO: trước đây ảnh được nhúng dưới dạng base64 (data URL) vào job.images và
// lưu thẳng vào cột `jobs.data`. Cùng một mảng ảnh bị nhân bản vào MỌI job (N
// ảnh × M nhóm) khiến `jobs.data` phình khổng lồ -> GET /jobs vượt
// maxAllowedPacket (lỗi 500) và "Duyệt tất cả" chậm tới mức SW MV3 quá hạn.
//
// Cách xử lý mới: vẫn nén ảnh bằng compressImageFiles (canvas -> JPEG nhỏ), sau
// đó GỬI các data URL đó qua service worker (lệnh UPLOAD_IMAGES). Backend ghi
// từng ảnh ra ổ đĩa (server/web/uploads/<userId>/...) và trả lại mảng URL
// "/uploads/...". UI dùng URL này cho job.images -> `jobs.data` chỉ còn chuỗi
// URL ngắn, không còn base64.
//
// crawl.js sẽ tự tải URL -> data URL ngay trước khi bơm vào trang Facebook, nên
// phần DOM (dataUrlToFile/attachImages) KHÔNG cần đổi.

import { compressImageFiles, type CompressOptions } from "./image";
import { bg, type BgResponse } from "./bg";

interface UploadResponse extends BgResponse {
  urls?: string[];
}

/**
 * Nén danh sách file ảnh rồi tải lên storage.
 * @returns Mảng URL công khai ("/uploads/...") theo đúng thứ tự file đầu vào.
 * @throws  Error nếu upload thất bại (SW lỗi hoặc backend trả ok:false).
 */
export async function compressAndUploadImages(
  fileList: FileList | File[],
  opts: CompressOptions = {},
): Promise<string[]> {
  const dataUrls = await compressImageFiles(fileList, opts);
  if (dataUrls.length === 0) return [];

  const res = await bg<UploadResponse>("UPLOAD_IMAGES", { dataUrls });
  if (!res.ok) {
    throw new Error(res.error || "Tải ảnh lên thất bại.");
  }
  return Array.isArray(res.urls) ? res.urls : [];
}
