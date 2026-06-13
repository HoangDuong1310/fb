import { Router } from "express";
import { getPool } from "./config.js";
import { hashPassword, verifyPassword, signToken } from "./auth.js";

export const authRouter = Router();

// Express 4.x does not catch rejections from async handlers; this wrapper
// forwards any rejection to the terminal error-handling middleware via next().
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Validates the register request body. Returns an error message string when the
// input is invalid, or null when it is acceptable. Kept small and pure so the
// route handler stays focused on persistence concerns.
export function validateRegisterInput(body) {
  const { email, password } = body || {};
  if (typeof email !== "string" || !email.trim() ||
      typeof password !== "string" || password.length < 6 ||
      password.length > 72) {
    // bcrypt silently truncates input past 72 bytes, so an upper bound is a
    // security requirement, not just hygiene: two long passwords sharing a
    // 72-byte prefix would otherwise authenticate interchangeably.
    if (typeof password === "string" &&
        (password.length < 6 || password.length > 72)) {
      return "password must be 6-72 characters";
    }
    return "email and password (>=6 chars) required";
  }
  // Simple structural email check; the DB UNIQUE constraint enforces identity.
  if (!/.+@.+\..+/.test(email)) {
    return "invalid email";
  }
  return null;
}

authRouter.post("/register", asyncHandler(async (req, res) => {
  const validationError = validateRegisterInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const { email, password, displayName } = req.body;
  const password_hash = await hashPassword(password);

  // Both inserts must succeed or fail atomically: an orphaned users row with no
  // matching user_share_prefs row breaks every later feature that reads share
  // defaults through the FK. Wrap them in a single transaction on one connection.
  const conn = await getPool().getConnection();
  let userId;
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      "INSERT INTO users (email, password_hash, display_name) VALUES (:email, :password_hash, :display_name)",
      { email, password_hash, display_name: displayName ?? null }
    );
    userId = result.insertId;
    await conn.query(
      "INSERT INTO user_share_prefs (user_id) VALUES (:userId)",
      { userId }
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    // The DB UNIQUE constraint on users.email is the source of truth. Translate
    // the violation (including the concurrent-registration race) into a 409.
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "email already registered" });
    }
    // Any other error propagates to the terminal middleware as a 500.
    throw err;
  } finally {
    conn.release();
  }

  const token = signToken({ userId });
  return res.status(200).json({
    token,
    user: { id: userId, email, displayName: displayName ?? null },
  });
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
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
}));
