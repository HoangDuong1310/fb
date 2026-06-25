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
      // Ghép thêm dữ liệu chẩn đoán (nếu có) để user biết VÌ SAO trượt:
      //  - commentAnchors: số bình luận FB đã tải trên trang (0 => sai link
      //    hoặc trang chưa tải kịp khu vực bình luận).
      //  - bestSoftScore: % từ trùng cao nhất giữa text đã dán và bình luận
      //    trên trang (cao mà <70 => text dán lệch; 0 => không thấy text nào).
      const d = res.diag;
      let extra = "";
      if (d) {
        if (!d.commentAnchors) {
          extra = " (Trang không có bình luận nào tải được — kiểm tra link có đúng bài/bình luận và thử lại sau khi trang tải xong.)";
        } else {
          extra =
            ` (Thấy ${d.commentAnchors} bình luận trên trang, khớp cao nhất ${d.bestSoftScore || 0}% từ.` +
            (d.needlePreview ? ` Text dò: "${d.needlePreview}".` : "") +
            ` Hãy dán đúng NGUYÊN VĂN bình luận của bạn.)`;
        }
      }
      toast(
        `Đã quét ${res.checked || 0} hội thoại nhưng KHÔNG định vị được bình luận của bạn trên ${res.noParent} hội thoại.${extra}`,
        "err",
        9000
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
      `<p class="hint">Dùng khi bạn đã bình luận TAY trên Facebook (không qua việc bình luận của tiện ích). Cách CHÍNH XÁC nhất: mở bình luận của bạn trên FB, bấm vào thời gian để lấy link có <code>comment_id=</code> rồi dán vào đây — khỏi cần nhập nội dung. Nếu link không có <code>comment_id=</code> thì nhập nội dung bình luận để dò.</p>` +
      `<label class="field"><span>Link bài viết / bình luận</span>` +
      `<input id="trackUrl" type="text" placeholder="https://www.facebook.com/groups/.../posts/...?comment_id=..." /></label>` +
      `<label class="field"><span>Nội dung bình luận của bạn (không bắt buộc nếu link có comment_id)</span>` +
      `<textarea id="trackComment" rows="3" placeholder="Dán nguyên văn bình luận của bạn..."></textarea></label>`,
    confirmText: "Bắt đầu theo dõi",
    onConfirm: async () => {
      const url = (document.getElementById("trackUrl") || {}).value || "";
      const myComment = (document.getElementById("trackComment") || {}).value || "";
      if (!url.trim()) return toast("Cần nhập link bài viết.", "err");
      // Cần MỘT trong hai: link có comment_id (định vị chính xác) HOẶC nội dung
      // bình luận (dò mềm). Có comment_id thì khỏi bắt nhập nội dung.
      const hasCommentId = /[?&]comment_id=\d+/.test(url);
      if (!hasCommentId && !myComment.trim()) {
        return toast("Link không có comment_id — hãy dán link bình luận của bạn hoặc nhập nội dung bình luận để dò.", "err");
      }
      toast("Đang tạo & quét hội thoại...", "info", 6000);
      const res = await bg("TRACK_CONVERSATION", { url: url.trim(), myComment: myComment.trim() });
      if (res && res.ok) {
        const added = (res.watch && res.watch.newReplies) || 0;
        if (added > 0) {
          toast(`Đã thêm hội thoại. Tìm thấy ${added} phản hồi.`, "ok", 4000);
        } else {
          // 0 reply: nêu rõ VÌ SAO dựa trên chẩn đoán của trình quét. Giúp phân
          // biệt "chưa ai trả lời" với "link không khớp / reply chưa kịp tải".
          const d = (res.watch && res.watch.diag) || null;
          let why = "Chưa thấy phản hồi nào.";
          if (d) {
            if (d.noParent) {
              why =
                `Không định vị được bình luận của bạn trên trang ` +
                `(thấy ${d.commentAnchors || 0} bình luận, khớp mềm cao nhất ${d.bestSoftScore || 0}%). ` +
                `Hãy dùng link có comment_id= hoặc dán đúng nội dung bình luận.`;
            } else if ((d.replyAnchorsTotal || 0) === 0) {
              why =
                "Trang chưa tải được phản hồi nào (tab nền có thể chưa kịp render). " +
                "Thử quét lại sau ít phút.";
            } else if ((d.replyAnchorsMatched || 0) === 0) {
              const others = (d.otherParents || []).join(", ");
              why =
                `Thấy ${d.replyAnchorsTotal} phản hồi trên trang nhưng KHÔNG cái nào thuộc ` +
                `bình luận của bạn (comment_id=${d.parentId || "?"})` +
                (others ? `. Các bình luận khác có phản hồi: ${others}` : "") +
                ". Có thể link trỏ sai bình luận.";
            } else {
              why = "Đã định vị bình luận của bạn nhưng chưa ai trả lời.";
            }
          }
          toast(`Đã thêm hội thoại. ${why}`, "info", 8000);
        }
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
  // Một hội thoại là chuỗi QUA LẠI: lượt của BẠN (r.mine) đứng một bên, lượt của
  // KHÁCH đứng bên kia — dựng như bong bóng chat để đọc đúng mạch, thay vì một
  // danh sách phẳng trông như "chỉ một reply". Số đếm chỉ tính lượt của KHÁCH.
  const repliesHTML = replies.length
    ? replies
        .map((r) => {
          const mine = !!r.mine;
          const who = mine ? "Bạn" : (r.author || "Người dùng");
          const av = `<span class="cv-avatar" style="background:${colorFor(who)}">${esc(initials(who))}</span>`;
          const when = r.seenAt ? `<span class="cv-when">${esc(timeAgo(r.seenAt))}</span>` : "";
          return `<div class="cv-reply${mine ? " mine" : ""}">${av}<div class="cv-reply-body"><b>${esc(who)}</b> ${when}<div>${esc(r.text || "")}</div></div></div>`;
        })
        .join("")
    : `<div class="cv-noreply">Chưa có phản hồi nào dưới bình luận này.</div>`;
  const guestList = replies.filter((r) => !r.mine);
  const guestReplies = guestList.length;
  // Gom NHÓM phản hồi của khách theo TÊN người để biết có MẤY người khác nhau
  // cùng trả lời dưới bình luận của ta. Mỗi người -> 1 nút "AI soạn cho <Tên>"
  // mang theo id của reply MỚI NHẤT của họ (data-target-reply) để soạn đúng mạch.
  const guestByAuthor = new Map();
  for (const r of guestList) {
    const who = (r.author || "Người dùng").trim() || "Người dùng";
    // Reply duyệt theo thứ tự -> ghi đè để giữ id MỚI NHẤT của mỗi người.
    guestByAuthor.set(who, { author: who, replyId: r.id });
  }
  const distinctGuests = [...guestByAuthor.values()];

  const draft = c.draft;
  const draftTarget = draft && draft.targetAuthor ? String(draft.targetAuthor) : "";
  const draftHTML = draft && draft.reply
    ? `<div class="cv-draft-wrap">
         <span class="cv-draft-label">Nháp phản hồi (AI soạn)${draftTarget ? ` cho <b>@${esc(draftTarget)}</b>` : ""}${draft.needsHumanCheck ? ' <span class="cv-flag">⚠ cần kiểm tra</span>' : ""}</span>
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

  // Khi NHIỀU người khác nhau cùng trả lời -> hiện 1 nút cho TỪNG người để ta
  // chọn soạn AI rep ĐÚNG người nào (kèm targetReplyId). Một người -> 1 nút gọn.
  const draftButtons = !hasReplies
    ? ""
    : distinctGuests.length > 1
    ? distinctGuests
        .map(
          (g) =>
            `<button class="btn primary" data-cv-act="draft" data-id="${id}" data-target-reply="${esc(String(g.replyId))}">AI soạn cho @${esc(g.author)}</button>`
        )
        .join("")
    : `<button class="btn primary" data-cv-act="draft" data-id="${id}">AI soạn nháp</button>`;

  const actions = [
    draftButtons,
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
        <span class="cv-count">${guestReplies} phản hồi của khách</span>
      </div>
      ${c.postText ? `<div class="cv-posttext">${esc(c.postText)}</div>` : ""}
      <div class="cv-mycomment"><span class="cv-mc-label">Bình luận của bạn</span><div>${esc(c.myComment || "")}</div></div>
      <div class="cv-replies">${repliesHTML}</div>
      ${draftHTML}
      <div class="cv-foot">${openLink}</div>
      <div class="cv-actions">${actions}</div>
    </div>`;
}

// AI soạn nháp phản hồi cho 1 hội thoại. targetReplyId (tuỳ chọn): khi NHIỀU
// người cùng trả lời, UI truyền id reply của người được chọn để AI soạn ĐÚNG
// người đó (và tag tên họ ở đầu phản hồi).
export async function draftConvReplyUI(id, targetReplyId) {
  toast("AI đang soạn nháp phản hồi...", "info", 6000);
  const payload = { id: Number(id) };
  if (targetReplyId != null && targetReplyId !== "") payload.targetReplyId = String(targetReplyId);
  const res = await bg("DRAFT_CONV_REPLY", payload);
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
