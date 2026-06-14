/**
 * keywords.js — View "Từ khóa học": quản lý bảng learned_keywords ở web backend.
 *
 * Từ khóa "bán" (sell signal) được dùng ở phễu tầng 1 khi trích giá group. AI có
 * thể tự HỌC thêm từ khóa mới (addedBy='ai') trong lúc trích; người dùng cũng có
 * thể thêm tay, bật/tắt, hoặc xoá. Bảng hiển thị: từ, loại, nguồn (AI/tôi), công
 * tắc bật, nút xoá, và badge "mới bởi AI".
 *
 * Đường dữ liệu: KHÔNG gọi HTTP trực tiếp từ dashboard (JWT ở service worker).
 * Mọi thao tác đi qua bg() -> handler ở background.js -> API.apiFetch. Message:
 *   - GET_KEYWORDS    { type? }                 -> { ok, keywords }
 *   - ADD_KEYWORD     { keyword, type, enabled } -> { ok }
 *   - UPDATE_KEYWORD  { id, patch }              -> { ok }
 *   - DELETE_KEYWORD  { id }                     -> { ok }
 */
import { $, bg, esc, emptyState, toast, timeAgo } from "../core.js";

// State riêng cho view. Hiện chỉ quản lý từ khóa loại "sell" (chưa có UI đổi loại).
export const keywordStore = {
  list: [],
  type: "sell",
};

// Nhãn nguồn từ khóa sang tiếng Việt.
const ADDED_BY_LABEL = { ai: "AI", user: "Tôi", me: "Tôi" };

export async function loadKeywordsView() {
  await reloadKeywords();
}

export async function reloadKeywords() {
  const wrap = $("keywordList");
  const res = await bg("GET_KEYWORDS", { type: keywordStore.type || "" });
  if (!res || !res.ok) {
    // Chưa đăng nhập -> hiện hướng dẫn thay vì bảng trống gây hiểu nhầm.
    if (wrap) {
      wrap.innerHTML = emptyState(
        "Cần đăng nhập",
        (res && res.error) || "Đăng nhập tài khoản web ở popup tiện ích để xem từ khóa đã học."
      );
    }
    return;
  }
  keywordStore.list = res.keywords || [];
  renderKeywords();
}

function renderKeywords() {
  const wrap = $("keywordList");
  if (!wrap) return;
  if (!keywordStore.list.length) {
    wrap.innerHTML = emptyState(
      "Chưa có từ khóa",
      'Thêm từ khóa "bán" thủ công, hoặc để AI tự học khi bạn trích xuất giá group.'
    );
    return;
  }
  const rows = keywordStore.list
    .map((k) => {
      const byAI = k.addedBy === "ai";
      const aiBadge = byAI ? `<span class="kw-ai-badge">mới bởi AI</span>` : "";
      const source = ADDED_BY_LABEL[k.addedBy] || esc(k.addedBy || "Tôi");
      const checked = k.enabled ? "checked" : "";
      return `
      <tr data-id="${esc(k.id)}">
        <td class="kw-word">${esc(k.keyword)} ${aiBadge}</td>
        <td class="kw-type">${esc(k.type || "")}</td>
        <td class="kw-source">${source}</td>
        <td class="kw-when muted">${k.createdAt ? esc(timeAgo(typeof k.createdAt === "number" ? k.createdAt : Date.parse(k.createdAt))) : ""}</td>
        <td class="kw-toggle">
          <label class="switch-mini">
            <input type="checkbox" data-kw-toggle ${checked} />
            <span></span>
          </label>
        </td>
        <td class="kw-actions">
          <button class="btn danger-ghost sm" data-kw-del title="Xóa từ khóa">Xóa</button>
        </td>
      </tr>`;
    })
    .join("");
  wrap.innerHTML = `
    <table class="kw-table">
      <thead>
        <tr><th>Từ khóa</th><th>Loại</th><th>Nguồn</th><th>Thêm lúc</th><th>Bật</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Thêm từ khóa thủ công từ form (input + nút). type lấy theo tab đang xem
// (mặc định "sell"); idempotent ở backend theo UNIQUE(keyword,type).
export async function addKeywordUI() {
  const input = $("kwNewWord");
  const word = (input && input.value || "").trim();
  if (!word) {
    toast("Nhập từ khóa trước đã.", "err", 2500);
    return;
  }
  const type = keywordStore.type || "sell";
  const res = await bg("ADD_KEYWORD", { keyword: word, type, enabled: true });
  if (res && res.ok) {
    if (input) input.value = "";
    toast("Đã thêm từ khóa.", "ok", 2000);
    await reloadKeywords();
  } else {
    toast((res && res.error) || "Thêm từ khóa thất bại.", "err", 5000);
  }
}

// Bật/tắt một từ khóa (PATCH enabled). Cập nhật lạc quan + nạp lại để chắc chắn.
export async function toggleKeyword(id, enabled) {
  const res = await bg("UPDATE_KEYWORD", { id, patch: { enabled: enabled ? 1 : 0 } });
  if (!res || !res.ok) {
    toast((res && res.error) || "Cập nhật thất bại.", "err", 5000);
    await reloadKeywords();
  }
}

// Xóa một từ khóa.
export async function deleteKeyword(id) {
  const res = await bg("DELETE_KEYWORD", { id });
  if (res && res.ok) {
    toast("Đã xóa từ khóa.", "ok", 2000);
    await reloadKeywords();
  } else {
    toast((res && res.error) || "Xóa thất bại.", "err", 5000);
  }
}
