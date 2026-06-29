/**
 * config.js — Cấu hình triển khai (deploy-time) cho phía EXTENSION.
 *
 * ====================================================================
 *  ĐÂY LÀ NƠI DUY NHẤT cần sửa khi đổi domain / IP của backend.
 * ====================================================================
 *
 * Vì sao là file này (Cách 2 — cấu hình lúc đóng gói), KHÔNG phải UI:
 *  - Màn ĐĂNG NHẬP nằm trong popup và phải gọi backend NGAY để lấy token.
 *  - Nếu để ô nhập URL trong giao diện sau đăng nhập thì sẽ kẹt vòng lặp
 *    "gà và trứng": chưa có URL đúng -> không đăng nhập được -> không vào
 *    được UI để sửa URL. Nên URL phải được "nướng" sẵn trước khi đóng gói.
 *
 * Cách dùng khi deploy:
 *  1) Sửa BACKEND_BASE_URL bên dưới thành domain/IP thật của server.
 *     - Có thể dùng http hoặc https, kèm cổng nếu cần.
 *     - KHÔNG để dấu "/" thừa ở cuối (code sẽ tự cắt cho an toàn).
 *  2) MỞ manifest.json và thêm domain đó vào "host_permissions"
 *     (Chrome chặn fetch tới host không khai báo). Ví dụ:
 *        "https://api.tenmiencuaban.com/*"
 *     Nếu vẫn chạy localhost thì giữ nguyên "http://localhost:3300/*".
 *  3) Nạp/đóng gói lại extension.
 *
 * Lưu ý: file này KHÔNG chứa bí mật (chỉ là URL công khai), an toàn để commit.
 */

// >>> SỬA DÒNG NÀY KHI DEPLOY <<<
// Ví dụ production: "https://api.tenmiencuaban.com"
//        hoặc IP:   "http://203.0.113.10:3300"
const BACKEND_BASE_URL = "http://localhost:3300";

/**
 * Base URL backend đã chuẩn hoá (bỏ "/" thừa ở cuối).
 * api.js import hằng này làm giá trị khởi tạo cho client HTTP.
 */
export const API_BASE_URL = String(BACKEND_BASE_URL || "").replace(/\/+$/, "");
