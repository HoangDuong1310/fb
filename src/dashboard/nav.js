/**
 * nav.js — Điều hướng giữa các view (sidebar) + tiêu đề/mô tả từng trang.
 *
 * switchView() là "bộ định tuyến" của dashboard: bật/tắt class .active cho
 * nav-item + section, cập nhật tiêu đề, rồi gọi đúng hàm nạp dữ liệu của view
 * tương ứng. Vì vậy module này import các hàm loader từ tất cả view module.
 */
import { $ } from "./core.js";
import { renderOverview } from "./views/overview.js";
import { renderGroups } from "./views/groups.js";
import { loadPosts } from "./views/posts.js";
import { loadJobs } from "./views/jobs.js";
import { loadSources, loadAutoSync, loadProducts } from "./views/products.js";
import { loadMyStore } from "./views/mystore.js";
import { loadBuildView } from "./views/build.js";
import { loadAdvisoryView } from "./views/advisory.js";
import { loadConversationsView } from "./views/conversations.js";
import { loadAIConfig } from "./views/ai.js";
import { loadSettings } from "./views/settings.js";

export const VIEW_META = {
  overview: ["Tổng quan", "Theo dõi hiệu quả khai thác nhóm của bạn."],
  groups: ["Nhóm", "Quản lý các nhóm đã tham gia và crawl theo từng nhóm."],
  posts: ["Bài viết", "Kho bài viết đã crawl, lọc và xuất dữ liệu."],
  autopost: ["Đăng bài", "Lên lịch đăng bài tự động vào nhóm."],
  autocomment: ["Bình luận", "Lên lịch bình luận tự động vào bài viết."],
  sources: ["Nguồn dữ liệu", "Quản lý các nguồn dữ liệu giá được cấu hình sẵn trong tiện ích."],
  products: ["Sản phẩm/Giá", "So sánh giá cùng một sản phẩm giữa các cửa hàng để AI tư vấn bán hàng."],
  mystore: ["Kho của tôi", "Nhập sản phẩm cửa hàng từ Google Sheet và so giá với các bên khác."],
  build: ["Build AI", "Nhập ngân sách + nhu cầu, AI dựng cấu hình tốt nhất từ kho của bạn."],
  advisory: ["Tư vấn AI", "Tạo nháp chào giá/hỗ trợ khách từ bài đã crawl. Bạn duyệt thì mới gửi."],
  conversations: ["Hội thoại", "Theo dõi phản hồi dưới bình luận của bạn, AI soạn nháp trả lời. Bạn duyệt thì mới đăng."],
  settings: ["Cài đặt", "Quản lý cấu hình crawl, tự động, AI và dữ liệu của tiện ích."],
};

export function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("active", s.dataset.view === view));
  const meta = VIEW_META[view] || ["", ""];
  $("viewTitle").textContent = meta[0];
  $("viewSub").textContent = meta[1];
  if (view === "overview") renderOverview();
  if (view === "groups") renderGroups();
  if (view === "posts") loadPosts();
  if (view === "autopost") loadJobs("post");
  if (view === "autocomment") loadJobs("comment");
  if (view === "sources") {
    loadSources();
    loadAutoSync();
  }
  if (view === "products") loadProducts();
  if (view === "mystore") loadMyStore();
  if (view === "build") loadBuildView();
  if (view === "advisory") loadAdvisoryView();
  if (view === "conversations") loadConversationsView();
  if (view === "settings") loadSettings();
}
