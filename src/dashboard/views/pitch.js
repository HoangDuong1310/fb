/**
 * pitch.js — Chào hàng inbox (DM): quản lý hàng đợi tin nhắn chào hàng qua
 * inbox riêng. Triết lý GIỐNG advisory: AI soạn NHÁP, người dùng DUYỆT tay
 * từng tin → hệ thống mới gửi (tạo message job).
 *
 * Dữ liệu nguồn: advisories đã có (status=pending, có authorProfile) — mỗi
 * advisory có thể tạo 1 tin inbox. Người dùng cũng có thể TỰ NHẬP nội dung
 * chào hàng (userPitch) thay vì dùng AI soạn.
 *
 * Luồng:
 *   1. loadPitchView() — nạp danh sách advisory pending có authorProfile.
 *   2. genPitchUI()    — gọi GEN_PITCH (AI soạn nháp inbox) cho 1 advisory.
 *   3. editPitchUI()   — sửa nội dung trước khi duyệt (hoặc tự nhập mới).
 *   4. approvePitchUI() — gọi APPROVE_PITCH → tạo message job (đã có safety).
 *   5. Quota bar: hiển thị số tin đã gửi hôm nay / trần mỗi ngày (15).
 */
import { $, bg, esc, emptyState, toast, modal, colorFor, initials } from "../core.js";
import { advIntentBadge } from "./advisory.js";

// ─── State riêng cho view pitch ───────────────────────────────────────────────
export const pitchStore = {
  list: [],       // advisory[] đủ điều kiện chào hàng inbox
  drafts: {},     // postId → draftMessage (AI hoặc user tự nhập, chưa duyệt)
  todayCount: 0,  // số message job đã tạo hôm nay
  dailyCap: 15,   // trần (sẽ lấy từ bg nếu có)
};

// ─── Load view ────────────────────────────────────────────────────────────────
export async function loadPitchView() {
  await reloadPitches();
}

export async function reloadPitches() {
  // Lấy advisory pending — chỉ giữ những mục có authorProfile (để gửi inbox).
  const res = await bg("GET_ADVISORIES", { status: "pending" });
  const all = (res && res.advisories) || [];
  pitchStore.list = all.filter(
    (a) => a.authorProfile && String(a.authorProfile).trim() !== ""
  );

  // Lấy quota hôm nay
  const qRes = await bg("GET_PITCH_QUOTA");
  if (qRes && qRes.ok) {
    pitchStore.todayCount = qRes.todayCount || 0;
    pitchStore.dailyCap = qRes.dailyCap || 15;
  }

  renderPitches();
}

// ─── Render ───────────────────────────────────────────────────────────────────
export function renderPitches() {
  const wrap = $("pitchList");
  if (!wrap) return;
  const list = pitchStore.list;

  // Quota bar
  const quotaEl = $("pitchQuota");
  if (quotaEl) {
    const remain = Math.max(0, pitchStore.dailyCap - pitchStore.todayCount);
    quotaEl.innerHTML =
      `Hôm nay: <b>${pitchStore.todayCount}</b> / ${pitchStore.dailyCap} tin` +
      (remain === 0
        ? ' — <span class="adv-badge q">Đã đạt trần</span>'
        : ` — còn <b>${remain}</b> tin`);
  }

  // Count pill
  const countEl = $("pitchCount");
  if (countEl) countEl.textContent = `${list.length} khách`;

  if (!list.length) {
    wrap.innerHTML = emptyState(
      "Chưa có khách nào có thể chào hàng inbox",
      "Cần có advisory ở trạng thái chờ duyệt VÀ có link trang cá nhân. Hãy tạo nháp tư vấn trước."
    );
    return;
  }
  wrap.innerHTML = list.map((a) => renderPitchCard(a)).join("");
}

// ─── Card ─────────────────────────────────────────────────────────────────────
export function renderPitchCard(a) {
  const pid = esc(a.postId);
  const author = a.authorName || "Ẩn danh";
  const av = `<span class="adv-avatar" style="background:${colorFor(author)}">${esc(initials(author))}</span>`;
  const draft = pitchStore.drafts[a.postId] || "";
  const hasDraft = !!draft;

  const permaLink = a.permalink
    ? `<a href="${esc(a.permalink)}" target="_blank" rel="noopener">Mở bài gốc</a>`
    : "";
  const profileLink = a.authorProfile
    ? `<a href="${esc(a.authorProfile)}" target="_blank" rel="noopener">Trang cá nhân</a>`
    : "";

  const draftHTML = hasDraft
    ? `<div class="adv-reply-wrap">
         <span class="adv-reply-label">Nháp tin inbox</span>
         <div class="adv-reply">${esc(draft)}</div>
       </div>`
    : "";

  const actions = `
    <button class="btn primary" data-pitch-act="gen" data-id="${pid}">AI soạn nháp inbox</button>
    <button class="btn ghost" data-pitch-act="edit" data-id="${pid}">${hasDraft ? "Sửa nháp" : "Tự nhập nội dung"}</button>
    ${hasDraft ? `<button class="btn primary" data-pitch-act="approve" data-id="${pid}">Duyệt &amp; gửi inbox</button>` : ""}
  `;

  return `
    <div class="adv-card" data-id="${pid}">
      <div class="adv-card-head">
        ${av}
        <div class="adv-author">
          <b>${esc(author)}</b>
          <span class="adv-group">${esc(a.groupName || a.groupId || "")}</span>
        </div>
        <div class="adv-meta">
          ${advIntentBadge(a.intent)}
        </div>
      </div>
      <div class="adv-posttext">${esc(a.postText || "")}</div>
      ${a.reply ? `<div class="adv-reply-wrap"><span class="adv-reply-label">Nháp bình luận (advisory)</span><div class="adv-reply">${esc(a.reply)}</div></div>` : ""}
      ${draftHTML}
      <div class="adv-foot">
        ${profileLink}
        ${permaLink}
      </div>
      <div class="adv-actions">${actions}</div>
    </div>`;
}

// ─── AI soạn nháp inbox ───────────────────────────────────────────────────────
export async function genPitchUI(postId) {
  const a = pitchStore.list.find((x) => x.postId === postId);
  if (!a) return toast("Không tìm thấy advisory.", "err");

  toast("AI đang soạn nháp tin chào hàng inbox...", "info", 6000);
  const res = await bg("GEN_PITCH", {
    postText: a.postText || "",
    authorName: a.authorName || "",
    groupName: a.groupName || a.groupId || "",
  });
  if (res && res.ok && res.message) {
    pitchStore.drafts[postId] = res.message;
    toast("Đã soạn nháp. Xem lại rồi duyệt để gửi inbox.", "ok", 3500);
    renderPitches();
  } else {
    toast((res && res.error) || "AI không soạn được nháp.", "err", 5000);
  }
}

// ─── Sửa / tự nhập nội dung ──────────────────────────────────────────────────
export function editPitchUI(postId) {
  const a = pitchStore.list.find((x) => x.postId === postId);
  if (!a) return;
  const current = pitchStore.drafts[postId] || "";
  modal({
    title: "Nội dung chào hàng inbox",
    bodyHTML:
      `<p class="hint">Nhập hoặc chỉnh sửa nội dung tin nhắn inbox gửi tới <b>${esc(a.authorName || "khách")}</b>.</p>` +
      `<label class="field"><span>Nội dung tin nhắn</span>` +
      `<textarea id="pitchEditText" rows="6">${esc(current)}</textarea></label>` +
      `<p class="hint">Duyệt xong sẽ tạo lịch gửi inbox tự động (qua Messenger trên Facebook).</p>`,
    confirmText: "Lưu nháp",
    onConfirm: () => {
      const text = (($("pitchEditText") && $("pitchEditText").value) || "").trim();
      if (!text) {
        toast("Nội dung trống.", "err");
        return;
      }
      pitchStore.drafts[postId] = text;
      toast("Đã lưu nháp inbox.", "ok");
      renderPitches();
    },
  });
}

// ─── Duyệt & gửi inbox ──────────────────────────────────────────────────────
export function approvePitchUI(postId) {
  const a = pitchStore.list.find((x) => x.postId === postId);
  if (!a) return;
  const message = pitchStore.drafts[postId] || "";
  if (!message) return toast("Chưa có nháp. Hãy soạn nháp trước.", "err");

  modal({
    title: "Duyệt & gửi chào hàng inbox",
    bodyHTML:
      `<p>Gửi tin nhắn inbox (Messenger) tới <b>${esc(a.authorName || "khách")}</b>?</p>` +
      `<div class="cv-modal-reply">${esc(message)}</div>` +
      `<p class="hint">Tin nhắn sẽ được đưa vào hàng đợi và gửi tự động qua DOM.</p>`,
    confirmText: "Duyệt & gửi",
    onConfirm: async () => {
      const res = await bg("APPROVE_PITCH", {
        message,
        authorProfile: a.authorProfile || "",
        authorName: a.authorName || "",
        postId: a.postId || "",
        groupId: a.groupId || "",
        groupName: a.groupName || "",
        postText: a.postText || "",
      });
      if (res && res.ok) {
        toast("Đã tạo lịch gửi inbox. Job #" + res.jobId, "ok");
        delete pitchStore.drafts[postId];
        await reloadPitches();
      } else {
        toast((res && res.error) || "Không tạo được lịch gửi.", "err", 5000);
      }
    },
  });
}
