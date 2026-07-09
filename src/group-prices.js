/**
 * group-prices.js — TRÍCH GIÁ từ bài đã crawl trong group bằng PHỄU 3 TẦNG.
 *
 * Mục tiêu: từ kho `posts` (đã crawl, lấy qua DB.getAllPosts) lọc ra các bài RAO
 * BÁN có giá thật rồi trích thành các dòng giá (group_prices) để tham khảo mặt
 * bằng giá. KHÔNG bịa số: AI chỉ TRÍCH từ text bài, mọi giá phải HẬU KIỂM khớp
 * với text gốc trước khi lưu.
 *
 * PHỄU 3 TẦNG (tiết kiệm token + chống nhiễu + chống bịa):
 *   Tầng 1 — tier1Pass(text, sellKeywords): lọc thô. Chỉ giữ bài có ĐỒNG THỜI
 *     (a) một con số TIỀN (reuse extractMoneyFigures của advisory.js) và
 *     (b) một từ khóa DẤU HIỆU BÁN. Bài "cần mua ... giá bao nhiêu" tuy có số
 *     model nhưng KHÔNG có money figure / sell signal -> loại.
 *   Tầng 2 — selectForAI(posts, sellKeywords): chỉ bài CHƯA parse (không có
 *     parsedAt) VÀ qua tier1 mới được đưa lên AI. Parse xong đánh dấu parsedAt
 *     để lần sau không gửi lại (khử trùng + tăng dần).
 *   Tầng 3 — extractBatch(posts, aiCall): gọi AI MỘT lần cho mỗi ~10-15 bài;
 *     AI trả per-post { items:[{name,price,condition,warranty,category}],
 *     new_keywords:[...] }. AI KHÔNG tự chế regex, chỉ trích từ text được cấp.
 *   Hậu kiểm — verifyExtraction(post, items): bỏ item nào có price KHÔNG xuất
 *     hiện trong text bài (so khớp sau khi chuẩn hóa) — chống bịa giá.
 *
 * Orchestration — runGroupPriceExtraction(deps): nạp sell keywords từ
 *   GET /api/keywords?type=sell, lấy posts, selectForAI, extractBatch, verify,
 *   POST /api/group-prices, đánh dấu posts parsedAt, và POST /api/keywords cho
 *   mọi new_keywords (addedBy:'ai', enabled:true).
 *
 * KIỂM THỬ ĐƯỢC: các hàm thuần (tier1Pass/selectForAI/verifyExtraction) và
 * extractBatch (nhận aiCall tiêm vào) chạy không cần network. runGroupPriceExtraction
 * nhận deps (apiFetch, getAllPosts, aiCall, markParsed) để test mock toàn bộ.
 *
 * Module ES (import/export), khớp phong cách advisory.js / db.js.
 */

import { extractMoneyFigures } from "./advisory.js";
import { hasAnyKeyword } from "./keyword-match.js";
import { apiFetch as realApiFetch } from "./api.js";
import * as DB from "./db.js";
import { getAIConfig, fetchWithTimeout, parseSelectorJson } from "./util.js";
import { getActiveProfile, systemForExtract } from "./prompts.js";

// Số bài tối đa gửi AI trong MỘT lần gọi (phễu tầng 3). ~10-15 theo plan.
const BATCH_SIZE = 15;

/* =============================== TẦNG 1 ================================== */

// TÍN HIỆU MUA/HỎI GIÁ — nếu bài chứa bất kỳ cụm nào thì đó là NGƯỜI MUA đang
// hỏi, KHÔNG phải rao bán. Loại thẳng để giá của người mua ("cần mua ... tầm
// 5tr") không lọt vào mặt bằng giá thị trường. Khớp theo ranh giới từ + bỏ dấu.
const BUY_GUARD = [
  "cần mua", "muốn mua", "tìm mua", "cần con", "ai bán", "ai pass",
  "giá bao nhiêu", "bao nhiêu tiền", "tầm giá", "tầm tiền", "ngân sách",
  "ai dư", "có ai bán", "chỗ nào bán", "mua ở đâu",
];

/**
 * tier1Pass(text, sellKeywords) — lọc thô tầng 1.
 * TRUE chỉ khi text có ĐỒNG THỜI: (a) một con số tiền (extractMoneyFigures) và
 * (b) ít nhất một từ khóa dấu hiệu BÁN — SO KHỚP THEO RANH GIỚI TỪ + BỎ DẤU
 * (dùng chung keyword-match.js) nên "banh" không dính "ban", "thanh ly" không
 * dấu vẫn khớp "thanh lý".
 * FALSE cho bài hỏi/mua: (a) không có money figure, HOẶC (b) dính BUY_GUARD
 * ("cần mua ... tầm 5tr, ai pass") dù có số tiền + từ "pass".
 */
export function tier1Pass(text, sellKeywords) {
  const s = String(text || "");
  if (!s.trim()) return false;
  const keywords = Array.isArray(sellKeywords) ? sellKeywords : [];
  if (keywords.length === 0) return false;
  const hasMoney = extractMoneyFigures(s).length > 0;
  if (!hasMoney) return false;
  // Người mua đang hỏi giá -> loại (chống ô nhiễm mặt bằng giá).
  if (hasAnyKeyword(s, BUY_GUARD)) return false;
  return hasAnyKeyword(s, keywords);
}

/* =============================== TẦNG 2 ================================== */

/**
 * selectForAI(posts, sellKeywords) — lọc tầng 2 (khử trùng + tăng dần).
 * Chỉ giữ bài CHƯA parse (không có parsedAt) VÀ qua tier1Pass. Bài đã có
 * parsedAt (đã trích trước đó) bị loại để không gửi lại AI.
 */
export function selectForAI(posts, sellKeywords) {
  if (!Array.isArray(posts)) return [];
  return posts.filter((p) => {
    if (!p) return false;
    // Đã parse rồi -> bỏ. Coi null/undefined/"" là CHƯA parse.
    if (p.parsedAt) return false;
    return tier1Pass(p.text, sellKeywords);
  });
}

/* ============================== HẬU KIỂM ================================= */

/**
 * Chuẩn hóa một chuỗi/biểu diễn giá về DẠNG SO KHỚP: trả về tập các "khóa số"
 * có thể có để dò trong text. Dùng extractMoneyFigures để quy mọi biểu diễn
 * ("5.000.000", "5,000,000", "5tr", 5000000) về cùng GIÁ TRỊ VND, nhờ đó
 * "5tr" trong bài khớp với "5.000.000" mà AI trả về.
 *
 * Trả về một Set<number> các giá trị VND đã chuẩn hóa từ chuỗi đầu vào.
 */
function priceToVndSet(price) {
  const out = new Set();
  if (price == null) return out;
  if (typeof price === "number" && Number.isFinite(price)) {
    out.add(Math.round(price));
    return out;
  }
  const s = String(price);
  // Thử trích như tiền (bắt cả "5tr", "5.000.000", "5,000,000").
  for (const n of extractMoneyFigures(s)) out.add(n);
  // Dự phòng: chuỗi toàn số dạng "5000000" không có dấu phân nhóm -> tự parse.
  const digits = s.replace(/[^\d]/g, "");
  if (digits) {
    const n = Number(digits);
    if (Number.isFinite(n) && n >= 1000) out.add(n);
  }
  return out;
}

/**
 * verifyExtraction(post, items) — HẬU KIỂM chống bịa giá.
 * Bỏ mọi item có price KHÔNG khớp bất kỳ con số tiền nào trong text bài (sau
 * khi chuẩn hóa cả hai về VND). Giữ những item có giá thật trong bài.
 */
export function verifyExtraction(post, items) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const text = String((post && post.text) || "");
  // Tập giá trị VND xuất hiện trong text bài (chuẩn để so khớp).
  const postVnd = new Set(extractMoneyFigures(text));
  if (postVnd.size === 0) return [];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const candidates = priceToVndSet(it.price);
    let matched = null;
    for (const v of candidates) {
      if (postVnd.has(v)) {
        matched = v;
        break;
      }
    }
    if (matched != null) {
      // QUAN TRỌNG: trả GIÁ TRỊ VND đã chuẩn hóa (số nguyên) thay vì chuỗi thô
      // AI trả về. Cột group_prices.price là BIGINT; nếu ghi "5.000.000" MySQL
      // sẽ cắt còn 5, phá vỡ ORDER BY/lọc giá và khóa idempotent uq_gp_line.
      out.push({ ...it, price: matched });
    }
  }
  return out;
}

/* =============================== TẦNG 3 ================================== */

/**
 * Chia mảng thành các lô tối đa `size` phần tử.
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * extractBatch(posts, aiCall) — tầng 3.
 * Gọi `aiCall(batch)` MỘT lần cho mỗi lô ~10-15 bài. `aiCall` nhận mảng bài và
 * trả về mảng per-post { postId, items, new_keywords }. Gộp kết quả mọi lô lại
 * và trả về một mảng phẳng (một entry/bài). `aiCall` được TIÊM VÀO để test mock.
 */
export async function extractBatch(posts, aiCall) {
  if (!Array.isArray(posts) || posts.length === 0) return [];
  if (typeof aiCall !== "function") {
    throw new Error("extractBatch: aiCall phải là một hàm.");
  }
  const results = [];
  for (const batch of chunk(posts, BATCH_SIZE)) {
    const out = await aiCall(batch);
    if (Array.isArray(out)) {
      for (const entry of out) results.push(entry);
    }
  }
  return results;
}

/* ====================== AI CALLER MẶC ĐỊNH (THẬT) ======================== */

/**
 * defaultAiCall(batch, sellKeywords) — AI caller THẬT (OpenAI-compatible), theo
 * đúng pattern classifyIntent của advisory.js (getAIConfig + fetchWithTimeout).
 * Trả mảng per-post { postId, items, new_keywords }. Lỗi/không key -> trả mảng
 * rỗng cho từng bài (an toàn: thà không trích còn hơn trích sai).
 */
async function defaultAiCall(batch, sellKeywords) {
  const empty = batch.map((p) => ({ postId: p.postId, items: [], new_keywords: [] }));

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) return empty; // không key -> không trích

  // Hồ sơ ngành đang kích hoạt (BE) -> dựng prompt trích giá theo đặc thù ngành.
  const profile = await getActiveProfile();
  const sys = systemForExtract(profile);

  const knownKeywords = Array.isArray(sellKeywords) ? sellKeywords.join(", ") : "";
  const postsBlock = batch
    .map(
      (p, i) =>
        "### BÀI " + (i + 1) + " (postId=" + p.postId + "):\n" +
        String(p.text || "").slice(0, 1200)
    )
    .join("\n\n");
  const user =
    "DANH SÁCH TỪ KHÓA BÁN ĐÃ BIẾT: " + (knownKeywords || "(trống)") + "\n\n" +
    "CÁC BÀI CẦN TRÍCH (" + batch.length + " bài):\n\n" + postsBlock +
    "\n\nTrả JSON theo đúng cấu trúc, mỗi bài MỘT entry trong results với postId tương ứng.";

  let resp;
  try {
    resp = await fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
          ],
          temperature: 0.1,
          max_tokens: 1500,
          stream: false,
          response_format: { type: "json_object" },
        }),
      },
      30000
    );
  } catch (e) {
    return empty;
  }
  if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
    // Một số endpoint không hỗ trợ response_format -> thử lại không có nó.
    try {
      resp = await fetchWithTimeout(
        apiBase + "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: user },
            ],
            temperature: 0.1,
            max_tokens: 1500,
            stream: false,
          }),
        },
        30000
      );
    } catch (e) {
      return empty;
    }
  }
  if (!resp.ok) return empty;

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return empty;
  }
  const content =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
  const parsed = parseSelectorJson(content);
  const results = parsed && Array.isArray(parsed.results) ? parsed.results : null;
  if (!results) return empty;

  // Chuẩn hóa: đảm bảo mỗi bài có entry; map theo postId AI trả về.
  const byId = new Map();
  for (const r of results) {
    if (r && r.postId != null) byId.set(String(r.postId), r);
  }
  return batch.map((p) => {
    const r = byId.get(String(p.postId));
    return {
      postId: p.postId,
      items: r && Array.isArray(r.items) ? r.items : [],
      new_keywords: r && Array.isArray(r.new_keywords) ? r.new_keywords : [],
    };
  });
}

/* ============================ ORCHESTRATION ============================= */

/**
 * runGroupPriceExtraction(deps) — chạy toàn bộ phễu 3 tầng.
 *
 * deps (tất cả tùy chọn, mặc định dùng module thật — test tiêm mock):
 *   - apiFetch:    hàm gọi API (mặc định api.js#apiFetch).
 *   - getAllPosts: () => Promise<post[]> (mặc định DB.getAllPosts).
 *   - aiCall:      (batch, sellKeywords) => Promise<entry[]> (mặc định defaultAiCall).
 *   - markParsed:  (postIds[]) => Promise<void> đánh dấu parsedAt (xem ghi chú).
 *
 * Luồng:
 *   1) GET /api/keywords?type=sell -> chỉ lấy keyword enabled.
 *   2) getAllPosts() -> selectForAI -> các bài đủ điều kiện.
 *   3) extractBatch(eligible, aiCall) -> kết quả AI per-post.
 *   4) verifyExtraction từng bài -> bỏ item bịa giá.
 *   5) POST /api/group-prices các dòng đã hậu kiểm (parser:'ai').
 *   6) markParsed(các postId đã xử lý) -> đánh dấu parsedAt.
 *   7) POST /api/keywords cho mọi new_keywords (addedBy:'ai', enabled:true, type:'sell').
 *
 * Trả { processed, inserted, newKeywords } để UI báo cáo.
 */
export async function runGroupPriceExtraction(deps = {}) {
  const apiFetch = deps.apiFetch || realApiFetch;
  const getAllPosts = deps.getAllPosts || DB.getAllPosts;
  const aiCall = deps.aiCall || defaultAiCall;
  const markParsed = deps.markParsed || defaultMarkParsed(apiFetch);

  // 1) Nạp sell keywords đang bật.
  const kwResp = await apiFetch("/api/keywords?type=sell");
  const sellKeywords = (kwResp && Array.isArray(kwResp.keywords) ? kwResp.keywords : [])
    .filter((k) => k && k.enabled)
    .map((k) => String(k.keyword || "").toLowerCase())
    .filter(Boolean);

  // 2) Lấy posts -> lọc phễu tầng 1+2.
  const posts = (await getAllPosts()) || [];
  const eligible = selectForAI(posts, sellKeywords);
  if (eligible.length === 0) {
    return { processed: 0, inserted: 0, newKeywords: 0 };
  }

  // 3) Gọi AI theo lô.
  const aiResults = await extractBatch(eligible, (batch) => aiCall(batch, sellKeywords));

  // Tra cứu bài theo postId để hậu kiểm + dựng dòng giá.
  const postById = new Map(eligible.map((p) => [String(p.postId), p]));

  const rows = [];
  const processedIds = [];
  const newKeywordSet = new Set();

  // 4) Hậu kiểm + dựng payload group-prices.
  for (const r of aiResults) {
    if (!r || r.postId == null) continue;
    const post = postById.get(String(r.postId));
    if (!post) continue;
    processedIds.push(post.postId);

    const verified = verifyExtraction(post, r.items);
    for (const it of verified) {
      rows.push({
        postId: post.postId,
        name: it.name ?? null,
        price: it.price ?? null,
        condition: it.condition ?? null,
        warranty: it.warranty ?? null,
        category: it.category ?? null,
        sellerName: post.authorName ?? null,
        sellerProfile: post.authorProfile ?? null,
        groupId: post.groupId ?? null,
        postedAt: post.timestamp ?? null,
        parser: "ai",
        confidence: it.confidence ?? null,
      });
    }

    if (Array.isArray(r.new_keywords)) {
      for (const kw of r.new_keywords) {
        const w = String(kw || "").trim();
        if (w) newKeywordSet.add(w);
      }
    }
  }

  // 5) Lưu các dòng giá đã hậu kiểm.
  let inserted = 0;
  if (rows.length > 0) {
    const resp = await apiFetch("/api/group-prices", {
      method: "POST",
      body: JSON.stringify({ groupPrices: rows }),
    });
    inserted = resp && typeof resp.inserted === "number" ? resp.inserted : rows.length;
  }

  // 6) Đánh dấu các bài đã xử lý là parsedAt (kể cả bài AI trả 0 item -> không
  // gửi lại lần sau). markParsed có thể là thin call (xem defaultMarkParsed).
  if (processedIds.length > 0 && typeof markParsed === "function") {
    await markParsed(processedIds);
  }

  // 7) Học từ khóa bán mới do AI phát hiện.
  for (const kw of newKeywordSet) {
    await apiFetch("/api/keywords", {
      method: "POST",
      body: JSON.stringify({ keyword: kw, type: "sell", addedBy: "ai", enabled: true }),
    });
  }

  return {
    processed: processedIds.length,
    inserted,
    newKeywords: newKeywordSet.size,
  };
}

/**
 * defaultMarkParsed(apiFetch) — THIN CALL đánh dấu parsedAt.
 *
 * GHI CHÚ THIẾT KẾ: db.js hiện KHÔNG xuất helper cập nhật parsedAt, và backend
 * `POST /api/group-prices` đã tự set `parsed_at = NOW()` trên hàng group_prices
 * khi insert. Việc đánh dấu parsedAt trên CHÍNH bản ghi `posts` (để tầng 2 bỏ
 * qua lần sau) cần một endpoint cập nhật posts chưa có trong contract Task 5.
 * Vì task này KHÔNG được sửa web/routes.js, để lại một thin call best-effort:
 * thử PATCH /api/posts/:id { parsedAt } nếu backend hỗ trợ; nuốt lỗi để không
 * chặn luồng. Test tiêm markParsed riêng nên không phụ thuộc endpoint này.
 */
function defaultMarkParsed(apiFetch) {
  return async (postIds) => {
    for (const id of postIds) {
      try {
        await apiFetch("/api/posts/" + encodeURIComponent(id), {
          method: "PATCH",
          body: JSON.stringify({ parsedAt: new Date().toISOString() }),
        });
      } catch (e) {
        // Best-effort: bài vẫn có thể được tái xử lý lần sau nếu endpoint thiếu.
        // Không chặn luồng trích giá chính.
      }
    }
  };
}
