import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, signToken, verifyToken } from "../auth.js";

test("password hash round-trips", async () => {
  const h = await hashPassword("secret123");
  assert.notEqual(h, "secret123");
  assert.equal(await verifyPassword("secret123", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
});

test("jwt sign/verify carries userId", () => {
  const tok = signToken({ userId: 42 });
  assert.equal(verifyToken(tok).userId, 42);
});

test("verifyToken throws on tampered token", () => {
  assert.throws(() => verifyToken("not.a.jwt"));
});
