/**
 * routes/auth.js — Authentication endpoints.
 *
 *   POST /api/auth/register  { email, password, displayName? } → { token, user }
 *   POST /api/auth/login     { email, password }               → { token, user }
 *   GET  /api/auth/me                                          → { user }
 */

import { Router } from "express";
import { pool } from "../db.js";
import { hashPassword, verifyPassword, signToken, requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/auth/register ──────────────────────────────────────────────── */
router.post("/register", async (req, res) => {
  const { email, password, displayName = "" } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email và password là bắt buộc." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự." });
  }

  try {
    // Check duplicate email
    const [existing] = await pool.execute(
      "SELECT id FROM users WHERE email = ?",
      [email.toLowerCase().trim()]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email đã được đăng ký." });
    }

    const hash = await hashPassword(password);
    const [result] = await pool.execute(
      "INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)",
      [email.toLowerCase().trim(), hash, displayName || ""]
    );
    const userId = result.insertId;

    // Create default share prefs (all TRUE)
    await pool.execute(
      "INSERT INTO user_share_prefs (user_id) VALUES (?)",
      [userId]
    );

    const token = signToken(userId);
    return res.status(201).json({
      token,
      user: { id: userId, email: email.toLowerCase().trim(), displayName: displayName || "" },
    });
  } catch (err) {
    console.error("[auth/register]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/auth/login ─────────────────────────────────────────────────── */
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "email và password là bắt buộc." });
  }

  try {
    const [rows] = await pool.execute(
      "SELECT id, email, password_hash, display_name FROM users WHERE email = ?",
      [email.toLowerCase().trim()]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: "Email hoặc mật khẩu không đúng." });
    }
    const user = rows[0];
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Email hoặc mật khẩu không đúng." });
    }

    const token = signToken(user.id);
    return res.json({
      token,
      user: { id: user.id, email: user.email, displayName: user.display_name },
    });
  } catch (err) {
    console.error("[auth/login]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/auth/me ─────────────────────────────────────────────────────── */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT id, email, display_name FROM users WHERE id = ?",
      [req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy user." });
    const u = rows[0];
    return res.json({ user: { id: u.id, email: u.email, displayName: u.display_name } });
  } catch (err) {
    console.error("[auth/me]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

export default router;
