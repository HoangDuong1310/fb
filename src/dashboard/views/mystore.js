/**
 * Kho của tôi — sản phẩm tự nhập từ Google Sheet + so giá thị trường.
 * Tách từ dashboard.js (B3.2i). Giữ nguyên hành vi gốc.
 */
import { $, bg, esc, toast, modal, emptyState, colorFor } from "../core.js";
import {
  fmtPrice,
  resolveProductUrl,
  productSignature,
  tokensSubset,
  isModelCode,
} from "./products.js";
import { canonCat } from "./build.js";

// State riêng cho view "Kho của tôi" (sản phẩm tự nhập từ Google Sheet).
export const myStore = {
  all: [],          // sản phẩm owned đã nạp
  products: [],     // sau khi lọc theo ô tìm/loại
  market: [],       // sản phẩm các cửa hàng khác (để so giá thị trường)
  cat: "",          // loại đang lọc ("" = tất cả)
  spreadsheetId: "",
  tabs: [],         // [{gid,name}] vừa liệt kê được
};

// Nạp song song: kho của tôi (source=mystore) + toàn bộ kho để tách phần thị trường.
export async function loadMyStore() {
  const res = await bg("GET_PRODUCTS");
  const all = (res && res.products) || [];
  myStore.all = all.filter((p) => p.owned || p.source === "mystore");
  myStore.market = all.filter((p) => !(p.owned || p.source === "mystore"));
  renderMyStoreCats();
  applyMyStoreFilter();
}

// Dựng dải chip lọc theo loại (CPU/RAM/VGA...) lấy từ chính dữ liệu đã nhập.
export function renderMyStoreCats() {
  const box = $("mystoreCatFilter");
  if (!box) return;
  // Gộp tên danh mục đồng nghĩa về nhãn chuẩn để chip lọc không bị phân mảnh.
  const cats = [...new Set(myStore.all.map((p) => canonCat(p.category)).filter(Boolean))].sort();
  const btn = (val, label) =>
    `<button type="button" data-cat="${esc(val)}"${
      myStore.cat === val ? ' class="active"' : ""
    }>${esc(label)}</button>`;
  box.innerHTML =
    btn("", "Tất cả") + cats.map((c) => btn(c, c)).join("");
}

// Lọc theo ô tìm + loại đang chọn, ngay trên client.
export function applyMyStoreFilter() {
  const q = ($("mystoreSearch") ? $("mystoreSearch").value || "" : "").trim().toLowerCase();
  let list = myStore.all;
  if (myStore.cat) list = list.filter((p) => canonCat(p.category) === myStore.cat);
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    list = list.filter((p) => {
      const hay = ((p.name || "") + " " + (p.category || "") + " " + (p.brand || "")).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  myStore.products = list;
  renderMyStore();
}

export function renderMyStore() {
  const wrap = $("mystoreList");
  if (!wrap) return;
  if ($("mystoreHint")) {
    if (!myStore.all.length) {
      $("mystoreHint").textContent =
        "Chưa có sản phẩm nào. Nhập từ Google Sheet ở trên để bắt đầu.";
    } else {
      const cats = new Set(myStore.all.map((p) => p.category).filter(Boolean));
      const priced = myStore.all.filter((p) => p.price != null).length;
      $("mystoreHint").textContent =
        `${myStore.all.length} sản phẩm thuộc ${cats.size} loại · ${priced} có giá. ` +
        `Bấm "So giá thị trường" trên từng sản phẩm để đối chiếu với các cửa hàng khác.`;
    }
  }
  if (!myStore.products.length) {
    wrap.innerHTML = emptyState("Không có sản phẩm", "Thử đổi bộ lọc hoặc nhập thêm từ Google Sheet.");
    return;
  }
  wrap.innerHTML = myStore.products.map(renderMineCard).join("");
}

export function renderMineCard(p) {
  const chips = [];
  const catLabel = canonCat(p.category);
  if (catLabel) chips.push(`<span class="mine-chip cat">${esc(catLabel)}</span>`);
  if (p.brand) chips.push(`<span class="mine-chip">${esc(p.brand)}</span>`);
  if (p.warranty) chips.push(`<span class="mine-chip">BH ${esc(p.warranty)}</span>`);
  if (p.qty != null) chips.push(`<span class="mine-chip">SL ${esc(String(p.qty))}</span>`);
  const price =
    p.price != null
      ? `<span class="mine-price">${fmtPrice(p.price)}</span>`
      : `<span class="mine-price empty">Chưa có giá</span>`;
  return `
    <div class="mine-card" data-id="${esc(p.productId)}">
      <div class="mine-name">${esc(p.name || "(không tên)")}</div>
      <div class="mine-meta">${chips.join("")}</div>
      <div class="mine-foot">
        ${price}
        <button type="button" class="mine-compare" data-cmp="${esc(p.productId)}">So giá thị trường</button>
      </div>
    </div>`;
}

// So một sản phẩm của tôi với kho các cửa hàng khác: gom theo chữ ký tên + mã model,
// lấy mỗi cửa hàng một giá rẻ nhất, hiển thị ngay dưới thẻ.
export function compareMine(productId) {
  const card = document.querySelector(`.mine-card[data-id="${cssEscape(productId)}"]`);
  if (!card) return;
  const old = card.querySelector(".mine-market");
  if (old) { old.remove(); return; } // bấm lần nữa -> thu gọn

  const mine = myStore.all.find((p) => p.productId === productId);
  if (!mine) return;
  const toks = productSignature(mine.name);
  const set = new Set(toks);
  const matches = [];
  if (set.size) {
    for (const o of myStore.market) {
      const ot = new Set(productSignature(o.name));
      if (!ot.size) continue;
      const small = set.size <= ot.size ? set : ot;
      const large = set.size <= ot.size ? ot : set;
      if (!tokensSubset(small, large)) continue;
      if (small.size >= 2 || (small.size === 1 && isModelCode([...small][0]))) {
        matches.push(o);
      }
    }
  }
  // Mỗi cửa hàng giữ giá rẻ nhất, chỉ tính món còn hàng (hết hàng thì không mua được).
  const byStore = new Map();
  for (const o of matches) {
    const price = Number(o.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (o.inStock === false) continue;
    const cur = byStore.get(o.source);
    if (!cur || price < Number(cur.price)) byStore.set(o.source, o);
  }
  const offers = [...byStore.values()].sort(
    (a, b) => (Number(a.price) || Infinity) - (Number(b.price) || Infinity)
  );

  const box = document.createElement("div");
  box.className = "mine-market";
  if (!offers.length) {
    box.innerHTML = `<span class="mine-market-empty">Chưa tìm thấy sản phẩm tương ứng ở các cửa hàng khác. Hãy đồng bộ nguồn cùng loại rồi thử lại.</span>`;
  } else {
    box.innerHTML = offers
      .map((o, i) => {
        const store = o.sourceName || o.source || "";
        const href = resolveProductUrl(o);
        const name = href
          ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(store)} ↗</a>`
          : esc(store);
        return `
          <div class="mine-market-row${i === 0 ? " best" : ""}">
            <span class="ms"><span class="dot" style="background:${colorFor(store)}"></span>${name}</span>
            <span class="mp">${fmtPrice(o.price)}</span>
          </div>`;
      })
      .join("");
  }
  card.appendChild(box);
}

// Thoát ký tự đặc biệt cho querySelector (productId chứa "::").
export function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&");
}

// ---- Nhập từ Google Sheet --------------------------------------------
export async function loadSheetTabs() {
  const url = ($("sheetUrl") ? $("sheetUrl").value || "" : "").trim();
  if (!url) { toast("Hãy dán link Google Sheet.", "err"); return; }
  const t = toast("Đang đọc danh sách tab...", "info", 0);
  const res = await bg("SHEET_TABS", { url });
  t.close();
  if (!res || !res.ok) {
    toast((res && res.error) || "Không đọc được Sheet.", "err", 5000);
    return;
  }
  myStore.spreadsheetId = res.spreadsheetId;
  myStore.tabs = res.tabs || [];
  renderSheetTabs();
  toast(`Tìm thấy ${myStore.tabs.length} tab.`, "ok");
}

// Đoán loại từ tên tab + nhận diện tab "báo giá ảo / bản gốc" để mặc định bỏ qua.
export function guessCategory(name) {
  const n = String(name || "").toLowerCase();
  const skip = /(bao gia|báo giá|hoa don|hóa đơn|ban goc|bản gốc|ao|ảo|template|mau|mẫu)/.test(n);
  const map = [
    ["cpu", "CPU"], ["ram", "RAM"], ["vga", "VGA"], ["card", "VGA"],
    ["main", "Mainboard"], ["bo mach", "Mainboard"], ["ssd", "SSD"], ["hdd", "HDD"],
    ["nguon", "Nguồn"], ["psu", "Nguồn"], ["case", "Case"], ["vo", "Case"],
    ["tan nhiet", "Tản nhiệt"], ["man", "Màn hình"], ["monitor", "Màn hình"],
  ];
  let cat = name || "";
  for (const [kw, label] of map) if (n.includes(kw)) { cat = label; break; }
  return { skip, cat };
}

export function renderSheetTabs() {
  const box = $("sheetTabs");
  if (!box) return;
  box.innerHTML = myStore.tabs
    .map((t) => {
      const g = guessCategory(t.name);
      return `
      <label class="sheet-tab${g.skip ? " skip" : ""}" data-gid="${esc(t.gid)}">
        <input type="checkbox" data-pick ${g.skip ? "" : "checked"} />
        <span>
          <span class="sheet-tab-name">${esc(t.name)}</span>
        </span>
        <span class="sheet-tab-gid">gid ${esc(t.gid)}</span>
        <input type="text" class="sheet-tab-cat" data-cat value="${esc(g.cat)}" placeholder="Loại (CPU/RAM...)" />
      </label>`;
    })
    .join("");
  const bar = $("sheetImportBar");
  if (bar) bar.hidden = myStore.tabs.length === 0;
}

export async function importSheet() {
  const box = $("sheetTabs");
  if (!box || !myStore.spreadsheetId) { toast("Hãy liệt kê tab trước.", "err"); return; }
  const tabs = [];
  box.querySelectorAll(".sheet-tab").forEach((row) => {
    const pick = row.querySelector("[data-pick]");
    if (!pick || !pick.checked) return;
    const gid = row.dataset.gid;
    const meta = myStore.tabs.find((t) => t.gid === gid) || { name: "" };
    const catEl = row.querySelector("[data-cat]");
    tabs.push({ gid, name: meta.name, category: (catEl ? catEl.value : "").trim() });
  });
  if (!tabs.length) { toast("Chưa chọn tab nào.", "err"); return; }
  const t = toast(`Đang nhập ${tabs.length} tab...`, "info", 0);
  const res = await bg("IMPORT_SHEET", { spreadsheetId: myStore.spreadsheetId, tabs });
  t.close();
  if (!res || !res.ok) {
    toast((res && res.error) || "Nhập thất bại.", "err", 5000);
    return;
  }
  toast(`Đã nhập ${res.imported} dòng (mới ${res.added}, cập nhật ${res.updated}).`, "ok", 4000);
  await loadMyStore();
}

export async function clearMyStore() {
  modal({
    title: "Xóa kho của tôi",
    bodyHTML: `<p>Xóa toàn bộ sản phẩm đã nhập từ Google Sheet? Hành động này không hoàn tác được.</p>`,
    confirmText: "Xóa hết",
    danger: true,
    onConfirm: async () => {
      const res = await bg("CLEAR_PRODUCTS", { source: "mystore" });
      await loadMyStore();
      toast(`Đã xóa ${(res && res.deleted) || 0} sản phẩm.`, "ok");
    },
  });
}
