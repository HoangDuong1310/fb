/**
 * views/posts.js — Tab Bài viết: lọc theo nhóm, tìm kiếm, xuất JSON/CSV, xóa,
 * tạo nhanh job bình luận, và "AI phân tích" một bài (soạn nháp trả lời).
 */

import { $, bg, store, toast, modal, esc, colorFor, initials, timeAgo, emptyState } from "../core.js";
import { uiPref, saveUIPref } from "../prefs.js";
import {
  classifyLead,
  matchLeadMode,
  LEAD_META,
  mineKeywordCandidates,
  addLeadKeyword,
} from "../leadfilter.js";
import { fmtPrice } from "./products.js";
import { switchView } from "../nav.js";
import {
  advisoryStore,
  syncAdvTabs,
  reloadAdvisories,
  advIntentBadge,
} from "./advisory.js";

/* =============================== BÀI VIẾT ============================== */
export async function loadPosts() {
  const sel = $("postsGroupFilter");
  // Khôi phục bộ lọc nhóm đã lưu (lần đầu vào tab, khi select còn rỗng).
  if (sel && !sel.value) {
    const saved = uiPref("postsGroupId", "");
    if (saved && sel.querySelector(`option[value="${saved}"]`)) sel.value = saved;
  }
  const groupId = (sel && sel.value) || "";
  store.postsGroupId = groupId;
  saveUIPref("postsGroupId", groupId);
  const res = await bg("GET_ALL_POSTS", { groupId });
  store.posts = (res && res.posts) || [];
  renderPosts();
}

// Chế độ lọc thông minh hiện tại: all | lead | buy | support.
export function applyLeadMode(mode) {
  store.postsLeadMode = mode || "all";
  saveUIPref("postsLeadMode", store.postsLeadMode);
  const box = $("postsLeadToggle");
  if (box) {
    box.querySelectorAll("button[data-lead]").forEach((b) => {
      b.classList.toggle("active", b.dataset.lead === store.postsLeadMode);
    });
  }
  renderPosts();
}

export function renderPosts() {
  const term = ($("postSearch").value || "").toLowerCase();
  // Khôi phục chế độ lọc đã lưu (lần đầu render khi state còn rỗng).
  if (store.postsLeadMode == null) {
    store.postsLeadMode = uiPref("postsLeadMode", "all");
    const box = $("postsLeadToggle");
    if (box) {
      box.querySelectorAll("button[data-lead]").forEach((b) => {
        b.classList.toggle("active", b.dataset.lead === store.postsLeadMode);
      });
    }
  }
  const mode = store.postsLeadMode || "all";
  const all = store.posts;
  const list = all.filter((p) => {
    // Lọc thông minh theo phân loại nhu cầu (chạy trên máy, không gọi AI).
    if (mode !== "all") {
      const lead = classifyLead(p.text || "");
      if (!matchLeadMode(lead.label, mode)) return false;
    }
    if (!term) return true;
    return (
      (p.text || "").toLowerCase().includes(term) ||
      (p.authorName || "").toLowerCase().includes(term)
    );
  });
  // Thanh tóm tắt: tổng số bài + đang hiển thị (giúp người dùng bao quát).
  const countEl = $("postsCount");
  if (countEl) {
    const filtered = term || mode !== "all";
    countEl.textContent = filtered
      ? `${list.length} / ${all.length} bài`
      : `${all.length} bài`;
  }
  const wrap = $("postsWrap");
  if (!list.length) {
    wrap.innerHTML = emptyState(
      all.length ? "Không khớp tìm kiếm" : "Chưa có bài viết",
      all.length ? "Thử từ khóa khác hoặc xóa ô tìm kiếm." : "Hãy crawl một nhóm hoặc đổi bộ lọc."
    );
    return;
  }
  wrap.innerHTML = list
    .map((p) => {
      const imgs = p.images || [];
      const thumbs = imgs
        .slice(0, 4)
        .map((src) => `<img src="${esc(src)}" loading="lazy" />`)
        .join("");
      const more = imgs.length > 4 ? `<span class="pc-more">+${imgs.length - 4}</span>` : "";
      const text = p.text || "";
      const isLong = text.length > 280;
      const author = p.authorName || "Không rõ";
      const av = `<span class="pc-avatar" style="background:${colorFor(author)}">${esc(initials(author))}</span>`;
      // Phân loại nhu cầu (chạy trên máy). Chỉ gắn badge khi có tín hiệu rõ.
      const lead = classifyLead(text);
      const leadBadge =
        lead.label !== "other"
          ? `<span class="lead-badge ${LEAD_META[lead.label].cls}">${LEAD_META[lead.label].text}</span>`
          : "";
      const links = (p.links || []).length
        ? `<div class="pc-links">${(p.links || [])
            .slice(0, 3)
            .map((l) => `<a href="${esc(l)}" target="_blank" rel="noopener">🔗 ${esc(shortUrl(l))}</a>`)
            .join("")}</div>`
        : "";
      return `
      <div class="post-card">
        <div class="pc-head">
          ${av}
          <div class="pc-id">
            <span class="pc-author">${esc(author)}${leadBadge}</span>
            <span class="pc-sub">${esc(p.timeText || timeAgo(p.crawledAt))} · ${esc(p.groupName || p.groupId || "")}</span>
          </div>
        </div>
        <div class="pc-text${isLong ? " clamp" : ""}">${esc(text || "(không có nội dung)")}</div>
        ${isLong ? `<button class="pc-toggle" data-toggle="1">Xem thêm</button>` : ""}
        ${thumbs ? `<div class="pc-thumbs">${thumbs}${more}</div>` : ""}
        ${links}
        <div class="pc-foot">
          <span class="pc-metric" title="Cảm xúc">${reactIco()} ${p.reactions != null ? p.reactions : "—"}</span>
          <span class="pc-metric" title="Bình luận">${cmtIco()} ${p.comments != null ? p.comments : "—"}</span>
          <span class="spacer"></span>
          ${p.permalink ? `<a class="btn ghost sm" href="${esc(p.permalink)}" target="_blank" rel="noopener">Mở bài ↗</a>` : ""}
          <button class="btn ghost sm" data-cmt="${esc(p.permalink || "")}">Bình luận</button>
          <button class="btn primary sm" data-analyze="${esc(p.postId || "")}">AI phân tích</button>
        </div>
      </div>`;
    })
    .join("");
}
/**
 * GỢI Ý TỪ KHOÁ: quét kho bài đã crawl (đang nạp trong store.posts hoặc lấy
 * thêm từ DB), rút ứng viên từ khoá đặc trưng cho từng nhóm rồi hiện modal cho
 * người dùng TICK DUYỆT. Chỉ từ được tick mới thêm vào bộ lọc.
 */
export async function suggestKeywordsUI() {
  // Lấy bài để phân tích: ưu tiên toàn bộ kho (không giới hạn nhóm đang lọc).
  const res = await bg("GET_ALL_POSTS", { groupId: "" });
  const posts = (res && res.posts) || store.posts || [];
  if (!posts.length) {
    toast("Chưa có bài nào để phân tích. Hãy crawl một vài nhóm trước.", "err");
    return;
  }
  const cand = mineKeywordCandidates(posts, { minCount: 3, maxPerGroup: 15 });
  const total = cand.buy.length + cand.support.length + cand.seller.length;
  if (!total) {
    toast("Không tìm thấy từ khoá mới đáng kể từ kho bài hiện có.", "info", 4000);
    return;
  }

  const groupTitle = { buy: "Cần mua", support: "Cần hỗ trợ", seller: "Người bán" };
  const section = (grp) => {
    const items = cand[grp];
    if (!items.length) return "";
    const rows = items
      .map((c) => {
        const pct = Math.round(c.ratio * 100);
        return `
        <label class="kw-row">
          <input type="checkbox" data-grp="${grp}" data-kw="${esc(c.phrase)}" />
          <span class="kw-phrase">${esc(c.phrase)}</span>
          <span class="kw-stat">${c.count} bài · ${pct}% đặc trưng</span>
          <span class="kw-ex" title="${esc(c.examples)}">${esc(c.examples)}</span>
        </label>`;
      })
      .join("");
    return `<div class="kw-group"><div class="kw-group-title ${LEAD_META[grp].cls}">${groupTitle[grp]}</div>${rows}</div>`;
  };

  const bodyHTML = `
    <p class="hint" style="margin:0 0 10px">Máy gợi ý từ ${posts.length} bài đã crawl. Tick những từ ĐÚNG rồi bấm Thêm. "% đặc trưng" càng cao thì từ càng riêng cho nhóm đó.</p>
    <div class="kw-list">${section("buy")}${section("support")}${section("seller")}</div>`;

  modal({
    title: "Gợi ý từ khoá",
    bodyHTML,
    confirmText: "Thêm từ đã chọn",
    onConfirm: (overlay) => {
      const checks = overlay.querySelectorAll('input[type="checkbox"]:checked');
      let added = 0;
      checks.forEach((ch) => {
        if (addLeadKeyword(ch.dataset.grp, ch.dataset.kw)) added++;
      });
      if (added) {
        toast(`Đã thêm ${added} từ khoá. Bộ lọc đã cập nhật.`, "ok");
        renderPosts();
      } else {
        toast("Chưa chọn từ nào (hoặc đã có sẵn).", "info");
      }
    },
  });
}

export function shortUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return h.length > 28 ? h.slice(0, 28) + "…" : h;
  } catch (_) {
    return String(u || "").slice(0, 28);
  }
}
export function reactIco() {
  return '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>';
}
export function cmtIco() {
  return '<svg viewBox="0 0 24 24"><path d="M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z"/></svg>';
}

export async function exportPosts(kind) {
  const groupId = store.postsGroupId;
  const res = await bg("GET_ALL_POSTS", { groupId });
  const posts = (res && res.posts) || [];
  if (!posts.length) {
    toast("Không có bài để xuất.", "err");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  if (kind === "json") {
    downloadFile(`posts-${stamp}.json`, JSON.stringify(posts, null, 2), "application/json");
  } else {
    const cols = ["postId", "groupName", "authorName", "timeText", "text", "reactions", "comments", "permalink"];
    const csv = [cols.join(",")]
      .concat(posts.map((p) => cols.map((c) => csvCell(p[c])).join(",")))
      .join("\r\n");
    downloadFile(`posts-${stamp}.csv`, "\uFEFF" + csv, "text/csv");
  }
  toast(`Đã xuất ${posts.length} bài (${kind.toUpperCase()}).`, "ok");
}
export function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export async function clearGroupPosts() {
  const groupId = store.postsGroupId;
  const label = groupId ? "nhóm đang chọn" : "TẤT CẢ các nhóm";
  modal({
    title: "Xóa bài đã crawl",
    bodyHTML: `<p>Bạn chắc chắn muốn xóa bài viết của <b>${esc(label)}</b>? Hành động này không thể hoàn tác.</p>`,
    confirmText: "Xóa",
    danger: true,
    onConfirm: async () => {
      const res = await bg("CLEAR_POSTS", { groupId });
      if (!res || !res.ok) {
        toast("Xóa thất bại.", "err");
        return false;
      }
      toast(`Đã xóa ${res.deleted} bài.`, "ok");
      loadPosts();
    },
  });
}

/**
 * Nút "AI phân tích" trên post card: nhờ AI soạn sẵn một nháp trả lời cho
 * đúng bài này. Nháp được LƯU vào store advisories (hiện trong tab Tư vấn AI,
 * duyệt/sửa/gửi như mọi nháp khác). Modal cho phép sửa nhanh, copy, đưa vào
 * hàng đợi bình luận, hoặc mở thẳng tab Tư vấn AI.
 */
export async function analyzePostUI(postId, btnEl) {
  const post = store.posts.find((p) => p.postId === postId);
  if (!post) return toast("Không tìm thấy bài viết.", "err");
  const oldLabel = btnEl ? btnEl.textContent : "";
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = "Đang phân tích...";
  }
  let res;
  try {
    res = await bg("ANALYZE_POST", { post });
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.textContent = oldLabel || "AI phân tích";
    }
  }
  if (!res || !res.ok) {
    return toast((res && res.error) || "AI chưa phân tích được bài này.", "err");
  }

  // Nháp đã được lưu DB -> nếu đang ở tab Tư vấn AI thì làm mới danh sách.
  if (res.saved) {
    advisoryStore.status = "pending";
    if (document.querySelector('.view[data-view="advisory"].active')) {
      syncAdvTabs();
      reloadAdvisories();
    }
  }

  const products = (res.usedProducts || [])
    .map((p) => {
      const price = p.price ? fmtPrice(p.price) : p.buildPrice ? fmtPrice(p.buildPrice) : "—";
      const link = p.url ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener">xem</a>` : "";
      return `<li><span class="adv-prod-name">${esc(p.name || "(không tên)")}</span> — <b>${price}</b> <span class="adv-prod-src">${esc(p.source || "")}</span>${link}</li>`;
    })
    .join("");
  const conf = res.confidence != null ? `${Math.round(res.confidence * 100)}%` : "—";
  const warn = res.needsHumanCheck
    ? `<div class="adv-warn">⚠️ Cần kiểm tra tay: ${esc(res.checkNote || "có số liệu cần xác minh")}</div>`
    : "";
  const canComment = !!post.permalink;

  const m = modal({
    title: "AI phân tích bài viết",
    bodyHTML: `
      <div class="analyze-meta">
        ${advIntentBadge(res.intent)}
        <span class="adv-conf">Độ tự tin: ${conf}</span>
        ${res.saved ? `<span class="analyze-saved">✓ Đã lưu vào Tư vấn AI</span>` : ""}
      </div>
      <label class="field"><span>Nháp trả lời (sửa rồi bấm Lưu để cập nhật)</span>
        <textarea id="analyzeReply" rows="5">${esc(res.reply || "")}</textarea>
      </label>
      ${products ? `<div class="analyze-prods"><span class="analyze-prods-title">Sản phẩm AI gợi ý</span><ul class="adv-products">${products}</ul></div>` : ""}
      ${warn}
      <p class="hint">Kiểm tra kỹ giá và thông tin trước khi gửi. Hệ thống không tự sửa giá.</p>
      <div class="analyze-row">
        <button class="btn ghost sm" id="analyzeSave" type="button">Lưu chỉnh sửa</button>
        <button class="btn ghost sm" id="analyzeCopy" type="button">Copy nội dung</button>
        <button class="btn ghost sm" id="analyzeOpenAdv" type="button">Mở trong Tư vấn AI</button>
      </div>`,
    confirmText: canComment ? "Đưa vào hàng đợi bình luận" : "Đóng",
    onConfirm: async () => {
      if (!canComment) return;
      const text = (($("analyzeReply") && $("analyzeReply").value) || "").trim();
      if (!text) {
        toast("Nội dung trống.", "err");
        return false;
      }
      switchView("autocomment");
      $("cmtJobUrl").value = post.permalink || "";
      $("cmtJobContent").value = text;
      toast("Đã điền link và nội dung. Kiểm tra rồi tạo việc bình luận.", "info");
    },
  });

  const getText = () => (($("analyzeReply") && $("analyzeReply").value) || "").trim();

  const saveBtn = m.overlay.querySelector("#analyzeSave");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const text = getText();
      if (!text) return toast("Nội dung trống.", "err");
      const r = await bg("UPDATE_ADVISORY", { postId: res.postId || postId, patch: { reply: text } });
      if (!r || !r.ok) return toast((r && r.error) || "Lưu thất bại.", "err");
      toast("Đã lưu chỉnh sửa vào nháp.", "ok");
      if (document.querySelector('.view[data-view="advisory"].active')) reloadAdvisories();
    });
  }

  const copyBtn = m.overlay.querySelector("#analyzeCopy");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const text = getText();
      if (!text) return toast("Nội dung trống.", "err");
      try {
        await navigator.clipboard.writeText(text);
        toast("Đã copy nội dung.", "ok");
      } catch (e) {
        toast("Không copy được, hãy chọn và copy thủ công.", "err");
      }
    });
  }

  const openBtn = m.overlay.querySelector("#analyzeOpenAdv");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      m.close();
      advisoryStore.status = "pending";
      switchView("advisory");
      toast("Đã mở tab Tư vấn AI. Nháp nằm trong danh sách Chờ duyệt.", "info");
    });
  }
}
