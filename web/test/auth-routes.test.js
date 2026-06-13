import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../server.js";
import { ensureDatabase, getPool } from "../config.js";
import { runMigrations } from "../schema.js";
import { signToken } from "../auth.js";

test("auth routes", async (t) => {
  try {
    await ensureDatabase();
    await runMigrations();
  } catch {
    return t.skip("MySQL not reachable");
  }

  const app = buildApp();

  await t.test("register then login returns a token", async () => {
    const email = `u${Date.now()}@t.io`;
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    assert.equal(reg.status, 200);
    assert.ok(reg.body.token);
    assert.equal(reg.body.user.email, email);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "secret123" });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    assert.equal(login.body.user.email, email);
  });

  await t.test("register with missing email is rejected", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ password: "secret123" });
    assert.equal(res.status, 400);
  });

  await t.test("register with missing password is rejected", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: `m${Date.now()}@t.io` });
    assert.equal(res.status, 400);
  });

  await t.test("register with duplicate email is rejected", async () => {
    const email = `dup${Date.now()}@t.io`;
    const first = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    assert.equal(first.status, 200);
    const second = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    assert.equal(second.status, 409);
  });

  // Proves the ER_DUP_ENTRY -> 409 translation. The DB UNIQUE constraint on
  // users.email is the source of truth: re-registering an existing email must
  // yield a clean 409 with the shared error body, never a 500 or a hung request
  // (which is what happened before the asyncHandler + INSERT-catch were added).
  await t.test("duplicate registration yields clean 409 body", async () => {
    const email = `dupbody${Date.now()}@t.io`;
    const first = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    assert.equal(first.status, 200);
    const second = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "email already registered");
  });

  await t.test("login with wrong password returns 401", async () => {
    const email = `wp${Date.now()}@t.io`;
    await request(app)
      .post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: "wrongpass" });
    assert.equal(res.status, 401);
  });

  await t.test("protected route without token returns 401", async () => {
    const res = await request(app).get("/api/_whoami");
    assert.equal(res.status, 401);
  });

  await t.test("protected route with valid token returns userId", async () => {
    const email = `who${Date.now()}@t.io`;
    const reg = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    const userId = reg.body.user.id;
    const token = signToken({ userId });
    const res = await request(app)
      .get("/api/_whoami")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.userId, userId);
  });

  await getPool().end();
});
