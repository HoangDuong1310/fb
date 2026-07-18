import { test } from "node:test";
import assert from "node:assert/strict";

import { didIncrementalItemsChange } from "../ui/src/lib/useIncremental.ts";

test("didIncrementalItemsChange ignores a new array wrapper with the same item objects", () => {
  const a = { id: 1 };
  const b = { id: 2 };
  assert.equal(didIncrementalItemsChange([a, b], [a, b]), false);
});

test("didIncrementalItemsChange detects filtering, reordering, and refetched objects", () => {
  const a = { id: 1 };
  const b = { id: 2 };
  assert.equal(didIncrementalItemsChange([a, b], [a]), true);
  assert.equal(didIncrementalItemsChange([a, b], [b, a]), true);
  assert.equal(didIncrementalItemsChange([a, b], [{ id: 1 }, { id: 2 }]), true);
});
