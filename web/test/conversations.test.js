/**
 * conversations.test.js — round-trip fidelity for the conversations API.
 *
 * Regression guard (code review, Task 7 follow-up): the rich conversation record
 * the client builds (postUrl, groupId, groupName, myComment, myCommentUrl,
 * postText, draft, jobId, lastWatchedAt, ...) must survive a POST → GET
 * round-trip and the mutable subset must be PATCH-able. Before the fix the POST
 * body and the schema only carried postId/commentPermalink/replies/status, so
 * every other field was silently dropped.
 *
 * Like the other DB-backed suites, this skips cleanly when MySQL is unreachable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../server.js";
import { ensureDatabase, getPool } from "../config.js";
import { runMigrations } from "../schema.js";

async function registerUser(app, suffix) {
  const email = `conv${Date.now()}_${suffix}@t.io`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "secret123", displayName: suffix });
  assert.equal(res.status, 200, `register ${suffix} should succeed`);
  return { token: res.body.token, userId: res.body.user.id, email };
}

test("conversations round-trip the full field set through the API", async (t) => {
  try {
    await ensureDatabase();
    await runMigrations();
  } catch {
    return t.skip("MySQL not reachable");
  }

  t.after(() => getPool().end());

  const app = buildApp();

  await t.test(
    "POST then GET preserves rich fields including draft as an object",
    async () => {
      const U = await registerUser(app, "rt");
      const postId = `cp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const groupId = `cg_${Date.now()}`;

      const conv = {
        postId,
        postUrl: "https://facebook.com/groups/x/posts/123",
        groupId,
        groupName: "Group X",
        myComment: "Inbox em giá nhé",
        myCommentUrl: "https://facebook.com/comment/abc",
        commentPermalink: "https://facebook.com/comment/abc",
        postText: "Cần bán iPhone 13 còn bảo hành",
        draft: { reply: "Dạ em gửi giá ạ", model: "gpt-4o" },
        jobId: "job-77",
        lastWatchedAt: 1700000000000,
        status: "watching",
        replies: [],
      };

      const create = await request(app)
        .post("/api/conversations")
        .set("Authorization", `Bearer ${U.token}`)
        .send(conv);
      assert.equal(create.status, 200);
      assert.ok(create.body.id, "POST must return the new id");

      const list = await request(app)
        .get("/api/conversations")
        .set("Authorization", `Bearer ${U.token}`);
      assert.equal(list.status, 200);

      const got = list.body.conversations.find((c) => c.id === create.body.id);
      assert.ok(got, "the created conversation must come back from GET");

      assert.equal(got.postId, conv.postId);
      assert.equal(got.postUrl, conv.postUrl);
      assert.equal(got.groupId, conv.groupId);
      assert.equal(got.groupName, conv.groupName);
      assert.equal(got.myComment, conv.myComment);
      assert.equal(got.myCommentUrl, conv.myCommentUrl);
      assert.equal(got.postText, conv.postText);
      assert.equal(got.jobId, conv.jobId);
      assert.equal(Number(got.lastWatchedAt), conv.lastWatchedAt);
      assert.deepEqual(got.draft, conv.draft, "draft must round-trip as an object");
    }
  );

  await t.test(
    "PATCH updates draft and lastWatchedAt and they persist on GET",
    async () => {
      const U = await registerUser(app, "patch");
      const postId = `cp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

      const create = await request(app)
        .post("/api/conversations")
        .set("Authorization", `Bearer ${U.token}`)
        .send({ postId, status: "watching", replies: [] });
      assert.equal(create.status, 200);
      const id = create.body.id;

      const newDraft = { reply: "Giá chốt 12tr", model: "gpt-4o" };
      const patch = await request(app)
        .patch(`/api/conversations/${id}`)
        .set("Authorization", `Bearer ${U.token}`)
        .send({
          draft: newDraft,
          lastWatchedAt: 1700000999000,
          myComment: "đã rep",
          status: "replied",
        });
      assert.equal(patch.status, 200);
      assert.equal(patch.body.updated, 1);

      const list = await request(app)
        .get("/api/conversations")
        .set("Authorization", `Bearer ${U.token}`);
      const got = list.body.conversations.find((c) => c.id === id);
      assert.ok(got);
      assert.deepEqual(got.draft, newDraft, "patched draft must persist");
      assert.equal(Number(got.lastWatchedAt), 1700000999000);
      assert.equal(got.myComment, "đã rep");
      assert.equal(got.status, "replied");
    }
  );
});
