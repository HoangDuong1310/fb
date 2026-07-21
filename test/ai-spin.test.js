import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runSpinBatches,
  planSpinHttpChunks,
  mergeSpinHttpChunks,
  SPIN_HTTP_CHUNK_SIZE,
} from "../src/ai.js";

test("AI spin splits a large target list into small sequential batches", async () => {
  const sizes = [];
  let active = 0;
  let maxActive = 0;
  const result = await runSpinBatches({
    content: "Bài gốc",
    count: 14,
    batchSize: 6,
    sleepFn: async () => {},
    generateBatch: async (size, offset) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      sizes.push(size);
      await Promise.resolve();
      active -= 1;
      return Array.from({ length: size }, (_, i) => `Bản ${offset + i + 1}`);
    },
  });

  assert.deepEqual(sizes, [6, 6, 2]);
  assert.equal(maxActive, 1);
  assert.equal(result.variants.length, 14);
  assert.equal(result.failedBatches, 0);
});

test("AI spin retries a transient HTTP 500 batch once", async () => {
  let calls = 0;
  const result = await runSpinBatches({
    content: "Bài gốc",
    count: 3,
    batchSize: 6,
    sleepFn: async () => {},
    generateBatch: async (size) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error("HTTP 500");
        error.status = 500;
        throw error;
      }
      return Array.from({ length: size }, (_, i) => `Bản ${i + 1}`);
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.variants, ["Bản 1", "Bản 2", "Bản 3"]);
  assert.equal(result.failedBatches, 0);
});

test("AI spin preserves successful batches and only falls back failed batches", async () => {
  const result = await runSpinBatches({
    content: "Bài gốc",
    count: 8,
    batchSize: 4,
    sleepFn: async () => {},
    generateBatch: async (size, offset) => {
      if (offset === 4) throw Object.assign(new Error("HTTP 500"), { status: 500 });
      return Array.from({ length: size }, (_, i) => `Bản ${offset + i + 1}`);
    },
  });

  assert.deepEqual(result.variants, [
    "Bản 1", "Bản 2", "Bản 3", "Bản 4",
    "Bài gốc", "Bài gốc", "Bài gốc", "Bài gốc",
  ]);
  assert.equal(result.failedBatches, 1);
});

test("AI spin HTTP plan splits multi-group count into ≤6 per request", () => {
  assert.deepEqual(planSpinHttpChunks(3), [3]);
  assert.deepEqual(planSpinHttpChunks(6), [6]);
  assert.deepEqual(planSpinHttpChunks(14), [6, 6, 2]);
  assert.deepEqual(planSpinHttpChunks(30), [6, 6, 6, 6, 6]);
  assert.equal(SPIN_HTTP_CHUNK_SIZE, 6);
});

test("AI spin HTTP merge keeps successful chunks and falls back failed ones", () => {
  const sizes = planSpinHttpChunks(8);
  const merged = mergeSpinHttpChunks(
    "Bài gốc",
    8,
    [
      { ok: true, variants: ["A1", "A2", "A3", "A4", "A5", "A6"], source: "ai" },
      null, // HTTP/network failure for last 2
    ],
    sizes
  );
  assert.equal(merged.ok, true);
  assert.equal(merged.source, "partial-ai");
  assert.deepEqual(merged.variants, [
    "A1", "A2", "A3", "A4", "A5", "A6",
    "Bài gốc", "Bài gốc",
  ]);
});

test("AI spin HTTP merge all failed chunks returns fallback, not hard error", () => {
  const sizes = planSpinHttpChunks(5);
  const merged = mergeSpinHttpChunks("Gốc", 5, [null], sizes);
  assert.equal(merged.ok, true);
  assert.equal(merged.source, "fallback");
  assert.deepEqual(merged.variants, ["Gốc", "Gốc", "Gốc", "Gốc", "Gốc"]);
});
