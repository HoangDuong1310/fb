/**
 * sharing.js — View "Cài đặt chia sẻ": BA công tắc tổng điều khiển việc dữ liệu
 * của bạn có được chia sẻ chung (cho người dùng khác xem) hay giữ riêng tư.
 *
 *   - share_crawled_default     : bài đã crawl.
 *   - share_commented_default   : bài/bình luận của bạn.
 *   - share_group_prices_default: dòng giá trích từ group.
 *
 * Mỗi công tắc khi đổi sẽ CASCADE xuống mọi bản ghi hiện có (backend làm trong
 * MỘT transaction) — nên đây là nơi DUY NHẤT chỉnh chia sẻ. Icon 🌐/🔒 ở thẻ
 * "Giá Group" chỉ hiển thị trạng thái, không chỉnh được.
 *
 * Đường dữ liệu: KHÔNG gọi HTTP trực tiếp (JWT ở service worker). Qua bg():
 *   - GET_SHARE_PREFS -> { ok, shareCrawledDefault, shareCommentedDefault, shareGroupPricesDefault }
 *   - SET_SHARE_PREFS { patch } -> trả cùng shape (patch dùng snake_case + 0/1).
 */
import { $, bg, toast } from "../core.js";

// Ánh xạ id checkbox (UI) <-> khoá camelCase (GET) <-> khoá snake_case (PATCH).
const TOGGLES = [
  {
    id: "shareCrawled",
    getKey: "shareCrawledDefault",
    setKey: "share_crawled_default",
  },
  {
    id: "shareCommented",
    getKey: "shareCommentedDefault",
    setKey: "share_commented_default",
  },
  {
    id: "shareGroupPrices",
    getKey: "shareGroupPricesDefault",
    setKey: "share_group_prices_default",
  },
];

export async function loadSharingView() {
  const res = await bg("GET_SHARE_PREFS");
  const hint = $("sharingAuthHint");
  if (!res || !res.ok) {
    // Chưa đăng nhập -> nhắc đăng nhập, KHÓA các công tắc để tránh hiểu nhầm.
    if (hint) {
      hint.hidden = false;
      hint.textContent =
        (res && res.error) || "Cần đăng nhập tài khoản web (ở popup tiện ích) để chỉnh cài đặt chia sẻ.";
    }
    TOGGLES.forEach((t) => {
      const el = $(t.id);
      if (el) {
        el.checked = false;
        el.disabled = true;
      }
    });
    return;
  }
  if (hint) hint.hidden = true;
  TOGGLES.forEach((t) => {
    const el = $(t.id);
    if (el) {
      el.disabled = false;
      el.checked = !!res[t.getKey];
    }
  });
}

// Lưu MỘT công tắc khi đổi. Gửi đúng khoá snake_case + 0/1 cho backend.
export async function saveSharePref(id) {
  const def = TOGGLES.find((t) => t.id === id);
  if (!def) return;
  const el = $(id);
  if (!el) return;
  const value = el.checked ? 1 : 0;
  const res = await bg("SET_SHARE_PREFS", { patch: { [def.setKey]: value } });
  if (res && res.ok) {
    toast(
      value
        ? "Đã bật chia sẻ. Áp dụng cho cả dữ liệu hiện có."
        : "Đã tắt chia sẻ. Dữ liệu chuyển về riêng tư.",
      "ok",
      2600
    );
    // Đồng bộ lại theo trạng thái server (đề phòng cascade đổi gì khác).
    TOGGLES.forEach((t) => {
      const e = $(t.id);
      if (e) e.checked = !!res[t.getKey];
    });
  } else {
    // Lỗi -> hoàn nguyên checkbox về trạng thái trước đó.
    el.checked = !value;
    toast((res && res.error) || "Lưu cài đặt chia sẻ thất bại.", "err", 5000);
  }
}
