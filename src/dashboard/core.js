/**
 * core.js — Nền tảng dùng chung cho Dashboard (ESM).
 *
 * Chứa các tiện ích và trạng thái được nhiều view dùng chung:
 *  - $   : truy cập phần tử theo id.
 *  - bg  : bọc chrome.runtime.sendMessage trả Promise + thông báo lỗi tiếng Việt.
 *  - store / syncToasts : trạng thái dùng chung giữa các module.
 *  - toast / modal : thành phần UI dùng lại.
 *  - esc / timeAgo / fmtDateTime / colorFor / initials / emptyState : tiện ích.
 */

export const $ = (id) => document.getElementById(id);

export function bg(type, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, ...payload }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) {
          // Kênh tới service worker bị lỗi: thường do vừa reload extension
          // mà chưa mở lại tab Dashboard, hoặc service worker chưa nạp code mới.
          resolve({
            ok: false,
            error:
              "Mất kết nối tới tiện ích (" +
              err.message +
              "). Hãy Reload extension trong chrome://extensions rồi mở lại Dashboard.",
          });
          return;
        }
        if (res === undefined) {
          // SW nhận message nhưng không trả lời (case chưa tồn tại trong SW đang chạy).
          resolve({
            ok: false,
            error:
              'Service worker không phản hồi lệnh "' +
              type +
              '". Có thể đang chạy bản cũ — hãy Reload extension rồi mở lại Dashboard.',
          });
          return;
        }
        resolve(res);
      });
    } catch (e) {
      resolve({
        ok: false,
        error: "Không gửi được lệnh tới tiện ích: " + String(e),
      });
    }
  });
}

/* ----------------------------- Trạng thái ------------------------------- */
export const store = {
  groups: [],
  posts: [],
  postsGroupId: "",
  jobs: [],
  selected: new Set(), // groupId đang được chọn để crawl hàng loạt
  batch: null, // { queue:[groupId], index, total, stop } khi đang crawl hàng loạt
};

// Map sourceId -> toast handle "dính" đang theo dõi tiến trình đồng bộ.
export const syncToasts = {};

/* ------------------------------- Toast ---------------------------------- */
export function toast(msg, kind = "info", ms = 3200) {
  const wrap = $("toasts");
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.innerHTML = '<span class="dot"></span>';
  const span = document.createElement("span");
  span.textContent = msg;
  el.appendChild(span);
  wrap.appendChild(el);
  // ms <= 0 => toast "dính" (không tự ẩn). Trả về handle để cập nhật/đóng.
  const handle = {
    el,
    update(text, newKind) {
      span.textContent = text;
      if (newKind) el.className = "toast " + newKind;
    },
    close(delay = 0) {
      setTimeout(() => {
        el.style.opacity = "0";
        el.style.transform = "translateY(8px)";
        el.style.transition = "all .25s";
        setTimeout(() => el.remove(), 260);
      }, delay);
    },
  };
  if (ms > 0) handle.close(ms);
  return handle;
}

/* ------------------------------- Modal ---------------------------------- */
export function modal({ title, bodyHTML, confirmText = "Xác nhận", onConfirm, danger, extraText, onExtra }) {
  const root = $("modalRoot");
  root.innerHTML = "";
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const extraBtn = extraText
    ? `<button class="btn ghost" data-act="extra">${extraText}</button>`
    : "";
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">${title}</div>
      <div class="modal-body">${bodyHTML}</div>
      <div class="modal-foot">
        <button class="btn ghost" data-act="cancel">Hủy</button>
        ${extraBtn}
        <button class="btn ${danger ? "danger-ghost" : "primary"}" data-act="ok">${confirmText}</button>
      </div>
    </div>`;
  root.appendChild(overlay);
  const close = () => (root.innerHTML = "");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.querySelector('[data-act="cancel"]').addEventListener("click", close);
  const extraEl = overlay.querySelector('[data-act="extra"]');
  if (extraEl) {
    extraEl.addEventListener("click", async () => {
      if (onExtra) {
        const ok = await onExtra(overlay);
        if (ok === false) return;
      }
      close();
    });
  }
  overlay.querySelector('[data-act="ok"]').addEventListener("click", async () => {
    if (onConfirm) {
      const ok = await onConfirm(overlay);
      if (ok === false) return;
    }
    close();
  });
  return { overlay, close };
}

/* ----------------------------- Tiện ích --------------------------------- */
export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
export function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "vừa xong";
  if (m < 60) return m + " phút trước";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " giờ trước";
  return Math.floor(h / 24) + " ngày trước";
}
export function fmtDateTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString("vi-VN");
}
export function colorFor(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return `hsl(${h}, 58%, 52%)`;
}
export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase() || "?";
}

export function emptyState(title, desc) {
  return `<div class="empty">
    <svg viewBox="0 0 24 24"><path d="M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 4h-2v6h2V7zm0 8h-2v2h2v-2z"/></svg>
    <h3>${esc(title)}</h3><p>${esc(desc)}</p></div>`;
}
