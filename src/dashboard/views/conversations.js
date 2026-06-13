/**
 * conversations.js — Hội thoại bình luận: theo dõi REPLY của khách dưới các bình
 * luận của ta, rồi để AI soạn NHÁP phản hồi hỗ trợ. Đúng triết lý an toàn của dự
 * án: AI chỉ tạo NHÁP, NGƯỜI DÙNG duyệt thì mới đăng (tạo comment job).
 *
 * Dữ liệu lấy từ store `conversations` (DB v5 — chỉ THÊM, không đụng dữ liệu cũ).
 * Mỗi hội thoại tạo ra khi một comment job chạy xong; theo dõi nền (alarm
 * watchReplies) gom reply mới vào mảng replies (merge, không ghi đè).
 */
import { $, bg, esc, emptyState, toast, modal, timeAgo, colorFor, initials } from "../core.js";
import { fmtPrice } from "./products.js";

// State riêng cho view. status = tab đang xem ("" = tất cả).
export const conversationStore = {
  status: "",
  list: [],
};

// Nhãn trạng thái hội thoại sang tiếng Việt.
const STATUS_LABEL = {
  watching: "Đang theo dõi",
  replied: "Có phản hồi mới",
  drafted: "Đã soạn nháp",
  closed: "Đã đóng",
};

export async function loadConversationsView() {
  syncConvTabs();
  await reloadConversations();
  await loadWatchConfig();
}

export async function reloadConversations() {
  const res = await bg("GET_CONVERSATIONS", { status: conversationStore.status });
  conversationStore.list = (res && res.conversations) || [];
  renderConversations();
}

export function syncConvTabs() {
  const tabs = $("convStatusTabs");
  if (!tabs) return;
  tabs
    .querySelectorAll("[data-status]")
    .forEach((b) => b.classList.toggle("active", b.dataset.status === conversationStore.status));
}

// Khôi phục + hiển thị cấu hình theo dõi reply nền.
export async function loadWatchConfig() {
  const res = await bg("GET_WATCH_CONFIG");
  const cfg = (res && res.config) || {};
  if ($("watchEnabled")) $("watchEnabled").checked = !!cfg.enabled;
  if ($("watchInterval")) $("watchInterval").value = cfg.intervalMinutes || 30;
}

export async function saveWatchConfig() {
  const enabled = !!($("watchEnabled") && $("watchEnabled").checked);
  const intervalMinutes = parseInt(($("watchInterval") && $("watchInterval").value) || "30", 10);
  const res = await bg("SET_WATCH_CONFIG", { config: { enabled, intervalMinutes } });
  if (res && res.ok) toast("Đã lưu cấu hình theo dõi reply.", "ok", 1800);
}

// Quét reply ngay (thủ công) cho tất cả hội thoại đang theo dõi.
export async function watchNow() {
  const btn = $("btnWatchNow");
  if (btn) { btn.disabled = true; btn.textContent = "Đang quét..."; }
  toast("Đang quét phản hồi mới...", "info", 4000);
  const res = await bg("WATCH_REPLIES_NOW", {});
  if (btn) { btn.disabled = false; btn.textContent = "Quét phản hồi ngay"; }
  if (res && res.ok) {
    if (res.noParent && !res.newReplies) {
      toast(
        `Đã quét ${res.checked || 0} hội thoại nhưng KHÔNG định vị được bình luận của bạn trên ${res.noParent} hội thoại. Kiểm tra lại nội dung bình luận đã nhập có khớp đúng không.`,
        "err",
        7000
      );
    } else {
      toast(`Đã quét ${res.checked || 0} hội thoại, +${res.newReplies || 0} phản hồi mới.`, "ok", 4000);
    }
    await reloadConversations();
  } else {
    toast((res && res.error) || "Không quét được.", "err", 5000);
  }
}

// Đăng ký THỦ CÔNG theo dõi một bình luận ta đã đăng tay trên Facebook.
export function trackConversationUI() {
  modal({
    title: "Theo dõi bình luận của tôi",
    bodyHTML:
      `<p class="hint">Dùng khi bạn đã bình luận TAY trên Facebook (không qua việc bình luận của tiện ích). Dán link bài viết và nội dung bình luận của bạn để dò các phản hồi.</p>` +
      `<label class="field"><span>Link bài viết / bình luận</span>` +
      `<input id="trackUrl" type="text" placeholder="https://www.facebook.com/groups/.../posts/..." /></label>` +
      `<label class="field"><span>Nội dung bình luận của bạn</span>` +
      `<textarea id="trackComment" rows="3" placeholder="Dán nguyên văn bình luận của bạn..."></textarea></label>`,
    confirmText: "Bắt đầu theo dõi",
    onConfirm: async () => {
      const url = (document.getElementById("trackUrl") || {}).value || "";
      const myComment = (document.getElementById("trackComment") || {}).value || "";
      if (!url.trim()) return toast("Cần nhập link bài viết.", "err");
      if (!myComment.trim()) return toast("Cần nhập nội dung bình luận của bạn.", "err");
      toast("Đang tạo & quét hội thoại...", "info", 6000);
      const res = await bg("TRACK_CONVERSATION", { url: url.trim(), myComment: myComment.trim() });
      if (res && res.ok) {
        const added = (res.watch && res.watch.newReplies) || 0;
        toast(`Đã thêm hội thoại. Tìm thấy ${added} phản hồi.`, "ok", 4000);
        await reloadConversations();
      } else {
        toast((res && res.error) || "Không tạo được hội thoại.", "err", 5000);
      }
    },
  });
}

export function renderConversations() {
  const wrap = $("conversationList");
  if (!wrap) return;
  const list = conversationStore.list;
  const countEl = $("convCount");
  if (countEl) countEl.textContent = `${list.length} hội thoại`;
  if (!list.length) {
    wrap.innerHTML = emptyState(
      "Chưa có hội thoại nào",
      "Khi một việc bình luận chạy xong, hội thoại sẽ xuất hiện ở đây để theo dõi phản hồi."
    );
    return;
  }
  wrap.innerHTML = list.map((c) => renderConversationCard(c)).join("");
}

function renderConversationCard(c) {
  const id = c.id;
  const replies = Array.isArray(c.replies) ? c.replies : [];
  const statusLabel = STATUS_LABEL[c.status] || c.status || "—";
  const repliesHTML = replies.length
    ? replies
        .map((r) => {
          const who = r.author || "Người dùng";
          const av = `<span class="cv-avatar" style="background:${colorFor(who)}">${esc(initials(who))}</span>`;
          const when = r.seenAt ? `<span class="cv-when">${esc(timeAgo(r.seenAt))}</span>` : "";
          return `<div class="cv-reply">${av}<div class="cv-reply-body"><b>${esc(who)}</b> ${when}<div>${esc(r.text || "")}</div></div></div>`;
        })
        .join("")
    : `<div class="cv-noreply">Chưa có phản hồi nào dưới bình luận này.</div>`;

  const draft = c.draft;
  const draftHTML = draft && draft.reply
    ? `<div class="cv-draft-wrap">
         <span class="cv-draft-label">Nháp phản hồi (AI soạn)${draft.needsHumanCheck ? ' <span class="cv-flag">⚠ cần kiểm tra</span>' : ""}</span>
         <textarea class="cv-draft" data-draft="${id}" rows="3">${esc(draft.reply)}</textarea>
         ${draft.checkNote ? `<div class="cv-checknote">${esc(draft.checkNote)}</div>` : ""}
       </div>`
    : "";

  const hasReplies = replies.length > 0;
  const canApprove = !!(draft && draft.reply);
  const link = c.myCommentUrl || c.postUrl;
  const openLink = link
    ? `<a href="${esc(link)}" target="_blank" rel="noopener">Mở trên Facebook</a>`
    : "";

  const actions = [
    hasReplies
      ? `<button class="btn primary" data-cv-act="draft" data-id="${id}">AI soạn nháp</button>`
      : "",
    canApprove
      ? `<button class="btn primary" data-cv-act="approve" data-id="${id}">Duyệt &amp; đăng</button>`
      : "",
    `<button class="btn ghost" data-cv-act="close" data-id="${id}">${c.status === "closed" ? "Mở lại" : "Đóng"}</button>`,
    `<button class="btn danger-ghost" data-cv-act="del" data-id="${id}">Xóa</button>`,
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="cv-card${c.status === "replied" ? " has-new" : ""}" data-id="${id}">
      <div class="cv-head">
        <span class="cv-status ${esc(c.status || "")}">${esc(statusLabel)}</span>
        <span class="cv-group">${esc(c.groupName || c.groupId || "")}</span>
        <span class="cv-count">${replies.length} phản hồi</span>
      </div>
      ${c.postText ? `<div class="cv-posttext">${esc(c.postText)}</div>` : ""}
      <div class="cv-mycomment"><span class="cv-mc-label">Bình luận của bạn</span><div>${esc(c.myComment || "")}</div></div>
      <div class="cv-replies">${repliesHTML}</div>
      ${draftHTML}
      <div class="cv-foot">${openLink}</div>
      <div class="cv-actions">${actions}</div>
    </div>`;
}

// AI soạn nháp phản hồi cho 1 hội thoại.
export async function draftConvReplyUI(id) {
  toast("AI đang soạn nháp phản hồi...", "info", 6000);
  const res = await bg("DRAFT_CONV_REPLY", { id: Number(id) });
  if (res && res.ok) {
    toast("Đã soạn nháp. Xem lại rồi duyệt để đăng.", "ok", 3500);
    await reloadConversations();
  } else {
    toast((res && res.error) || "AI không soạn được nháp.", "err", 5000);
  }
}

// Duyệt nháp -> tạo comment job đăng phản hồi (lấy nội dung đã chỉnh tay nếu có).
export async function approveConvReplyUI(id) {
  const ta = document.querySelector(`textarea.cv-draft[data-draft="${id}"]`);
  const reply = ta ? ta.value.trim() : "";
  if (!reply) return toast("Nháp rỗng, không thể đăng.", "err");
  modal({
    title: "Duyệt & đăng phản hồi",
    bodyHTML:
      `<p>Đưa phản hồi này vào hàng đợi để tự động đăng lên Facebook?</p>` +
      `<div class="cv-modal-reply">${esc(reply)}</div>`,
    confirmText: "Đăng phản hồi",
    onConfirm: async () => {
      const res = await bg("APPROVE_CONV_REPLY", { id: Number(id), reply });
      if (res && res.ok) toast("Đã đưa phản hồi vào hàng đợi bình luận.", "ok");
      else toast((res && res.error) || "Không tạo được việc.", "err", 5000);
      await reloadConversations();
    },
  });
}

// Đóng / mở lại theo dõi một hội thoại.
export async function toggleConvClose(id) {
  const conv = conversationStore.list.find((c) => c.id === Number(id));
  const nextStatus = conv && conv.status === "closed" ? "watching" : "closed";
  await bg("UPDATE_CONVERSATION", { id: Number(id), patch: { status: nextStatus } });
  await reloadConversations();
}

export function deleteConvUI(id) {
  modal({
    title: "Xóa hội thoại",
    bodyHTML: `<p>Xóa hội thoại này khỏi danh sách theo dõi? (Không ảnh hưởng bình luận trên Facebook.)</p>`,
    confirmText: "Xóa",
    danger: true,
    onConfirm: async () => {
      await bg("DELETE_CONVERSATION", { id: Number(id) });
      toast("Đã xóa hội thoại.", "ok");
      await reloadConversations();
    },
  });
}

// fmtPrice được import để dùng khi mở rộng hiển thị sản phẩm trích dẫn về sau.
void fmtPrice;
