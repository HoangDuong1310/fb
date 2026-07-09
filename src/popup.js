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
  rememberMe: $("rememberMe"),
  linkShowRegister: $("linkShowRegister"),
  // ---- Đăng ký ----
  registerSection: $("registerSection"),
  registerName: $("registerName"),
  registerEmail: $("registerEmail"),
  registerPassword: $("registerPassword"),
  btnRegister: $("btnRegister"),
  registerError: $("registerError"),
  linkShowLogin: $("linkShowLogin"),
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

// Hiện/ẩn dòng lỗi đăng ký.
function setRegisterError(text) {
  if (!text) {
    els.registerError.textContent = "";
    els.registerError.hidden = true;
    return;
  }
  els.registerError.textContent = text;
  els.registerError.hidden = false;
}

// Hiện giao diện đã đăng nhập: ẩn cả form login lẫn register, hiện appSection.
function showLoggedIn(displayName) {
  els.authName.textContent = displayName || "";
  els.authBar.hidden = false;
  els.loginSection.hidden = true;
  els.registerSection.hidden = true;
  els.appSection.hidden = false;
  setLoginError("");
  setRegisterError("");
}

// Hiện form đăng nhập: ẩn appSection + authBar + form đăng ký. note = thông báo tuỳ chọn.
function showLoggedOut(note) {
  els.authBar.hidden = true;
  els.appSection.hidden = true;
  els.registerSection.hidden = true;
  els.loginSection.hidden = false;
  els.authName.textContent = "";
  setRegisterError("");
  setLoginError(note || "");
}

// Chuyển sang form đăng ký: ẩn login, hiện register, xoá lỗi cũ.
function showRegisterView() {
  els.loginSection.hidden = true;
  els.registerSection.hidden = false;
  setLoginError("");
  setRegisterError("");
}

// Quay lại form đăng nhập từ form đăng ký.
function showLoginView() {
  els.registerSection.hidden = true;
  els.loginSection.hidden = false;
  setLoginError("");
  setRegisterError("");
}

// Hỏi background trạng thái đăng nhập rồi định tuyến giao diện.
async function refreshAuth() {
  try {
    const res = await bg("AUTH_STATE");
    if (res && res.ok && res.loggedIn) {
      showLoggedIn(res.display_name);
      // Đã đăng nhập: tải dữ liệu phụ thuộc API.
      loadStats();
      viewSelectors();
    } else {
      showLoggedOut();
    }
  } catch (e) {
    // SW lỗi / chưa kịp thức: vẫn đưa về form đăng nhập để có lối thoát,
    // tránh popup treo ở trạng thái trống (cả login lẫn app đều đang ẩn).
    void e;
    showLoggedOut("Không kết nối được máy chủ, vui lòng thử lại.");
  }
}

// Chuyển lỗi đăng nhập thành thông báo tiếng Việt thân thiện. apiFetch ném lỗi
// dạng "API 401: invalid credentials" khi sai thông tin; mọi lỗi khác (mất mạng,
// 5xx) coi như sự cố kết nối thay vì hiện nguyên văn exception tiếng Anh.
function loginErrorMessage(raw) {
  const s = String(raw || "");
  if (/\b401\b/.test(s) || /invalid credentials/i.test(s)) {
    return "Email hoặc mật khẩu không đúng.";
  }
  return "Không đăng nhập được, kiểm tra kết nối rồi thử lại.";
}

/* ---- Ghi nhớ tài khoản --------------------------------------------------
 * Chỉ nhớ EMAIL (không bao giờ nhớ mật khẩu) trong chrome.storage.local. Token
 * phiên do api.js quản lý riêng và đã sống qua restart; phần này chỉ điền sẵn
 * email + tích lại ô để người dùng đỡ gõ lại. Bỏ tích -> xoá email đã nhớ.
 */
const REMEMBER_KEY = "rememberedLogin";

// Đọc { remember, email } đã lưu (an toàn khi chưa có gì / ngoài extension).
function loadRememberedLogin() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(REMEMBER_KEY, (r) => {
        void chrome.runtime.lastError;
        const saved = (r && r[REMEMBER_KEY]) || {};
        resolve({
          remember: !!saved.remember,
          email: typeof saved.email === "string" ? saved.email : "",
        });
      });
    } catch (e) {
      resolve({ remember: false, email: "" });
    }
  });
}

// Lưu (remember=true) hoặc xoá (remember=false) email đã nhớ.
function saveRememberedLogin(remember, email) {
  try {
    if (remember && email) {
      chrome.storage.local.set(
        { [REMEMBER_KEY]: { remember: true, email } },
        () => void chrome.runtime.lastError
      );
    } else {
      chrome.storage.local.remove(REMEMBER_KEY, () => void chrome.runtime.lastError);
    }
  } catch (e) {
    // Bỏ qua: không nhớ được tài khoản không phải lỗi chặn đăng nhập.
  }
}

// Điền sẵn email đã nhớ + trạng thái ô tích lúc mở popup.
async function applyRememberedLogin() {
  const { remember, email } = await loadRememberedLogin();
  if (els.rememberMe) els.rememberMe.checked = remember;
  if (remember && email && els.loginEmail && !els.loginEmail.value) {
    els.loginEmail.value = email;
  }
}

// Xử lý đăng nhập: kiểm tra rỗng, gửi AUTH_LOGIN, định tuyến theo kết quả.
async function doLogin() {
  const email = els.loginEmail.value.trim();
  // KHÔNG trim mật khẩu: khoảng trắng đầu/cuối có thể là một phần hợp lệ.
  const password = els.loginPassword.value;
  if (!email || !password) {
    setLoginError("Nhập email và mật khẩu");
    return;
  }
  els.btnLogin.disabled = true;
  try {
    const res = await bg("AUTH_LOGIN", { email, password });
    if (res && res.ok) {
      els.loginPassword.value = "";
      // Nhớ/quên email theo ô tích — chỉ làm sau khi đăng nhập THÀNH CÔNG để
      // không lưu email gõ sai. KHÔNG bao giờ lưu mật khẩu.
      const remember = !!(els.rememberMe && els.rememberMe.checked);
      saveRememberedLogin(remember, email);
      // Login route trả user.displayName (camelCase) — KHÔNG phải display_name.
      showLoggedIn(res.user && res.user.displayName);
      loadStats();
      viewSelectors();
    } else {
      setLoginError(loginErrorMessage(res && res.error));
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

// Chuyển lỗi đăng ký thành thông báo tiếng Việt thân thiện. apiFetch ném lỗi
// dạng "API 409: email already registered" khi email trùng, "API 400: ..." khi
// mật khẩu yếu / email sai định dạng; mọi lỗi khác coi như sự cố kết nối.
function registerErrorMessage(raw) {
  const s = String(raw || "");
  if (/\b409\b/.test(s) || /already registered/i.test(s)) {
    return "Email này đã được đăng ký. Hãy đăng nhập.";
  }
  if (/password must be 6-72/i.test(s)) {
    return "Mật khẩu phải từ 6 đến 72 ký tự.";
  }
  if (/invalid email/i.test(s)) {
    return "Email không hợp lệ.";
  }
  if (/\b400\b/.test(s)) {
    return "Thông tin đăng ký không hợp lệ, vui lòng kiểm tra lại.";
  }
  return "Không đăng ký được, kiểm tra kết nối rồi thử lại.";
}

// Xử lý đăng ký: kiểm tra rỗng + độ dài mật khẩu phía client (khớp ràng buộc
// backend 6-72 ký tự), gửi AUTH_REGISTER. Backend trả {token, user} và đăng
// nhập luôn, nên thành công thì vào thẳng appSection.
async function doRegister() {
  const email = els.registerEmail.value.trim();
  // KHÔNG trim mật khẩu: khoảng trắng đầu/cuối có thể là một phần hợp lệ.
  const password = els.registerPassword.value;
  const displayName = els.registerName.value.trim();
  if (!email || !password) {
    setRegisterError("Nhập email và mật khẩu");
    return;
  }
  if (password.length < 6 || password.length > 72) {
    setRegisterError("Mật khẩu phải từ 6 đến 72 ký tự.");
    return;
  }
  els.btnRegister.disabled = true;
  try {
    const res = await bg("AUTH_REGISTER", { email, password, displayName });
    if (res && res.ok) {
      els.registerPassword.value = "";
      // Register route trả user.displayName (camelCase) — KHÔNG phải display_name.
      showLoggedIn(res.user && res.user.displayName);
      loadStats();
      viewSelectors();
    } else {
      setRegisterError(registerErrorMessage(res && res.error));
    }
  } finally {
    els.btnRegister.disabled = false;
  }
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
  chrome.runtime.sendMessage(
    { type: "GET_SETTING", key: "aiConfig" },
    (res) => {
      void chrome.runtime.lastError;
      const cfg = (res && res.value) || {};
      els.aiApiBase.value = cfg.apiBase || "https://danglamgiau.com/v1";
      els.aiApiKey.value = cfg.apiKey || "";
      els.aiModel.value = cfg.model || "gpt-5.5";
    }
  );
}

function saveAIConfig() {
  const cfg = {
    apiBase: els.aiApiBase.value.trim() || "https://danglamgiau.com/v1",
    apiKey: els.aiApiKey.value.trim(),
    model: els.aiModel.value.trim() || "gpt-5.5",
  };
  chrome.runtime.sendMessage(
    { type: "SET_SETTING", key: "aiConfig", value: cfg },
    (res) => {
      void chrome.runtime.lastError;
      if (res && res.ok) setStatus("Đã lưu cấu hình AI.", "ok");
      else setStatus("Lưu cấu hình AI thất bại.", "err");
    }
  );
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

// ---- Sự kiện đăng ký ----
els.btnRegister.addEventListener("click", doRegister);
els.registerPassword.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doRegister();
});
els.linkShowRegister.addEventListener("click", (e) => {
  e.preventDefault();
  showRegisterView();
});
els.linkShowLogin.addEventListener("click", (e) => {
  e.preventDefault();
  showLoginView();
});

// Khởi tạo: cấu hình AI là cục bộ nên tải ngay; dữ liệu phụ thuộc API chỉ
// chạy sau khi xác nhận đã đăng nhập (trong refreshAuth). Điền sẵn email đã nhớ
// (nếu có) để người dùng đỡ gõ lại khi phiên hết hạn thật và quay về form login.
loadAIConfig();
applyRememberedLogin();
refreshAuth();
