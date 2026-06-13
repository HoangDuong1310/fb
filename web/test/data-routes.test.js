import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../server.js";
import { ensureDatabase, getPool } from "../config.js";
import { runMigrations } from "../schema.js";

// Registers a fresh user and returns { token, userId } so each scenario gets an
// isolated identity (emails are timestamp+suffix unique to avoid 409 collisions
// across reruns against a persistent dev database).
async function registerUser(app, suffix) {
  const email = `data${Date.now()}_${suffix}@t.io`;
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email, password: "secret123", displayName: suffix });
  assert.equal(res.status, 200, `register ${suffix} should succeed`);
  return { token: res.body.token, userId: res.body.user.id, email };
}

test("data routes share-filtering", async (t) => {
  try {
    await ensureDatabase();
    await runMigrations();
  } catch {
    return t.skip("MySQL not reachable");
  }

  // Close the single shared pool exactly once after all sub-tests complete.
  t.after(() => getPool().end());

  const app = buildApp();

  await t.test(
    "B sees A's shared post; after A turns share_crawled off, B loses it but A keeps it",
    async () => {
      const A = await registerUser(app, "A");
      const B = await registerUser(app, "B");

      // A unique post id and group id so the assertions key off exactly this
      // row regardless of other data in a persistent dev database.
      const postId = `p_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const groupId = `g_${Date.now()}`;

      // A saves a post. The row inherits A's share_crawled_default (TRUE by
      // default at registration), so it starts shared.
      const save = await request(app)
        .post("/api/posts")
        .set("Authorization", `Bearer ${A.token}`)
        .send({
          posts: [
            {
              postId,
              groupId,
              groupName: "G",
              text: "shared post body",
              timestamp: Date.now(),
            },
          ],
        });
      assert.equal(save.status, 200);

      // Observation 1: B sees A's post while it is shared.
      const bSees = await request(app)
        .get("/api/posts")
        .set("Authorization", `Bearer ${B.token}`);
      assert.equal(bSees.status, 200);
      assert.ok(
        bSees.body.posts.some((p) => p.postId === postId),
        "B should see A's shared post"
      );

      // A flips the master share_crawled switch off. The PATCH handler cascades
      // to existing rows: A's posts get share_crawled=0, hiding them from others
      // while leaving the rows intact and visible to A.
      const patch = await request(app)
        .patch("/api/me/share-prefs")
        .set("Authorization", `Bearer ${A.token}`)
        .send({ share_crawled_default: false });
      assert.equal(patch.status, 200);

      // Observation 2: B no longer sees the post after A unshares.
      const bAfter = await request(app)
        .get("/api/posts")
        .set("Authorization", `Bearer ${B.token}`);
      assert.equal(bAfter.status, 200);
      assert.ok(
        !bAfter.body.posts.some((p) => p.postId === postId),
        "B should NOT see A's post after A turns share off"
      );

      // Observation 3: A still sees their own post (ownership beats the flag).
      const aAfter = await request(app)
        .get("/api/posts")
        .set("Authorization", `Bearer ${A.token}`);
      assert.equal(aAfter.status, 200);
      assert.ok(
        aAfter.body.posts.some((p) => p.postId === postId),
        "A should STILL see their own post after turning share off"
      );
    }
  );

  await t.test("data routes require authentication", async () => {
    const res = await request(app).get("/api/posts");
    assert.equal(res.status, 401);
  });
});
