/**
 * popup.js — Launcher tối giản cho popup của extension.
 *
 * Toàn bộ chức năng (đăng nhập, crawl, bài viết, đăng & bình luận, cấu hình AI,
 * xuất dữ liệu…) đã chuyển hẳn sang dashboard React. Popup giờ chỉ còn một việc:
 * mở (hoặc focus) bảng quản lý. Việc mở tab do background xử lý qua thông điệp
 * OPEN_DASHBOARD (gọi openDashboard() trong util.js) để tái sử dụng logic
 * "focus tab đang mở nếu có, nếu không thì tạo tab mới".
 */

const btn = document.getElementById("btnDashboard");

function openDashboard() {
  try {
    chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" }, () => {
      // Nuốt lastError (service worker có thể vừa ngủ dậy) rồi đóng popup.
      void chrome.runtime.lastError;
      window.close();
    });
  } catch (e) {
    // Fallback: nếu messaging lỗi, tự mở tab từ chính popup.
    const url = chrome.runtime.getURL("dist/ui/index.html");
    chrome.tabs.create({ url }, () => window.close());
  }
}

if (btn) {
  btn.addEventListener("click", openDashboard);
}
