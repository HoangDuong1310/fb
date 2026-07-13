/**
 * lead-classify.test.js — KIỂM THỬ PHỄU PHÂN LOẠI LEAD + VÒNG HỌC KEYWORD.
 *
 * Chạy bằng `node --test`, KHÔNG cần network/DB: mọi phụ thuộc I/O
 * (apiFetch, getAllPosts, aiCall, savePost) đều được TIÊM VÀO deps và mock.
 *
 * Bài text được thiết kế bám sát luật chấm điểm thật (keyword-match.js):
 *   - cụm >= 2 từ nặng 1.0 điểm; STRONG_SELLER ("cần bán", "thanh lý", ...) ép
 *     nhãn seller ngay.
 *   - CONF_MIN=1.5, CONF_MARGIN=1.0 -> "confident" khi một nhãn đạt >=1.5 và
 *     vượt nhãn nhì >=1.0.
 *   - AUTO_PROMOTE: cụm mới ratio>=0.85 & count>=5 -> POST /api/keywords.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyRule,
  selectForClassify,
  splitByConfidence,
  classifyBatch,
  runLeadClassification,
} from "../src/lead-classify.js";
import { mineKeywordCandidates } from "../src/dashboard/leadfilter.js";

/* =============================== classifyRule ============================= */

test("classifyRule: bài người bán rõ ràng -> seller + confident", () => {
  // "cần bán" (STRONG_SELLER, ép seller) + "thanh lý" = 2.0 điểm seller.
  const r = classifyRule("Cần bán laptop cũ, thanh lý nhanh gọn");
  assert.equal(r.label, "seller");
  assert.equal(r.confident, true);
});

test("classifyRule: bài cần mua rõ ràng -> buy + confident", () => {
  // "cần mua" + "tư vấn cho" + "ngân sách" = 3.0 điểm buy, không tín hiệu khác.
  const r = classifyRule("Cần mua laptop cũ, tư vấn cho mình với ngân sách 10 triệu");
  assert.equal(r.label, "buy");
  assert.equal(r.confident, true);
});

test("classifyRule: bài không tín hiệu -> other, KHÔNG confident (đẩy AI)", () => {
  const r = classifyRule("Hôm nay trời đẹp quá đi làm thôi");
  assert.equal(r.label, "other");
  assert.equal(r.confident, false);
});

test("classifyRule: tín hiệu yếu (1 cụm support) -> mơ hồ, KHÔNG confident", () => {
  // "cho hỏi" = 1.0 điểm support < CONF_MIN 1.5 -> mơ hồ -> AI.
  const r = classifyRule("Cho hỏi con này ổn không mọi người");
  assert.equal(r.label, "support");
  assert.equal(r.confident, false);
});

/* ============================ selectForClassify =========================== */

test("selectForClassify: lấy bài chưa nhãn/nhãn cũ, bỏ manual & bản hiện tại", () => {
  const posts = [
    null, // bỏ phần tử rỗng
    { postId: "a" }, // chưa có nhãn -> lấy
    { postId: "b", leadLabel: "buy", leadVer: 1 }, // đúng phiên bản -> bỏ
    { postId: "c", leadLabel: "buy", leadVer: 0 }, // phiên bản cũ -> lấy
    { postId: "d", leadSource: "manual", leadLabel: "seller" }, // sửa tay -> bỏ
    { postId: "e", leadLabel: "buy" }, // có nhãn nhưng thiếu leadVer (=0) -> lấy
  ];
  const ids = selectForClassify(posts, 1).map((p) => p.postId);
  assert.deepEqual(ids, ["a", "c", "e"]);
});

test("selectForClassify: force=true -> lấy mọi bài không phải manual bất kể nhãn/phiên bản", () => {
  const posts = [
    null,
    { postId: "a" }, // chưa nhãn -> lấy
    { postId: "b", leadLabel: "buy", leadVer: 1 }, // đúng phiên bản nhưng force -> lấy
    { postId: "c", leadLabel: "other", leadVer: 1 }, // đã gán other -> vẫn lấy khi force
    { postId: "d", leadSource: "manual", leadLabel: "seller" }, // manual -> vẫn bỏ
  ];
  const ids = selectForClassify(posts, 1, { force: true }).map((p) => p.postId);
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("selectForClassify: đầu vào không phải mảng -> []", () => {
  assert.deepEqual(selectForClassify(null), []);
  assert.deepEqual(selectForClassify("nope"), []);
  assert.deepEqual(selectForClassify(undefined), []);
});

/* =========================== splitByConfidence ============================ */

test("splitByConfidence: chốt ca rõ, gom ca mơ hồ", () => {
  const posts = [
    { postId: "1", text: "Cần bán laptop, thanh lý gấp" }, // confident seller
    { postId: "2", text: "Hôm nay trời đẹp quá" }, // other -> ambiguous
  ];
  const { confident, ambiguous } = splitByConfidence(posts);
  assert.equal(confident.length, 1);
  assert.equal(confident[0].label, "seller");
  assert.equal(confident[0].post.postId, "1");
  assert.equal(ambiguous.length, 1);
  assert.equal(ambiguous[0].postId, "2");
});

/* ============================== classifyBatch ============================= */

test("classifyBatch: chia >12 bài thành nhiều lô rồi gộp kết quả", async () => {
  const posts = Array.from({ length: 25 }, (_, i) => ({ postId: String(i) }));
  const batchSizes = [];
  const aiCall = async (batch) => {
    batchSizes.push(batch.length);
    return batch.map((p) => ({ postId: p.postId, label: "buy" }));
  };
  const out = await classifyBatch(posts, aiCall);
  assert.equal(out.length, 25);
  assert.deepEqual(batchSizes, [12, 12, 1]);
});

test("classifyBatch: aiCall không phải hàm -> ném lỗi", async () => {
  await assert.rejects(() => classifyBatch([{ postId: "x" }], null), /aiCall/);
});

test("classifyBatch: mảng rỗng / không phải mảng -> [] (không gọi AI)", async () => {
  const aiCall = async () => {
    throw new Error("không được gọi AI");
  };
  assert.deepEqual(await classifyBatch([], aiCall), []);
  assert.deepEqual(await classifyBatch("no", aiCall), []);
});

test("classifyBatch: 1 lô ném lỗi -> lô đó rơi về 'other', các lô khác VẪN chạy", async () => {
  // 25 bài -> 3 lô [12,12,1]. Lô thứ 2 (index 1) ném lỗi; các lô còn lại OK.
  const posts = Array.from({ length: 25 }, (_, i) => ({ postId: String(i) }));
  let call = 0;
  const aiCall = async (batch) => {
    const idx = call++;
    if (idx === 1) throw new Error("giả lập rate-limit/timeout ở lô 2");
    return batch.map((p) => ({ postId: p.postId, label: "buy" }));
  };
  const out = await classifyBatch(posts, aiCall);
  // Không mất bài nào: đủ 25 kết quả dù 1 lô hỏng.
  assert.equal(out.length, 25);
  const byId = new Map(out.map((r) => [r.postId, r.label]));
  // Bài trong lô hỏng (index 12..23) -> 'other'; còn lại -> 'buy'.
  assert.equal(byId.get("0"), "buy");
  assert.equal(byId.get("12"), "other");
  assert.equal(byId.get("23"), "other");
  assert.equal(byId.get("24"), "buy");
});

/* ========================= mineKeywordCandidates ========================== */

test("mineKeywordCandidates: cụm mới lặp nhiều & đặc trưng -> ứng viên seller", () => {
  const posts = [
    { text: "Thanh lý macbook gaming còn đẹp" },
    { text: "Bán gấp macbook gaming giá tốt" },
    { text: "Cần pass macbook gaming cho ai cần" },
    { text: "Nhượng lại macbook gaming zin" },
    { text: "Pass nhanh macbook gaming đây" },
    { text: "Cần mua laptop văn phòng nhẹ" }, // buy, không chứa macbook gaming
  ];
  const mined = mineKeywordCandidates(posts, { minCount: 3, maxPerGroup: 25 });
  const sellerPhrases = mined.seller.map((c) => c.phrase);
  assert.ok(sellerPhrases.includes("macbook gaming"));
  const mg = mined.seller.find((c) => c.phrase === "macbook gaming");
  assert.equal(mg.count, 5);
  assert.equal(mg.ratio, 1);
});

/* ========================= runLeadClassification ========================== */

test("runLeadClassification: end-to-end rule+AI, auto-promote & hàng chờ", async () => {
  const posts = [
    // 5 bài người bán rõ ràng, DÙNG CHUNG cụm mới "macbook gaming".
    // Mỗi bài có 2 tín hiệu bán (>= CONF_MIN 1.5) để rule chốt seller chắc chắn;
    // cụm phụ khác nhau từng bài nên chỉ "macbook gaming" là n-gram chung cả 5.
    { postId: "s1", text: "Thanh lý macbook gaming, cần bán liền tay" },
    { postId: "s2", text: "Bán gấp macbook gaming, bán nhanh trong tuần" },
    { postId: "s3", text: "Cần pass macbook gaming, pass lại giá mềm" },
    { postId: "s4", text: "Nhượng lại macbook gaming, giá fix nhẹ" },
    { postId: "s5", text: "Freeship macbook gaming, ib zalo nhé" },
    // 1 bài cần mua rõ ràng -> rule chốt buy.
    { postId: "b1", text: "Cần mua laptop cũ, tư vấn cho mình với ngân sách 10 triệu" },
    // 1 bài mơ hồ -> đẩy AI.
    { postId: "amb1", text: "Cho hỏi con này ổn không mọi người" },
    // 1 bài sửa tay -> KHÔNG được đụng tới.
    { postId: "man1", text: "Cần bán gì đó", leadSource: "manual", leadLabel: "seller", leadVer: 1 },
  ];

  const calls = { keywords: [], candidates: [] };
  const apiFetch = async (path, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === "/api/keywords" && method === "POST") {
      calls.keywords.push(body);
      return { ok: true };
    }
    if (path === "/api/keyword-candidates" && method === "POST") {
      calls.candidates.push(body);
      return { upserted: body.candidates.length };
    }
    throw new Error("unexpected apiFetch " + method + " " + path);
  };

  const saved = [];
  const savePost = async (postId, label, source) => {
    saved.push({ postId, label, source });
  };

  const aiBatches = [];
  const aiCall = async (batch) => {
    aiBatches.push(batch.map((p) => p.postId));
    return batch.map((p) => ({
      postId: p.postId,
      label: "support",
      phrases: ["con nay on khong"],
    }));
  };

  const result = await runLeadClassification({
    apiFetch,
    getAllPosts: async () => posts,
    aiCall,
    savePost,
    leadVer: 1,
  });

  // 6 rule (5 seller + 1 buy) + 1 ai (amb1); manual bị bỏ.
  assert.equal(result.processed, 7);
  assert.equal(result.ruleCount, 6);
  assert.equal(result.aiCount, 1);

  // AI chỉ nhận bài mơ hồ.
  assert.deepEqual(aiBatches, [["amb1"]]);

  // Lưu đúng 7 bài; KHÔNG lưu bài sửa tay.
  assert.equal(saved.length, 7);
  assert.ok(!saved.find((s) => s.postId === "man1"));
  assert.equal(saved.find((s) => s.postId === "s1").label, "seller");
  assert.equal(saved.find((s) => s.postId === "s1").source, "rule");
  assert.equal(saved.find((s) => s.postId === "b1").label, "buy");
  assert.equal(saved.find((s) => s.postId === "amb1").source, "ai");
  assert.equal(saved.find((s) => s.postId === "amb1").label, "support");

  // AUTO-PROMOTE: các cụm dùng chung ("macbook", "gaming", "macbook gaming")
  // đạt count=5, ratio=1 -> thăng thẳng thành keyword type "sell".
  assert.equal(result.promoted, 3);
  assert.equal(calls.keywords.length, 3);
  for (const b of calls.keywords) {
    assert.equal(b.type, "sell");
    assert.equal(b.addedBy, "auto");
    assert.equal(b.enabled, true);
  }
  assert.ok(calls.keywords.map((b) => b.keyword).includes("macbook gaming"));

  // HÀNG CHỜ: cụm AI gợi ý -> POST /api/keyword-candidates.
  assert.equal(result.queued, 1);
  assert.equal(calls.candidates.length, 1);
  assert.equal(calls.candidates[0].candidates.length, 1);
  assert.equal(calls.candidates[0].candidates[0].source, "ai");
  assert.equal(calls.candidates[0].candidates[0].label, "support");
});

test("runLeadClassification: không có bài đủ điều kiện -> không gọi AI/lưu/API", async () => {
  const result = await runLeadClassification({
    getAllPosts: async () => [
      { postId: "m", text: "Cần bán", leadSource: "manual", leadLabel: "seller" },
      { postId: "c", text: "abc", leadLabel: "other", leadVer: 1 },
    ],
    aiCall: async () => {
      throw new Error("không được gọi AI");
    },
    savePost: async () => {
      throw new Error("không được lưu");
    },
    apiFetch: async () => {
      throw new Error("không được gọi API");
    },
    leadVer: 1,
  });
  assert.deepEqual(result, {
    processed: 0,
    ruleCount: 0,
    aiCount: 0,
    promoted: 0,
    queued: 0,
  });
});
