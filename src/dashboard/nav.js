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
import { loadMyActivityView } from "./views/my-activity.js";
import { loadSources, loadAutoSync, loadProducts } from "./views/products.js";
import { loadMyStore } from "./views/mystore.js";
import { loadAdvisoryView } from "./views/advisory.js";
import { loadConversationsView } from "./views/conversations.js";
import { loadAIConfig } from "./views/ai.js";
import { loadSettings } from "./views/settings.js";
import { loadGroupPricesView } from "./views/groupprices.js";
import { loadKeywordsView } from "./views/keywords.js";
import { loadProfilesView } from "./views/profiles.js";
import { loadRemoteCommandsView } from "./views/remote-commands.js";

export const VIEW_META = {
  overview: ["Tổng quan", "Theo dõi hiệu quả khai thác nhóm của bạn."],
  groups: ["Nhóm", "Quản lý các nhóm đã tham gia và crawl theo từng nhóm."],
  posts: ["Bài viết", "Kho bài viết đã crawl, lọc và xuất dữ liệu."],
  myactivity: ["Hoạt động của tôi", "Quản lý bài đã đăng và bình luận đã đăng của bạn."],
  autopost: ["Đăng bài", "Lên lịch đăng bài tự động vào nhóm."],
  autocomment: ["Bình luận", "Lên lịch bình luận tự động vào bài viết."],
  sources: ["Nguồn dữ liệu", "Quản lý các nguồn dữ liệu giá được cấu hình sẵn trong tiện ích."],
  products: ["Sản phẩm/Giá", "So sánh giá cùng một sản phẩm giữa các cửa hàng để AI tư vấn bán hàng."],
  mystore: ["Kho của tôi", "Nhập sản phẩm cửa hàng từ Google Sheet và so giá với các bên khác."],
  advisory: ["Tư vấn AI", "Tạo nháp chào giá/hỗ trợ khách từ bài đã crawl. Bạn duyệt thì mới gửi."],
  conversations: ["Hội thoại", "Theo dõi phản hồi dưới bình luận của bạn, AI soạn nháp trả lời. Bạn duyệt thì mới đăng."],
  groupprices: ["Giá Group", "Mặt bằng giá trích từ bài rao bán trong nhóm, gom theo sản phẩm thấp→cao."],
  keywords: ["Từ khóa học", "Quản lý từ khóa AI đã học để lọc bài rao bán khi trích giá group."],
  profiles: ["Hồ sơ ngành", "Tùy biến giọng AI theo ngành hàng của bạn (bán điện thoại, bất động sản, thuê phòng...). Lưu riêng theo tài khoản của bạn."],
  settings: ["Cài đặt", "Quản lý cấu hình crawl, tự động, AI và dữ liệu của tiện ích."],
  remoteCommands: ["Lệnh từ Web", "Xem và theo dõi các lệnh điều khiển từ web server."],
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
  if (view === "myactivity") loadMyActivityView();
  if (view === "autopost") loadJobs("post");
  if (view === "autocomment") loadJobs("comment");
  if (view === "sources") {
    loadSources();
    loadAutoSync();
  }
  if (view === "products") loadProducts();
  if (view === "mystore") loadMyStore();
  if (view === "advisory") loadAdvisoryView();
  if (view === "conversations") loadConversationsView();
  if (view === "groupprices") loadGroupPricesView();
  if (view === "keywords") loadKeywordsView();
  if (view === "profiles") loadProfilesView();
  if (view === "settings") loadSettings();
  if (view === "remoteCommands") loadRemoteCommandsView();
}
