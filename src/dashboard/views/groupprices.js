/**
 * groupprices.js — View "Giá Group": hiển thị mặt bằng giá đã TRÍCH từ bài rao
 * bán trong các nhóm (group_prices ở web backend). Gom theo sản phẩm để thấy
 * ngay dải giá thấp→cao, kèm bộ lọc nhóm/loại/khoảng giá/tình trạng.
 *
 * Dữ liệu này là RIÊNG TƯ theo tài khoản: backend chỉ trả về các dòng giá do
 * chính người dùng hiện tại crawl/trích, nên không còn khái niệm "chung" vs
 * "chỉ của tôi" hay icon chia sẻ.
 *
 * Đường dữ liệu: dashboard KHÔNG gọi HTTP API trực tiếp (JWT nằm ở service
 * worker). Mọi dữ liệu đi qua bg() -> message handler ở background.js -> gọi
 * API.apiFetch (giống AUTH_LOGIN). Các message dùng ở đây:
 *   - GET_GROUP_PRICES  { filters } -> { ok, groupPrices }
 *   - RUN_GROUP_PRICE_EXTRACTION    -> { ok, processed, inserted, newKeywords }
 *   - GET_GROUPS (đã có sẵn)        -> để dựng dropdown lọc theo nhóm.
 *
 * KIỂM THỬ ĐƯỢC: normalizeProductKey / groupByProduct / filterRows là hàm THUẦN
 * (không đụng DOM, không network) nên test bằng node --test (xem
 * test/dashboard-groupprices.test.js).
 */
import { $, bg, esc, emptyState, toast, timeAgo, colorFor, initials } from "../core.js";
import { fmtPrice } from "./products.js";

// State riêng cho view.
export const groupPriceStore = {
  rows: [],   // toàn bộ dòng giá đã nạp (đã lọc riêng-tư theo user ở backend)
  groups: [], // danh sách nhóm (để dựng dropdown + tra tên theo groupId)
};

// Chỉ cho phép http/https khi dựng <a href> từ dữ liệu AI/crawl (ít tin cậy):
// chặn javascript:/data: và các scheme nguy hiểm. Trả "" nếu không hợp lệ.
function safeHttpUrl(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^https?:\/\//i.test(s)) return "";
  return s;
}

/* ============================ LOGIC THUẦN ============================== */

/**
 * normalizeProductKey(name) — chuẩn hoá tên sản phẩm để gom cùng một mặt hàng:
 * hạ thường + gộp khoảng trắng thừa. Tên rỗng/null -> "" (không ném).
 */
export function normalizeProductKey(name) {
  return String(name == null ? "" : name)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * groupByProduct(rows) — gom các dòng giá theo tên đã chuẩn hoá.
 * Mỗi nhóm trả { key, name, rows (sắp giá tăng dần), minPrice, maxPrice }.
 * - Dòng không có giá (price null/undefined) vẫn nằm trong nhóm nhưng KHÔNG
 *   tính vào min/max.
 * - Các nhóm được sắp theo minPrice tăng dần (nhóm chưa có giá xếp cuối).
 */
export function groupByProduct(rows) {
  if (!Array.isArray(rows)) return [];
  const map = new Map();
  for (const r of rows) {
    if (!r) continue;
    const key = normalizeProductKey(r.name);
    if (!map.has(key)) {
      map.set(key, { key, name: r.name || "", rows: [] });
    }
    map.get(key).rows.push(r);
  }

  const groups = [];
  for (const g of map.values()) {
    // Sắp dòng trong nhóm theo giá tăng dần; dòng không giá xuống cuối.
    g.rows.sort((a, b) => priceOrInfinity(a) - priceOrInfinity(b));
    const prices = g.rows
      .map((r) => r.price)
      .filter((p) => p != null && !Number.isNaN(Number(p)))
      .map(Number);
    g.minPrice = prices.length ? Math.min(...prices) : null;
    g.maxPrice = prices.length ? Math.max(...prices) : null;
    groups.push(g);
  }

  // Sắp nhóm theo giá thấp nhất tăng dần; nhóm chưa có giá (minPrice null) cuối.
  groups.sort((a, b) => priceOrInfinity(a, "minPrice") - priceOrInfinity(b, "minPrice"));
  return groups;
}

// Trả price của dòng/nhóm hoặc +Infinity nếu thiếu, để dồn xuống cuối khi sort.
function priceOrInfinity(obj, field = "price") {
  const v = obj ? obj[field] : null;
  return v == null || Number.isNaN(Number(v)) ? Infinity : Number(v);
}

/**
 * filterRows(rows, filters) — lọc dòng giá theo các điều kiện (bỏ qua filter rỗng):
 *   - groupId, category, condition: so khớp tuyệt đối.
 *   - priceMin, priceMax: khoảng giá (bao gồm 2 đầu). Dòng không có giá bị loại
 *     khi có ràng buộc khoảng giá.
 */
export function filterRows(rows, filters = {}) {
  if (!Array.isArray(rows)) return [];
  const { groupId, category, condition, priceMin, priceMax } = filters || {};
  return rows.filter((r) => {
    if (!r) return false;
    if (groupId && String(r.groupId) !== String(groupId)) return false;
    if (category && r.category !== category) return false;
    if (condition && r.condition !== condition) return false;
    const hasRange = priceMin != null || priceMax != null;
    if (hasRange) {
      if (r.price == null) return false;
      if (priceMin != null && Number(r.price) < Number(priceMin)) return false;
      if (priceMax != null && Number(r.price) > Number(priceMax)) return false;
    }
    return true;
  });
}

/* ============================ NẠP DỮ LIỆU ============================== */

export async function loadGroupPricesView() {
  // Nạp song song danh sách nhóm (cho dropdown) + dòng giá.
  await Promise.all([loadGroupsForFilter(), reloadGroupPrices()]);
}

async function loadGroupsForFilter() {
  const res = await bg("GET_GROUPS");
  groupPriceStore.groups = (res && res.groups) || [];
  renderGroupFilterOptions();
}

// Đổ option cho dropdown lọc nhóm (giữ lựa chọn hiện tại nếu còn).
function renderGroupFilterOptions() {
  const sel = $("gpGroupFilter");
  if (!sel) return;
  const cur = sel.value;
  const opts = ['<option value="">Tất cả nhóm</option>'];
  for (const g of groupPriceStore.groups) {
    opts.push(`<option value="${esc(g.groupId)}">${esc(g.name || g.groupId)}</option>`);
  }
  sel.innerHTML = opts.join("");
  if (cur) sel.value = cur;
}

// Nạp dòng giá từ backend (qua service worker). Backend tự lọc theo user hiện
// tại nên không cần đẩy filter riêng-tư nào lên server.
export async function reloadGroupPrices() {
  const wrap = $("groupPriceList");
  const res = await bg("GET_GROUP_PRICES", { filters: {} });
  if (!res || !res.ok) {
    // Chưa đăng nhập -> hiện hướng dẫn thay vì bảng trống gây hiểu nhầm.
    if (wrap) {
      wrap.innerHTML = emptyState(
        "Cần đăng nhập",
        (res && res.error) || "Đăng nhập tài khoản web ở popup tiện ích để xem mặt bằng giá."
      );
    }
    return;
  }
  groupPriceStore.rows = res.groupPrices || [];
  renderGroupPrices();
}

// Đọc bộ lọc hiện tại từ các control trên UI.
function readFilters() {
  const num = (id) => {
    const el = $(id);
    const v = el && el.value ? parseInt(el.value, 10) : NaN;
    return Number.isNaN(v) ? null : v;
  };
  return {
    groupId: ($("gpGroupFilter") && $("gpGroupFilter").value) || "",
    category: ($("gpCatFilter") && $("gpCatFilter").value) || "",
    condition: ($("gpCondFilter") && $("gpCondFilter").value) || "",
    priceMin: num("gpPriceMin"),
    priceMax: num("gpPriceMax"),
  };
}

/* ============================== RENDER ================================= */

// Áp filter client + render lại danh sách (gọi khi đổi filter cục bộ).
export function applyGroupPriceFilter() {
  renderGroupPrices();
}

function groupName(groupId) {
  const g = groupPriceStore.groups.find((x) => String(x.groupId) === String(groupId));
  return g ? g.name || g.groupId : groupId || "";
}

// Nhãn tình trạng tiếng Việt.
const COND_LABEL = { "mới": "Mới", "cũ": "Cũ", "likenew": "Like new" };

function renderGroupPrices() {
  const wrap = $("groupPriceList");
  if (!wrap) return;
  const filtered = filterRows(groupPriceStore.rows, readFilters());
  if (!filtered.length) {
    wrap.innerHTML = emptyState(
      "Chưa có dữ liệu giá",
      'Bấm "Trích xuất giá" để AI trích giá từ các bài rao bán đã crawl, hoặc đổi bộ lọc.'
    );
    return;
  }
  const groups = groupByProduct(filtered);
  wrap.innerHTML = groups.map(renderProductGroup).join("");
}

// Render một nhóm sản phẩm: tiêu đề + dải giá + các thẻ dòng giá.
function renderProductGroup(g) {
  const range =
    g.minPrice == null
      ? "—"
      : g.minPrice === g.maxPrice
      ? fmtPrice(g.minPrice)
      : `${fmtPrice(g.minPrice)} – ${fmtPrice(g.maxPrice)}`;
  const cards = g.rows.map(renderPriceCard).join("");
  return `
    <div class="gp-group">
      <div class="gp-group-head">
        <h3 class="gp-group-name">${esc(g.name || "(không tên)")}</h3>
        <span class="gp-range">${esc(range)}</span>
        <span class="count-pill">${g.rows.length} tin</span>
      </div>
      <div class="gp-cards">${cards}</div>
    </div>`;
}

// Render một thẻ dòng giá.
function renderPriceCard(r) {
  // Class hậu tố chỉ giữ chữ-số (esc không escape dấu nháy nên không thể nhét
  // trực tiếp giá trị AI/crawl vào thuộc tính class).
  const condSlug = String(r.condition || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const cond = r.condition ? `<span class="gp-cond gp-cond-${condSlug}">${esc(COND_LABEL[r.condition] || r.condition)}</span>` : "";
  const warranty = r.warranty ? `<span class="gp-warranty">BH: ${esc(r.warranty)}</span>` : "";
  const seller = r.sellerName || "Ẩn danh";
  // Chỉ render <a> khi sellerProfile là http(s) hợp lệ; chặn javascript:/data:
  // và breakout attribute do dữ liệu AI/crawl không tin cậy.
  const safeProfile = safeHttpUrl(r.sellerProfile);
  const sellerLink = safeProfile
    ? `<a href="${esc(safeProfile)}" target="_blank" rel="noopener">${esc(seller)}</a>`
    : esc(seller);
  const gname = groupName(r.groupId);
  const when = r.postedAt ? timeAgo(typeof r.postedAt === "number" ? r.postedAt : Date.parse(r.postedAt)) : "";
  // Link tới bài nguồn (best-effort dựng từ groupId + postId).
  const sourceLink =
    r.groupId && r.postId
      ? `<a class="gp-source" href="https://www.facebook.com/groups/${esc(r.groupId)}/posts/${esc(r.postId)}/" target="_blank" rel="noopener">Bài gốc ↗</a>`
      : "";
  const av = `<span class="gp-avatar" style="background:${colorFor(seller)}">${esc(initials(seller))}</span>`;
  return `
    <div class="gp-card">
      <div class="gp-card-main">
        <div class="gp-name-row">
          <span class="gp-name">${esc(r.name || "(không tên)")}</span>
        </div>
        <div class="gp-meta">
          ${cond}${warranty}
          ${r.category ? `<span class="gp-cat">${esc(r.category)}</span>` : ""}
        </div>
        <div class="gp-sub muted">
          ${av} ${sellerLink} · ${esc(gname)} ${when ? "· " + when : ""} ${sourceLink}
        </div>
      </div>
      <div class="gp-price">${fmtPrice(r.price)}</div>
    </div>`;
}

/* ========================= TRÍCH XUẤT GIÁ ============================= */

// Chạy phễu trích giá ở service worker (nơi có JWT + posts + AI). Nút hiện
// trạng thái và báo kết quả, rồi nạp lại danh sách.
export async function runExtraction() {
  const btn = $("btnExtractPrices");
  if (btn) { btn.disabled = true; btn.textContent = "Đang trích..."; }
  toast("Đang trích giá từ bài đã crawl bằng AI...", "info", 4000);
  const res = await bg("RUN_GROUP_PRICE_EXTRACTION");
  if (btn) { btn.disabled = false; btn.textContent = "Trích xuất giá"; }
  if (res && res.ok) {
    toast(
      `Trích xong: xử lý ${res.processed || 0} bài, thêm ${res.inserted || 0} dòng giá, học ${res.newKeywords || 0} từ khoá mới.`,
      "ok",
      5000
    );
    await reloadGroupPrices();
  } else {
    toast((res && res.error) || "Trích giá thất bại.", "err", 6000);
  }
}
