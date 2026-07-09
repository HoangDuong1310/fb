/**
 * nav.js — Điều hướng 2 cấp: WORKSPACE (sidebar) → VIEW (sub-tab trên topbar).
 *
 * Trước đây sidebar liệt kê thẳng 16 view rời rạc gây rối. Nay gom thành 6
 * "workspace" theo nghiệp vụ; mỗi workspace có 1..n view con hiển thị dưới dạng
 * thanh sub-tab. TOÀN BỘ <section class="view" data-view="..."> và ID bên trong
 * GIỮ NGUYÊN — chỉ thay lớp điều hướng bao ngoài, nên các view module không đổi.
 *
 * switchView(view) vẫn là "bộ định tuyến" gọi đúng hàm nạp dữ liệu của view; nó
 * còn tự bật đúng workspace + sub-tab tương ứng để có thể gọi trực tiếp từ nơi khác.
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
import { loadPitchView } from "./views/pitch.js";
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
  autopost: ["Đăng bài", "AI tự viết nội dung theo yêu cầu rồi lên lịch đăng vào nhóm."],
  autocomment: ["Bình luận", "Lên lịch bình luận tự động vào bài viết."],
  sources: ["Nguồn dữ liệu", "Quản lý các nguồn dữ liệu giá được cấu hình sẵn trong tiện ích."],
  products: ["So giá sản phẩm", "So sánh giá cùng một sản phẩm giữa các cửa hàng để AI tư vấn bán hàng."],
  mystore: ["Kho của tôi", "Nhập sản phẩm cửa hàng từ Google Sheet và so giá với các bên khác."],
  advisory: ["Tư vấn từ bài", "Tạo nháp chào giá/hỗ trợ khách từ bài đã crawl. Bạn duyệt thì mới gửi."],
  conversations: ["Hội thoại", "Theo dõi phản hồi dưới bình luận của bạn, AI soạn nháp trả lời. Bạn duyệt thì mới đăng."],
  pitch: ["Chào hàng inbox", "Gửi tin nhắn chào hàng qua inbox (Messenger). AI soạn nháp, bạn duyệt từng tin."],
  groupprices: ["Giá Group", "Mặt bằng giá trích từ bài rao bán trong nhóm, gom theo sản phẩm thấp→cao."],
  keywords: ["Từ khóa học", "Quản lý từ khóa AI đã học để lọc bài rao bán khi trích giá group."],
  profiles: ["Hồ sơ ngành", "Tùy biến giọng AI theo ngành hàng của bạn. Lưu riêng theo tài khoản của bạn."],
  settings: ["Cài đặt", "Quản lý cấu hình crawl, tự động, AI và dữ liệu của tiện ích."],
  remoteCommands: ["Lệnh từ Web", "Xem và theo dõi các lệnh điều khiển từ web server."],
};

/**
 * 6 workspace gom theo nghiệp vụ. `views` là thứ tự sub-tab; `views[0]` là view
 * mặc định khi mở workspace. `icon` là path SVG (dùng lại từ bộ icon sidebar cũ).
 */
export const WORKSPACES = {
  overview: {
    label: "Tổng quan",
    icon: "M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z",
    views: ["overview"],
  },
  data: {
    label: "Nhóm & Bài viết",
    icon: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
    views: ["groups", "posts", "myactivity"],
  },
  sales: {
    label: "Chào hàng",
    icon: "M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zM7 9h10v2H7V9zm0 4h7v2H7v-2z",
    views: ["advisory", "conversations", "pitch"],
  },
  publish: {
    label: "Đăng bài",
    icon: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
    views: ["autopost", "autocomment"],
  },
  market: {
    label: "Giá & Kho",
    icon: "M3 3h2v18H3V3zm4 10h2v8H7v-8zm4-6h2v14h-2V7zm4 3h2v11h-2V10zm4-5h2v16h-2V5z",
    views: ["groupprices", "products", "mystore", "sources"],
  },
  profile: {
    label: "Hồ sơ ngành",
    icon: "M20 6h-4V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-6 0h-4V4h4v2z",
    views: ["profiles"],
  },
  config: {
    label: "Cấu hình",
    icon: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
    views: ["settings", "keywords", "remoteCommands"],
  },
};

/** Nhãn ngắn cho sub-tab (khác với tiêu đề dài trong VIEW_META). */
export const SUBTAB_LABEL = {
  groups: "Nhóm",
  posts: "Bài viết",
  myactivity: "Hoạt động của tôi",
  advisory: "Tư vấn từ bài",
  conversations: "Hội thoại",
  pitch: "Inbox",
  autopost: "Đăng bài (AI)",
  autocomment: "Bình luận",
  groupprices: "Giá Group",
  products: "So giá",
  mystore: "Kho của tôi",
  sources: "Nguồn",
  settings: "Crawl & Đồng bộ",
  profiles: "AI & Hồ sơ",
  keywords: "Từ khóa",
  remoteCommands: "Lệnh Web",
};

/** Bảng tra ngược view → workspace (dựng 1 lần). */
const VIEW_TO_WS = {};
for (const [ws, cfg] of Object.entries(WORKSPACES)) {
  for (const v of cfg.views) VIEW_TO_WS[v] = ws;
}

let CURRENT_VIEW = "overview";

/** View đang mở — dùng cho nút "Làm mới" và các nơi cần biết ngữ cảnh. */
export function getCurrentView() {
  return CURRENT_VIEW;
}

/** Vẽ thanh sub-tab cho 1 workspace. Workspace 1 view thì ẩn thanh. */
function renderSubnav(ws) {
  const bar = $("subnav");
  if (!bar) return;
  const views = (WORKSPACES[ws] && WORKSPACES[ws].views) || [];
  if (views.length <= 1) {
    bar.innerHTML = "";
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.innerHTML = views
    .map((v) => {
      const label = SUBTAB_LABEL[v] || (VIEW_META[v] ? VIEW_META[v][0] : v);
      return `<button class="subnav-item" data-view="${v}">${label}</button>`;
    })
    .join("");
}

/** Mở 1 workspace: bật nav-item, vẽ sub-tab, nhảy vào view đầu tiên. */
export function switchWorkspace(ws) {
  const cfg = WORKSPACES[ws];
  if (!cfg) return;
  renderSubnav(ws);
  switchView(cfg.views[0]);
}

/**
 * Bộ định tuyến chính: bật section .view, cập nhật tiêu đề, gọi loader; đồng thời
 * tự đồng bộ workspace (sidebar) + sub-tab (topbar) tương ứng với view.
 */
export function switchView(view) {
  const ws = VIEW_TO_WS[view] || "overview";
  CURRENT_VIEW = view;

  document
    .querySelectorAll(".nav-item")
    .forEach((b) => b.classList.toggle("active", b.dataset.workspace === ws));

  const bar = $("subnav");
  if (bar && !bar.querySelector(`[data-view="${view}"]`)) renderSubnav(ws);
  document
    .querySelectorAll(".subnav-item")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));

  document
    .querySelectorAll(".view")
    .forEach((s) => s.classList.toggle("active", s.dataset.view === view));

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
  if (view === "pitch") loadPitchView();
  if (view === "groupprices") loadGroupPricesView();
  if (view === "keywords") loadKeywordsView();
  if (view === "profiles") loadProfilesView();
  if (view === "settings") loadSettings();
  if (view === "remoteCommands") loadRemoteCommandsView();
}

/** Gắn sự kiện điều hướng: click workspace (sidebar) + click sub-tab (topbar). */
export function initNav() {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => switchWorkspace(b.dataset.workspace))
  );
  const bar = $("subnav");
  if (bar) {
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest(".subnav-item");
      if (btn) switchView(btn.dataset.view);
    });
  }
}
