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
import { bg, toast, modal } from "../core.js";
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
