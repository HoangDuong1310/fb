import { Router } from "express";
import { getPool } from "./config.js";
import { hashPassword, verifyPassword, signToken } from "./auth.js";

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const { email, password, displayName } = req.body || {};
  if (typeof email !== "string" || !email.trim() ||
      typeof password !== "string" || password.length < 6) {
    return res.status(400).json({ error: "email and password (>=6 chars) required" });
  }
  const pool = getPool();
  const [existing] = await pool.query(
    "SELECT id FROM users WHERE email = :email",
    { email }
  );
  if (existing.length) {
    return res.status(409).json({ error: "email already registered" });
  }
  const password_hash = await hashPassword(password);
  const [result] = await pool.query(
    "INSERT INTO users (email, password_hash, display_name) VALUES (:email, :password_hash, :display_name)",
    { email, password_hash, display_name: displayName ?? null }
  );
  const userId = result.insertId;
  await pool.query(
    "INSERT INTO user_share_prefs (user_id) VALUES (:userId)",
    { userId }
  );
  const token = signToken({ userId });
  return res.status(200).json({
    token,
    user: { id: userId, email, displayName: displayName ?? null },
  });
});

authRouter.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT id, email, password_hash, display_name FROM users WHERE email = :email",
    { email }
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const token = signToken({ userId: user.id });
  return res.status(200).json({
    token,
    user: { id: user.id, email: user.email, displayName: user.display_name },
  });
});
