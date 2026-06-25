/**
 * profiles.js — View "Hồ sơ ngành": quản lý các hồ sơ prompt (business profile)
 * quyết định "giọng" + đặc thù ngành của TOÀN BỘ AI trong hệ thống.
 *
 * VÌ SAO: phần đặc thù ngành (vai trò người bán, danh mục, hướng dẫn tư vấn,
 * cách trích giá, cách build) trước đây hard-code cho bán máy tính. View này cho
 * người dùng TẠO / NHÂN BẢN / SỬA / KÍCH HOẠT / XÓA hồ sơ để áp tool cho ngành
 * bất kỳ (bán điện thoại, bất động sản, cho thuê phòng trọ...). Một hồ sơ ĐANG
 * KÍCH HOẠT là hồ sơ AI dùng; phần cấu trúc JSON bắt buộc do code tự nối, người
 * dùng KHÔNG đụng tới nên đổi ngành không vỡ luồng.
 *
 * DỮ LIỆU 100% Ở BACKEND (bảng prompt_profiles) -> chia sẻ được. Không gọi HTTP
 * trực tiếp (JWT ở service worker); mọi thao tác qua bg():
 *   - GET_PROMPT_PROFILES                  -> { ok, profiles:[...] }
 *   - SAVE_PROMPT_PROFILE   { profile }     -> { ok }
 *   - ACTIVATE_PROMPT_PROFILE { id }        -> { ok }  (SW xoá cache hồ sơ luôn)
 *   - DELETE_PROMPT_PROFILE   { id }        -> { ok }
 */
import { $, bg, toast, modal, esc, emptyState } from "../core.js";
import { PROFILE_TEXT_FIELDS } from "../../prompts.js";

// Hồ sơ đã tải (mỗi phần tử = config dẹp phẳng + id/name/isActive). Giữ ở module
// để các handler (sửa/nhân bản/xóa) tra nhanh mà không gọi lại backend.
let profiles = [];

/** Nạp danh sách hồ sơ ngành từ backend và render. Khóa UI nếu chưa đăng nhập. */
export async function loadProfilesView() {
  const res = await bg("GET_PROMPT_PROFILES");
  const hint = $("profilesAuthHint");
  if (!res || !res.ok) {
    // Chưa đăng nhập / lỗi -> nhắc đăng nhập, dọn danh sách + đóng trình sửa.
    if (hint) {
      hint.hidden = false;
      hint.textContent =
        (res && res.error) || "Cần đăng nhập tài khoản web (ở popup tiện ích) để quản lý hồ sơ ngành.";
    }
    profiles = [];
    const wrap = $("profilesList");
    if (wrap) wrap.innerHTML = "";
    closeEditor();
    return;
  }
  if (hint) hint.hidden = true;
  profiles = Array.isArray(res.profiles) ? res.profiles : [];
  renderProfilesList();
}

function renderProfilesList() {
  const wrap = $("profilesList");
  if (!wrap) return;
  if (!profiles.length) {
    // Empty state DẠY người dùng hồ sơ ngành là gì + nút tạo ngay (bắt qua
    // delegation profile-new) thay vì chỉ báo "trống".
    wrap.innerHTML =
      emptyState(
        "Chưa có hồ sơ ngành nào",
        "Hồ sơ ngành quyết định giọng văn và đặc thù ngành của toàn bộ AI trong hệ thống. Tạo hồ sơ đầu tiên để áp tool cho ngành của bạn."
      ) +
      '<div class="empty-cta"><button class="btn primary" data-act="profile-new">Tạo hồ sơ đầu tiên</button></div>';
    return;
  }
  wrap.innerHTML = profiles.map(profileCardHTML).join("");
}

function profileCardHTML(p) {
  const active = !!p.isActive;
  const cats = Array.isArray(p.categories) ? p.categories : [];
  return (
    '<div class="profile-card' + (active ? " is-active" : "") + '" data-id="' + esc(p.id) + '">' +
    '<div class="profile-card-main">' +
    '<div class="profile-name">' + esc(p.name || p.id) +
    (active ? ' <span class="badge ok">Đang dùng</span>' : "") +
    "</div>" +
    '<div class="profile-desc">' + esc(p.description || "") + "</div>" +
    '<div class="profile-cats">' +
    cats.map((c) => '<span class="chip">' + esc(c) + "</span>").join("") +
    "</div>" +
    "</div>" +
    '<div class="profile-card-actions">' +
    (active ? "" : '<button class="btn primary sm" data-act="profile-activate" data-id="' + esc(p.id) + '">Kích hoạt</button>') +
    '<button class="btn ghost sm" data-act="profile-edit" data-id="' + esc(p.id) + '">Sửa</button>' +
    '<button class="btn ghost sm" data-act="profile-clone" data-id="' + esc(p.id) + '">Nhân bản</button>' +
    '<button class="btn danger-ghost sm" data-act="profile-delete" data-id="' + esc(p.id) + '">Xóa</button>' +
    "</div>" +
    "</div>"
  );
}

/**
 * MỘT handler click cho cả section (gắn delegation ở dashboard.js). Mọi nút đều
 * dùng data-act nên không cần inline onclick.
 */
export function onProfileAction(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  if (act === "profile-new") return newProfile();
  if (act === "profile-activate") return activateProfile(id);
  if (act === "profile-edit") return openEditor(id);
  if (act === "profile-clone") return cloneProfile(id);
  if (act === "profile-delete") return deleteProfileUI(id);
  if (act === "profile-save") return saveProfileEdit();
  if (act === "profile-cancel") return closeEditor();
  if (act === "profile-gen-skill") return generateSkillUI(btn.dataset.field);
}

/**
 * Gọi AI sinh nội dung cho MỘT trường skill đang để trống/thiếu. Lấy ngữ cảnh từ
 * chính trình sửa đang mở (tên/mô tả/danh mục) để AI viết đúng giọng ngành, rồi
 * điền thẳng vào textarea tương ứng. Dùng toast "dính" làm chỉ báo đang chạy.
 */
async function generateSkillUI(field) {
  if (!field) return;
  const ta = $("pf_" + field);
  if (!ta) return;
  const val = (key) => ($(key) && $(key).value ? $(key).value : "");
  const profile = {
    name: val("pf_name").trim(),
    description: val("pf_description").trim(),
    categories: val("pf_categories")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  if (!profile.name && !profile.description && profile.categories.length === 0) {
    toast("Hãy nhập tên / mô tả / danh mục trước để AI có ngữ cảnh sinh nội dung.", "err", 4000);
    return;
  }
  const loading = toast("Đang tạo nội dung bằng AI...", "info", 0);
  const res = await bg("GEN_PROFILE_SKILL", { field, profile });
  if (res && res.ok && res.text) {
    ta.value = res.text;
    loading.update("Đã tạo nội dung bằng AI.", "ok");
    loading.close(2200);
  } else {
    loading.update((res && res.error) || "Tạo nội dung bằng AI thất bại.", "err");
    loading.close(4500);
  }
}

async function activateProfile(id) {
  const res = await bg("ACTIVATE_PROMPT_PROFILE", { id });
  if (res && res.ok) {
    toast("Đã kích hoạt hồ sơ. AI sẽ dùng hồ sơ này ngay.", "ok", 2600);
    await loadProfilesView();
  } else {
    toast((res && res.error) || "Kích hoạt hồ sơ thất bại.", "err", 5000);
  }
}

// Tạo hồ sơ mới: mở trình sửa với khuôn trống (id bỏ trống để người dùng đặt).
function newProfile() {
  openEditorWith(
    { id: "", name: "", description: "", categories: [], classifyIntro: "", draftPersona: "", extractIntro: "", buildPersona: "" },
    true
  );
}

// Sửa hồ sơ có sẵn: id KHÓA (readonly) để upsert đúng bản ghi.
function openEditor(id) {
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  openEditorWith(JSON.parse(JSON.stringify(p)), false);
}

// Nhân bản: sao chép nội dung, bỏ trống id (người dùng đặt id mới) + đánh dấu bản sao.
function cloneProfile(id) {
  const p = profiles.find((x) => x.id === id);
  if (!p) return;
  const copy = JSON.parse(JSON.stringify(p));
  copy.id = "";
  copy.name = (p.name || p.id) + " (bản sao)";
  copy.isActive = false;
  openEditorWith(copy, true);
}

function openEditorWith(p, isNew) {
  const panel = $("profileEditorPanel");
  const title = $("profileEditorTitle");
  const ed = $("profileEditor");
  if (!panel || !ed) return;
  panel.hidden = false;
  if (title) title.textContent = isNew ? "Tạo hồ sơ mới" : "Sửa hồ sơ: " + (p.name || p.id);
  const cats = Array.isArray(p.categories) ? p.categories.join(", ") : "";
  // Mỗi trường skill kèm nút "Tạo bằng AI" để AI sinh nội dung khi người dùng để
  // trống / nhập thiếu. data-field cho biết trường nào cần điền sau khi AI trả về.
  const fieldsHTML = PROFILE_TEXT_FIELDS.map(
    (f) =>
      '<label class="field"><span class="field-label-row">' +
      "<span>" + esc(f.label) + "</span>" +
      '<button type="button" class="btn ghost tiny" data-act="profile-gen-skill" data-field="' +
      esc(f.key) + '">✨ Tạo bằng AI</button>' +
      "</span>" +
      '<textarea id="pf_' + f.key + '" rows="' + f.rows + '" class="input">' +
      esc(p[f.key] || "") +
      "</textarea></label>"
  ).join("");
  // Chia 2 nhóm rõ ràng: (1) ĐỊNH DANH hồ sơ — id/tên/mô tả/danh mục; (2) NỘI
  // DUNG huấn luyện AI — 4 đoạn prompt đặc thù ngành. Tách bằng .form-section để
  // không trộn ô ngắn với ô textarea dài, đỡ rối mắt.
  ed.innerHTML =
    '<div class="form-section">' +
    '<div class="form-section-head">' +
    "<h3>Thông tin hồ sơ</h3>" +
    "<p>Định danh và danh mục sản phẩm của ngành.</p>" +
    "</div>" +
    '<div class="grid2">' +
    '<label class="field"><span>Mã hồ sơ (id)</span>' +
    '<input id="pf_id" type="text" class="input" value="' + esc(p.id || "") + '" ' + (isNew ? "" : "readonly") +
    ' placeholder="vd: phone, realestate, room" />' +
    '<small class="field-hint">Không dấu, không khoảng trắng. Không đổi được sau khi tạo.</small></label>' +
    '<label class="field"><span>Tên hiển thị</span>' +
    '<input id="pf_name" type="text" class="input" value="' + esc(p.name || "") + '" placeholder="vd: Bán điện thoại" /></label>' +
    "</div>" +
    '<label class="field"><span>Mô tả ngắn</span>' +
    '<input id="pf_description" type="text" class="input" value="' + esc(p.description || "") + '" placeholder="vd: Tư vấn &amp; bán điện thoại, phụ kiện chính hãng" /></label>' +
    '<label class="field"><span>Danh mục sản phẩm</span>' +
    '<input id="pf_categories" type="text" class="input" value="' + esc(cats) + '" placeholder="iphone, samsung, phụ kiện, sạc" />' +
    '<small class="field-hint">Cách nhau bởi dấu phẩy.</small></label>' +
    "</div>" +
    '<div class="form-section">' +
    '<div class="form-section-head">' +
    "<h3>Nội dung huấn luyện AI theo ngành</h3>" +
    "<p>Các đoạn hướng dẫn quyết định cách AI phân loại ý định, soạn trả lời, trích giá và ghép bộ. Khung JSON bắt buộc do hệ thống tự nối — bạn chỉ điền nội dung đặc thù ngành.</p>" +
    "</div>" +
    fieldsHTML +
    "</div>" +
    '<div class="btn-row">' +
    '<button class="btn primary" data-act="profile-save">Lưu hồ sơ</button>' +
    '<button class="btn ghost" data-act="profile-cancel">Hủy</button>' +
    "</div>";
  panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEditor() {
  const panel = $("profileEditorPanel");
  if (panel) panel.hidden = true;
  const ed = $("profileEditor");
  if (ed) ed.innerHTML = "";
}

async function saveProfileEdit() {
  const id = ($("pf_id") && $("pf_id").value ? $("pf_id").value : "").trim();
  if (!id || /\s/.test(id)) {
    toast("Mã hồ sơ (id) bắt buộc và không chứa khoảng trắng.", "err", 4000);
    return;
  }
  const val = (key) => ($(key) && $(key).value ? $(key).value : "");
  const profile = {
    id,
    name: val("pf_name").trim() || id,
    description: val("pf_description").trim(),
    categories: val("pf_categories")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
  // 4 trường text đặc thù ngành (classifyIntro/draftPersona/extractIntro/buildPersona).
  PROFILE_TEXT_FIELDS.forEach((f) => {
    profile[f.key] = val("pf_" + f.key);
  });
  const res = await bg("SAVE_PROMPT_PROFILE", { profile });
  if (res && res.ok) {
    toast("Đã lưu hồ sơ ngành.", "ok", 2600);
    closeEditor();
    await loadProfilesView();
  } else {
    toast((res && res.error) || "Lưu hồ sơ thất bại.", "err", 5000);
  }
}

function deleteProfileUI(id) {
  const p = profiles.find((x) => x.id === id);
  modal({
    title: "Xóa hồ sơ ngành",
    bodyHTML: "<p>Xóa hồ sơ <b>" + esc((p && p.name) || id) + "</b>? Không thể hoàn tác.</p>",
    confirmText: "Xóa",
    danger: true,
    onConfirm: async () => {
      const res = await bg("DELETE_PROMPT_PROFILE", { id });
      if (res && res.ok) {
        toast("Đã xóa hồ sơ.", "ok", 2600);
        await loadProfilesView();
      } else {
        toast((res && res.error) || "Xóa hồ sơ thất bại.", "err", 5000);
      }
    },
  });
}
