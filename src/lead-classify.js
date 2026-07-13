/**
 * lead-classify.js — PHÂN LOẠI LEAD CÓ CACHE + VÒNG HỌC KEYWORD TỰ LÀM GIÀU.
 *
 * Bài toán: bộ lọc keyword (leadfilter.classifyLead) nhanh & miễn phí nhưng "mù
 * ngữ nghĩa" — không phân biệt được VAI TRÒ (shop "nhận sửa" vs khách "cần sửa")
 * hay CHIỀU (cung vs cầu) ở các ca mơ hồ. Ta KHÔNG bỏ keyword, mà làm nó NGÀY
 * CÀNG THÔNG MINH HƠN theo thời gian:
 *
 *   PHỄU (giống group-prices, tiết kiệm token):
 *     Tầng 1 — RULE: classifyLead chấm điểm. Ca RÕ RÀNG (một nhãn áp đảo) -> chốt
 *       ngay, nguồn 'rule', KHÔNG gọi AI.
 *     Tầng 2 — selectForClassify: chỉ lấy bài CHƯA phân loại hoặc phiên bản logic
 *       cũ (lead_ver < LEAD_VER); BỎ bài người dùng sửa tay (lead_source='manual').
 *     Tầng 3 — AI (chỉ ca MƠ HỒ): gom ~12 bài/lô, AI trả nhãn + cụm từ gợi ý.
 *
 *   VÒNG HỌC (điểm cốt lõi): sau khi có nhãn chắc chắn (rule/ai/manual), ĐÀO các
 *   cụm từ ĐẶC TRƯNG (mineKeywordCandidates) rồi:
 *     - Cụm cực đặc trưng + đủ tần suất  -> AUTO-PROMOTE thẳng thành keyword thật.
 *     - Cụm còn lại                       -> đẩy vào HÀNG CHỜ DUYỆT (keyword_candidates).
 *   Lần sau bộ lọc keyword bắt được các cụm này -> ÍT bài phải nhờ AI hơn.
 *
 * LEAD_VER: tăng số này mỗi khi logic phân loại đổi -> bài cũ (lead_ver nhỏ hơn)
 * tự được xếp lại hàng chờ phân loại; nhãn sửa tay không bị đụng.
 *
 * KIỂM THỬ ĐƯỢC: các hàm thuần (selectForClassify, splitByConfidence, classifyBatch
 * với aiCall tiêm vào) chạy không cần network. runLeadClassification nhận deps
 * (apiFetch, getAllPosts, aiCall, savePost) để test mock toàn bộ.
 */

import { classifyLead, mineKeywordCandidates } from "./dashboard/leadfilter.js";
import { apiFetch as realApiFetch } from "./api.js";
import * as DB from "./db.js";
import { getAIConfig, fetchWithTimeout, parseSelectorJson } from "./util.js";

/**
 * Phiên bản logic phân loại lead. TĂNG khi đổi luật/keyword gốc để bài cũ được
 * phân loại lại (bài có lead_ver < LEAD_VER sẽ vào hàng chờ needLead).
 *
 * v1 -> v2: kỷ nguyên "silent bug" trước đây có thể đã đóng dấu nhãn SAI ở
 * lead_ver=1 (gán 'other' khi AI hỏng mà không báo lỗi). Tăng lên 2 để MỌI bài
 * cũ tự xếp lại hàng phân loại ĐÚNG MỘT LẦN (chữa dữ liệu sai), sau đó thôi.
 * Nhờ vậy nút "Phân loại lại" chạy INCREMENTAL (không force) vẫn xử được bài cũ
 * mà không đốt token lặp lại ở những lần bấm sau.
 */
export const LEAD_VER = 2;

// Số bài tối đa gửi AI trong MỘT lần gọi (chỉ áp cho ca mơ hồ).
const BATCH_SIZE = 12;

// Số lô AI chạy SONG SONG cùng lúc. Trước đây chạy 1 lô/lần rất chậm với ~1000
// bài; chạy vài luồng song song rút ngắn thời gian đáng kể mà không dội quá
// nhiều request lên API cùng lúc.
const AI_CONCURRENCY = 4;

// Ngưỡng "chắc chắn" của RULE: nhãn thắng phải có điểm >= CONF_MIN và vượt nhãn
// nhì tối thiểu CONF_MARGIN. Dưới ngưỡng -> coi là MƠ HỒ, nhường cho AI.
const CONF_MIN = 1.5;
const CONF_MARGIN = 1.0;

// Nhãn hợp lệ để nhận từ AI (khớp CHECK phía API).
const VALID_LABELS = new Set(["buy", "support", "seller", "other"]);

/* =============================== TẦNG 1: RULE ============================= */

/**
 * classifyRule(text) — chấm điểm bằng bộ keyword hiện có và đánh giá độ chắc chắn.
 * Trả { label, score, signals, confident }.
 *   confident=true  -> ca rõ ràng, chốt bằng rule (source 'rule'), không cần AI.
 *   confident=false -> ca mơ hồ, đẩy lên AI.
 */
export function classifyRule(text) {
  const res = classifyLead(text);
  const { label, signals } = res;
  // "other" luôn coi là mơ hồ: rule không tìm thấy tín hiệu nào rõ -> hỏi AI.
  if (label === "other") {
    return { ...res, confident: false };
  }
  const vals = [signals.buy || 0, signals.support || 0, signals.seller || 0];
  const top = Math.max(...vals);
  // Điểm nhì (loại 1 lần xuất hiện của top).
  const idx = vals.indexOf(top);
  const rest = vals.filter((_, i) => i !== idx);
  const second = rest.length ? Math.max(...rest) : 0;
  const confident = top >= CONF_MIN && top - second >= CONF_MARGIN;
  return { ...res, confident };
}

/* =========================== TẦNG 2: CHỌN BÀI ============================= */

/**
 * selectForClassify(posts, leadVer, opts) — chọn bài CẦN phân loại.
 * Lấy bài: (a) chưa có nhãn (leadLabel rỗng) HOẶC (b) nhãn cũ hơn leadVer;
 * NHƯNG bỏ qua bài người dùng sửa tay (leadSource='manual') — đã chốt, không đụng.
 *
 * opts.force=true: người dùng bấm "Phân loại lại" -> chạy lại TẤT CẢ bài không
 * phải manual bất kể đã có nhãn/đúng phiên bản hay chưa (vẫn tôn trọng manual).
 */
export function selectForClassify(posts, leadVer = LEAD_VER, opts = {}) {
  if (!Array.isArray(posts)) return [];
  const force = !!(opts && opts.force);
  return posts.filter((p) => {
    if (!p) return false;
    if (p.leadSource === "manual") return false;
    if (force) return true;
    if (!p.leadLabel) return true;
    const v = Number.isFinite(Number(p.leadVer)) ? Number(p.leadVer) : 0;
    return v < leadVer;
  });
}

/**
 * splitByConfidence(posts) — chia bài đã chọn thành 2 nhóm:
 *   confident: [{ post, label }] — rule tự tin, chốt luôn.
 *   ambiguous: [post]            — cần AI.
 */
export function splitByConfidence(posts) {
  const confident = [];
  const ambiguous = [];
  for (const p of posts || []) {
    if (!p) continue;
    const r = classifyRule(p.text);
    if (r.confident) confident.push({ post: p, label: r.label });
    else ambiguous.push(p);
  }
  return { confident, ambiguous };
}

/* ============================== TẦNG 3: AI =============================== */

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * classifyBatch(posts, aiCall, onProgress) — gọi `aiCall(batch)` cho mỗi lô ~12
 * bài chỉ với các bài MƠ HỒ. `aiCall` trả mảng per-post { postId, label,
 * phrases }. Gộp mọi lô lại. `aiCall` được TIÊM VÀO để test mock.
 *
 * SONG SONG + CÁCH LY LỖI: các lô chạy qua một "hồ" tối đa AI_CONCURRENCY luồng
 * cùng lúc (nhanh hơn nhiều so với 1 lô/lần). MỖI lô được bọc try/catch: nếu 1
 * lô hỏng (timeout/rate-limit/JSON lỗi) thì chỉ các bài trong lô đó rơi về
 * 'other', TOÀN BỘ tiến trình VẪN CHẠY TIẾP — không còn cảnh "chạy tới 400/1000
 * rồi đứng" do một lô ném lỗi kéo sập cả vòng lặp.
 *
 * onProgress(info) (tuỳ chọn): gọi SAU MỖI LÔ với { done, total } (số bài mơ hồ
 * đã xử lý / tổng) để UI hiện tiến độ thực thay vì spinner đứng im.
 */
export async function classifyBatch(posts, aiCall, onProgress) {
  if (!Array.isArray(posts) || posts.length === 0) return [];
  if (typeof aiCall !== "function") {
    throw new Error("classifyBatch: aiCall phải là một hàm.");
  }

  const batches = chunk(posts, BATCH_SIZE);
  const perBatch = new Array(batches.length); // kết quả từng lô, giữ đúng thứ tự
  const total = posts.length;
  let done = 0;

  const report = () => {
    if (typeof onProgress !== "function") return;
    try {
      onProgress({ phase: "ai", done, total });
    } catch (_) {
      /* progress là best-effort, không được làm hỏng luồng chính */
    }
  };

  // Xử một lô: gọi AI, lỗi thì rơi về 'other' cho riêng lô đó (không ném ra
  // ngoài để khỏi kéo sập cả hồ luồng).
  const runOne = async (idx) => {
    const batch = batches[idx];
    let out;
    try {
      out = await aiCall(batch);
    } catch (_) {
      out = null; // lô hỏng -> fallback 'other' bên dưới
    }
    if (Array.isArray(out)) {
      perBatch[idx] = out;
    } else {
      perBatch[idx] = batch.map((p) => ({
        postId: p.postId,
        label: "other",
        phrases: [],
      }));
    }
    done += batch.length;
    report();
  };

  // Hồ luồng: tối đa AI_CONCURRENCY worker cùng rút lô kế tiếp theo thứ tự index.
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const idx = next++;
      await runOne(idx);
    }
  };
  const poolSize = Math.min(AI_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  // Gộp theo đúng thứ tự lô.
  const results = [];
  for (const part of perBatch) {
    if (Array.isArray(part)) {
      for (const entry of part) results.push(entry);
    }
  }
  return results;
}

/* ====================== AI CALLER MẶC ĐỊNH (THẬT) ======================== */

/**
 * defaultAiCall(batch) — AI caller THẬT (OpenAI-compatible), phân loại lead cho
 * các bài MƠ HỒ. Trả mảng per-post { postId, label, phrases }. Lỗi/không key ->
 * trả 'other' cho từng bài (an toàn: thà để "khác" còn hơn gán bừa).
 */
async function defaultAiCall(batch) {
  const empty = batch.map((p) => ({ postId: p.postId, label: "other", phrases: [] }));

  const cfg = await getAIConfig();
  const apiBase = (cfg.apiBase || "https://danglamgiau.com/v1").replace(/\/+$/, "");
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || "gpt-5.5";
  if (!apiKey) return empty;

  const sys =
    "Bạn phân loại bài đăng nhóm Facebook (tiếng Việt, lĩnh vực mua bán đồ công " +
    "nghệ/gaming) thành đúng MỘT nhãn theo VAI TRÒ người viết:\n" +
    "- buy: KHÁCH đang cần mua / đi tìm hàng.\n" +
    "- support: KHÁCH cần hỗ trợ, hỏi kỹ thuật, so sánh, hoặc gặp sự cố/hỏng hóc.\n" +
    "- seller: NGƯỜI BÁN hoặc SHOP/THỢ chào hàng/dịch vụ (rao bán, thu mua, " +
    "nhận sửa, nhận bọc, trao đổi mua bán...). Đây là bên CUNG, KHÔNG phải khách.\n" +
    "- other: không thuộc nhóm nào.\n\n" +
    "QUAN TRỌNG: 'nhận sửa'/'thu mua'/'nhận bọc' là SHOP chào dịch vụ -> seller, " +
    "KHÁC với khách 'cần sửa'/'máy bị lỗi' -> support.\n\n" +
    "Với mỗi bài, ngoài nhãn hãy trích 1-3 CỤM TỪ ngắn (2-4 chữ) đặc trưng nhất " +
    "cho nhãn đó (để hệ thống học làm giàu bộ lọc). Trả JSON: " +
    '{ "results": [ { "postId": "...", "label": "buy|support|seller|other", "phrases": ["..."] } ] }';

  const postsBlock = batch
    .map(
      (p, i) =>
        "### BÀI " + (i + 1) + " (postId=" + p.postId + "):\n" +
        String(p.text || "").slice(0, 800)
    )
    .join("\n\n");
  const user =
    "PHÂN LOẠI " + batch.length + " BÀI SAU, mỗi bài MỘT entry trong results với " +
    "postId tương ứng:\n\n" + postsBlock;

  const bodyBase = {
    model,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    temperature: 0.1,
    max_tokens: 1200,
    stream: false,
  };

  let resp;
  try {
    resp = await fetchWithTimeout(
      apiBase + "/chat/completions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
        body: JSON.stringify({ ...bodyBase, response_format: { type: "json_object" } }),
      },
      30000
    );
  } catch (e) {
    return empty;
  }
  if (!resp.ok && (resp.status === 400 || resp.status === 422)) {
    try {
      resp = await fetchWithTimeout(
        apiBase + "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
          body: JSON.stringify(bodyBase),
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

  const byId = new Map();
  for (const r of results) {
    if (r && r.postId != null) byId.set(String(r.postId), r);
  }
  return batch.map((p) => {
    const r = byId.get(String(p.postId));
    const label = r && VALID_LABELS.has(String(r.label)) ? String(r.label) : "other";
    const phrases = r && Array.isArray(r.phrases) ? r.phrases : [];
    return { postId: p.postId, label, phrases };
  });
}

/* ======================= ORCHESTRATION + VÒNG HỌC ======================== */

// Ngưỡng AUTO-PROMOTE: cụm cực đặc trưng (ratio cao) + đủ tần suất -> thăng cấp
// thẳng thành keyword thật; còn lại vào hàng chờ duyệt.
const AUTO_PROMOTE_RATIO = 0.85;
const AUTO_PROMOTE_MIN_COUNT = 5;

// Nhãn lead -> type trong learned_keywords (seller gộp chung type 'sell').
const LABEL_TO_KW_TYPE = { buy: "buy", support: "support", seller: "sell" };

/**
 * runLeadClassification(deps) — điều phối toàn bộ vòng phân loại + học.
 *
 * Luồng:
 *   1) getAllPosts() -> selectForClassify (bỏ manual, bỏ bài đã đúng phiên bản).
 *   2) splitByConfidence: rule chốt ca rõ; gom ca mơ hồ.
 *   3) classifyBatch(ambiguous, aiCall) -> nhãn AI + cụm từ gợi ý.
 *   4) savePost mỗi bài: leadLabel + leadSource (rule|ai) + leadVer + leadAt.
 *   5) VÒNG HỌC: mineKeywordCandidates trên các bài VỪA gán nhãn chắc chắn:
 *        - ratio>=AUTO_PROMOTE_RATIO & count>=AUTO_PROMOTE_MIN_COUNT -> POST
 *          /api/keywords (addedBy:'auto', enabled:true) để dùng ngay.
 *        - còn lại + cụm AI gợi ý -> POST /api/keyword-candidates (hàng chờ duyệt).
 *
 * deps: { apiFetch, getAllPosts, aiCall, savePost, leadVer } đều tiêm được để test.
 * Trả { processed, ruleCount, aiCount, promoted, queued }.
 */
export async function runLeadClassification(deps = {}) {
  const apiFetch = deps.apiFetch || realApiFetch;
  const getAllPosts = deps.getAllPosts || DB.getAllPosts;
  const aiCall = deps.aiCall || defaultAiCall;
  const leadVer = Number.isFinite(Number(deps.leadVer)) ? Number(deps.leadVer) : LEAD_VER;
  const savePost = deps.savePost || defaultSavePost(apiFetch, leadVer);
  // onProgress(info): best-effort, để UI hiện tiến độ THỰC (không phải spinner
  // đứng im). Các phase: "select" | "ai" | "save" | "done".
  const emit = (info) => {
    if (typeof deps.onProgress !== "function") return;
    try {
      deps.onProgress(info);
    } catch (_) {
      /* progress không được làm hỏng luồng chính */
    }
  };

  // 1) Chọn bài cần phân loại. force=true (bấm "Phân loại lại") -> chạy lại mọi
  //    bài không phải manual, kể cả bài đã có nhãn đúng phiên bản.
  const posts = (await getAllPosts()) || [];
  const todo = selectForClassify(posts, leadVer, { force: !!deps.force });
  if (todo.length === 0) {
    emit({ phase: "done", processed: 0, total: 0 });
    return { processed: 0, ruleCount: 0, aiCount: 0, promoted: 0, queued: 0 };
  }
  emit({ phase: "select", total: todo.length });

  // 2) Rule chốt ca rõ; gom ca mơ hồ.
  const { confident, ambiguous } = splitByConfidence(todo);

  // Bản ghi nhãn cuối cùng cho từng bài (để lưu + để đào keyword).
  const labeled = []; // { post, label, source }

  for (const c of confident) {
    labeled.push({ post: c.post, label: c.label, source: "rule" });
  }

  // 3) AI cho ca mơ hồ. Phát tiến độ theo từng lô để UI không thấy spinner đơ.
  const aiPhrases = { buy: new Map(), support: new Map(), seller: new Map() };
  if (ambiguous.length > 0) {
    const aiResults = await classifyBatch(ambiguous, aiCall, (p) =>
      emit({ ...p, ruleDone: confident.length }),
    );
    const postById = new Map(ambiguous.map((p) => [String(p.postId), p]));
    for (const r of aiResults) {
      if (!r || r.postId == null) continue;
      const post = postById.get(String(r.postId));
      if (!post) continue;
      const label = VALID_LABELS.has(String(r.label)) ? String(r.label) : "other";
      labeled.push({ post, label, source: "ai" });
      // Gom cụm AI gợi ý theo nhãn để đề xuất keyword (chỉ nhãn có bộ keyword).
      if (aiPhrases[label] && Array.isArray(r.phrases)) {
        for (const ph of r.phrases) {
          const w = String(ph || "").trim().toLowerCase();
          if (w) aiPhrases[label].set(w, (aiPhrases[label].get(w) || 0) + 1);
        }
      }
    }
  }

  // 4) Lưu nhãn cho từng bài. Chạy SONG SONG qua hồ luồng (tối đa SAVE_CONCURRENCY
  //    request cùng lúc) thay vì tuần tự 1 bài/lần — với ~1000 bài, lưu tuần tự
  //    là nút thắt lớn. Mỗi lần lưu bọc try/catch: 1 bài lỗi không kéo sập cả mẻ.
  let ruleCount = 0;
  let aiCount = 0;
  let saved = 0;
  const totalSave = labeled.length;
  let nextSave = 0;
  const saveWorker = async () => {
    while (nextSave < totalSave) {
      const it = labeled[nextSave++];
      try {
        await savePost(it.post.postId, it.label, it.source);
      } catch (_) {
        /* best-effort: 1 bài lưu lỗi không dừng cả mẻ */
      }
      if (it.source === "rule") ruleCount++;
      else aiCount++;
      saved++;
      // Nhịp báo mỗi ~20 bài để tránh spam broadcast nhưng vẫn thấy nhúc nhích.
      if (saved % 20 === 0 || saved === totalSave) {
        emit({ phase: "save", done: saved, total: totalSave });
      }
    }
  };
  const savePool = Math.min(AI_CONCURRENCY, totalSave);
  await Promise.all(Array.from({ length: savePool }, () => saveWorker()));

  // 5) VÒNG HỌC: đào cụm từ đặc trưng từ các bài vừa gán nhãn chắc chắn.
  const minedPosts = labeled
    .filter((it) => it.label !== "other")
    .map((it) => ({ text: it.post.text }));
  const mined = mineKeywordCandidates(minedPosts, { minCount: 3, maxPerGroup: 25 });

  let promoted = 0;
  const queue = []; // candidate rows cho /api/keyword-candidates

  for (const label of ["buy", "support", "seller"]) {
    for (const c of mined[label] || []) {
      if (c.ratio >= AUTO_PROMOTE_RATIO && c.count >= AUTO_PROMOTE_MIN_COUNT) {
        // AUTO-PROMOTE: thành keyword thật ngay.
        try {
          await apiFetch("/api/keywords", {
            method: "POST",
            body: JSON.stringify({
              keyword: c.phrase,
              type: LABEL_TO_KW_TYPE[label],
              addedBy: "auto",
              enabled: true,
            }),
          });
          promoted++;
        } catch (_) {
          // best-effort: nếu lỗi, vẫn đẩy vào hàng chờ để không mất cụm.
          queue.push(candRow(c, label, "mine"));
        }
      } else {
        queue.push(candRow(c, label, "mine"));
      }
    }
    // Cụm AI gợi ý (chưa chắc đặc trưng) -> luôn vào hàng chờ duyệt.
    for (const [phrase, cnt] of aiPhrases[label] || []) {
      queue.push({ phrase, label, cnt, ratio: null, example: "", source: "ai" });
    }
  }

  let queued = 0;
  if (queue.length > 0) {
    try {
      const resp = await apiFetch("/api/keyword-candidates", {
        method: "POST",
        body: JSON.stringify({ candidates: queue }),
      });
      queued = resp && typeof resp.upserted === "number" ? resp.upserted : queue.length;
    } catch (_) {
      /* best-effort: không chặn luồng phân loại chính */
    }
  }

  emit({
    phase: "done",
    processed: labeled.length,
    total: labeled.length,
    aiCount,
  });
  return {
    processed: labeled.length,
    ruleCount,
    aiCount,
    promoted,
    queued,
  };
}

/** Dựng một dòng candidate từ kết quả đào n-gram. */
function candRow(c, label, source) {
  return {
    phrase: c.phrase,
    label,
    cnt: c.count,
    ratio: c.ratio,
    example: c.examples || "",
    source,
  };
}

/**
 * defaultSavePost(apiFetch, leadVer) — THIN CALL lưu nhãn lead vào bài qua
 * PATCH /api/posts/:id. Nuốt lỗi để không chặn luồng (bài sẽ được xử lại lần sau).
 */
function defaultSavePost(apiFetch, leadVer) {
  return async (postId, label, source) => {
    try {
      await apiFetch("/api/posts/" + encodeURIComponent(postId), {
        method: "PATCH",
        body: JSON.stringify({ leadLabel: label, leadSource: source, leadVer }),
      });
    } catch (_) {
      /* best-effort */
    }
  };
}
