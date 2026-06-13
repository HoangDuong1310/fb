/**
 * View "Sản phẩm / Giá" — nạp kho sản phẩm, lọc, và so sánh giá giữa các cửa hàng.
 * Tách từ dashboard.js (B3.2h). Phụ thuộc canonCat từ build.js (gọi trong hàm nên
 * import vòng an toàn).
 */
import { $, bg, esc, emptyState, timeAgo, toast, modal, syncToasts, colorFor, initials } from "../core.js";
import { canonCat } from "./build.js";

/* ========================== SẢN PHẨM / GIÁ ============================ */
// State riêng cho view sản phẩm.
export const productStore = { sources: [], products: [], allProducts: [], mode: "compare", page: 1, pageSize: 50 };

// Lấy & hiển thị các nguồn dữ liệu đã lưu.
export async function loadSources() {
  const res = await bg("GET_SOURCES");
  productStore.sources = (res && res.sources) || [];
  renderSources();
}

export function renderSources() {
  const wrap = $("sourceList");
  if (!wrap) return;
  if (!productStore.sources.length) {
    wrap.innerHTML = emptyState("Chưa có nguồn", "Chưa có nguồn dữ liệu giá nào được cấu hình.");
    return;
  }
  wrap.innerHTML = productStore.sources
    .map((s) => {
      const last = s.lastSyncAt
        ? `Đồng bộ ${timeAgo(s.lastSyncAt)} · ${s.lastCount || 0} SP`
        : "Chưa đồng bộ";
      return `
      <div class="job-card" data-id="${esc(s.id)}">
        <div class="job-main">
          <div class="job-title">${esc(s.name || s.id)}</div>
          <div class="job-sub muted">${esc(s.url || "")}</div>
          <div class="job-sub muted">${esc(last)}</div>
        </div>
        <div class="job-actions">
          <button class="btn ghost sm" data-act="sync">Đồng bộ</button>
          <button class="btn danger-ghost sm" data-act="del">Xóa</button>
        </div>
      </div>`;
    })
    .join("");
}

export async function onSourceAction(e) {
  const card = e.target.closest(".job-card");
  if (!card) return;
  const id = card.dataset.id;
  const act = e.target.closest("[data-act]") && e.target.closest("[data-act]").dataset.act;
  const source = productStore.sources.find((s) => s.id === id);
  if (act === "sync") {
    // Toast "dính" để cập nhật tiến trình realtime (xem listener SYNC_PROGRESS).
    syncToasts[id] = toast("Đang gọi nguồn và đồng bộ...", "info", 0);
    const res = await bg("SYNC_SOURCE", { id });
    const handle = syncToasts[id];
    delete syncToasts[id];
    if (res && res.ok) {
      const msg = `Đồng bộ xong: ${res.fetched} SP (mới ${res.added || 0}, cập nhật ${res.updated || 0}).`;
      if (handle) { handle.update(msg, "ok"); handle.close(4000); }
      else toast(msg, "ok", 4000);
      await loadSources();
      await loadProducts();
    } else {
      const msg = (res && res.error) || "Đồng bộ thất bại.";
      if (handle) { handle.update(msg, "err"); handle.close(6000); }
      else toast(msg, "err", 6000);
    }
  } else if (act === "del") {
    modal({
      title: "Xóa nguồn",
      bodyHTML: `<p>Xóa nguồn dữ liệu này? (Sản phẩm đã lưu vẫn được giữ.)</p>`,
      confirmText: "Xóa",
      danger: true,
      onConfirm: async () => {
        await bg("DELETE_SOURCE", { id });
        await loadSources();
        toast("Đã xóa nguồn.", "ok");
      },
    });
  }
}

export async function syncAllSources() {
  toast("Đang đồng bộ tất cả nguồn...", "info", 4000);
  const res = await bg("SYNC_ALL_SOURCES");
  if (!res || !res.ok) {
    toast((res && res.error) || "Đồng bộ thất bại.", "err", 5000);
    return;
  }
  toast(`Đã đồng bộ ${res.synced}/${res.total} nguồn.`, "ok", 4000);
  await loadSources();
  await loadProducts();
}

// Lưu cấu hình tự động đồng bộ giá (công tắc + chu kỳ 6h/12h/24h).
export function saveAutoSync() {
  const enabled = !!($("autoSyncEnabled") && $("autoSyncEnabled").checked);
  let hours = parseInt(($("autoSyncInterval") && $("autoSyncInterval").value) || "", 10);
  if (![6, 12, 24].includes(hours)) hours = 12;
  bg("SET_AUTOSYNC", { config: { enabled, intervalHours: hours } }).then((res) => {
    if (res && res.ok) {
      toast(
        enabled
          ? `Đã bật tự động đồng bộ giá mỗi ${hours} giờ cho tất cả nguồn.`
          : "Đã tắt tự động đồng bộ giá.",
        "ok",
        3000
      );
    } else {
      toast((res && res.error) || "Không lưu được cấu hình tự động đồng bộ.", "err", 5000);
    }
  });
}

export async function loadAutoSync() {
  const res = await bg("GET_AUTOSYNC");
  const cfg = (res && res.config) || {};
  if ($("autoSyncEnabled")) $("autoSyncEnabled").checked = !!cfg.enabled;
  if ($("autoSyncInterval") && cfg.intervalHours) {
    $("autoSyncInterval").value = String(cfg.intervalHours);
  }
}

// Nạp TOÀN BỘ kho sản phẩm (không giới hạn) rồi lọc/hiển thị phía client.
// Trước đây dùng SEARCH_PRODUCTS limit:200 nên chỉ thấy 200 SP rẻ nhất trong
// hàng nghìn SP -> các cửa hàng gần như không trùng nhau -> chỉ gom được 1 nhóm.
export async function loadProducts() {
  const res = await bg("GET_PRODUCTS");
  productStore.all = (res && res.products) || [];
  applyProductFilter();
}

// Lọc kho theo ô tìm kiếm (tên/hãng/loại) ngay trên client.
// Chỉ giữ món còn bán được: còn hàng (inStock !== false) và có giá bán lẻ > 0.
// An Phát trả quantity:"0" + price:"0" cho hàng hết -> phải ẩn khỏi mọi view.
export function isSellable(p) {
  if (p && p.inStock === false) return false;
  const price = Number(p && p.price);
  return Number.isFinite(price) && price > 0;
}

export function applyProductFilter() {
  productStore.page = 1; // đổi bộ lọc -> về trang đầu
  const q = ($("productSearch") ? $("productSearch").value || "" : "").trim().toLowerCase();
  const all = (productStore.all || []).filter(isSellable);
  if (!q) {
    productStore.products = all;
  } else {
    const terms = q.split(/\s+/).filter(Boolean);
    productStore.products = all.filter((p) => {
      const hay = ((p.name || "") + " " + (p.category || "") + " " + canonCat(p.category) + " " + (p.brand || "")).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  renderProducts();
}

export function fmtPrice(v) {
  if (v == null) return "—";
  return new Intl.NumberFormat("vi-VN").format(v) + "₫";
}

// Dựng URL tuyệt đối cho link "Xem". Dữ liệu cũ trong kho có thể lưu URL tương đối
// ("foo.html"); nếu để nguyên, trình duyệt sẽ ghép vào origin chrome-extension://.
// Ở đây ghép lại theo domain của nguồn (lấy từ source.url đã lưu).
export function resolveProductUrl(p) {
  const raw = (p && p.url ? String(p.url) : "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^\/\//.test(raw)) return "https:" + raw;
  const src = productStore.sources.find((s) => s.id === p.source);
  if (!src || !src.url) return raw;
  try {
    const origin = new URL(src.url).origin;
    return new URL(raw, origin).toString();
  } catch (e) {
    return raw;
  }
}

// Chuẩn hoá tên sản phẩm thành "chữ ký" để gom cùng một sản phẩm giữa các cửa hàng.
// Bỏ dấu tiếng Việt + ký tự đặc biệt + từ marketing thừa; GIỮ LẠI brand, mã model,
// thông số (công suất/dung lượng) và từ phân biệt biến thể (Max/Standard/Non/Modular...).
const PROD_STOPWORDS = new Set([
  "laptop", "may", "tinh", "pc", "san", "pham", "chinh", "hang", "moi", "new",
  "cpu", "vga", "ram", "ssd", "hdd", "mainboard", "main", "bo", "mach", "case",
  "vo", "nguon", "psu", "man", "hinh", "monitor", "ban", "phim", "chuot",
  "tan", "nhiet", "quat", "cao", "cap", "gia", "re", "khuyen", "mai", "the",
  "hop", "kit", "for", "and", "with", "core", "gen", "chiec", "sp", "ma",
]);

// Xây "chữ ký sản phẩm" để gom cùng một sản phẩm giữa các cửa hàng. Mỗi cửa hàng
// đặt tên rất khác nhau (nhồi spec, chữ marketing riêng), nên KHÔNG dùng toàn bộ
// tên. Thay vào đó lấy các token MÃ MODEL/THÔNG SỐ (token có chứa chữ số) vì đây là
// phần ổn định nhất: "i5 14400f" / "i5-14400f" -> {i5,14400f}; "NZXT C1200 1200W"
// -> {c1200,1200w}; "GSKILL Z5 32GB 6000MHz" -> {z5,32gb,6000mhz}.
//   - Cắt bỏ phần trong ngoặc: spec chi tiết khác nhau giữa cửa hàng -> gây lệch chữ ký.
//   - Tách dấu "-" thành khoảng trắng để "i5-14400f" khớp "i5 14400f" (trước đây bị gộp
//     thành "i514400f" nên không bao giờ trùng store khác).
//   - Brand viết khác nhau (gskill vs g.skill) nên không dùng làm khoá chính.
export function productSignature(name) {
  let s = (name || "").toLowerCase();
  // cắt bỏ nội dung trong ngoặc (mô tả thông số gây nhiễu, khác nhau giữa cửa hàng)
  s = s.replace(/\([^)]*\)/g, " ");
  // bỏ dấu tiếng Việt
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
  // mọi ký tự không phải chữ/số (kể cả "-", ".", "/") -> khoảng trắng để tách token
  s = s.replace(/[^a-z0-9]+/g, " ");
  const tokens = s.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((t) => {
    if (!t || t.length <= 1) return false;
    if (PROD_STOPWORDS.has(t)) return false;
    return true;
  });
  if (!kept.length) return [];
  // Ưu tiên token có chứa chữ số (mã model / công suất / dung lượng) làm chữ ký vì
  // chúng ổn định giữa các cửa hàng. Không có token số nào -> dùng toàn bộ token còn lại.
  const strong = kept.filter((t) => /[0-9]/.test(t));
  const basis = strong.length ? strong : kept;
  return [...new Set(basis)].sort();
}

// Một tập token là "tập con" của tập kia (mọi phần tử của a đều có trong b).
export function tokensSubset(a, b) {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// Token là "mã model/thông số đặc thù" (đủ dài + có chữ số) như 5600x, 14400f,
// 4060, c1200, 6000mhz. Những token kiểu này đủ riêng biệt để 1 token cũng coi
// là cùng sản phẩm (CPU/GPU thường chỉ có đúng 1 mã model trong chữ ký).
export function isModelCode(t) {
  return t.length >= 4 && /[0-9]/.test(t);
}

// Gom danh sách sản phẩm phẳng thành các "cụm" cùng sản phẩm theo cửa hàng.
// Mỗi cửa hàng đặt tên dài ngắn khác nhau (thêm/bớt CL30, 80 Plus, Black...), nên
// KHÔNG đòi token trùng khít tuyệt đối. Thay vào đó: nếu tập token của sản phẩm này
// nằm trọn trong tập token của một cụm đã có (hoặc ngược lại) và phần chung >= 2
// token thì coi là cùng sản phẩm. "core" của cụm là phần token chung của mọi thành
// viên, co dần để luôn đại diện đúng cái chung nhất.
export function clusterProducts(products) {
  const clusters = [];
  for (const p of products) {
    const toks = productSignature(p.name);
    if (!toks.length) continue;
    const set = new Set(toks);
    let best = null;
    for (const c of clusters) {
      const small = set.size <= c.tokens.size ? set : c.tokens;
      const large = set.size <= c.tokens.size ? c.tokens : set;
      if (!tokensSubset(small, large)) continue;
      // Bao hàm 1 chiều: chung >= 2 token thì chắc chắn ghép.
      if (small.size >= 2) {
        best = c;
        break;
      }
      // Chung đúng 1 token nhưng là mã model đặc thù (5600x, 14400f, 4060...)
      // thì vẫn coi là cùng sản phẩm — CPU/GPU thường chỉ có 1 mã trong chữ ký.
      if (small.size === 1 && isModelCode([...small][0])) {
        best = c;
        break;
      }
    }
    if (!best) {
      best = {
        sig: toks.join(" "),
        tokens: set,
        name: p.name,
        brand: p.brand,
        category: p.category,
        offers: [],
      };
      clusters.push(best);
    } else {
      // Co "core" về phần token chung để cụm luôn đại diện cái chung nhất.
      const inter = new Set();
      for (const t of best.tokens) if (set.has(t)) inter.add(t);
      if (inter.size >= 2) best.tokens = inter;
    }
    best.offers.push(p);
    // Giữ tên dài hơn làm tên hiển thị (thường đầy đủ thông tin hơn).
    if ((p.name || "").length > (best.name || "").length) best.name = p.name;
  }
  const list = clusters;
  // Sắp xếp: cụm có nhiều cửa hàng trước, rồi tới chênh lệch giá lớn nhất.
  for (const c of list) {
    const prices = c.offers.map((o) => Number(o.price)).filter((n) => Number.isFinite(n) && n > 0);
    c.minPrice = prices.length ? Math.min(...prices) : null;
    c.maxPrice = prices.length ? Math.max(...prices) : null;
    c.storeCount = new Set(c.offers.map((o) => o.source)).size;
    c.spread = c.minPrice != null ? c.maxPrice - c.minPrice : 0;
  }
  list.sort((a, b) => b.storeCount - a.storeCount || b.spread - a.spread);
  return list;
}

export function renderProducts() {
  const wrap = $("productList");
  if (!wrap) return;
  if (!productStore.products.length) {
    wrap.innerHTML = emptyState("Kho trống", "Đồng bộ một nguồn để nạp sản phẩm vào kho.");
    return;
  }
  wrap.classList.toggle("compare-grid", productStore.mode !== "list");
  if (productStore.mode === "list") {
    renderProductsList(wrap);
  } else {
    renderProductsCompare(wrap);
  }
}

// Cắt mảng theo trang hiện tại + dựng HTML thanh phân trang. Render hàng nghìn thẻ
// một lúc rất nặng, nên chỉ vẽ pageSize mục mỗi trang.
function paginate(arr) {
  const size = productStore.pageSize;
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / size));
  if (productStore.page > pages) productStore.page = pages;
  if (productStore.page < 1) productStore.page = 1;
  const start = (productStore.page - 1) * size;
  const items = arr.slice(start, start + size);
  const pager = total > size ? renderPagerHTML(productStore.page, pages, total) : "";
  return { items, pager };
}

function renderPagerHTML(page, pages, total) {
  return `
    <div class="pager">
      <button class="btn ghost sm" data-pg="prev"${page <= 1 ? " disabled" : ""}>← Trước</button>
      <span class="pager-info">Trang <b>${page}</b>/${pages} · ${total} mục</span>
      <button class="btn ghost sm" data-pg="next"${page >= pages ? " disabled" : ""}>Sau →</button>
    </div>`;
}

// Chế độ danh sách phẳng: mỗi dòng là một bản ghi sản phẩm của một cửa hàng.
function renderProductsList(wrap) {
  const { items, pager } = paginate(productStore.products);
  wrap.innerHTML = items
    .map((p) => {
      const store = p.sourceName || p.source || "";
      const href = resolveProductUrl(p);
      const link = href
        ? `<a class="btn ghost sm" href="${esc(href)}" target="_blank" rel="noopener">Xem ↗</a>`
        : "";
      const chips = [];
      if (store) chips.push(`<span class="prod-chip store">${esc(store)}</span>`);
      if (p.brand) chips.push(`<span class="prod-chip">${esc(p.brand)}</span>`);
      const catLabel = canonCat(p.category);
      if (catLabel) chips.push(`<span class="prod-chip">${esc(catLabel)}</span>`);
      const extra = [p.warranty ? `BH ${p.warranty}` : "", p.condition || ""]
        .filter(Boolean)
        .map(esc)
        .join(" · ");
      if (extra) chips.push(`<span class="prod-chip soft">${extra}</span>`);
      return `
      <div class="prod-item">
        <span class="prod-store" style="background:${colorFor(store)}">${esc(
        initials(store)
      )}</span>
        <div class="prod-info">
          <div class="prod-name">${esc(p.name || "(không tên)")}</div>
          <div class="prod-meta">${chips.join("")}</div>
        </div>
        <div class="prod-right">
          <div class="prod-price">${fmtPrice(p.price)}</div>
          ${
            p.buildPrice != null && p.buildPrice !== p.price
              ? `<div class="prod-build">Build: ${fmtPrice(p.buildPrice)}</div>`
              : ""
          }
          ${link}
        </div>
      </div>`;
    })
    .join("") + pager;
}

// Đếm số SP theo từng nguồn để người dùng biết dữ liệu đã đủ chưa.
function sourceBreakdown(products) {
  const map = new Map();
  for (const p of products) {
    const key = p.sourceName || p.source || "(không rõ)";
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

// Chế độ so sánh: CHỈ hiện các nhóm có mặt ở >=2 cửa hàng (cái thực sự để so giá).
// Nhóm chỉ 1 cửa hàng bị ẩn để tránh đổ hàng nghìn thẻ lẻ gây rối; muốn xem tất cả
// thì chuyển sang chế độ "Danh sách".
function renderProductsCompare(wrap) {
  const clusters = clusterProducts(productStore.products);
  const multi = clusters.filter((c) => c.storeCount >= 2);
  const single = clusters.length - multi.length;
  const breakdown = sourceBreakdown(productStore.products);
  if ($("prodHint")) {
    const perSource = breakdown.map(([n, c]) => `${esc(n)}: ${c}`).join(" · ");
    $("prodHint").textContent =
      `Tổng ${productStore.products.length} SP từ ${breakdown.length} nguồn (${perSource}). ` +
      `Gom thành ${clusters.length} sản phẩm, trong đó ${multi.length} có ở từ 2 cửa hàng trở lên (đang hiển thị bên dưới). ` +
      `${single} sản phẩm chỉ có 1 cửa hàng được ẩn — xem chế độ "Danh sách" để thấy tất cả.`;
  }
  if (!multi.length) {
    wrap.innerHTML = emptyState(
      "Chưa ghép được sản phẩm chung",
      "Không tìm thấy sản phẩm nào xuất hiện ở từ 2 cửa hàng trở lên để so giá. " +
        "Hãy đồng bộ các nguồn cùng nhóm hàng (ví dụ cùng là CPU) rồi thử lại."
    );
    return;
  }
  const { items, pager } = paginate(multi);
  wrap.innerHTML = items.map(renderClusterCard).join("") + pager;
}

function renderClusterCard(c) {
  // Mỗi cửa hàng một offer giá thấp nhất (phòng khi 1 cửa hàng có nhiều biến thể trùng).
  const byStore = new Map();
  for (const o of c.offers) {
    const cur = byStore.get(o.source);
    const price = Number(o.price);
    if (!cur || (Number.isFinite(price) && price > 0 && price < (Number(cur.price) || Infinity))) {
      byStore.set(o.source, o);
    }
  }
  const offers = [...byStore.values()].sort((a, b) => {
    const pa = Number(a.price) || Infinity;
    const pb = Number(b.price) || Infinity;
    return pa - pb;
  });
  // Chênh giá phải tính ĐÚNG trên tập đang hiển thị: mỗi cửa hàng 1 giá rẻ nhất.
  // Không dùng c.spread (tính trên toàn bộ offers, gồm nhiều biến thể đắt trong
  // cùng 1 cửa hàng đã bị ẩn) -> số chênh sẽ vênh với các dòng giá người dùng thấy.
  const shownPrices = offers
    .map((o) => Number(o.price))
    .filter((n) => Number.isFinite(n) && n > 0);
  const shownSpread =
    shownPrices.length >= 2 ? Math.max(...shownPrices) - Math.min(...shownPrices) : 0;
  const rows = offers
    .map((o, i) => {
      const price = Number(o.price);
      const valid = Number.isFinite(price) && price > 0;
      const best = i === 0 && valid && offers.length > 1;
      const store = o.sourceName || o.source || "";
      const href = resolveProductUrl(o);
      const link = href
        ? `<a class="cmp-go" href="${esc(href)}" target="_blank" rel="noopener" title="Mở trang gốc">↗</a>`
        : "";
      // Bảo hành + tình trạng hàng: dữ liệu để AI tư vấn cho khách.
      const extra = [
        o.warranty ? `BH ${o.warranty}` : "",
        o.condition || "",
      ]
        .filter(Boolean)
        .map(esc)
        .join(" · ");
      const extraHTML = extra ? `<span class="cmp-extra">${extra}</span>` : "";
      return `
        <div class="cmp-row${best ? " best" : ""}">
          <span class="cmp-dot" style="background:${colorFor(store)}"></span>
          <span class="cmp-store">${esc(store)}</span>
          <span class="cmp-price">${fmtPrice(o.price)}${
            o.buildPrice != null && o.buildPrice !== o.price
              ? ` <span class="cmp-build">(build ${fmtPrice(o.buildPrice)})</span>`
              : ""
          }</span>
          ${best ? '<span class="cmp-best">Rẻ nhất</span>' : ""}
          ${link}
          ${extraHTML}
        </div>`;
    })
    .join("");
  const spread =
    c.storeCount >= 2 && shownSpread > 0
      ? `<span class="cmp-spread">Chênh ${fmtPrice(shownSpread)}</span>`
      : "";
  const sub = [c.brand, canonCat(c.category)].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="cmp-card">
      <div class="cmp-head">
        <div class="cmp-title">${esc(c.name || "(không tên)")}</div>
        <div class="cmp-tags">
          <span class="cmp-count">${c.storeCount} cửa hàng</span>
          ${spread}
        </div>
      </div>
      ${sub ? `<div class="cmp-sub muted">${sub}</div>` : ""}
      <div class="cmp-rows">${rows}</div>
    </div>`;
}

export async function clearAllProducts() {
  modal({
    title: "Xóa toàn bộ sản phẩm",
    bodyHTML: `<p>Xóa toàn bộ sản phẩm trong kho? Hành động này không hoàn tác được.</p>`,
    confirmText: "Xóa hết",
    danger: true,
    onConfirm: async () => {
      const res = await bg("CLEAR_PRODUCTS", {});
      await loadProducts();
      toast(`Đã xóa ${(res && res.deleted) || 0} sản phẩm.`, "ok");
    },
  });
}
