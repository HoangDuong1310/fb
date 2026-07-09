/**
 * prices.js — Nguồn dữ liệu giá/sản phẩm (HACOM + 3 store nền tảng Hura).
 * Fetch + chuẩn hoá + phân trang + đồng bộ + seed sẵn 4 nguồn.
 *
 * Tách từ background.js (B3.1b). Phụ thuộc:
 *   - util.js: getByPath, parsePrice, resolveUrl, stripTags, withQueryParam,
 *              broadcast, sleepJitter
 *   - db.js (DB.*): getSources, saveSource, deleteSource, saveProducts, clearProducts
 */

import * as DB from "./db.js";
import {
  getByPath,
  parsePrice,
  resolveUrl,
  stripTags,
  withQueryParam,
  broadcast,
  sleepJitter,
} from "./util.js";

// Bóc các MỐC GIÁ có nhãn rõ ràng trong khối khuyến mãi (specialOffer) của
// nền tảng Hura. Quan trọng: field "price" của Hura KHÔNG nhất quán giữa các
// store (Nguyễn Công: price = giá BUILD PC rẻ nhất; An Phát: price = giá bán
// lẻ thực) nên không được đoán. Mỗi cửa hàng lại DIỄN ĐẠT KHÁC NHAU, nên không
// thể khớp cứng theo một mẫu câu. Cách làm: tách khối khuyến mãi thành từng
// DÒNG, dòng nào có số tiền thì phân loại theo từ khoá xuất hiện trong dòng đó:
//   - chứa "bán lẻ"            -> giá BÁN LẺ thực (giá đứng một mình)
//   - chứa "build" (mà ko "bán lẻ") -> giá BUILD (mua kèm bộ)
// Thứ tự chữ/số trong dòng không quan trọng (có store ghi tiền trước nhãn).
// VD thực tế:
//   Nguyễn Công: "Giá Build PC : 3.290.000đ", "Giá bán lẻ rời CPU : 3.890.000đ"
//   Hoàng Hà   : "...3.290.000đ áp dụng khi build PC", "Giá bán lẻ là: 3.990.000đ"
// -> cả hai đều bóc được build (thấp nhất trong các dòng build) + retail.
// Trả { retail, build }; nhãn nào không có thì để null.
function extractHuraPrices(raw) {
  const empty = { retail: null, build: null };
  if (raw == null) return empty;
  // QUAN TRỌNG: chỉ đọc các GIÁ TRỊ chuỗi (câu chữ người đọc) trong specialOffer,
  // KHÔNG stringify cả object. Nếu stringify cả object thì TÊN FIELD cũng lọt vào
  // text: ví dụ field số "buildPcId":1650 sẽ bị bắt nhầm. Gom string value đệ quy
  // nên tên field không bao giờ xuất hiện trong chuỗi cần phân tích.
  const parts = [];
  const collect = (v) => {
    if (v == null) return;
    if (typeof v === "string") {
      parts.push(v);
    } else if (Array.isArray(v)) {
      for (const e of v) collect(e);
    } else if (typeof v === "object") {
      for (const k in v) collect(v[k]);
    }
  };
  collect(raw);
  // QUAN TRỌNG (xác minh dữ liệu thật): số tiền hay bị thẻ inline cắt đôi, ví dụ
  // "9<strong>.990.000</strong>đ" — chữ số "9" NẰM NGOÀI thẻ. Nếu để stripTags
  // thay thẻ bằng KHOẢNG TRẮNG sẽ thành "9 .990.000" và MONEY chỉ bắt "990.000"
  // (mất mất hàng triệu). Vì vậy bóc các thẻ ĐỊNH DẠNG inline (strong/b/em/i/
  // span/u) bằng chuỗi RỖNG TRƯỚC, để số bị tách được nối liền lại.
  const joined = parts
    .join("\n")
    .replace(/<\/?(?:strong|b|em|i|span|u)\b[^>]*>/gi, "");
  // Tách thành từng DÒNG theo ranh giới hiển thị: </p>, <br>, xuống dòng, hoặc
  // bullet (•, ⭐, ★). Tách TRƯỚC khi bóc các thẻ còn lại để giữ ranh giới dòng.
  const lines = joined
    .split(/<\/p>|<br\s*\/?>|\r?\n|[•⭐★]/gi)
    .map((s) => stripTags(s))
    .filter((s) => s);
  const toNum = (s) => {
    const digits = String(s || "").replace(/[^\d]/g, "");
    if (!digits) return null;
    const n = parseInt(digits, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  // Số tiền VND LUÔN có định dạng phân tách nghìn ("3.290.000" / "3,290,000").
  // Bắt buộc khớp định dạng đó để loại số trần (vd 1650), phần trăm, dung lượng...
  const MONEY = /(\d{1,3}(?:[.,]\d{3})+)/;
  // Nhãn GIÁ BÁN LẺ thực tế (xác minh trên dữ liệu thật cả 3 store) gồm nhiều biến
  // thể: "bán lẻ", "bán lẻ rời", và CẢ "mua lẻ" ("GIÁ MUA LẺ", "ưu đãi mua lẻ").
  const RETAIL_KW = /(b[áa]n|mua)\s*l[ẻe]/i;
  // Nhãn GIÁ BUILD gồm "build" và "kèm PC" ("GIÁ ƯU ĐÃI MUA KÈM PC").
  const BUILD_KW = /build|k[èe]m\s*pc/i;
  // Dòng nhiễu KHÔNG phải giá sản phẩm: khuyến mãi giảm tiền, trị giá quà tặng.
  // (Số điện thoại như 097.111.3333 cũng khớp MONEY nhưng các dòng đó không chứa
  //  từ khoá retail/build nên đã tự bị loại.)
  const NOISE_KW = /gi[ảa]m|qu[àa]\s*t[ặa]ng|tr[ịi]\s*gi[áa]/i;
  let retail = null;
  let build = null;
  for (const line of lines) {
    if (NOISE_KW.test(line)) continue; // bỏ dòng giảm giá / quà tặng.
    const mMoney = line.match(MONEY);
    if (!mMoney) continue; // dòng không có giá -> bỏ (vd dòng điều kiện, lưu ý).
    const money = toNum(mMoney[1]);
    if (money == null) continue;
    // Ưu tiên kiểm retail trước: "bán lẻ"/"mua lẻ" = giá bán lẻ thực.
    if (RETAIL_KW.test(line)) {
      if (retail == null) retail = money;
    } else if (BUILD_KW.test(line)) {
      // Có thể nhiều dòng build (kèm PC / không VGA...) -> lấy giá THẤP NHẤT
      // (giá kèm trọn bộ PC luôn là mốc thấp nhất, đại diện cho "giá build").
      if (build == null || money < build) build = money;
    }
  }
  return { retail, build };
}

// Đọc mảng sản phẩm thô từ JSON theo itemsPath, ánh xạ trường theo mapping,
// trả về danh sách sản phẩm đã chuẩn hoá theo schema chung của kho.
function normalizeItems(json, source) {
  const itemsPath = source.itemsPath || "";
  let raw = getByPath(json, itemsPath);
  if (!Array.isArray(raw)) {
    // Nếu itemsPath trỏ tới object chứa mảng con phổ biến, thử vài khả năng.
    if (raw && Array.isArray(raw.items)) raw = raw.items;
    else if (Array.isArray(json)) raw = json;
    else raw = [];
  }
  const m = source.mapping || {};
  const pick = (item, key) => (m[key] ? getByPath(item, m[key]) : undefined);
  // Coi 1 giá trị cờ là "có/đúng": true, 1, "Y", "yes", "true"...
  const isTruthyFlag = (v) =>
    v === true || v === 1 || /^(y|yes|true|1|còn hàng)$/i.test(String(v).trim());
  // Tách số nguyên từ chuỗi tồn kho ("26", "10 cái"...). Trả null nếu không có số.
  const toInt = (v) => {
    if (v == null) return null;
    const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  // Chuyển giá trị về chuỗi an toàn. Một số nguồn trả object thay vì chuỗi
  // (vd An Phát: brand = {id, name, image, url}); lấy .name/.title để tránh
  // render ra "[object Object]".
  const toStr = (v) => {
    if (v == null) return "";
    if (typeof v === "object") {
      if (typeof v.name === "string") return v.name;
      if (typeof v.title === "string") return v.title;
      return "";
    }
    return String(v);
  };
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rawId = pick(item, "productId");
    const name = pick(item, "name");
    if (rawId == null && name == null) continue;
    // Loại hàng KHÔNG bán lẻ (vd HACOM coBanLe="N": hàng liên hệ/giá build),
    // để đảm bảo giá lưu lại luôn là giá bán lẻ thực.
    if (m.retailFlag) {
      const rf = getByPath(item, m.retailFlag);
      if (rf != null && rf !== "" && !isTruthyFlag(rf)) continue;
    }
    const idPart = rawId != null ? String(rawId) : String(name);
    // Tình trạng còn hàng: ưu tiên cờ tồn kho (HACOM hasStock), nếu không có thì
    // dựa vào số lượng tồn (Hura quantity / HACOM onhandQuantity). Không rõ -> coi
    // như còn (không loại oan dữ liệu cũ chưa có thông tin này).
    const stockRaw = pick(item, "stock");
    const stockNum = toInt(stockRaw);
    const flagRaw = m.stockFlag ? getByPath(item, m.stockFlag) : undefined;
    let inStock;
    if (flagRaw !== undefined && flagRaw !== null && flagRaw !== "") {
      inStock = isTruthyFlag(flagRaw);
    } else if (stockNum != null) {
      inStock = stockNum > 0;
    } else {
      inStock = true;
    }
    // Giá: mặc định lấy field "price" làm giá bán lẻ. Nhưng field "price" của
    // Hura KHÔNG nhất quán: ở Nguyễn Công nó là GIÁ BUILD PC (rẻ nhất, chỉ khi
    // mua kèm bộ), còn ở An Phát nó lại là giá bán lẻ thực. Nên với store có
    // khối khuyến mãi (m.retailOffer), đọc đúng các dòng có nhãn:
    //   - "Giá bán lẻ rời ... : X" -> X là giá bán lẻ thực (ưu tiên dùng cho price)
    //   - "Giá Build PC : Y"       -> Y là giá build (lưu riêng vào buildPrice)
    // Không có nhãn bán lẻ rời -> giữ field "price" (trường hợp An Phát).
    let price = parsePrice(pick(item, "price"));
    let buildPrice = null;
    if (m.buildPrice) {
      // HACOM: giá build PC là field RIÊNG (giaBuildPcKoVga) -> lấy thẳng,
      // KHÔNG suy đoán theo "thấp nhất" (giá build có thể cao HOẶC thấp hơn lẻ).
      buildPrice = parsePrice(pick(item, "buildPrice"));
    }
    if (m.retailOffer) {
      const hp = extractHuraPrices(getByPath(item, m.retailOffer));
      if (hp.retail != null) price = hp.retail;
      buildPrice = hp.build;
    }
    out.push({
      // productId là khoá chính trong kho: gắn tiền tố source để không đụng nhau.
      productId: source.id + ":" + idPart,
      sourceProductId: rawId != null ? String(rawId) : null,
      source: source.id,
      sourceName: source.name || source.id,
      name: name != null ? String(name) : "",
      price,
      // Giá build PC (chỉ Hura có): giá khi mua kèm nguyên bộ, lưu riêng để
      // hiển thị tham khảo. null nếu nguồn không có mốc "Giá Build PC".
      buildPrice,
      category: toStr(pick(item, "category")),
      brand: toStr(pick(item, "brand")),
      url: resolveUrl(pick(item, "url") != null ? String(pick(item, "url")) : "", source.url),
      image: resolveUrl(pick(item, "image") != null ? String(pick(item, "image")) : "", source.url),
      stock: stockRaw,
      // Còn hàng hay không (đã chuẩn hoá) — dùng để lọc khi so giá / build cấu hình.
      inStock,
      // Mã nội bộ cửa hàng + model (đa số rỗng) — phụ trợ cho gom nhóm.
      sku: toStr(pick(item, "sku")),
      model: toStr(pick(item, "model")),
      // Dữ liệu để AI tư vấn cho khách: bảo hành + tình trạng hàng.
      warranty: toStr(pick(item, "warranty")),
      condition: toStr(pick(item, "condition")),
    });
  }
  return out;
}

// --- Trích sản phẩm từ payload Next.js RSC (HACOM) ---------------------------
// HACOM nhúng dữ liệu sản phẩm trong các chunk self.__next_f.push([...]) dưới
// dạng container "product":{...}. Gộp chunk -> cân bằng ngoặc -> JSON.parse.
function mergeRSC(html) {
  const pushRe = /self\.__next_f\.push\(\[\d+,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m, merged = "";
  while ((m = pushRe.exec(html)) !== null) {
    try { merged += JSON.parse('"' + m[1] + '"'); } catch (e) { merged += m[1]; }
  }
  return merged;
}

// Đọc 1 object JSON hoàn chỉnh bắt đầu tại braceIdx (cân bằng ngoặc, bỏ qua chuỗi).
function readRscObject(str, braceIdx) {
  let d = 0, inStr = false, esc = false;
  for (let i = braceIdx; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) return str.slice(braceIdx, i + 1); }
  }
  return null;
}

// Trả mảng product object (chỉ giữ item có itemCode) từ HTML trang HACOM.
function extractRscProducts(html) {
  const merged = mergeRSC(html);
  const out = [], seen = new Set();
  const re = /"product"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(merged)) !== null) {
    const braceIdx = merged.indexOf("{", m.index + 9);
    if (braceIdx < 0) continue;
    const objStr = readRscObject(merged, braceIdx);
    if (!objStr) continue;
    try {
      const p = JSON.parse(objStr);
      if (p && p.itemCode && !seen.has(p.itemCode)) {
        seen.add(p.itemCode);
        out.push(p);
      }
    } catch (e) {}
  }
  return out;
}

// Fetch 1 trang theo cấu hình nguồn, trả về JSON đã parse.
// Nếu source.parse === "html-rsc": đọc HTML, trích sản phẩm RSC -> {list:[...]}.
async function fetchSourcePage(source, url) {
  const init = {
    method: source.method || "GET",
    headers: source.headers || {},
    credentials: "include",
  };
  if ((source.method || "GET").toUpperCase() !== "GET" && source.bodyTemplate) {
    init.body = source.bodyTemplate;
  }
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const err = new Error("Nguồn trả về HTTP " + resp.status);
    err.httpStatus = resp.status;
    throw err;
  }
  if ((source.parse || "").toLowerCase() === "html-rsc") {
    const html = await resp.text();
    return { list: extractRscProducts(html) };
  }
  return resp.json();
}

// Lấy toàn bộ sản phẩm của MỘT URL gốc (1 category) qua phân trang.
// Trả { items, total, pages, lastError, hardError } — hardError nghĩa là
// ngay trang đầu đã lỗi (coi như URL hỏng hẳn).
async function fetchPaginatedUrl(source, baseUrl, ctx) {
  const pageParam = source.pageParam || "";
  const pageStart = Number.isFinite(source.pageStart) ? source.pageStart : 1;
  const pageSize = source.pageSize > 0 ? source.pageSize : 0;
  const pageSizeParam = source.pageSizeParam || "";
  const totalPath = source.totalPath || "";
  const maxPages = source.maxPages > 0 ? source.maxPages : (pageParam ? 50 : 1);

  const items = [];
  let total = null;
  let pages = 0;
  let lastError = null;

  for (let i = 0; i < maxPages; i++) {
    const pageNo = pageStart + i;
    let url = baseUrl;
    if (pageParam) url = withQueryParam(url, pageParam, pageNo);
    if (pageSizeParam && pageSize) url = withQueryParam(url, pageSizeParam, pageSize);

    let json;
    try {
      json = await fetchSourcePage(source, url);
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
      if (i === 0) return { items, total, pages, lastError, hardError: true };
      break;
    }

    if (total == null && totalPath) {
      const t = parseInt(getByPath(json, totalPath), 10);
      if (Number.isFinite(t)) total = t;
    }

    const pageItems = normalizeItems(json, source);
    pages++;
    if (!pageItems.length) break; // hết dữ liệu
    items.push(...pageItems);

    // Báo tiến trình realtime cho dashboard (cộng dồn toàn nguồn qua ctx).
    broadcast("SYNC_PROGRESS", {
      id: source.id,
      name: source.name || source.id,
      status: "fetching",
      page: pageNo,
      pagesFetched: ctx.pagesFetched + pages,
      fetched: ctx.fetchedBefore + items.length,
      total: ctx.totalBefore != null ? ctx.totalBefore + (total || 0) : total,
    });

    if (total != null && items.length >= total) break; // đủ total
    if (!pageParam) break;                              // không phân trang
    if (pageSize && pageItems.length < pageSize) break; // trang cuối

    await sleepJitter(source.pageDelayMin || 400, source.pageDelayMax || 1200);
  }

  return { items, total, pages, lastError, hardError: false };
}

// Gọi 1 nguồn theo cấu hình: fetch URL nội bộ đã dò được -> JSON -> chuẩn hoá -> lưu.
// Hỗ trợ nhiều category (source.urls[]) và phân trang cho từng category.
async function syncSource(id) {
  const sources = await DB.getSources();
  const source = sources.find((s) => s.id === id);
  if (!source) return { ok: false, error: "Không tìm thấy nguồn dữ liệu." };

  // Danh sách URL gốc: ưu tiên source.urls[] (nhiều category), nếu không có thì
  // dùng source.url đơn lẻ như trước.
  const baseUrls = Array.isArray(source.urls) && source.urls.length
    ? source.urls.filter(Boolean)
    : (source.url ? [source.url] : []);
  if (!baseUrls.length) return { ok: false, error: "Nguồn chưa cấu hình URL." };

  const all = [];
  let total = null;
  let pagesFetched = 0;
  let lastError = null;

  broadcast("SYNC_PROGRESS", {
    id: source.id,
    name: source.name || source.id,
    status: "started",
    page: 0,
    pagesFetched: 0,
    fetched: 0,
    total: null,
  });

  for (let u = 0; u < baseUrls.length; u++) {
    const ctx = {
      pagesFetched,
      fetchedBefore: all.length,
      totalBefore: total,
    };
    const r = await fetchPaginatedUrl(source, baseUrls[u], ctx);
    pagesFetched += r.pages;
    if (r.items.length) all.push(...r.items);
    if (r.total != null) total = (total || 0) + r.total;
    if (r.lastError) lastError = r.lastError;
    // URL đầu tiên hỏng hẳn và chưa lấy được gì => coi như nguồn lỗi.
    if (r.hardError && u === 0 && !all.length) {
      return { ok: false, error: "Không gọi được URL nguồn: " + r.lastError };
    }
    // Nghỉ giữa các category để giảm rủi ro bị chặn.
    if (u < baseUrls.length - 1) {
      await sleepJitter(source.pageDelayMin || 400, source.pageDelayMax || 1200);
    }
  }

  if (!all.length) {
    return {
      ok: false,
      error:
        "Không trích được sản phẩm nào. Kiểm tra lại itemsPath/ánh xạ trường.",
    };
  }

  // Khử trùng theo productId (phòng trường hợp trang/category chồng lấn).
  const seen = new Set();
  const products = [];
  for (const p of all) {
    if (seen.has(p.productId)) continue;
    seen.add(p.productId);
    products.push(p);
  }

  const res = await DB.saveProducts(products);
  await DB.saveSource({
    ...source,
    lastSyncAt: Date.now(),
    lastCount: products.length,
    lastTotal: total,
    lastPages: pagesFetched,
  });
  return {
    ok: true,
    fetched: products.length,
    pages: pagesFetched,
    total,
    partialError: lastError,
    ...res,
  };
}

// Đồng bộ tất cả nguồn đang bật. Trả về tổng hợp kết quả từng nguồn.
async function syncAllSources() {
  const sources = await DB.getSources();
  const enabled = sources.filter((s) => s.enabled !== false);
  const results = [];
  for (const s of enabled) {
    try {
      const r = await syncSource(s.id);
      results.push({ id: s.id, name: s.name || s.id, ...r });
    } catch (e) {
      results.push({ id: s.id, name: s.name || s.id, ok: false, error: String(e) });
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return { ok: true, synced: okCount, total: enabled.length, results };
}

// ---- Seed sẵn 4 nguồn giá để so sánh (HACOM + 3 store nền tảng Hura) --------
// HACOM: Next.js RSC, mỗi leaf-category là 1 URL ?page=N (36 sp/trang). Gộp 8
// leaf linh kiện chính qua source.urls[] + parse "html-rsc".
// Hura (Nguyễn Công / Hoàng Hà / An Phát): API get_json.php, cần header
// Authorization, phân trang page+show, total nằm ở "total", list ở "list".
const HURA_AUTH = "Basic ssaaAS76DAs6faFFghs1";
const HURA_HEADERS = {
  Authorization: HURA_AUTH,
  "X-Requested-With": "XMLHttpRequest",
};
// Ánh xạ trường chung cho cả 3 store Hura (dùng "id" làm khoá vì An Phát thiếu
// productId/productModel; các store khác vẫn có "id" trùng productId).
const HURA_MAPPING = {
  productId: "id",
  name: "productName",
  price: "price",
  // Field "price" của Hura KHÔNG nhất quán giữa các store (Nguyễn Công = giá
  // BUILD PC rẻ nhất; An Phát = giá bán lẻ thực) nên không tin được. Khối
  // "specialOffer" chứa các dòng có nhãn rõ ràng ("Giá Build PC : X", "Giá bán
  // lẻ rời ... : X"); extractHuraPrices() bóc cả giá bán lẻ và giá build từ đó.
  retailOffer: "specialOffer",
  list: "marketPrice",
  brand: "brand",
  url: "productUrl",
  image: "productImage.small",
  stock: "quantity",
  sku: "productSKU",
  warranty: "warranty",
  condition: "condition",
};
// Endpoint danh sách sản phẩm theo category cho nền tảng Hura.
function huraCatUrl(host, cat) {
  return (
    host +
    "/ajax/get_json.php?action=product&action_type=product-list&category=" +
    cat
  );
}

const SEED_PRICE_SOURCES = [
  {
    id: "hacom",
    name: "HACOM",
    parse: "html-rsc",
    urls: [
      "https://hacom.vn/cpu-bo-vi-xu-ly",
      "https://hacom.vn/mainboard-bo-mach-chu",
      "https://hacom.vn/ram-bo-nho-trong",
      "https://hacom.vn/vga-card-man-hinh",
      "https://hacom.vn/o-cung-ssd",
      "https://hacom.vn/o-cung-hdd-desktop",
      "https://hacom.vn/nguon-may-tinh",
      "https://hacom.vn/vo-case",
    ],
    url: "https://hacom.vn/cpu-bo-vi-xu-ly",
    itemsPath: "list",
    pageParam: "page",
    pageStart: 1,
    pageSize: 36,
    maxPages: 50,
    mapping: {
      productId: "itemCode",
      name: "itemName",
      // unitSellingPrice = giá bán lẻ thực; giaBuildPcKoVga = giá khi build PC
      // (không gồm VGA). Hai field RIÊNG trên mỗi SP -> lấy thẳng, KHÔNG suy đoán
      // theo "thấp nhất" như Hura (HACOM giá build có thể cao HOẶC thấp hơn lẻ).
      price: "unitSellingPrice",
      buildPrice: "giaBuildPcKoVga",
      list: "marketPrice",
      brand: "brandName",
      url: "url",
      image: "primaryImage",
      stock: "onhandQuantity",
      // hasStock=true => còn hàng (đáng tin hơn onhandQuantity với hàng order).
      stockFlag: "hasStock",
      // coBanLe="Y" => có bán lẻ; "N" là hàng liên hệ/giá build, phải loại.
      retailFlag: "coBanLe",
      sku: "itemCode",
      warranty: "warrantyDescrition",
    },
    enabled: true,
  },
  {
    id: "nguyencong",
    name: "Nguyễn Công PC",
    headers: HURA_HEADERS,
    url: huraCatUrl("https://nguyencongpc.vn", 3431),
    itemsPath: "list",
    totalPath: "total",
    pageParam: "page",
    pageSizeParam: "show",
    pageStart: 1,
    pageSize: 50,
    maxPages: 50,
    mapping: HURA_MAPPING,
    enabled: true,
  },
  {
    id: "hoangha",
    name: "Hoàng Hà PC",
    headers: HURA_HEADERS,
    // Hoàng Hà không có category "linh kiện" tổng (cat 166 lẫn lộn, cat 170 là PC
    // dựng sẵn) -> gộp từng nhóm linh kiện riêng để lấy đúng CPU/Main/RAM...
    urls: [
      huraCatUrl("https://hoanghapc.vn", 2), // CPU
      huraCatUrl("https://hoanghapc.vn", 3), // Mainboard
      huraCatUrl("https://hoanghapc.vn", 4), // RAM
      huraCatUrl("https://hoanghapc.vn", 6), // VGA
      huraCatUrl("https://hoanghapc.vn", 16), // SSD
      huraCatUrl("https://hoanghapc.vn", 15), // HDD
      huraCatUrl("https://hoanghapc.vn", 7), // Nguồn
      huraCatUrl("https://hoanghapc.vn", 8), // Case
    ],
    url: huraCatUrl("https://hoanghapc.vn", 2),
    itemsPath: "list",
    totalPath: "total",
    pageParam: "page",
    pageSizeParam: "show",
    pageStart: 1,
    pageSize: 50,
    maxPages: 50,
    mapping: HURA_MAPPING,
    enabled: true,
  },
  {
    id: "anphat",
    name: "An Phát PC",
    headers: HURA_HEADERS,
    // An Phát không có category "linh kiện" tổng -> gộp từng nhóm linh kiện.
    urls: [
      huraCatUrl("https://anphatpc.com.vn", 1025), // CPU
      huraCatUrl("https://anphatpc.com.vn", 1024), // Mainboard
      huraCatUrl("https://anphatpc.com.vn", 1234), // RAM
      huraCatUrl("https://anphatpc.com.vn", 1155), // VGA
      huraCatUrl("https://anphatpc.com.vn", 1030), // SSD
      huraCatUrl("https://anphatpc.com.vn", 1047), // HDD
      huraCatUrl("https://anphatpc.com.vn", 1051), // Nguồn
      huraCatUrl("https://anphatpc.com.vn", 1050), // Case
    ],
    url: huraCatUrl("https://anphatpc.com.vn", 1025),
    itemsPath: "list",
    totalPath: "total",
    pageParam: "page",
    pageSizeParam: "show",
    pageStart: 1,
    pageSize: 50,
    maxPages: 50,
    mapping: HURA_MAPPING,
    enabled: true,
  },
];

const SEED_PRICE_SOURCE_IDS = new Set(SEED_PRICE_SOURCES.map((s) => s.id));
const DELETED_SEED_KEY = "deletedPriceSeedIds";

// Đọc danh sách id seed mà người dùng đã chủ động xoá (để không tự thêm lại).
// Lưu theo TÀI KHOẢN trên server (qua /api/settings).
async function getDeletedSeedIds() {
  const arr = await DB.getSetting(DELETED_SEED_KEY, []);
  return new Set(Array.isArray(arr) ? arr : []);
}

// Ghi nhớ 1 id seed vừa bị xoá.
async function rememberDeletedSeed(id) {
  const set = await getDeletedSeedIds();
  set.add(id);
  try {
    await DB.setSetting(DELETED_SEED_KEY, [...set]);
  } catch (e) {
    /* bỏ qua */
  }
}

// Dọn các nguồn TRÙNG LẶP đời cũ (seed vòng trước) có tên chứa
// "Linh kiện máy tính". Chúng được lưu trong IndexedDB với id khác nên không
// nằm trong SEED_PRICE_SOURCES hiện tại -> phải tự tìm theo tên rồi xoá kèm
// toàn bộ sản phẩm đã gom của nguồn đó.
async function pruneLegacySources() {
  try {
    const sources = await DB.getSources();
    const legacy = sources.filter(
      (s) => s && typeof s.name === "string" && /linh kiện máy tính/i.test(s.name)
    );
    for (const s of legacy) {
      await DB.clearProducts(s.id); // xoá sản phẩm gắn với nguồn này
      await DB.deleteSource(s.id);   // xoá cấu hình nguồn
      await rememberDeletedSeed(s.id); // chặn tự thêm lại nếu trùng id seed
    }
    return legacy.length;
  } catch (e) {
    return 0;
  }
}

// Thêm/cập nhật các nguồn seed. Nguồn người dùng đã xoá thì tôn trọng (không
// thêm lại). Nguồn đã tồn tại: LÀM MỚI cấu hình crawl (urls[]/mapping/phân
// trang...) theo bản seed mới nhất để vá các bản đời cũ bị thiếu (vd HACOM cũ
// chỉ có url CPU đơn lẻ, thiếu urls[] nên chỉ lấy được mỗi danh mục CPU).
// Giữ nguyên metadata runtime (lastSyncAt/lastCount...) và công tắc enabled
// mà người dùng đã chỉnh.
async function seedPriceSources() {
  try {
    const [existing, deleted] = await Promise.all([
      DB.getSources(),
      getDeletedSeedIds(),
    ]);
    const byId = new Map(existing.map((s) => [s.id, s]));
    for (const seed of SEED_PRICE_SOURCES) {
      if (deleted.has(seed.id)) continue;   // user đã xoá -> tôn trọng, không thêm lại
      const prev = byId.get(seed.id);
      if (!prev) {
        await DB.saveSource(seed);
        continue;
      }
      // Đã tồn tại: ghi đè cấu hình crawl bằng bản seed, nhưng tôn trọng lựa
      // chọn bật/tắt của người dùng. saveSource merge {...existing, ...source}
      // nên lastSyncAt/lastCount (chỉ có trong existing) được giữ nguyên.
      await DB.saveSource({
        ...seed,
        enabled: typeof prev.enabled === "boolean" ? prev.enabled : seed.enabled,
      });
    }
  } catch (e) {}
}

export {
  extractHuraPrices,
  normalizeItems,
  mergeRSC,
  readRscObject,
  extractRscProducts,
  fetchSourcePage,
  fetchPaginatedUrl,
  syncSource,
  syncAllSources,
  HURA_AUTH,
  HURA_HEADERS,
  HURA_MAPPING,
  huraCatUrl,
  SEED_PRICE_SOURCES,
  SEED_PRICE_SOURCE_IDS,
  DELETED_SEED_KEY,
  getDeletedSeedIds,
  rememberDeletedSeed,
  pruneLegacySources,
  seedPriceSources,
};
