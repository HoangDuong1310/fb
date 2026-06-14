/**
 * popup.js — Điều khiển giao diện popup.
 *
 * - Đăng nhập / đăng xuất qua background (AUTH_STATE / AUTH_LOGIN / AUTH_LOGOUT).
 * - Gửi START_CRAWL / STOP_CRAWL tới background (background chuyển tiếp cho content).
 * - Lắng nghe CRAWL_PROGRESS / CRAWL_DONE để cập nhật trạng thái realtime.
 * - GET_STATS để hiển thị số bài đã lưu theo nhóm.
 * - Xuất JSON / CSV và xoá dữ liệu.
 */

const $ = (id) => document.getElementById(id);

const els = {
  maxNewPosts: $("maxNewPosts"),
  stopAfterKnown: $("stopAfterKnown"),
  scrollDelay: $("scrollDelay"),
  btnStart: $("btnStart"),
  btnStop: $("btnStop"),
  status: $("status"),
  totalCount: $("totalCount"),
  groupList: $("groupList"),
  btnExportJson: $("btnExportJson"),
  btnExportCsv: $("btnExportCsv"),
  btnRefresh: $("btnRefresh"),
  btnClear: $("btnClear"),
  aiApiBase: $("aiApiBase"),
  aiApiKey: $("aiApiKey"),
  aiModel: $("aiModel"),
  btnSaveAI: $("btnSaveAI"),
  btnDiscover: $("btnDiscover"),
  btnViewSelectors: $("btnViewSelectors"),
  btnClearSelectors: $("btnClearSelectors"),
  selectorBox: $("selectorBox"),
  btnDashboard: $("btnDashboard"),
  // ---- Đăng nhập / trạng thái auth ----
  loginSection: $("loginSection"),
  loginEmail: $("loginEmail"),
  loginPassword: $("loginPassword"),
  btnLogin: $("btnLogin"),
  loginError: $("loginError"),
  authBar: $("authBar"),
  authName: $("authName"),
  btnLogout: $("btnLogout"),
  appSection: $("appSection"),
};

// ---- Helper gửi message tới background -----------------------------------

function bg(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (res) => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
}

function setRunning(running) {
  els.btnStart.disabled = running;
  els.btnStop.disabled = !running;
  els.maxNewPosts.disabled = running;
  els.stopAfterKnown.disabled = running;
  els.scrollDelay.disabled = running;
}

// ---- Đăng nhập / trạng thái auth -----------------------------------------

// Hiện/ẩn dòng lỗi đăng nhập.
function setLoginError(text) {
  if (!text) {
    els.loginError.textContent = "";
    els.loginError.hidden = true;
    return;
  }
  els.loginError.textContent = text;
  els.loginError.hidden = false;
}

// Hiện giao diện đã đăng nhập: ẩn form login, hiện appSection + thanh authBar.
function showLoggedIn(displayName) {
  els.authName.textContent = displayName || "";
  els.authBar.hidden = false;
  els.loginSection.hidden = true;
  els.appSection.hidden = false;
  setLoginError("");
}

// Hiện form đăng nhập: ẩn appSection + authBar. note = thông báo tuỳ chọn.
function showLoggedOut(note) {
  els.authBar.hidden = true;
  els.appSection.hidden = true;
  els.loginSection.hidden = false;
  els.authName.textContent = "";
  setLoginError(note || "");
}

// Hỏi background trạng thái đăng nhập rồi định tuyến giao diện.
async function refreshAuth() {
  const res = await bg("AUTH_STATE");
  if (res && res.ok && res.loggedIn) {
    showLoggedIn(res.display_name);
    // Đã đăng nhập: tải dữ liệu phụ thuộc API.
    loadStats();
    viewSelectors();
  } else {
    showLoggedOut();
  }
}

// Xử lý đăng nhập: kiểm tra rỗng, gửi AUTH_LOGIN, định tuyến theo kết quả.
async function doLogin() {
  const email = els.loginEmail.value.trim();
  const password = els.loginPassword.value.trim();
  if (!email || !password) {
    setLoginError("Nhập email và mật khẩu");
    return;
  }
  els.btnLogin.disabled = true;
  try {
    const res = await bg("AUTH_LOGIN", { email, password });
    if (res && res.ok) {
      els.loginPassword.value = "";
      showLoggedIn(res.user && res.user.display_name);
      loadStats();
      viewSelectors();
    } else {
      setLoginError((res && res.error) || "Đăng nhập thất bại.");
    }
  } finally {
    els.btnLogin.disabled = false;
  }
}

// Xử lý đăng xuất: gửi AUTH_LOGOUT rồi quay về form đăng nhập.
async function doLogout() {
  await bg("AUTH_LOGOUT");
  showLoggedOut();
}

// ---- Tải & hiển thị thống kê ---------------------------------------------

async function loadStats() {
  const res = await bg("GET_STATS");
  if (!res || !res.ok) {
    setStatus("Không đọc được dữ liệu đã lưu.", "err");
    return;
  }
  const { total, groups } = res.stats;
  els.totalCount.textContent = String(total);
  els.groupList.innerHTML = "";
  if (!groups.length) {
    els.groupList.innerHTML = '<div class="muted">Chưa có dữ liệu.</div>';
    return;
  }
  groups
    .sort((a, b) => b.count - a.count)
    .forEach((g) => {
      const div = document.createElement("div");
      div.className = "group-item";
      const name = document.createElement("span");
      name.textContent = g.groupName || g.groupId;
      name.title = g.groupId;
      const cnt = document.createElement("b");
      cnt.textContent = String(g.count);
      div.appendChild(name);
      div.appendChild(cnt);
      els.groupList.appendChild(div);
    });
}

// ---- Bắt đầu / dừng crawl -------------------------------------------------

async function startCrawl() {
  const options = {
    maxNewPosts: clampInt(els.maxNewPosts.value, 1, 2000, 100),
    stopAfterKnown: clampInt(els.stopAfterKnown.value, 1, 100, 8),
    scrollDelay: clampInt(els.scrollDelay.value, 400, 8000, 1500),
  };
  setRunning(true);
  setStatus("Đang khởi động crawl trên tab hiện tại...");
  const res = await bg("START_CRAWL", { options });
  if (!res || !res.ok) {
    setRunning(false);
    setStatus((res && res.error) || "Không bắt đầu được crawl.", "err");
    return;
  }
  setStatus("Đang crawl... cuộn feed và bóc tách bài mới.");
}

async function stopCrawl() {
  setStatus("Đang gửi yêu cầu dừng...");
  await bg("STOP_CRAWL");
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ---- Lắng nghe tiến độ từ content & broadcast auth -----------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "AUTH_REQUIRED") {
    showLoggedOut("Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.");
    return;
  }

  if (msg.type === "CRAWL_PROGRESS" && msg.progress) {
    const p = msg.progress;
    const lines = [
      `Nhóm: ${p.groupName || p.groupId}`,
      `Bài mới đã lấy: ${p.newCount}`,
      `Số lần cuộn: ${p.scrolls}`,
    ];
    if (p.lastAuthor) lines.push(`Mới nhất: ${p.lastAuthor}`);
    setStatus(lines.join("\n"));
  }

  if (msg.type === "CRAWL_DONE" && msg.result) {
    setRunning(false);
    setStatus(
      `Hoàn tất. Đã lấy ${msg.result.newCount} bài mới.\n${msg.result.reason || ""}`,
      "ok"
    );
    loadStats();
  }
});

// ---- Xuất dữ liệu ---------------------------------------------------------

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

async function exportJson() {
  const res = await bg("GET_ALL_POSTS");
  if (!res || !res.ok) return setStatus("Không lấy được dữ liệu để xuất.", "err");
  if (!res.posts.length) return setStatus("Chưa có dữ liệu để xuất.", "err");
  downloadFile(
    `fb_group_posts_${stamp()}.json`,
    JSON.stringify(res.posts, null, 2),
    "application/json"
  );
  setStatus(`Đã xuất ${res.posts.length} bài ra JSON.`, "ok");
}

const CSV_COLUMNS = [
  "postId",
  "groupId",
  "groupName",
  "authorName",
  "authorProfile",
  "timestamp",
  "timeText",
  "text",
  "images",
  "videos",
  "links",
  "reactions",
  "comments",
  "permalink",
  "crawledAt",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s;
  if (Array.isArray(value)) s = value.join(" | ");
  else s = String(value);
  // Escape: bọc trong dấu nháy kép và nhân đôi nháy kép bên trong.
  if (/[",\n\r]/.test(s)) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function exportCsv() {
  const res = await bg("GET_ALL_POSTS");
  if (!res || !res.ok) return setStatus("Không lấy được dữ liệu để xuất.", "err");
  if (!res.posts.length) return setStatus("Chưa có dữ liệu để xuất.", "err");

  const rows = [CSV_COLUMNS.join(",")];
  for (const p of res.posts) {
    rows.push(CSV_COLUMNS.map((c) => csvCell(p[c])).join(","));
  }
  // BOM để Excel đọc đúng UTF-8 tiếng Việt.
  const content = "\uFEFF" + rows.join("\r\n");
  downloadFile(`fb_group_posts_${stamp()}.csv`, content, "text/csv;charset=utf-8");
  setStatus(`Đã xuất ${res.posts.length} bài ra CSV.`, "ok");
}

// ---- Xoá dữ liệu ----------------------------------------------------------

async function clearAll() {
  const ok = confirm("Xoá TOÀN BỘ dữ liệu đã lưu? Hành động này không thể hoàn tác.");
  if (!ok) return;
  const res = await bg("CLEAR_POSTS");
  if (res && res.ok) {
    setStatus(`Đã xoá ${res.deleted} bài.`, "ok");
    loadStats();
  } else {
    setStatus("Xoá thất bại.", "err");
  }
}

// ---- Cấu hình AI & khám phá selector -------------------------------------

function setSelectorBox(text) {
  els.selectorBox.textContent = text;
}

function loadAIConfig() {
  chrome.storage.local.get("aiConfig", (r) => {
    const cfg = (r && r.aiConfig) || {};
    els.aiApiBase.value = cfg.apiBase || "https://danglamgiau.com/v1";
    els.aiApiKey.value = cfg.apiKey || "";
    els.aiModel.value = cfg.model || "gpt-5.5";
  });
}

function saveAIConfig() {
  const cfg = {
    apiBase: els.aiApiBase.value.trim() || "https://danglamgiau.com/v1",
    apiKey: els.aiApiKey.value.trim(),
    model: els.aiModel.value.trim() || "gpt-5.5",
  };
  chrome.storage.local.set({ aiConfig: cfg }, () => {
    setStatus("Đã lưu cấu hình AI.", "ok");
  });
}

async function discoverSelectors() {
  if (!els.aiApiKey.value.trim()) {
    setStatus("Hãy nhập API key rồi bấm Lưu cấu hình trước.", "err");
    return;
  }
  saveAIConfig();
  setStatus("Đang lấy HTML bài mẫu và gọi AI để khám phá selector...");
  setSelectorBox("Đang xử lý...");
  const res = await bg("DISCOVER_SELECTORS");
  if (!res || !res.ok) {
    setStatus((res && res.error) || "Khám phá selector thất bại.", "err");
    setSelectorBox((res && res.error) || "Thất bại.");
    return;
  }
  setStatus("Đã tạo & lưu selector. Lần crawl tới sẽ dùng selector này.", "ok");
  setSelectorBox(JSON.stringify(res.selectors, null, 2));
}

async function viewSelectors() {
  const res = await bg("GET_SELECTORS");
  if (res && res.ok && res.selectors) {
    setSelectorBox(JSON.stringify(res.selectors, null, 2));
  } else {
    setSelectorBox("Chưa có selector nào được lưu.");
  }
}

async function clearSelectors() {
  await bg("CLEAR_SELECTORS");
  setSelectorBox("Đã xoá selector. Crawl sẽ dùng heuristic mặc định.");
  setStatus("Đã xoá selector AI.", "ok");
}

// ---- Gắn sự kiện & khởi tạo -----------------------------------------------

els.btnStart.addEventListener("click", startCrawl);
els.btnStop.addEventListener("click", stopCrawl);
els.btnExportJson.addEventListener("click", exportJson);
els.btnExportCsv.addEventListener("click", exportCsv);
els.btnRefresh.addEventListener("click", loadStats);
els.btnClear.addEventListener("click", clearAll);
els.btnSaveAI.addEventListener("click", saveAIConfig);
els.btnDiscover.addEventListener("click", discoverSelectors);
els.btnViewSelectors.addEventListener("click", viewSelectors);
els.btnClearSelectors.addEventListener("click", clearSelectors);
els.btnDashboard.addEventListener("click", () => {
  bg("OPEN_DASHBOARD");
  window.close();
});

// ---- Sự kiện đăng nhập / đăng xuất ----
els.btnLogin.addEventListener("click", doLogin);
els.loginPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});
els.btnLogout.addEventListener("click", doLogout);

// Khởi tạo: cấu hình AI là cục bộ nên tải ngay; dữ liệu phụ thuộc API chỉ
// chạy sau khi xác nhận đã đăng nhập (trong refreshAuth).
loadAIConfig();
refreshAuth();
