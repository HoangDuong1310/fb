/**
 * app.js — Bảng dữ liệu web CHỈ ĐỌC cho FB Group Crawler.
 *
 * Luồng: đăng nhập (POST /api/auth/login) -> lưu token + email vào localStorage
 * -> nạp dữ liệu từ 3 endpoint (/api/stats, /api/group-prices, /api/posts) bằng
 * header Authorization: Bearer <token>. Không có thao tác ghi nào ngoài đăng nhập.
 *
 * AN TOÀN (XSS): dữ liệu hiển thị đến từ AI/crawl của NHIỀU người dùng nên KHÔNG
 * tin cậy. Mọi giá trị được chèn qua document.createElement + textContent (không
 * dùng innerHTML nối chuỗi). URL trong href chỉ chấp nhận http/https
 * (safeHttpUrl), nếu không hợp lệ thì render dạng text thường.
 */

// Khoá localStorage dùng chung cho token và email đã đăng nhập.
const TOKEN_KEY = "fb_crawler_token";
const EMAIL_KEY = "fb_crawler_email";

// Định dạng tiền VND theo locale Việt Nam (dấu phân cách hàng nghìn).
const vnd = new Intl.NumberFormat("vi-VN");

/* ============================ TIỆN ÍCH ============================== */

// Lấy phần tử theo id cho gọn.
function $(id) {
  return document.getElementById(id);
}

// Chỉ cho phép http/https khi dựng <a href> từ dữ liệu AI/crawl (ít tin cậy):
// chặn javascript:/data: và các scheme nguy hiểm. Trả "" nếu không hợp lệ.
function safeHttpUrl(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

// Định dạng giá VND (số nguyên BIGINT). Trả "" nếu không phải số hợp lệ.
function fmtPrice(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return `${vnd.format(n)} ₫`;
}

// Cắt ngắn nội dung dài (~140 ký tự) để bảng gọn gàng.
function truncate(text, max = 140) {
  const s = String(text == null ? "" : text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Tạo <td> chứa text thuần (an toàn XSS qua textContent).
function textCell(value) {
  const td = document.createElement("td");
  td.textContent = value == null ? "" : String(value);
  return td;
}

// Tạo <td> chứa link http/https an toàn; nếu URL không hợp lệ thì render text.
// label tuỳ chọn (mặc định dùng chính URL làm nhãn).
function linkCell(rawUrl, label) {
  const td = document.createElement("td");
  const url = safeHttpUrl(rawUrl);
  const text = label == null || label === "" ? url : String(label);
  if (url) {
    const a = document.createElement("a");
    a.href = url;
    a.textContent = text || url;
    a.target = "_blank";
    // noreferrer cũng loại bỏ header Referer khi mở link ngoài lấy từ dữ liệu crawl.
    a.rel = "noopener noreferrer";
    td.appendChild(a);
  } else {
    // URL không hợp lệ -> hiển thị nhãn (hoặc rỗng) dưới dạng text thuần.
    td.textContent = label == null ? "" : String(label);
  }
  return td;
}

// Dựng một <table> từ danh sách tiêu đề + danh sách hàng (mỗi hàng là mảng <td>).
function buildTable(headers, rowCells) {
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.scope = "col"; // hỗ trợ trình đọc màn hình điều hướng bảng theo cột.
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const cells of rowCells) {
    const tr = document.createElement("tr");
    for (const td of cells) tr.appendChild(td);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

// Thay thế nội dung một container bằng node mới (xoá sạch trước khi gắn).
function setContent(id, node) {
  const el = $(id);
  el.replaceChildren();
  if (node) el.appendChild(node);
}

/* ============================ XÁC THỰC ============================== */

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

// Hiển thị bảng dữ liệu, ẩn form đăng nhập, gắn email đang đăng nhập.
function showDashboard(email) {
  $("login-card").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
  $("userbox").classList.remove("hidden");
  $("user-email").textContent = email || "";
}

// Quay về form đăng nhập, ẩn dashboard, xoá các bảng đã render.
function showLogin() {
  $("dashboard").classList.add("hidden");
  $("userbox").classList.add("hidden");
  $("login-card").classList.remove("hidden");
  $("user-email").textContent = "";
  setContent("stats-table", null);
  setContent("prices-table", null);
  setContent("posts-table", null);
  $("stats-total").textContent = "";
  $("stats-status").textContent = "";
  $("prices-status").textContent = "";
  $("posts-status").textContent = "";
}

// Đăng xuất: xoá token + email, hiện form đăng nhập, dọn bảng.
function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
  showLogin();
}

/* ============================ GỌI API ============================== */

// Lỗi dùng nội bộ để báo phiên hết hạn (401) -> kích hoạt đăng xuất.
class UnauthorizedError extends Error {}

// fetchJson(path): luôn gửi Bearer token + Accept JSON, parse JSON. Gặp 401 thì
// ném UnauthorizedError để caller xử lý đăng xuất về form đăng nhập.
async function fetchJson(path) {
  const token = getToken();
  const res = await fetch(path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (res.status === 401) {
    throw new UnauthorizedError("unauthorized");
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
}

/* ============================ RENDER BẢNG ============================== */

function renderStats(data) {
  const total = data && typeof data.total === "number" ? data.total : 0;
  $("stats-total").textContent = `Tổng số bài: ${vnd.format(total)}`;
  const groups = Array.isArray(data && data.groups) ? data.groups : [];
  if (groups.length === 0) {
    $("stats-status").textContent = "Chưa có nhóm nào.";
    setContent("stats-table", null);
    return;
  }
  $("stats-status").textContent = "";
  const rows = groups.map((g) => [
    textCell(g.groupName || g.groupId || ""),
    textCell(vnd.format(Number(g.count) || 0)),
  ]);
  setContent("stats-table", buildTable(["Nhóm", "Số bài"], rows));
}

function renderGroupPrices(data) {
  const list = Array.isArray(data && data.groupPrices) ? data.groupPrices : [];
  if (list.length === 0) {
    $("prices-status").textContent = "Chưa có dữ liệu giá.";
    setContent("prices-table", null);
    return;
  }
  $("prices-status").textContent = "";
  const headers = [
    "Tên",
    "Giá",
    "Tình trạng",
    "Người bán",
    "Nhóm",
    "Độ tin cậy",
  ];
  const rows = list.map((r) => [
    textCell(r.name || ""),
    textCell(fmtPrice(r.price)),
    textCell(r.condition || ""),
    // Người bán: chỉ link nếu sellerProfile là http/https hợp lệ; nhãn = tên.
    linkCell(r.sellerProfile, r.sellerName || ""),
    textCell(r.groupName || r.groupId || ""),
    textCell(r.confidence == null ? "" : r.confidence),
  ]);
  setContent("prices-table", buildTable(headers, rows));
}

function renderPosts(data) {
  const list = Array.isArray(data && data.posts) ? data.posts : [];
  if (list.length === 0) {
    $("posts-status").textContent = "Chưa có bài viết.";
    setContent("posts-table", null);
    return;
  }
  $("posts-status").textContent = "";
  const headers = ["Nhóm", "Tác giả", "Nội dung", "Thời gian", "Link"];
  const rows = list.map((p) => [
    textCell(p.groupName || ""),
    textCell(p.authorName || ""),
    textCell(truncate(p.text)),
    textCell(p.timestamp || p.crawledAt || ""),
    linkCell(p.permalink, "Mở"),
  ]);
  setContent("posts-table", buildTable(headers, rows));
}

/* ============================ ĐIỀU PHỐI ============================== */

// Nạp cả ba tập dữ liệu. Nếu bất kỳ lệnh nào trả 401 -> đăng xuất về form login.
async function loadAll() {
  try {
    const [stats, prices, posts] = await Promise.all([
      fetchJson("/api/stats"),
      fetchJson("/api/group-prices"),
      fetchJson("/api/posts"),
    ]);
    renderStats(stats);
    renderGroupPrices(prices);
    renderPosts(posts);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      logout();
      $("login-status").textContent = "Phiên đã hết hạn, vui lòng đăng nhập lại.";
      $("login-status").className = "status error";
      return;
    }
    // Lỗi khác (mạng/máy chủ): báo nhẹ ở từng vùng để người dùng biết.
    const msg = "Không tải được dữ liệu. Thử lại sau.";
    $("stats-status").textContent = msg;
    $("prices-status").textContent = msg;
    $("posts-status").textContent = msg;
  }
}

// Xử lý đăng nhập: POST /api/auth/login với email/mật khẩu dạng JSON.
async function handleLogin(event) {
  event.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const status = $("login-status");
  status.textContent = "Đang đăng nhập…";
  status.className = "status info";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    if (res.status === 401) {
      status.textContent = "Sai email hoặc mật khẩu";
      status.className = "status error";
      return;
    }
    if (!res.ok) {
      status.textContent = "Đăng nhập thất bại. Thử lại sau.";
      status.className = "status error";
      return;
    }
    // Tách riêng việc parse JSON: nếu thân phản hồi 2xx không phải JSON hợp lệ,
    // báo "đăng nhập thất bại" thay vì rơi xuống catch và báo nhầm lỗi kết nối.
    let data;
    try {
      data = await res.json();
    } catch {
      status.textContent = "Đăng nhập thất bại. Thử lại sau.";
      status.className = "status error";
      return;
    }
    // Hợp đồng đảm bảo có token khi 200; chặn lưu "undefined" thành chuỗi
    // (sẽ thành "Bearer undefined" cho tới lần 401 đầu tiên).
    if (!data.token) {
      status.textContent = "Đăng nhập thất bại. Thử lại sau.";
      status.className = "status error";
      return;
    }
    const userEmail = (data.user && data.user.email) || email;
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(EMAIL_KEY, userEmail);
    status.textContent = "";
    status.className = "status";
    $("password").value = "";
    showDashboard(userEmail);
    await loadAll();
  } catch {
    status.textContent = "Không kết nối được máy chủ.";
    status.className = "status error";
  }
}

/* ============================ KHỞI ĐỘNG ============================== */

function init() {
  $("login-form").addEventListener("submit", handleLogin);
  $("logout-btn").addEventListener("click", logout);

  // Nếu đã có token lưu sẵn -> hiện dashboard và nạp dữ liệu ngay (loadAll tự
  // xử lý 401 để quay lại form đăng nhập nếu token đã hết hạn).
  const token = getToken();
  if (token) {
    showDashboard(localStorage.getItem(EMAIL_KEY) || "");
    loadAll();
  } else {
    showLogin();
  }
}

init();
