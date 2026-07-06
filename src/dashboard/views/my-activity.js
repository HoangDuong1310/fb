/**
 * my-activity.js — View "Hoạt động của tôi".
 *
 * Gom lại NHỮNG GÌ CHÍNH BẠN đã đăng lên Facebook qua tiện ích, để dễ tra cứu &
 * mở lại link:
 *   - Tab "Bài đã đăng": các việc ĐĂNG BÀI đã chạy xong (job.type==="post",
 *     status==="done") — có link bài (job.result.postUrl), tên nhóm, nội dung.
 *   - Tab "Bình luận đã đăng": các việc BÌNH LUẬN đã chạy xong
 *     (job.type==="comment", status==="done") — có link bình luận
 *     (job.result.commentUrl), link bài gốc (job.targetUrl), nội dung. Việc rep
 *     tiếp trong hội thoại cũng là comment job nên tự động gộp vào đây.
 *
 * Chỉ hiển thị (read-only) + tìm kiếm + lọc theo tab. Không tạo/sửa/xoá gì.
 */

import { $, bg, store, esc, emptyState, timeAgo, fmtDateTime } from "../core.js";
import { groupName } from "./jobs.js";

/* ---- Trạng thái view ---------------------------------------------------- */
export const myActivity = {
  tab: "posts", // "posts" | "comments"
  query: "",
  posts: [], // done post jobs
  comments: [], // done comment jobs
};

/* ---- Nạp dữ liệu -------------------------------------------------------- */
export async function loadMyActivityView() {
  const [postRes, cmtRes] = await Promise.all([
    bg("GET_JOBS", { jobType: "post" }),
    bg("GET_JOBS", { jobType: "comment" }),
  ]);
  const done = (arr) =>
    (arr || []).filter((j) => j && j.status === "done");
  myActivity.posts = done(postRes && postRes.jobs);
  myActivity.comments = done(cmtRes && cmtRes.jobs);
  renderMyActivity();
}

/* ---- Đổi tab / tìm kiếm ------------------------------------------------- */
export function setMyActivityTab(tab) {
  if (tab !== "posts" && tab !== "comments") return;
  myActivity.tab = tab;
  const seg = $("myActTabs");
  if (seg) {
    seg.querySelectorAll("button[data-mya]").forEach((b) =>
      b.classList.toggle("active", b.dataset.mya === tab)
    );
  }
  renderMyActivity();
}

export function setMyActivityQuery(q) {
  myActivity.query = String(q || "").trim().toLowerCase();
  renderMyActivity();
}

/* ---- Render ------------------------------------------------------------- */
export function renderMyActivity() {
  const wrap = $("myActWrap");
  if (!wrap) return;
  const list = myActivity.tab === "comments" ? myActivity.comments : myActivity.posts;
  const q = myActivity.query;

  const filtered = !q
    ? list
    : list.filter((j) => {
        const hay = [
          j.content || "",
          j.targetUrl || "",
          j.groupId || "",
          groupName(j.groupId) || "",
          (j.result && (j.result.postUrl || j.result.commentUrl)) || "",
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });

  const countEl = $("myActCount");
  if (countEl) countEl.textContent = `${filtered.length} mục`;

  if (!filtered.length) {
    wrap.innerHTML =
      myActivity.tab === "comments"
        ? emptyState(
            "Chưa có bình luận nào đã đăng",
            "Các bình luận bạn đã đăng qua tiện ích (kể cả rep trong hội thoại) sẽ hiện ở đây."
          )
        : emptyState(
            "Chưa có bài nào đã đăng",
            "Các bài bạn đã đăng qua tiện ích sẽ hiện ở đây."
          );
    return;
  }

  wrap.innerHTML = filtered
    .map((j) => (myActivity.tab === "comments" ? renderCommentCard(j) : renderPostCard(j)))
    .join("");
}

function renderPostCard(j) {
  const target =
    j.targetType === "profile" ? "Trang cá nhân của tôi" : groupName(j.groupId);
  const url = j.result && j.result.postUrl;
  const imgs = imgStrip(j.images);
  return `
    <div class="job-card" data-id="${esc(String(j.id))}">
      <div class="job-top">
        <span class="job-target" title="${esc(target)}">${esc(target)}</span>
        <span class="pill done">Đã đăng</span>
      </div>
      <div class="job-body">${esc(j.content || "")}</div>
      ${imgs}
      <div class="job-foot">
        <span class="job-time">${esc(whenText(j))}</span>
        ${
          url
            ? `<a class="btn ghost sm" href="${esc(url)}" target="_blank" rel="noopener">Mở bài</a>`
            : ""
        }
      </div>
    </div>`;
}

function renderCommentCard(j) {
  const url = bestCommentUrl(j);
  const imgs = imgStrip(j.images);
  const src =
    j.meta && j.meta.source === "conversation"
      ? '<span class="pill" style="opacity:.7">Rep hội thoại</span>'
      : "";
  return `
    <div class="job-card" data-id="${esc(String(j.id))}">
      <div class="job-top">
        <span class="job-target" title="${esc(j.targetUrl || "")}">${esc(
    j.targetUrl || "(thiếu link bài)"
  )}</span>
        ${src}
        <span class="pill done">Đã đăng</span>
      </div>
      <div class="job-body">${esc(j.content || "")}</div>
      ${imgs}
      <div class="job-foot">
        <span class="job-time">${esc(whenText(j))}</span>
        ${
          url
            ? `<a class="btn ghost sm" href="${esc(url)}" target="_blank" rel="noopener">Mở bình luận</a>`
            : ""
        }
      </div>
    </div>`;
}

/* ---- Helpers ------------------------------------------------------------ */
// Dựng link bình luận "chắc mở được" cho job: LUÔN ưu tiên ghép lại từ
// targetUrl (link BÀI GỐC, luôn còn đủ story_fbid/id với bài trang cá nhân)
// + commentId, giống logic executeCommentJob/executeWatchReplies bên
// background. Không tin thẳng result.commentUrl đã lưu vì các job CŨ (đăng
// trước khi có an toàn này) có thể đã lưu link hỏng dạng
// permalink.php?comment_id=... (FB tự bỏ mất story_fbid/id khi render href).
function bestCommentUrl(j) {
  const commentId = j.result && j.result.commentId;
  if (j.targetUrl && commentId) {
    try {
      const u = new URL(j.targetUrl);
      u.searchParams.set("comment_id", String(commentId));
      return u.toString();
    } catch (_) {}
  }
  return (j.result && j.result.commentUrl) || j.targetUrl || "";
}

function whenText(j) {
  const ts = j.updatedAt || j.createdAt;
  return ts ? `Đăng: ${timeAgo(ts)} (${fmtDateTime(ts)})` : "";
}

function imgStrip(images) {
  if (!Array.isArray(images) || !images.length) return "";
  return `<div class="job-imgs">${images
    .slice(0, 6)
    .map((d) => `<img src="${d}" alt="" />`)
    .join("")}</div>`;
}
