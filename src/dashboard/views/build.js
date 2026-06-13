/**
 * build.js — View "Build cấu hình bằng AI".
 *
 * Gom linh kiện trong "Kho của tôi" (lấp giá thiếu từ thị trường) rồi gọi service
 * worker (BUILD_CONFIG) để AI đề xuất bộ máy theo ngân sách + nhu cầu.
 *
 * Lưu ý phụ thuộc chéo: canonCat() định nghĩa & export tại đây và được
 * products.js / mystore.js import lại (chuẩn hoá tên danh mục về 1 nhãn).
 */
import { $, bg, esc, toast } from "../core.js";
import {
  fmtPrice,
  productSignature,
  tokensSubset,
  isModelCode,
  resolveProductUrl,
} from "./products.js";

// Thứ tự ưu tiên chuẩn của linh kiện (danh mục đầu = quan trọng nhất khi nâng/hạ cấp).
// Dùng để vừa SẮP danh mục trong form, vừa truyền thứ tự ưu tiên cho thuật toán.
const BUILD_CAT_ORDER = [
  "CPU", "Main", "Mainboard", "Bo mạch chủ", "VGA", "RAM",
  "Ổ cứng", "SSD", "Nguồn PSU", "Nguồn", "PSU",
  "Tản nhiệt", "Vỏ case", "Case", "Màn hình", "Phụ Kiện",
];

export const buildAI = {
  owned: [],        // sản phẩm trong kho (source=mystore)
  market: [],       // sản phẩm các cửa hàng khác (để lấp giá thiếu)
  cats: [],         // danh mục khả dụng (từ kho), đã sắp theo BUILD_CAT_ORDER
  selected: new Set(), // danh mục đang chọn
  needs: new Set(["gaming"]),
  candidates: {},   // { cat: [ {id,name,price,store,owned,url} ] } của lần build gần nhất
  lastResult: null, // kết quả render gần nhất (để xuất)
};

// Gộp các tên danh mục đồng nghĩa về MỘT nhãn chuẩn để không bị phân mảnh khi
// build (VD "Main"/"Bo mạch chủ" -> "Mainboard", "PSU"/"Nguồn PSU" -> "Nguồn",
// "Vỏ case" -> "Case"). Tên lạ giữ nguyên.
export function canonCat(c) {
  const n = String(c || "").trim().toLowerCase();
  if (!n) return "";
  if (n === "cpu") return "CPU";
  if (n === "ram") return "RAM";
  if (n === "vga" || n === "card" || n.includes("card màn") || n.includes("card man")) return "VGA";
  if (n.includes("main") || n.includes("bo mạch") || n.includes("bo mach")) return "Mainboard";
  if (n === "ssd") return "SSD";
  if (n === "hdd") return "HDD";
  if (n.includes("ổ cứng") || n.includes("o cung")) return "Ổ cứng";
  if (n.includes("nguồn") || n.includes("nguon") || n === "psu") return "Nguồn";
  if (n.includes("case") || n.includes("vỏ") || n === "vo") return "Case";
  if (n.includes("tản") || n.includes("tan nhiet")) return "Tản nhiệt";
  if (n.includes("màn") || n.includes("man hinh") || n.includes("monitor")) return "Màn hình";
  return String(c).trim();
}

// Nạp dữ liệu kho + thị trường, dựng lại dải danh mục.
export async function loadBuildView() {
  const res = await bg("GET_PRODUCTS");
  const all = (res && res.products) || [];
  buildAI.owned = all.filter((p) => p.owned || p.source === "mystore");
  buildAI.market = all.filter((p) => !(p.owned || p.source === "mystore"));
  // Danh mục lấy từ chính kho, gộp tên đồng nghĩa, sắp theo thứ tự ưu tiên chuẩn.
  const present = [...new Set(buildAI.owned.map((p) => canonCat(p.category)).filter(Boolean))];
  present.sort((a, b) => {
    const ia = BUILD_CAT_ORDER.findIndex((x) => canonCat(x) === a);
    const ib = BUILD_CAT_ORDER.findIndex((x) => canonCat(x) === b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  buildAI.cats = present;
  // Mặc định chọn hết các danh mục có trong kho (lần đầu).
  if (!buildAI.selected.size) buildAI.selected = new Set(present);
  renderBuildCats();
  // Đồng bộ ô ngân sách lần đầu.
  syncBuildBudget();
  // Nếu kho trống -> báo cho người dùng.
  if (!buildAI.owned.length) {
    setBuildOutput(
      buildEmptyHTML(
        "Kho của tôi đang trống",
        'Hãy vào "Kho của tôi" nhập sản phẩm từ Google Sheet trước, rồi quay lại đây để AI dựng cấu hình.'
      )
    );
  } else if (!buildAI.lastResult) {
    setBuildOutput(
      buildEmptyHTML(
        "Chưa có cấu hình",
        "Nhập ngân sách + nhu cầu rồi bấm “Tạo cấu hình” để AI đề xuất bộ máy phù hợp."
      )
    );
  }
}

export function buildEmptyHTML(title, desc) {
  return `<div class="build-empty">
    <svg viewBox="0 0 24 24"><path d="M22 9 12 2 2 9l10 7 10-7zm-10 9.5L4 12.7V15l8 5.8 8-5.8v-2.3l-8 5.8z"/></svg>
    <strong>${esc(title)}</strong><span>${esc(desc)}</span>
  </div>`;
}

export function setBuildOutput(html) {
  if ($("buildOutput")) $("buildOutput").innerHTML = html;
}

// Dựng các ô chọn danh mục linh kiện (checkbox), tích sẵn theo buildAI.selected.
export function renderBuildCats() {
  const box = $("buildCats");
  if (!box) return;
  if (!buildAI.cats.length) {
    box.innerHTML = `<span class="muted" style="grid-column:1/-1">Chưa có danh mục nào trong kho.</span>`;
    return;
  }
  box.innerHTML = buildAI.cats
    .map((c) => {
      const on = buildAI.selected.has(c);
      return `<label class="${on ? "on" : ""}" data-cat="${esc(c)}">
        <input type="checkbox" ${on ? "checked" : ""} /><span>${esc(c)}</span>
      </label>`;
    })
    .join("");
}

// Đọc số tiền người dùng gõ (bỏ mọi ký tự không phải số).
export function parseBudget(v) {
  const n = Number(String(v || "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// Đồng bộ ô số <-> thanh trượt <-> dòng hiển thị lớn.
export function syncBuildBudget(fromRange) {
  const input = $("buildBudget");
  const range = $("buildBudgetRange");
  const text = $("buildBudgetText");
  if (!input || !range) return;
  let val;
  if (fromRange) {
    val = Number(range.value);
    input.value = new Intl.NumberFormat("vi-VN").format(val);
  } else {
    val = parseBudget(input.value);
    if (val) {
      const clamped = Math.min(Math.max(val, Number(range.min)), Number(range.max));
      range.value = clamped;
    }
  }
  if (text) text.textContent = fmtPrice(val || parseBudget(input.value));
}

// Khớp 1 sản phẩm kho với thị trường: lấy giá RẺ NHẤT (tái dùng logic compareMine).
export function cheapestMarketFor(mine) {
  const toks = productSignature(mine.name);
  const set = new Set(toks);
  if (!set.size) return null;
  let best = null;
  for (const o of buildAI.market) {
    const ot = new Set(productSignature(o.name));
    if (!ot.size) continue;
    const small = set.size <= ot.size ? set : ot;
    const large = set.size <= ot.size ? ot : set;
    if (!tokensSubset(small, large)) continue;
    if (!(small.size >= 2 || (small.size === 1 && isModelCode([...small][0])))) continue;
    const price = Number(o.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    // Bỏ qua hàng đã hết: build cấu hình chỉ chọn món còn bán được.
    if (o.inStock === false) continue;
    if (!best || price < Number(best.price)) best = o;
  }
  return best;
}

// Gom ứng viên theo danh mục: mỗi sản phẩm kho -> 1 ứng viên có GIÁ THỰC.
//  - Có giá trong kho: dùng giá đó, owned=true.
//  - Kho chưa có giá: lấy giá rẻ nhất từ cửa hàng khác (nếu tìm được), owned=false.
//  - ownedOnly=true: chỉ giữ món có giá ngay trong kho.
export function buildCandidatesByCategory(categories, ownedOnly) {
  const out = {};
  for (const c of categories) {
    const arr = [];
    for (const p of buildAI.owned) {
      if (canonCat(p.category) !== c) continue;
      const ownPrice = Number(p.price);
      if (Number.isFinite(ownPrice) && ownPrice > 0) {
        arr.push({ id: p.productId, name: p.name, price: ownPrice, store: p.sourceName || "Kho của tôi", owned: true, url: p.url || "" });
        continue;
      }
      if (ownedOnly) continue; // chỉ dùng hàng kho có giá
      const m = cheapestMarketFor(p);
      if (m) {
        arr.push({
          id: p.productId, name: p.name, price: Number(m.price),
          store: m.sourceName || m.source || "Cửa hàng khác", owned: false, url: resolveProductUrl(m),
        });
      }
    }
    out[c] = arr;
  }
  return out;
}

// Nút "Tạo cấu hình": gom ứng viên -> gọi BUILD_CONFIG -> render.
export async function runBuildConfig() {
  const budget = parseBudget($("buildBudget") ? $("buildBudget").value : "");
  if (!budget) {
    toast("Hãy nhập ngân sách (VD: 25.000.000).", "err");
    return;
  }
  const categories = buildAI.cats.filter((c) => buildAI.selected.has(c));
  if (!categories.length) {
    toast("Hãy chọn ít nhất một danh mục linh kiện.", "err");
    return;
  }
  const ownedOnly = !!($("buildOwnedOnly") && $("buildOwnedOnly").checked);
  const candidates = buildCandidatesByCategory(categories, ownedOnly);
  buildAI.candidates = candidates;

  const totalCand = categories.reduce((n, c) => n + (candidates[c] ? candidates[c].length : 0), 0);
  if (!totalCand) {
    setBuildOutput(
      buildEmptyHTML(
        "Không tìm được linh kiện có giá",
        ownedOnly
          ? "Kho chưa có linh kiện nào có giá ở các danh mục đã chọn. Bỏ tích “Chỉ dùng hàng trong kho” để lấy giá từ cửa hàng khác."
          : "Chưa khớp được giá nào. Hãy đồng bộ nguồn giá ở mục Sản phẩm/Giá rồi thử lại."
      )
    );
    return;
  }

  // Mô tả nhu cầu: chip đang chọn + ghi chú tự do.
  const NEED_LABEL = { gaming: "Gaming", office: "Văn phòng", design: "Đồ hoạ", stream: "Stream", render: "Render/AI" };
  const needList = [...buildAI.needs].map((k) => NEED_LABEL[k] || k);
  const note = ($("buildNote") ? $("buildNote").value || "" : "").trim();
  const needs = (needList.join(", ") + (note ? ". " + note : "")).trim();

  setBuildOutput(
    `<div class="build-loading"><div class="build-spin"></div><span id="buildProgressText">Đang chuẩn bị linh kiện...</span></div>`
  );
  buildAI.running = true;
  if ($("btnBuildConfig")) $("btnBuildConfig").disabled = true;

  let res;
  try {
    res = await bg("BUILD_CONFIG", { payload: { budget, needs, categories, candidates } });
  } catch (e) {
    res = { ok: false, error: String(e) };
  } finally {
    buildAI.running = false;
    if ($("btnBuildConfig")) $("btnBuildConfig").disabled = false;
  }

  if (!res || !res.ok) {
    setBuildOutput(buildEmptyHTML("Không tạo được cấu hình", (res && res.error) || "Lỗi không xác định."));
    return;
  }
  renderBuildResult(res, budget);
}

// Render kết quả: thanh tổng tiền/ngân sách + ghi chú + từng linh kiện + nút xuất.
export function renderBuildResult(res, budget) {
  const items = Array.isArray(res.items) ? res.items : [];
  // Map mỗi item về ứng viên thực để lấy GIÁ THỰC (không tin số AI tự tính).
  const rows = [];
  let total = 0;
  for (const it of items) {
    const pool = buildAI.candidates[it.category] || [];
    const cand = pool.find((x) => String(x.id) === String(it.id)) || pool[0];
    if (!cand) continue;
    const price = Number(cand.price);
    if (Number.isFinite(price) && price > 0) total += price;
    rows.push({ category: it.category, cand, reason: it.reason || "" });
  }

  const pct = budget > 0 ? Math.min(100, Math.round((total / budget) * 100)) : 0;
  const over = total > budget;
  const barClass = over ? "over" : pct >= 85 ? "warn" : "ok";
  const badge = $("buildSrcBadge");
  if (badge) {
    badge.hidden = false;
    badge.className = "build-src-badge " + (res.source === "ai" ? "ai" : "fallback");
    badge.textContent = res.source === "ai" ? "AI chọn" : "Tự chọn";
  }

  const summary = `
    <div class="build-summary">
      <div class="bs-total"><small>Tổng cấu hình</small><strong>${fmtPrice(total)}</strong></div>
      <div class="bs-budget">
        Ngân sách ${fmtPrice(budget)}${over ? ' · <span style="color:var(--red)">vượt ' + fmtPrice(total - budget) + "</span>" : " · còn " + fmtPrice(Math.max(0, budget - total))}
        <div class="build-bar"><i class="${barClass}" style="width:${pct}%"></i></div>
      </div>
    </div>`;

  const noteHTML = res.note ? `<div class="build-note">${esc(res.note)}</div>` : "";

  const itemsHTML = rows
    .map((r, i) => {
      const c = r.cand;
      const tag = c.owned
        ? `<span class="bi-tag owned">Trong kho</span>`
        : `<span class="bi-tag market">${esc(c.store)}</span>`;
      const href = resolveProductUrl(c);
      const nameHTML = href
        ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(c.name || "(không tên)")}</a>`
        : esc(c.name || "(không tên)");
      const price =
        Number(c.price) > 0
          ? `<span class="bi-price">${fmtPrice(c.price)}</span>`
          : `<span class="bi-price empty">Chưa có giá</span>`;
      const reason = r.reason ? `<div class="bi-reason">${esc(r.reason)}</div>` : "";
      return `<div class="build-item" style="animation-delay:${i * 0.04}s">
        <span class="bi-cat">${esc(r.category)}</span>
        <div class="bi-main">
          <div class="bi-name">${nameHTML}</div>
          <div class="bi-meta">${tag}</div>
          ${reason}
        </div>
        ${price}
      </div>`;
    })
    .join("");

  setBuildOutput(
    summary + noteHTML +
    `<div class="build-items">${itemsHTML}</div>` +
    `<div class="build-actions"><button id="btnCopyBuild" class="btn ghost">Sao chép cấu hình</button></div>`
  );

  // Lưu để xuất văn bản.
  buildAI.lastResult = { rows, total, budget, source: res.source, note: res.note || "" };
  if ($("btnCopyBuild")) $("btnCopyBuild").addEventListener("click", copyBuildResult);
}

// Sao chép cấu hình dạng văn bản (tiện gửi khách qua chat).
export function copyBuildResult() {
  const r = buildAI.lastResult;
  if (!r) return;
  const lines = ["📋 CẤU HÌNH ĐỀ XUẤT", ""];
  for (const it of r.rows) {
    const c = it.cand;
    const price = Number(c.price) > 0 ? fmtPrice(c.price) : "Chưa có giá";
    lines.push(`• ${it.category}: ${c.name || "(không tên)"} — ${price}${c.owned ? " (kho)" : " (" + c.store + ")"}`);
  }
  lines.push("", `Tổng: ${fmtPrice(r.total)} / Ngân sách: ${fmtPrice(r.budget)}`);
  if (r.note) lines.push("", r.note);
  const text = lines.join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast("Đã sao chép cấu hình.", "ok"),
    () => toast("Không sao chép được.", "err")
  );
}
