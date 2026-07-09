/**
 * jobs.js — Tab Đăng bài / Bình luận.
 *
 * Đăng bài: chọn nhiều nhóm (và/hoặc trang cá nhân), AI xào nấu nội dung thành
 * nhiều biến thể (giữ nguyên ý gốc), xem trước/sửa rồi tạo MỘT việc cho mỗi mục
 * tiêu (cùng batchId để theo dõi như một chiến dịch). Hỗ trợ đính kèm ảnh.
 */

import { $, bg, store, esc, emptyState, fmtDateTime, timeAgo, toast, modal } from "../core.js";
import { switchView } from "../nav.js";

/* ---- Trạng thái ảnh đính kèm (dataURL) cho từng khung ------------------ */
const postImagesArr = [];
const cmtImagesArr = [];

/* ================================ JOBS ================================= */
export async function loadJobs(type) {
  const res = await bg("GET_JOBS", { jobType: type });
  store.jobs = (res && res.jobs) || [];
  renderJobs(type);
}

export function renderJobs(type) {
  const wrap = type === "comment" ? $("cmtJobs") : $("postJobs");
  const list = store.jobs;
  if (!list.length) {
    wrap.innerHTML = emptyState("Chưa có việc nào", "Tạo việc ở khung bên trái để đưa vào hàng đợi.");
    return;
  }
  // Việc do người dùng soạn được tạo ở trạng thái "Chờ duyệt" (paused) -> KHÔNG
  // tự chạy. Hiện thanh "Duyệt tất cả" khi còn việc chờ duyệt để xác nhận một lần.
  const pausedCount = list.filter((j) => j.status === "paused").length;
  const approveBar = pausedCount
    ? `<div class="job-approve-bar"><span class="hint">${pausedCount} việc đang chờ bạn duyệt trước khi đăng.</span><button class="btn primary sm" data-act="approve-all">Duyệt tất cả (${pausedCount})</button></div>`
    : "";
  const toolbarRow = list.length
    ? `<div class="job-approve-bar"><span class="hint">${list.length} việc trong hàng đợi.</span><button class="btn danger-ghost sm" data-act="clear-all">Xóa tất cả</button></div>`
    : "";
  wrap.innerHTML = approveBar + toolbarRow + list
    .map((j) => {
      const target =
        type === "comment"
          ? j.targetUrl || "(thiếu link)"
          : j.targetType === "profile"
          ? "Trang cá nhân của tôi"
          : groupName(j.groupId);
      const imgs =
        Array.isArray(j.images) && j.images.length
          ? `<div class="job-imgs">${j.images
              .slice(0, 6)
              .map((d) => `<img src="${d}" alt="" />`)
              .join("")}</div>`
          : "";
      return `
      <div class="job-card" data-id="${j.id}">
        <div class="job-top">
          <span class="job-target" title="${esc(target)}">${esc(target)}</span>
          <span class="pill ${j.status}">${statusText(j.status)}</span>
        </div>
        <div class="job-body">${esc(j.content || "")}</div>
        ${imgs}
        ${j.error ? `<div class="job-body" style="color:var(--red)">Lỗi: ${esc(j.error)}</div>` : ""}
        <div class="job-foot">
          <span class="job-time">${
            j.scheduledAt > Date.now()
              ? "Lên lịch: " + fmtDateTime(j.scheduledAt)
              : "Tạo: " + timeAgo(j.createdAt)
          }</span>
          ${
            j.status === "paused"
              ? `<button class="btn primary sm" data-act="approve">Duyệt</button><button class="btn ghost sm" data-act="run">Đăng ngay</button>`
              : j.status === "pending" || j.status === "error"
              ? `<button class="btn ghost sm" data-act="run">Chạy ngay</button>`
              : ""
          }
          <button class="btn danger-ghost sm" data-act="del">Xóa</button>
        </div>
      </div>`;
    })
    .join("");
}
export function statusText(s) {
  return {
    paused: "Chờ duyệt",
    pending: "Chờ",
    running: "Đang chạy",
    done: "Xong",
    error: "Lỗi",
  }[s] || s;
}
export function groupName(id) {
  const g = store.groups.find((x) => x.groupId === id);
  return g ? g.groupName || id : id;
}

/* --------------------------- Ảnh đính kèm ------------------------------- */
function readFiles(fileList) {
  return Promise.all(
    [...fileList].map(
      (f) =>
        new Promise((resolve) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => resolve(null);
          fr.readAsDataURL(f);
        })
    )
  ).then((arr) => arr.filter(Boolean));
}

function renderImgPreview(container, arr, removeFn) {
  if (!container) return;
  container.innerHTML = arr
    .map(
      (d, i) =>
        `<div class="img-thumb"><img src="${d}" alt="" /><button type="button" data-i="${i}" title="Bỏ ảnh">×</button></div>`
    )
    .join("");
  [...container.querySelectorAll("button[data-i]")].forEach((b) => {
    b.addEventListener("click", () => removeFn(parseInt(b.dataset.i, 10)));
  });
}

function renderPostImgPreview() {
  renderImgPreview($("postImgPreview"), postImagesArr, (i) => {
    postImagesArr.splice(i, 1);
    renderPostImgPreview();
  });
}
function renderCmtImgPreview() {
  renderImgPreview($("cmtImgPreview"), cmtImagesArr, (i) => {
    cmtImagesArr.splice(i, 1);
    renderCmtImgPreview();
  });
}

export async function addPostImages(fileList) {
  if (!fileList || !fileList.length) return;
  const arr = await readFiles(fileList);
  postImagesArr.push(...arr);
  renderPostImgPreview();
}
export async function addCmtImages(fileList) {
  if (!fileList || !fileList.length) return;
  const arr = await readFiles(fileList);
  cmtImagesArr.push(...arr);
  renderCmtImgPreview();
}

/* --------------------- Chọn nhóm (checklist) ---------------------------- */
function getSelectedPostGroups() {
  const list = $("postGroupList");
  if (!list) return [];
  return [...list.querySelectorAll('input.gcl-check:checked')].map((ch) => ({
    groupId: ch.value,
    groupName: ch.dataset.name || ch.value,
  }));
}

export function updatePostGroupCount() {
  const el = $("postGroupCount");
  if (el) el.textContent = String(getSelectedPostGroups().length);
}

export function togglePostSelectAll(checked) {
  const list = $("postGroupList");
  if (!list) return;
  [...list.querySelectorAll("label.gcl-item")].forEach((item) => {
    if (item.style.display === "none") return; // chỉ áp dụng cho mục đang hiển thị
    const ch = item.querySelector("input.gcl-check");
    if (ch) ch.checked = checked;
  });
  updatePostGroupCount();
}

export function filterPostGroups(query) {
  const q = String(query || "").trim().toLowerCase();
  const list = $("postGroupList");
  if (!list) return;
  [...list.querySelectorAll("label.gcl-item")].forEach((item) => {
    const name = (item.dataset.name || "").toLowerCase();
    item.style.display = !q || name.includes(q) ? "" : "none";
  });
}

/* ------------------- Chế độ soạn nội dung (tự soạn / AI viết) ------------ */
// Cache biến thể AI vừa sinh (để preparePost dùng lại khi số mục tiêu khớp,
// khỏi gọi AI thêm một lần nữa cho cùng nội dung).
let lastGenerated = null;
// Kho sản phẩm của tôi để dựng gợi ý "chào hàng" (nạp lười khi mở chế độ AI viết).
let pitchProducts = [];

export function setPostMode(mode) {
  const isGen = mode === "generate";
  const toggle = $("postModeToggle");
  if (toggle) {
    toggle.querySelectorAll("[data-postmode]").forEach((b) => {
      b.classList.toggle("active", b.dataset.postmode === mode);
    });
  }
  const pitch = $("postPitchField");
  const brief = $("postBriefField");
  const gen = $("postGenControls");
  if (pitch) pitch.hidden = !isGen;
  if (brief) brief.hidden = !isGen;
  if (gen) gen.hidden = !isGen;
  // Lần đầu bật chế độ AI viết thì nạp kho để dựng danh sách chào hàng.
  if (isGen && !pitchProducts.length) loadPitchProducts();
}

/**
 * loadPitchProducts — Nạp sản phẩm "Kho của tôi" và đổ vào ô chọn để người dùng
 * lấy nhanh làm nội dung chào hàng. Liên kết dữ liệu kho ↔ đăng bài (không nhập tay lại).
 */
export async function loadPitchProducts() {
  const sel = $("postPitchProduct");
  if (!sel) return;
  try {
    const res = await bg("GET_PRODUCTS");
    const all = (res && res.products) || [];
    pitchProducts = all.filter((p) => p.owned || p.source === "mystore");
  } catch {
    pitchProducts = [];
  }
  const opts = ['<option value="">— Chọn sản phẩm để AI tự soạn yêu cầu —</option>'];
  pitchProducts.forEach((p, i) => {
    const price = p.price != null ? " · " + Number(p.price).toLocaleString("vi-VN") + "₫" : "";
    opts.push(`<option value="${i}">${esc((p.name || "SP") + price)}</option>`);
  });
  sel.innerHTML = opts.join("");
}

/**
 * fillPitchBrief — Từ sản phẩm đang chọn trong kho, dựng sẵn "brief" chào hàng
 * (tên, giá, bảo hành, cửa hàng, tồn kho) rồi đổ vào ô yêu cầu để AI viết bài.
 */
export function fillPitchBrief() {
  const sel = $("postPitchProduct");
  const briefEl = $("postJobBrief");
  if (!sel || !briefEl) return;
  const idx = parseInt(sel.value, 10);
  if (Number.isNaN(idx) || !pitchProducts[idx]) {
    return toast("Hãy chọn một sản phẩm trong kho trước.", "err");
  }
  const p = pitchProducts[idx];
  const lines = ["Viết bài chào hàng cho sản phẩm sau:"];
  lines.push("- Tên: " + (p.name || ""));
  if (p.price != null) lines.push("- Giá: " + Number(p.price).toLocaleString("vi-VN") + "₫");
  if (p.category) lines.push("- Loại: " + p.category);
  if (p.brand) lines.push("- Hãng: " + p.brand);
  if (p.warranty) lines.push("- Bảo hành: " + p.warranty);
  if (p.store) lines.push("- Cửa hàng: " + p.store);
  if (p.inStock === false) lines.push("- Tình trạng: tạm hết hàng (nhận đặt trước)");
  else lines.push("- Tình trạng: còn hàng");
  briefEl.value = lines.join("\n");
  toast("Đã điền yêu cầu từ kho. Bổ sung ưu đãi/liên hệ rồi bấm ✨ để AI viết bài.", "ok");
}

/**
 * generatePostDraft — Gọi AI TỰ VIẾT nội dung từ "brief" (yêu cầu) của người
 * dùng rồi đổ vào ô "Nội dung gốc" để họ xem/sửa trước khi tạo hàng đợi. Nếu đã
 * chọn nhiều nhóm, xin AI đúng số biến thể để mỗi nhóm một bài khác nhau.
 */
export async function generatePostDraft() {
  const brief = ($("postJobBrief").value || "").trim();
  if (!brief) return toast("Hãy nhập yêu cầu để AI viết nội dung.", "err");
  const tone = ($("postTone") && $("postTone").value) || "than-thien";
  // Số biến thể mong muốn = số mục tiêu (nhóm + trang cá nhân), tối thiểu 1.
  const targetCount =
    getSelectedPostGroups().length + ($("postToProfile").checked ? 1 : 0);
  const count = Math.max(1, targetCount);

  const loading = toast("Đang nhờ AI viết nội dung...", "info", 60000);
  const res = await bg("AI_GENERATE_CONTENT", { payload: { brief, tone, count } });
  loading.close();

  if (!res || !res.ok || !Array.isArray(res.variants) || !res.variants.length) {
    return toast((res && res.error) || "AI chưa viết được nội dung.", "err");
  }
  // Đổ biến thể đầu vào ô nội dung gốc; nếu có nhiều mục tiêu, người dùng vẫn
  // có thể bật "AI xào nấu" để tự chia biến thể ở bước xem trước.
  $("postJobContent").value = res.variants[0];
  toast(
    res.variants.length > 1
      ? `AI đã viết ${res.variants.length} biến thể — bản đầu đã điền vào ô nội dung. Xem trước để chỉnh từng bài.`
      : "AI đã viết xong nội dung. Kiểm tra rồi tạo hàng đợi.",
    "ok"
  );
  // Lưu lại toàn bộ biến thể để preparePost dùng trực tiếp (khỏi gọi AI lần nữa).
  lastGenerated = { content: res.variants[0], variants: res.variants };
}

/* --------------------------- Tạo bài (batch) ---------------------------- */
export async function preparePost() {
  const toProfile = $("postToProfile").checked;
  const content = ($("postJobContent").value || "").trim();
  const useAI = $("postUseAI").checked;
  const selected = getSelectedPostGroups();

  if (!content) return toast("Hãy nhập nội dung bài.", "err");

  const targets = [];
  if (toProfile) targets.push({ type: "profile", groupId: null, name: "Trang cá nhân của tôi" });
  selected.forEach((g) => targets.push({ type: "group", groupId: g.groupId, name: g.groupName }));

  if (!targets.length)
    return toast("Hãy chọn ít nhất một nhóm hoặc bật đăng lên trang cá nhân.", "err");

  let variants;
  // fallbackInfo: thông báo bền vững hiển thị trong modal xem trước khi AI không xào nấu được
  let fallbackInfo = null;

  // Nếu vừa nhờ AI TỰ VIẾT đúng số biến thể cho số mục tiêu này và người dùng
  // chưa sửa nội dung gốc, dùng thẳng các biến thể đó — khỏi gọi AI xào nấu lại.
  const canReuseGen =
    lastGenerated &&
    Array.isArray(lastGenerated.variants) &&
    lastGenerated.variants.length === targets.length &&
    lastGenerated.content === content;

  if (canReuseGen) {
    variants = lastGenerated.variants.slice();
  } else if (useAI && targets.length > 1) {
    const loading = toast("Đang nhờ AI xào nấu nội dung...", "info", 60000);
    const res = await bg("AI_SPIN_CONTENT", { payload: { content, count: targets.length } });
    loading.close();
    if (res && res.ok && Array.isArray(res.variants) && res.variants.length) {
      variants = res.variants;
      if (res.source === "fallback") {
        const note = res.note || "Chưa xào nấu được bằng AI, tạm dùng nội dung gốc.";
        toast(note, "info");
        fallbackInfo = { kind: "warn", note };
      }
    } else {
      variants = targets.map(() => content);
      const note = (res && res.error) || "AI lỗi, dùng nội dung gốc cho mọi mục tiêu.";
      toast(note, "err");
      fallbackInfo = { kind: "err", note };
    }
  } else {
    variants = targets.map(() => content);
  }

  showPreview(targets, variants, content, fallbackInfo);
}

function showPreview(targets, variants, origContent, fallbackInfo) {
  const images = postImagesArr.slice();
  const spacing = Math.max(0, parseInt($("postJobSpacing").value, 10) || 0);
  const tVal = $("postJobTime").value;
  const baseTime = tVal ? new Date(tVal).getTime() : Date.now();

  const rows = targets
    .map((t, i) => {
      const v = variants[i] || "";
      const isOrig = v.trim() === origContent.trim();
      return `
      <div class="variant-item" data-i="${i}">
        <div class="variant-head">
          <span class="variant-target">${esc(t.name)}</span>
          <span class="variant-badge ${isOrig ? "orig" : ""}">${
        isOrig ? "Nguyên gốc" : "AI xào nấu"
      }</span>
        </div>
        <textarea rows="5">${esc(v)}</textarea>
      </div>`;
    })
    .join("");

  const imgNote = images.length
    ? `<p class="hint">${images.length} ảnh sẽ được đính kèm cho tất cả mục tiêu.</p>`
    : "";

  modal({
    title: `Xem trước ${targets.length} bài đăng`,
    bodyHTML: `${
      fallbackInfo
        ? `<div class="ai-fallback-banner ${fallbackInfo.kind === "err" ? "err" : "warn"}">${esc(
            fallbackInfo.note
          )}</div>`
        : ""
    }<p class="hint">Bạn có thể sửa từng biến thể trước khi tạo việc.</p><div class="variant-list">${rows}</div>${imgNote}`,
    confirmText: `Tạo ${targets.length} việc`,
    onConfirm: async (overlay) => {
      const tas = [...overlay.querySelectorAll(".variant-item textarea")];
      const batchId = "batch_" + Date.now();
      // Thu thập danh sách job cần tạo (bỏ qua mục nội dung rỗng).
      const jobsToCreate = [];
      const jobTargets = [];
      for (let i = 0; i < targets.length; i++) {
        const text = ((tas[i] && tas[i].value) || "").trim();
        if (!text) continue;
        const scheduledAt = baseTime + i * spacing * 60000;
        jobsToCreate.push({
          type: "post",
          status: "paused", // chờ người dùng duyệt, KHÔNG tự đăng
          targetType: targets[i].type,
          groupId: targets[i].groupId,
          content: text,
          images,
          batchId,
          batchName: targets[i].name,
          scheduledAt,
        });
        jobTargets.push(targets[i]);
      }
      // Tạo TOÀN BỘ job trong MỘT lần message (batch) để tránh mất SW giữa chừng.
      const res = await bg("CREATE_JOBS", { jobs: jobsToCreate });
      // Ghi hàng đợi vào chrome.storage.local có thể THẤT BẠI (vd vượt hạn mức
      // khi chọn nhiều nhóm + nhiều ảnh). Trước đây lỗi bị nuốt nên vẫn "báo
      // thành công" dù không lưu được gì -> hàng đợi trống. Nay bg trả về
      // {ok:false} khi ghi lỗi: giữ modal + nội dung để người dùng thử lại.
      if (!res || !res.ok) {
        toast(
          (res && res.error) ||
            "Không lưu được hàng đợi (có thể do quá nhiều ảnh vượt dung lượng). Hãy bớt ảnh hoặc bớt nhóm rồi thử lại.",
          "err"
        );
        return false; // KHÔNG đóng modal, KHÔNG xoá nội dung đã soạn.
      }
      const created = Array.isArray(res.jobs) ? res.jobs.length : 0;
      toast(
        `Đã tạo ${created}/${targets.length} việc (đang CHỜ DUYỆT). Bấm "Duyệt" để đăng.`,
        created ? "ok" : "err"
      );
      $("postJobContent").value = "";
      $("postJobTime").value = "";
      postImagesArr.length = 0;
      renderPostImgPreview();
      togglePostSelectAll(false);
      if ($("postToProfile")) $("postToProfile").checked = false;
      loadJobs("post");
      return true;
    },
  });
}

/* ----------------------------- Bình luận -------------------------------- */
export async function createCommentJob(prefillUrl) {
  if (prefillUrl) {
    switchView("autocomment");
    $("cmtJobUrl").value = prefillUrl;
    toast("Đã điền link bài. Nhập nội dung rồi tạo việc.", "info");
    return;
  }
  const targetUrl = ($("cmtJobUrl").value || "").trim();
  const content = ($("cmtJobContent").value || "").trim();
  if (!targetUrl) return toast("Hãy nhập link bài viết.", "err");
  if (!content) return toast("Hãy nhập nội dung bình luận.", "err");
  const t = $("cmtJobTime").value;
  const scheduledAt = t ? new Date(t).getTime() : Date.now();
  const images = cmtImagesArr.slice();
  const res = await bg("CREATE_JOB", {
    job: { type: "comment", status: "paused", targetUrl, content, images, scheduledAt },
  });
  if (!res || !res.ok) return toast("Không tạo được việc.", "err");
  $("cmtJobContent").value = "";
  $("cmtJobUrl").value = "";
  $("cmtJobTime").value = "";
  cmtImagesArr.length = 0;
  renderCmtImgPreview();
  toast('Đã thêm vào hàng đợi (CHỜ DUYỆT). Bấm "Duyệt" để gửi.', "ok");
  loadJobs("comment");
}
