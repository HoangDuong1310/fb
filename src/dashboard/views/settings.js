/**
 * views/settings.js — Tab "Cài đặt": gom toàn bộ cấu hình của tiện ích vào một
 * nơi, gồm:
 *   - Cấu hình crawl mặc định + tự động crawl nền (prefs + groups).
 *   - Tự động đồng bộ giá theo chu kỳ (products).
 *   - Kết nối AI (API base/key/model) + khám phá selector (ai).
 *   - Quản lý dữ liệu: xuất bài viết, xóa bài viết/sản phẩm/kho/nháp tư vấn.
 *
 * Các khối cấu hình dùng lại đúng những control (cùng id) đã chuyển từ các tab
 * khác sang section data-view="settings" trong dashboard.html, nên loader cũ
 * (loadAIConfig/loadCrawlSettings/loadAutoCrawl/loadAutoSync) vẫn hoạt động.
 * loadSettings() chỉ điều phối nạp lại trạng thái cho các control này.
 *
 * Phần "Quản lý dữ liệu" tái sử dụng các hành động xóa/xuất đã có ở từng tab
 * (clearAllProducts, clearMyStore, clearGroupPosts, exportPosts) để không nhân
 * đôi logic và không phụ thuộc tham số backend chưa hỗ trợ.
 */
import { bg, toast, modal, esc } from "../core.js";
import { loadCrawlSettings } from "../prefs.js";
import { loadAutoCrawl } from "./groups.js";
import { loadAutoSync, clearAllProducts } from "./products.js";
import { clearMyStore } from "./mystore.js";
import { loadAIConfig } from "./ai.js";
import { exportPosts, loadPosts } from "./posts.js";
import { reloadAdvisories } from "./advisory.js";

// Nạp lại trạng thái cho mọi khối cấu hình khi mở tab Cài đặt.
export async function loadSettings() {
  loadAIConfig();
  await loadCrawlSettings();
  await loadAutoCrawl();
  await loadAutoSync();
  await loadCrawlBlockBanner();
}

// Hiển thị banner khi auto-crawl đang bị "ngắt mạch" (circuit-breaker) do FB
// chặn (429/checkpoint...). Trong thời gian này auto-crawl tạm ngưng để bảo vệ
// tài khoản; banner cho biết còn bao lâu và lý do.
export async function loadCrawlBlockBanner() {
  const el = document.getElementById("crawlBlockBanner");
  if (!el) return;
  let state = null;
  try {
    const res = await bg("GET_CRAWL_BLOCK_STATE", {});
    state = res && res.ok ? res.state : null;
  } catch (e) {
    state = null;
  }
  if (!state || !state.blocked) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const mins = Math.max(1, Math.ceil((state.blockedUntil - Date.now()) / 60000));
  const until = new Date(state.blockedUntil).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const reason = state.reason ? String(state.reason) : "FB tạm chặn crawl.";
  el.innerHTML =
    `<span>⏸️</span><span class="switch-text">` +
    `<strong>Auto-crawl đang tạm ngưng ~${mins} phút (đến ${until})</strong>` +
    `<small>Lý do: ${esc(reason)}. Đây là cơ chế bảo vệ tài khoản: khi FB chặn, ` +
    `tiện ích tự nghỉ và giãn dần thời gian trước khi thử lại. Bạn có thể crawl thủ công lại sau khi hết thời gian nghỉ.</small>` +
    `</span>`;
  el.hidden = false;
}

// ---- Quản lý dữ liệu --------------------------------------------------

// Xuất bài viết: dùng lại exportPosts (xuất theo bộ lọc nhóm đang lưu, mặc định
// là tất cả nếu chưa lọc nhóm nào ở tab Bài viết).
export function exportAllPosts(kind) {
  exportPosts(kind);
}

// Xóa TẤT CẢ bài viết của mọi nhóm.
export function clearAllPosts() {
  modal({
    title: "Xóa toàn bộ bài viết",
    bodyHTML: `<p>Xóa <b>toàn bộ</b> bài viết đã crawl của <b>tất cả các nhóm</b>? Hành động này không thể hoàn tác.</p>`,
    confirmText: "Xóa hết",
    danger: true,
    onConfirm: async () => {
      const res = await bg("CLEAR_POSTS", {});
      if (!res || !res.ok) {
        toast("Xóa thất bại.", "err");
        return false;
      }
      toast(`Đã xóa ${res.deleted} bài.`, "ok");
      if (document.querySelector('.view[data-view="posts"].active')) loadPosts();
    },
  });
}

// Xóa TẤT CẢ nháp tư vấn ở mọi trạng thái (chờ duyệt/đã gửi/đã bỏ).
export function clearAllAdvisories() {
  modal({
    title: "Xóa toàn bộ nháp tư vấn",
    bodyHTML: `<p>Xóa <b>toàn bộ</b> nháp tư vấn ở mọi trạng thái (chờ duyệt, đã gửi, đã bỏ)? Không thể hoàn tác.</p>`,
    confirmText: "Xóa hết",
    danger: true,
    onConfirm: async () => {
      const res = await bg("CLEAR_ADVISORIES", { status: "" });
      toast(`Đã xóa ${res && res.deleted != null ? res.deleted : ""} nháp.`, "ok");
      if (document.querySelector('.view[data-view="advisory"].active')) reloadAdvisories();
    },
  });
}

// Xóa toàn bộ sản phẩm/giá: dùng lại hành động đã có ở tab Sản phẩm.
export function clearAllPrices() {
  clearAllProducts();
}

// Xóa "Kho của tôi": dùng lại hành động đã có ở tab Kho của tôi.
export function clearMyStoreData() {
  clearMyStore();
}
