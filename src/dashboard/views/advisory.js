/**
 * Tư vấn AI: quản lý các nháp tư vấn (advisory drafts) sinh từ bài đã crawl.
 * Mặc định CHỈ tạo nháp (DRAFT) — người dùng duyệt tay trước khi gửi.
 */
import { $, bg, store, esc, emptyState, toast, modal, colorFor, initials } from "../core.js";
import { uiPref, saveUIPref } from "../prefs.js";
import { fmtPrice } from "./products.js";

// State riêng cho view tư vấn. status = tab đang xem (pending/sent/rejected/"").
export const advisoryStore = {
  status: "pending",
  list: [],
};

// Nạp view: đổ danh sách nhóm vào ô lọc + tải nháp theo tab hiện tại.
export async function loadAdvisoryView() {
  const sel = $("advGroupFilter");
  if (sel) {
    const cur = sel.value || uiPref("advGroupId", "");
    const opts = store.groups
      .map((g) => `<option value="${esc(g.groupId)}">${esc(g.groupName || g.groupId)}</option>`)
      .join("");
    sel.innerHTML = `<option value="">Tất cả nhóm</option>` + opts;
    if (cur && sel.querySelector(`option[value="${cur}"]`)) sel.value = cur;
  }
  // Khôi phục các tùy chọn quét đã lưu (giữ nguyên sau F5).
  if ($("advScanLimit")) $("advScanLimit").value = uiPref("advScanLimit", 60);
  if ($("advMaxPerGroup")) $("advMaxPerGroup").value = uiPref("advMaxPerGroup", 5);
  syncAdvTabs();
  await reloadAdvisories();
}

export async function reloadAdvisories() {
  const res = await bg("GET_ADVISORIES", { status: advisoryStore.status });
  advisoryStore.list = (res && res.advisories) || [];
  renderAdvisories();
}

export function syncAdvTabs() {
  const tabs = $("advStatusTabs");
  if (!tabs) return;
  tabs
    .querySelectorAll("[data-status]")
    .forEach((b) => b.classList.toggle("active", b.dataset.status === advisoryStore.status));
}

export function advIntentBadge(intent) {
  if (intent === "buy") return `<span class="adv-badge buy">Nhu cầu mua</span>`;
  if (intent === "question") return `<span class="adv-badge q">Câu hỏi</span>`;
  return `<span class="adv-badge">${esc(intent || "—")}</span>`;
}

export function renderAdvisories() {
  const wrap = $("advisoryList");
  if (!wrap) return;
  const list = advisoryStore.list;
  const countEl = $("advCount");
  if (countEl) countEl.textContent = `${list.length} nháp`;
  if (!list.length) {
    wrap.innerHTML = emptyState("Chưa có nháp nào", 'Bấm "Tạo nháp tư vấn" để AI soạn nháp từ bài đã crawl.');
    return;
  }
  wrap.innerHTML = list.map((a) => renderAdvisoryCard(a)).join("");
}

export function renderAdvisoryCard(a) {
  const pid = esc(a.postId);
  const products = (a.usedProducts || [])
    .map((p) => {
      const price = p.price ? fmtPrice(p.price) : p.buildPrice ? fmtPrice(p.buildPrice) : "—";
      const link = p.url ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener">xem</a>` : "";
      return `<li><span class="adv-prod-name">${esc(p.name || "(không tên)")}</span> — <b>${price}</b> <span class="adv-prod-src">${esc(p.source || "")}</span>${link}</li>`;
    })
    .join("");
  const warn = a.needsHumanCheck
    ? `<div class="adv-warn">⚠️ Cần kiểm tra tay: ${esc(a.checkNote || "có số liệu cần xác minh")}</div>`
    : "";
  const conf = a.confidence != null ? `${Math.round(a.confidence * 100)}%` : "—";
  const isPending = a.status === "pending";
  const statusLabel = a.status === "sent" ? "Đã gửi" : a.status === "rejected" ? "Đã bỏ" : "Chờ duyệt";
  const permaLink = a.permalink
    ? `<a href="${esc(a.permalink)}" target="_blank" rel="noopener">Mở bài gốc</a>`
    : "";
  const actions = isPending
    ? `
        <button class="btn primary" data-adv-act="approve" data-id="${pid}">Duyệt &amp; gửi</button>
        <button class="btn ghost" data-adv-act="edit" data-id="${pid}">Sửa</button>
        <button class="btn danger-ghost" data-adv-act="reject" data-id="${pid}">Bỏ</button>
        <button class="btn danger-ghost" data-adv-act="del" data-id="${pid}">Xóa</button>`
    : `
        <button class="btn danger-ghost" data-adv-act="del" data-id="${pid}">Xóa</button>`;
  const author = a.authorName || "Ẩn danh";
  const av = `<span class="adv-avatar" style="background:${colorFor(author)}">${esc(initials(author))}</span>`;
  return `
    <div class="adv-card${a.needsHumanCheck ? " flagged" : ""}" data-id="${pid}">
      <div class="adv-card-head">
        ${av}
        <div class="adv-author">
          <b>${esc(author)}</b>
          <span class="adv-group">${esc(a.groupName || a.groupId || "")}</span>
        </div>
        <div class="adv-meta">
          ${advIntentBadge(a.intent)}
          <span class="adv-status ${esc(a.status)}">${statusLabel}</span>
        </div>
      </div>
      <div class="adv-posttext">${esc(a.postText || "")}</div>
      <div class="adv-reply-wrap">
        <span class="adv-reply-label">Nháp trả lời</span>
        <div class="adv-reply">${esc(a.reply || "")}</div>
      </div>
      ${products ? `<div class="adv-prod-title">Sản phẩm trích dẫn</div><ul class="adv-products">${products}</ul>` : ""}
      ${warn}
      <div class="adv-foot">
        <span class="adv-conf">Độ tự tin: ${conf}</span>
        ${permaLink}
      </div>
      <div class="adv-actions">${actions}</div>
    </div>`;
}

export async function genAdvisories() {
  const btn = $("btnGenAdvisories");
  const num = (id, def, min, max) => {
    const v = parseInt(($(id) && $(id).value) || "", 10);
    if (!Number.isFinite(v)) return def;
    return Math.min(max, Math.max(min, v));
  };
  const options = {
    groupId: ($("advGroupFilter") && $("advGroupFilter").value) || "",
    scanLimit: num("advScanLimit", 60, 1, 300),
    maxPerGroup: num("advMaxPerGroup", 5, 1, 50),
  };
  // Lưu lại tùy chọn để lần sau giữ nguyên.
  saveUIPref("advGroupId", options.groupId);
  saveUIPref("advScanLimit", options.scanLimit);
  saveUIPref("advMaxPerGroup", options.maxPerGroup);
  const prog = $("advProgress");
  if (btn) btn.disabled = true;
  if (prog) {
    prog.hidden = false;
    prog.textContent = "Đang quét bài và soạn nháp... vui lòng chờ.";
  }
  const res = await bg("GEN_ADVISORIES", { options });
  if (btn) btn.disabled = false;
  if (!res || !res.ok) {
    if (prog) prog.textContent = (res && res.error) || "Tạo nháp thất bại.";
    toast((res && res.error) || "Tạo nháp thất bại.", "err");
    return;
  }
  if (prog) {
    prog.textContent =
      `Đã quét ${res.scanned} bài → tạo ${res.created} nháp ` +
      `(cần kiểm tra: ${res.flagged}, bỏ qua đã có: ${res.skippedExisting}, ` +
      `không khớp ý định: ${res.ignored}, không có hàng: ${res.noProduct}).`;
  }
  toast(`Đã tạo ${res.created} nháp tư vấn.`, "ok");
  advisoryStore.status = "pending";
  syncAdvTabs();
  await reloadAdvisories();
}

export function editAdvisory(postId) {
  const a = advisoryStore.list.find((x) => x.postId === postId);
  if (!a) return;
  modal({
    title: "Sửa nội dung nháp",
    bodyHTML: `
      <label class="field"><span>Nội dung bình luận sẽ gửi</span>
        <textarea id="advEditText" rows="6">${esc(a.reply || "")}</textarea>
      </label>
      <p class="hint">Kiểm tra kỹ giá và thông tin trước khi duyệt. Hệ thống không tự sửa giá.</p>`,
    confirmText: "Lưu",
    onConfirm: async () => {
      const text = (($("advEditText") && $("advEditText").value) || "").trim();
      if (!text) {
        toast("Nội dung trống.", "err");
        return;
      }
      const res = await bg("UPDATE_ADVISORY", { postId, patch: { reply: text } });
      if (!res || !res.ok) {
        toast((res && res.error) || "Lưu thất bại.", "err");
        return;
      }
      toast("Đã lưu nháp.", "ok");
      await reloadAdvisories();
    },
  });
}

export function approveAdvisoryUI(postId) {
  const a = advisoryStore.list.find((x) => x.postId === postId);
  const doApprove = async () => {
    const res = await bg("APPROVE_ADVISORY", { postId });
    if (!res || !res.ok) {
      toast((res && res.error) || "Duyệt thất bại.", "err");
      return;
    }
    toast("Đã duyệt → đã tạo lịch bình luận.", "ok");
    await reloadAdvisories();
  };
  if (a && a.needsHumanCheck) {
    modal({
      title: "Nháp cần kiểm tra tay",
      bodyHTML: `<p>${esc(a.checkNote || "Có số liệu cần xác minh.")}</p><p>Bạn chắc chắn muốn duyệt và tạo lịch gửi?</p>`,
      confirmText: "Vẫn duyệt & gửi",
      danger: true,
      onConfirm: doApprove,
    });
    return;
  }
  modal({
    title: "Duyệt & gửi",
    bodyHTML: `<p>Tạo lịch đăng bình luận này vào bài gốc? Bình luận sẽ được gửi theo hàng đợi tự động.</p>`,
    confirmText: "Duyệt & gửi",
    onConfirm: doApprove,
  });
}

export async function rejectAdvisoryUI(postId) {
  const res = await bg("REJECT_ADVISORY", { postId });
  if (!res || !res.ok) {
    toast((res && res.error) || "Thất bại.", "err");
    return;
  }
  toast("Đã bỏ nháp.", "ok");
  await reloadAdvisories();
}

export function deleteAdvisoryUI(postId) {
  modal({
    title: "Xóa nháp",
    bodyHTML: `<p>Xóa hẳn nháp này khỏi danh sách?</p>`,
    confirmText: "Xóa",
    danger: true,
    onConfirm: async () => {
      await bg("DELETE_ADVISORY", { postId });
      await reloadAdvisories();
      toast("Đã xóa nháp.", "ok");
    },
  });
}

export function clearAdvisoriesUI() {
  const label =
    advisoryStore.status === "pending"
      ? "chờ duyệt"
      : advisoryStore.status === "sent"
      ? "đã gửi"
      : advisoryStore.status === "rejected"
      ? "đã bỏ"
      : "tất cả";
  modal({
    title: "Xóa nháp đang xem",
    bodyHTML: `<p>Xóa toàn bộ nháp ở mục "${esc(label)}"? Không thể hoàn tác.</p>`,
    confirmText: "Xóa",
    danger: true,
    onConfirm: async () => {
      const res = await bg("CLEAR_ADVISORIES", { status: advisoryStore.status });
      toast(`Đã xóa ${res && res.deleted != null ? res.deleted : ""} nháp.`, "ok");
      await reloadAdvisories();
    },
  });
}
