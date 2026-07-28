/**
 * Test TẦNG 2.5 — BỘ TRÍCH CỤC BỘ (không AI) của src/group-prices.js.
 *
 * Ý đồ kiểm chứng:
 *   1) scanMoney trả GIÁ TRỊ VND + VỊ TRÍ, và là tập con của extractMoneyFigures
 *      (nhờ đó item cục bộ luôn qua được verifyExtraction).
 *   2) localExtract đọc được bài rao bán "sạch" -> complete === true.
 *   3) Gặp NHẬP NHẰNG (2tr8 / khoảng giá / nhiều giá một dòng) thì complete ===
 *      false để nhường AI — thà chậm còn hơn ghi sai số.
 *   4) runGroupPriceExtraction CHỈ gửi lên AI những bài cục bộ không đọc trọn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scanMoney,
  cleanItemName,
  detectCondition,
  detectWarranty,
  localExtract,
  runGroupPriceExtraction,
} from "../src/group-prices.js";

const SEL = ["bán", "thanh lý", "pass", "giá", "fix"];

/* ----------------------------- scanMoney -------------------------------- */

test("scanMoney: đọc số có dấu phân nhóm + trả vị trí", () => {
  const hits = scanMoney("Thanh lý laptop giá 15.000.000 nhé");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].value, 15000000);
  assert.equal(hits[0].raw, "15.000.000");
  assert.equal(hits[0].start, 20);
});

test("scanMoney: đọc đuôi đơn vị tr/k/triệu về VND", () => {
  assert.equal(scanMoney("giá 12tr")[0].value, 12000000);
  assert.equal(scanMoney("giá 450k")[0].value, 450000);
  assert.equal(scanMoney("giá 5 triệu")[0].value, 5000000);
});

test("scanMoney: nhiều giá trên một dòng -> nhiều hit, không chồng lấn", () => {
  const hits = scanMoney("laptop 15.000.000 ship 30k");
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.value),
    [15000000, 30000],
  );
});

test("scanMoney: bỏ số quá nhỏ (không phải tiền)", () => {
  assert.equal(scanMoney("i5 8GB 256").length, 0);
});

/* ---------------------------- cleanItemName ----------------------------- */

test("cleanItemName: gọt tiền tố rao bán và hậu tố 'giá'", () => {
  assert.equal(cleanItemName("Thanh lý laptop Dell XPS 13 giá"), "laptop Dell XPS 13");
  assert.equal(cleanItemName("pass Chuột Logitech G304 -"), "Chuột Logitech G304");
});

test("cleanItemName: từ chối đoạn quá dài (giống câu văn) và đoạn toàn số", () => {
  const sentence =
    "mọi người cho em hỏi cái này bây giờ bán được khoảng chừng bao nhiêu tiền vậy ạ";
  assert.equal(cleanItemName(sentence), "");
  assert.equal(cleanItemName("12 13 14"), "");
});

/* ------------------------ detectCondition/Warranty ---------------------- */

test("detectCondition: nhận likenew / mới / cũ, mơ hồ -> null", () => {
  assert.equal(detectCondition("Máy còn 98% như mới"), "likenew");
  assert.equal(detectCondition("Like New chưa một vết xước"), "likenew");
  assert.equal(detectCondition("Hàng mới 100% fullbox"), "mới");
  assert.equal(detectCondition("Nguyên seal chưa bóc"), "mới");
  assert.equal(detectCondition("Máy cũ đã qua sử dụng"), "cũ");
  assert.equal(detectCondition("Bán laptop Dell"), null);
});

test("detectWarranty: đọc số tháng/năm, hết BH, BH hãng", () => {
  assert.equal(detectWarranty("còn BH 6 tháng"), "6 tháng");
  assert.equal(detectWarranty("bảo hành 2 năm"), "2 năm");
  assert.equal(detectWarranty("hết bảo hành rồi"), "hết bảo hành");
  assert.equal(detectWarranty("bảo hành chính hãng"), "bảo hành hãng");
  assert.equal(detectWarranty("bán laptop giá tốt"), null);
});

/* ----------------------------- localExtract ----------------------------- */

test("localExtract: bài nhiều dòng sạch -> đọc TRỌN VẸN (complete)", () => {
  const post = {
    postId: "p1",
    text: "Thanh lý laptop Dell XPS 13 giá 15.000.000\nChuột Logitech G304 giá 450.000",
  };
  const { items, complete } = localExtract(post);
  assert.equal(complete, true);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "laptop Dell XPS 13");
  assert.equal(items[0].price, 15000000);
  assert.equal(typeof items[0].price, "number"); // BIGINT-safe
  assert.equal(items[1].name, "Chuột Logitech G304");
  assert.equal(items[1].price, 450000);
});

test("localExtract: lấy tình trạng + bảo hành ở cấp bài", () => {
  const post = {
    postId: "p2",
    text: "Pass Macbook Air M1 giá 16.500.000\nMáy còn 97%, còn BH 6 tháng",
  };
  const { items, complete } = localExtract(post);
  assert.equal(complete, true);
  assert.equal(items.length, 1);
  assert.equal(items[0].condition, "likenew");
  assert.equal(items[0].warranty, "6 tháng");
});

test("localExtract: dòng bắt đầu bằng giá vẫn đọc được tên phía sau", () => {
  const { items, complete } = localExtract({
    postId: "p3",
    text: "3.500.000 màn hình Dell 24 inch",
  });
  assert.equal(complete, true);
  assert.equal(items[0].name, "màn hình Dell 24 inch");
  assert.equal(items[0].price, 3500000);
});

test("localExtract: khoảng giá '5-6tr' -> KHÔNG tự quyết, nhường AI", () => {
  const { items, complete } = localExtract({
    postId: "p4",
    text: "Bán iPhone 13 giá 5-6tr fix nhẹ",
  });
  assert.equal(complete, false);
  assert.equal(items.length, 0);
});

test("localExtract: nhiều giá trên cùng một dòng -> nhường AI", () => {
  const { complete, items } = localExtract({
    postId: "p5",
    text: "Bán laptop giá 15.000.000, ship 30k toàn quốc",
  });
  assert.equal(complete, false);
  assert.equal(items.length, 0);
});

test("localExtract: bài không có giá -> complete false", () => {
  const { items, complete } = localExtract({ postId: "p6", text: "Bán laptop Dell" });
  assert.equal(items.length, 0);
  assert.equal(complete, false);
});

test("localExtract: bỏ qua post rỗng/không text mà không ném lỗi", () => {
  assert.deepEqual(localExtract({}), { items: [], complete: false });
  assert.deepEqual(localExtract(null), { items: [], complete: false });
});

/* --------------------------- ORCHESTRATION ------------------------------ */

function mockApi(captured) {
  return async (path, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    if (path.startsWith("/api/keywords") && method === "GET") {
      return { keywords: SEL.map((k) => ({ keyword: k, enabled: true })) };
    }
    if (path === "/api/group-prices" && method === "POST") {
      const body = JSON.parse(init.body);
      captured.rows = body.groupPrices;
      return { inserted: body.groupPrices.length };
    }
    if (path === "/api/keywords" && method === "POST") {
      return { ok: true };
    }
    throw new Error("gọi API ngoài dự kiến: " + method + " " + path);
  };
}

test("runGroupPriceExtraction: bài đọc trọn KHÔNG lên AI, bài nhập nhằng mới lên AI", async () => {
  const posts = [
    {
      postId: "clean",
      text: "Thanh lý laptop Dell XPS 13 giá 15.000.000",
      authorName: "An",
      groupId: "g1",
    },
    {
      postId: "hard",
      text: "Pass iPhone 13 giá 5-6tr fix nhẹ",
      authorName: "Bình",
      groupId: "g1",
    },
  ];

  const captured = {};
  const seenByAI = [];
  const aiCall = async (batch) => {
    for (const p of batch) seenByAI.push(p.postId);
    return batch.map((p) => ({
      postId: p.postId,
      items: [{ name: "iPhone 13", price: "6.000.000", confidence: 0.9 }],
      new_keywords: [],
    }));
  };

  const result = await runGroupPriceExtraction({
    apiFetch: mockApi(captured),
    getAllPosts: async () => posts,
    aiCall,
    markParsed: async () => {},
  });

  // AI chỉ thấy đúng bài khó -> tiết kiệm token.
  assert.deepEqual(seenByAI, ["hard"]);
  assert.equal(result.localPosts, 1);
  assert.equal(result.aiPosts, 1);
  assert.equal(result.processed, 2);
  assert.equal(result.inserted, 2);

  const local = captured.rows.find((r) => r.parser === "local");
  const ai = captured.rows.find((r) => r.parser === "ai");
  assert.equal(local.name, "laptop Dell XPS 13");
  assert.equal(local.price, 15000000);
  assert.equal(local.sellerName, "An");
  assert.equal(local.groupId, "g1");
  assert.equal(ai.price, 6000000);
});

test("runGroupPriceExtraction: không bài nào lên AI thì KHÔNG gọi AI lần nào", async () => {
  const captured = {};
  let aiCalls = 0;
  const result = await runGroupPriceExtraction({
    apiFetch: mockApi(captured),
    getAllPosts: async () => [
      { postId: "a", text: "Bán RAM Kingston 16GB giá 1.200.000" },
      { postId: "b", text: "Thanh lý SSD Samsung 1TB giá 1.850.000" },
    ],
    aiCall: async () => {
      aiCalls += 1;
      return [];
    },
    markParsed: async () => {},
  });

  assert.equal(aiCalls, 0);
  assert.equal(result.aiPosts, 0);
  assert.equal(result.localPosts, 2);
  assert.equal(result.inserted, 2);
  assert.ok(captured.rows.every((r) => r.parser === "local"));
});

test("runGroupPriceExtraction: useLocal=false giữ nguyên hành vi cũ (mọi bài lên AI)", async () => {
  const captured = {};
  const seenByAI = [];
  const result = await runGroupPriceExtraction({
    apiFetch: mockApi(captured),
    getAllPosts: async () => [
      { postId: "a", text: "Bán RAM Kingston 16GB giá 1.200.000" },
    ],
    aiCall: async (batch) => {
      for (const p of batch) seenByAI.push(p.postId);
      return batch.map((p) => ({
        postId: p.postId,
        items: [{ name: "RAM Kingston 16GB", price: 1200000 }],
        new_keywords: [],
      }));
    },
    markParsed: async () => {},
    useLocal: false,
  });

  assert.deepEqual(seenByAI, ["a"]);
  assert.equal(result.localPosts, 0);
  assert.equal(result.aiPosts, 1);
  assert.equal(captured.rows[0].parser, "ai");
});

test("runGroupPriceExtraction: item cục bộ vẫn phải qua hậu kiểm (một cửa vào DB)", async () => {
  // Bài chỉ có phí ship 30k (dưới ngưỡng giá món) -> cục bộ không dựng item nào,
  // và cũng không được tự ý ghi gì vào DB.
  const captured = {};
  const result = await runGroupPriceExtraction({
    apiFetch: mockApi(captured),
    getAllPosts: async () => [{ postId: "z", text: "Bán ốp lưng giá 9.000" }],
    aiCall: async () => [],
    markParsed: async () => {},
  });
  assert.equal(result.localPosts, 0);
  assert.equal(result.inserted, 0);
  assert.equal(captured.rows, undefined);
});
