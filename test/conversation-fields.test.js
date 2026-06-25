/**
 * conversation-fields.test.js — client-side round-trip fidelity (Task 7 follow-up).
 *
 * Runs under plain Node via `node --test test/*.test.js` (NO `chrome`, NO MySQL).
 * We mock global.fetch and assert the REQUEST BODY src/db.js sends, since the
 * regression is that the rich conversation fields were dropped before reaching
 * the wire.
 *
 *  1) createConversation() must POST every rich field the client builds
 *     (postUrl, groupId, groupName, myComment, myCommentUrl, postText, draft,
 *     jobId, lastWatchedAt) — not just postId/commentPermalink/replies/status.
 *
 *  2) updateConversation() must forward the mutable fields it is given
 *     (draft, lastWatchedAt, myComment, ...) in the PATCH body.
 *
 * With the pre-fix db.js the POST body only carries four fields, so (1) fails RED.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as DB from "../src/db.js";
import { setBaseUrl, setToken } from "../src/api.js";

// Installs a fetch stub that records each call and replies with `reply` (parsed
// by apiFetch as JSON). Returns the captured-calls array.
function captureFetch(reply) {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      json: async () => reply,
    };
  };
  return calls;
}

test("createConversation POSTs the full rich field set", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");
  const calls = captureFetch({ id: 42 });

  await DB.createConversation({
    postId: "p1",
    postUrl: "https://fb.com/groups/x/posts/1",
    groupId: "g1",
    groupName: "Group One",
    commentId: "2198772343999307",
    myComment: "Inbox giá nhé",
    myCommentUrl: "https://fb.com/comment/abc",
    postText: "Cần bán iPhone",
    draft: { reply: "Dạ em gửi giá" },
    jobId: "job-9",
    lastWatchedAt: 1700000000000,
    status: "watching",
    replies: [],
  });

  const post = calls.find(
    (c) => /\/api\/conversations(\?|$)/.test(c.url) && c.init.method === "POST"
  );
  assert.ok(post, "createConversation must POST to /api/conversations");

  const body = JSON.parse(post.init.body);
  assert.equal(body.postId, "p1");
  assert.equal(body.postUrl, "https://fb.com/groups/x/posts/1");
  assert.equal(body.groupId, "g1");
  assert.equal(body.groupName, "Group One");
  // commentId là ID bình luận GỐC trích chắc từ URL — phải tới server để định
  // vị reply chính xác, khỏi dò mò theo nội dung text.
  assert.equal(body.commentId, "2198772343999307");
  assert.equal(body.myComment, "Inbox giá nhé");
  assert.equal(body.myCommentUrl, "https://fb.com/comment/abc");
  assert.equal(body.postText, "Cần bán iPhone");
  assert.deepEqual(body.draft, { reply: "Dạ em gửi giá" });
  assert.equal(body.jobId, "job-9");
  assert.equal(body.lastWatchedAt, 1700000000000);
  assert.equal(body.status, "watching");
});

test("updateConversation forwards mutable fields in the PATCH body", async () => {
  setBaseUrl("http://localhost:3300");
  setToken("tok-test");
  const calls = captureFetch({ conversations: [] });

  await DB.updateConversation(42, {
    draft: { reply: "Giá chốt 12tr" },
    lastWatchedAt: 1700000999000,
    myComment: "đã rep",
    status: "replied",
  });

  const patch = calls.find(
    (c) => /\/api\/conversations\/42(\?|$)/.test(c.url) && c.init.method === "PATCH"
  );
  assert.ok(patch, "updateConversation must PATCH /api/conversations/:id");

  const body = JSON.parse(patch.init.body);
  assert.deepEqual(body.draft, { reply: "Giá chốt 12tr" });
  assert.equal(body.lastWatchedAt, 1700000999000);
  assert.equal(body.myComment, "đã rep");
  assert.equal(body.status, "replied");
});
