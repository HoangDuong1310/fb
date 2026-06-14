/**
 * group-prices.test.js — Pure-logic tests for the 3-tier group-price funnel
 * (src/group-prices.js). Runs under plain Node via
 * `node --test test/group-prices.test.js` (NOT in an extension), so there is no
 * `chrome` global. Every test mocks the AI caller and apiFetch — NO network/DB.
 *
 * Tiers under test:
 *   Tier 1 — tier1Pass(text, sellKeywords): money figure AND sell keyword.
 *   Tier 2 — selectForAI(posts): drop already-parsed + tier1 failures.
 *   Tier 3 — extractBatch(posts, aiCall): batch ~10-15 posts per AI call.
 *   verifyExtraction(post, items): anti-hallucination price check.
 *   runGroupPriceExtraction(deps): orchestration with injected deps.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tier1Pass,
  selectForAI,
  extractBatch,
  verifyExtraction,
  runGroupPriceExtraction,
} from "../src/group-prices.js";

// Sell-signal keywords used across tests (lowercase, as the funnel compares
// against text.toLowerCase()).
const SELL = ["bán", "thanh lý", "pass", "giá", "fix"];

/* ------------------------------ tier1Pass -------------------------------- */

test("tier1Pass: TRUE when text has BOTH a money figure AND a sell keyword", () => {
  const text = "Bán laptop Dell giá 5.000.000 còn bảo hành";
  assert.equal(tier1Pass(text, SELL), true);
});

test("tier1Pass: FALSE for a buy/ask post with a number but no sell keyword", () => {
  // "cần mua ... giá bao nhiêu" — has a model number but is a buyer asking.
  const text = "Cần mua RTX 4060, ai có inbox giá bao nhiêu vậy";
  // No money figure here (4060 is a model number, filtered by extractMoneyFigures),
  // and no sell keyword in our SELL list except "giá" — but "giá bao nhiêu" is an
  // ask. The decisive factor: there is no MONEY FIGURE -> must be FALSE.
  assert.equal(tier1Pass(text, SELL), false);
});

test("tier1Pass: FALSE for a buy post even when it contains a real money figure", () => {
  // Buyer with a budget number but no sell-signal keyword at all.
  const text = "Cần mua màn hình tầm 2.000.000 đổ lại, ai dư ới mình";
  const buyKeywords = ["bán", "thanh lý", "pass"]; // no "giá"/"fix"
  assert.equal(tier1Pass(text, buyKeywords), false);
});

test("tier1Pass: FALSE when a sell keyword is present but there is no money figure", () => {
  const text = "Bán laptop Dell còn bảo hành, ai cần inbox";
  assert.equal(tier1Pass(text, SELL), false);
});

test("tier1Pass: tolerates empty/undefined text and empty keyword list", () => {
  assert.equal(tier1Pass("", SELL), false);
  assert.equal(tier1Pass(undefined, SELL), false);
  assert.equal(tier1Pass("Bán giá 5.000.000", []), false);
});

/* ----------------------------- selectForAI ------------------------------- */

test("selectForAI: keeps only un-parsed posts that pass tier1", () => {
  const posts = [
    // PASS: no parsed_at, has money + sell keyword.
    { postId: "p1", text: "Thanh lý CPU i5 giá 1.500.000", parsedAt: null },
    // DROP: already parsed (has parsedAt) even though it would pass tier1.
    { postId: "p2", text: "Bán VGA giá 3.000.000", parsedAt: "2026-06-01T00:00:00Z" },
    // DROP: tier1 failure (no money figure).
    { postId: "p3", text: "Bán chuột logitech mới", parsedAt: null },
    // DROP: tier1 failure (buyer, no sell keyword).
    { postId: "p4", text: "Cần mua RAM 16GB tầm 800.000", parsedAt: null },
  ];
  const out = selectForAI(posts, SELL);
  assert.deepEqual(out.map((p) => p.postId), ["p1"]);
});

test("selectForAI: treats missing parsedAt field the same as un-parsed", () => {
  const posts = [{ postId: "p1", text: "Pass nhanh tai nghe giá 250.000" }];
  const out = selectForAI(posts, SELL);
  assert.deepEqual(out.map((p) => p.postId), ["p1"]);
});

/* --------------------------- verifyExtraction ---------------------------- */

test("verifyExtraction: drops items whose price is NOT present in the post text", () => {
  const post = { postId: "p1", text: "Bán laptop giá 5.000.000, bao test" };
  const items = [
    { name: "Laptop", price: "5.000.000" }, // present -> keep
    { name: "Sạc", price: "9.999.999" }, // hallucinated -> drop
  ];
  const kept = verifyExtraction(post, items);
  assert.deepEqual(kept.map((i) => i.name), ["Laptop"]);
});

test("verifyExtraction: matches across separator/format normalization (5.000.000 vs 5,000,000)", () => {
  const post = { postId: "p1", text: "Bán nhanh, giá 5,000,000 thôi" };
  const items = [{ name: "Laptop", price: "5.000.000" }];
  const kept = verifyExtraction(post, items);
  assert.equal(kept.length, 1);
});

test("verifyExtraction: matches shorthand 5tr against a 5.000.000 figure in the post", () => {
  // The post states the price as "5tr"; AI normalized it to "5.000.000".
  // Normalization should reduce both to the same numeric value.
  const post = { postId: "p1", text: "Pass màn hình 5tr fix nhẹ" };
  const items = [{ name: "Màn hình", price: "5.000.000" }];
  const kept = verifyExtraction(post, items);
  assert.equal(kept.length, 1);
});

test("verifyExtraction: keeps numeric-typed prices that match the post", () => {
  const post = { postId: "p1", text: "Thanh lý giá 1.500.000" };
  const items = [{ name: "CPU", price: 1500000 }];
  const kept = verifyExtraction(post, items);
  assert.equal(kept.length, 1);
});

test("verifyExtraction: returns empty array for empty/invalid items", () => {
  const post = { postId: "p1", text: "Bán giá 1.000.000" };
  assert.deepEqual(verifyExtraction(post, []), []);
  assert.deepEqual(verifyExtraction(post, null), []);
});

/* ------------------------------ extractBatch ----------------------------- */

test("extractBatch: groups posts into batches of ~10-15 per AI call", async () => {
  // 32 posts -> with batch size 15 that's 3 calls (15 + 15 + 2).
  const posts = Array.from({ length: 32 }, (_, i) => ({
    postId: "p" + i,
    text: "Bán món " + i + " giá " + (i + 1) + ".000.000",
  }));

  const callBatchSizes = [];
  const mockAI = async (batch) => {
    callBatchSizes.push(batch.length);
    // Echo back one item per post whose price literally appears in the text.
    return batch.map((p) => ({
      postId: p.postId,
      items: [{ name: "X", price: p.text.match(/\d+\.000\.000/)[0] }],
      new_keywords: [],
    }));
  };

  const results = await extractBatch(posts, mockAI);

  // No single AI call exceeds 15 posts, and every post is covered.
  assert.ok(callBatchSizes.length >= 2, "should make multiple batched calls");
  for (const n of callBatchSizes) {
    assert.ok(n <= 15, "each batch must be <= 15 posts, got " + n);
  }
  assert.equal(
    callBatchSizes.reduce((a, b) => a + b, 0),
    32,
    "every post must be sent exactly once"
  );
  // One result entry per post.
  assert.equal(results.length, 32);
});

test("extractBatch: returns per-post {postId, items, new_keywords} from the AI", async () => {
  const posts = [
    { postId: "p1", text: "Bán laptop giá 5.000.000" },
    { postId: "p2", text: "Pass chuột giá 250.000" },
  ];
  const mockAI = async (batch) =>
    batch.map((p) => ({
      postId: p.postId,
      items: [{ name: "thing", price: "1.000.000" }],
      new_keywords: ["sang nhượng"],
    }));

  const results = await extractBatch(posts, mockAI);
  assert.equal(results.length, 2);
  assert.equal(results[0].postId, "p1");
  assert.ok(Array.isArray(results[0].items));
  assert.deepEqual(results[0].new_keywords, ["sang nhượng"]);
});

/* ------------------------- runGroupPriceExtraction ----------------------- */

test("runGroupPriceExtraction: end-to-end with injected mocks, verification applied", async () => {
  // Two crawl-able posts: one sell (passes tier1), one buyer (fails tier1).
  const posts = [
    {
      postId: "p1",
      text: "Bán laptop Dell giá 5.000.000, bảo hành 6 tháng",
      groupId: "g1",
      timestamp: "2026-06-10T00:00:00Z",
      authorName: "Seller A",
      authorProfile: "https://fb.com/a",
      parsedAt: null,
    },
    {
      postId: "p2",
      text: "Cần mua RTX 4060 ai có inbox", // buyer, no money + no sell signal
      groupId: "g1",
      parsedAt: null,
    },
  ];

  const calls = { keywordsGet: 0, postBody: null, keywordPosts: [], marked: [] };

  // Mock apiFetch routing by path + method.
  const apiFetch = async (path, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    if (path.startsWith("/api/keywords") && method === "GET") {
      calls.keywordsGet++;
      return {
        keywords: [
          { id: 1, keyword: "bán", type: "sell", addedBy: "user", enabled: 1 },
          { id: 2, keyword: "giá", type: "sell", addedBy: "user", enabled: 1 },
        ],
      };
    }
    if (path === "/api/group-prices" && method === "POST") {
      calls.postBody = JSON.parse(init.body);
      return { inserted: calls.postBody.groupPrices.length };
    }
    if (path === "/api/keywords" && method === "POST") {
      calls.keywordPosts.push(JSON.parse(init.body));
      return { ok: true };
    }
    throw new Error("unexpected apiFetch " + method + " " + path);
  };

  // Mock the AI batch caller: returns one valid item (price present in text) and
  // one hallucinated item (price NOT in text) plus a new keyword to learn.
  const aiCall = async (batch) =>
    batch.map((p) => ({
      postId: p.postId,
      items: [
        { name: "Laptop Dell", price: "5.000.000", condition: "cũ", warranty: "6 tháng", category: "laptop" },
        { name: "Ghost item", price: "9.999.999", condition: "mới", warranty: "", category: "khác" },
      ],
      new_keywords: ["sang nhượng"],
    }));

  const markParsed = async (ids) => {
    calls.marked.push(...ids);
  };

  const result = await runGroupPriceExtraction({
    apiFetch,
    getAllPosts: async () => posts,
    aiCall,
    markParsed,
  });

  // Only p1 reaches the AI (p2 fails tier1).
  assert.equal(calls.keywordsGet, 1, "loads enabled sell keywords once");

  // The hallucinated 9.999.999 item must be dropped by verifyExtraction; only the
  // real 5.000.000 item is posted.
  assert.ok(calls.postBody, "should POST group-prices");
  assert.equal(calls.postBody.groupPrices.length, 1, "hallucinated item dropped");
  const row = calls.postBody.groupPrices[0];
  assert.equal(row.postId, "p1");
  assert.equal(row.name, "Laptop Dell");
  assert.equal(row.parser, "ai");

  // New keyword learned with addedBy:'ai', enabled:true.
  assert.equal(calls.keywordPosts.length, 1);
  assert.equal(calls.keywordPosts[0].keyword, "sang nhượng");
  assert.equal(calls.keywordPosts[0].addedBy, "ai");
  assert.equal(calls.keywordPosts[0].enabled, true);
  assert.equal(calls.keywordPosts[0].type, "sell");

  // p1 marked parsed.
  assert.deepEqual(calls.marked, ["p1"]);

  // Reported counts reflect inserted rows.
  assert.equal(result.inserted, 1);
  assert.equal(result.processed, 1);
});

test("runGroupPriceExtraction: no eligible posts -> no group-prices POST", async () => {
  const apiFetch = async (path, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    if (path.startsWith("/api/keywords") && method === "GET") {
      return { keywords: [{ id: 1, keyword: "bán", type: "sell", enabled: 1 }] };
    }
    throw new Error("unexpected apiFetch " + method + " " + path);
  };
  const result = await runGroupPriceExtraction({
    apiFetch,
    getAllPosts: async () => [
      { postId: "p1", text: "Cần mua laptop", parsedAt: null },
    ],
    aiCall: async () => {
      throw new Error("AI must not be called when nothing passes tier1");
    },
    markParsed: async () => {},
  });
  assert.equal(result.inserted, 0);
  assert.equal(result.processed, 0);
});
