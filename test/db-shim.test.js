/**
 * db-shim.test.js — Task 7: src/db.js becomes a thin API client.
 *
 * Runs under plain Node via `node --test test/*.test.js` (NO `chrome`, NO
 * `indexedDB`). Two guarantees:
 *
 *  1) PUBLIC API SNAPSHOT — db.js must keep exporting every name the rest of the
 *     extension imports (crawl.js, advisory.js, prices.js, dashboard views, ...).
 *     Removing or renaming any export breaks a caller, so we snapshot the list.
 *
 *  2) DATA CALLS GO THROUGH THE HTTP API — getAllPosts() must hit
 *     GET /api/posts via the shared apiFetch client (which talks to global
 *     fetch). We mock global.fetch and assert the request URL/shape. With the
 *     old IndexedDB implementation there is no fetch at all, so this fails RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as DB from "../src/db.js";
import { setBaseUrl, setToken } from "../src/api.js";

// The complete set of names callers depend on (plan Task 7, db.js export block).
const EXPECTED_EXPORTS = [
  // posts
  "savePosts",
  "getKnownIds",
  "getAllPosts",
  "getStats",
  "clearPosts",
  // groups
  "saveGroup",
  "saveGroups",
  "getGroups",
  "deleteGroup",
  // jobs (chrome.storage.local — device-local, NOT API)
  "createJob",
  "updateJob",
  "getJobs",
  "getDueJobs",
  "deleteJob",
  "clearFinishedJobs",
  // products
  "saveProducts",
  "getProducts",
  "searchProducts",
  "clearProducts",
  "deleteProduct",
  // sources
  "saveSource",
  "getSources",
  "deleteSource",
  // advisories
  "saveAdvisory",
  "getAdvisories",
  "getAdvisory",
  "updateAdvisory",
  "deleteAdvisory",
  "clearAdvisories",
  // conversations
  "createConversation",
  "getConversations",
  "getConversation",
  "updateConversation",
  "mergeReplies",
  "deleteConversation",
];

test("db.js exports every public name the extension depends on", () => {
  for (const name of EXPECTED_EXPORTS) {
    assert.equal(
      typeof DB[name],
      "function",
      `db.js must export ${name} as a function`
    );
  }
});

test("getAllPosts() calls GET /api/posts through apiFetch", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");

  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: [] }),
    };
  };

  const result = await DB.getAllPosts();

  assert.ok(captured, "getAllPosts must trigger an HTTP request via fetch");
  assert.match(
    String(captured.url),
    /\/api\/posts(\?|$)/,
    "getAllPosts must hit the /api/posts endpoint"
  );
  assert.ok(Array.isArray(result), "getAllPosts must return an array");
});

test("getAllPosts(groupId) forwards groupId as a query param", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");

  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ posts: [] }),
    };
  };

  await DB.getAllPosts("g-42");

  assert.match(
    String(captured.url),
    /\/api\/posts\?.*groupId=g-42/,
    "groupId must be sent as a query param"
  );
});

test("getKnownIds() returns an array of post ids from /api/posts/known-ids", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");

  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ids: ["p1", "p2"] }),
    };
  };

  const ids = await DB.getKnownIds();

  assert.match(String(captured.url), /\/api\/posts\/known-ids/);
  assert.ok(Array.isArray(ids), "getKnownIds must return an array");
  assert.deepEqual(ids, ["p1", "p2"]);
});
