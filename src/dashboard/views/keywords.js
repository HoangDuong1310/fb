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
 *   - GET_KEYWORDS    { kwType? }                  -> { ok, keywords }
 *   - ADD_KEYWORD     { keyword, kwType, enabled } -> { ok }
 *   - UPDATE_KEYWORD  { id, patch }                -> { ok }
 *   - DELETE_KEYWORD  { id }                       -> { ok }
 *
 * LƯU Ý: payload tuyệt đối KHÔNG được dùng khóa tên "type" — nó trùng với khóa
 * định tuyến của bg(message.type) và sẽ ghi đè lệnh, khiến message rơi vào case
 * default ở background.js (không trả lời) -> lỗi "The message port closed".
 * Vì vậy loại từ khóa được truyền dưới tên "kwType".
 */
import { $, bg, esc, emptyState, toast, timeAgo } from "../core.js";

// State riêng cho view. type = tab đang xem (sell | buy | support).
export const keywordStore = {
  list: [],
  type: "sell",
};

// Nhãn nguồn từ khóa sang tiếng Việt.
const ADDED_BY_LABEL = { ai: "AI", user: "Tôi", me: "Tôi", system: "Hệ thống" };

// Gợi ý theo từng nhóm để người dùng hiểu nhóm dùng vào việc gì.
const KW_HINTS = {
  sell: 'Từ khóa "bán" dùng ở phễu trích giá group VÀ để loại NGƯỜI BÁN khỏi Lọc thông minh. AI có thể tự học thêm (gắn nhãn "mới bởi AI"); bạn có thể bật/tắt hoặc xóa.',
  buy: 'Từ khóa "Cần mua" giúp Lọc thông minh nhận diện KHÁCH CÓ NHU CẦU MUA. Thêm/bật/tắt để tinh chỉnh bộ lọc bài viết.',
  support: 'Từ khóa "Cần hỗ trợ" giúp Lọc thông minh nhận diện người HỎI KỸ THUẬT / GẶP SỰ CỐ. Thêm/bật/tắt để tinh chỉnh bộ lọc bài viết.',
};

export async function loadKeywordsView() {
  await reloadKeywords();
}

// Đổi nhóm từ khóa đang xem (tab). Cập nhật trạng thái nút + gợi ý rồi nạp lại.
export async function switchKeywordType(type) {
  keywordStore.type = type || "sell";
  const tabs = $("kwTypeTabs");
  if (tabs) {
    tabs.querySelectorAll("button[data-kwtype]").forEach((b) => {
      b.classList.toggle("active", b.dataset.kwtype === keywordStore.type);
    });
  }
  const hint = $("kwHint");
  if (hint) hint.textContent = KW_HINTS[keywordStore.type] || KW_HINTS.sell;
  await reloadKeywords();
}

export async function reloadKeywords() {
  const wrap = $("keywordList");
  const res = await bg("GET_KEYWORDS", { kwType: keywordStore.type || "" });
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
  const res = await bg("ADD_KEYWORD", { keyword: word, kwType: type, enabled: true });
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
