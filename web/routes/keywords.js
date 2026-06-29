/**
 * routes/keywords.js — Learned keywords (sell signals, etc.).
 *
 *   GET    /api/keywords          ?type            → { keywords: [] }
 *   POST   /api/keywords          { keyword, type, addedBy, enabled } → { id }
 *   PATCH  /api/keywords/:id      { keyword?, enabled? }              → { updated }
 *   DELETE /api/keywords/:id                                          → { deleted }
 *
 * Keywords are global (not per-user) — any authenticated user can read/write.
 * The UNIQUE constraint on (keyword, type) makes POST idempotent.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── GET /api/keywords ────────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const { type } = req.query;
  try {
    let sql = "SELECT * FROM learned_keywords";
    const params = [];
    if (type) {
      sql += " WHERE type = ?";
      params.push(String(type));
    }
    sql += " ORDER BY created_at DESC";
    const [rows] = await pool.execute(sql, params);
    return res.json({ keywords: rows.map(mapKeyword) });
  } catch (err) {
    console.error("[keywords/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/keywords ───────────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const {
    keyword,
    type = "sell",
    addedBy = "user",
    enabled = true,
  } = req.body || {};

  if (!keyword || !String(keyword).trim()) {
    return res.status(400).json({ error: "keyword là bắt buộc." });
  }

  const kw = String(keyword).trim().toLowerCase();
  const tp = String(type).trim() || "sell";
  const ab = String(addedBy).trim() || "user";
  const en = enabled !== false ? 1 : 0;

  try {
    // Idempotent upsert — UNIQUE KEY on (keyword) in schema
    const [result] = await pool.execute(
      `INSERT INTO learned_keywords (keyword, type, added_by, enabled)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         type      = VALUES(type),
         added_by  = VALUES(added_by),
         enabled   = VALUES(enabled)`,
      [kw, tp, ab, en]
    );
    const id = result.insertId || null;
    return res.status(201).json({ id });
  } catch (err) {
    console.error("[keywords/post]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/keywords/:id ──────────────────────────────────────────────── */
router.patch("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id không hợp lệ." });

  const { keyword, enabled } = req.body || {};
  const sets = [];
  const params = [];

  if (keyword !== undefined) {
    const kw = String(keyword).trim().toLowerCase();
    if (!kw) return res.status(400).json({ error: "keyword không được rỗng." });
    sets.push("keyword = ?");
    params.push(kw);
  }
  if (enabled !== undefined) {
    sets.push("enabled = ?");
    params.push(enabled ? 1 : 0);
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: "Không có trường nào để cập nhật." });
  }

  params.push(id);
  try {
    const [result] = await pool.execute(
      `UPDATE learned_keywords SET ${sets.join(", ")} WHERE id = ?`,
      params
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Không tìm thấy từ khóa." });
    }
    return res.json({ updated: result.affectedRows });
  } catch (err) {
    console.error("[keywords/patch]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/keywords/:id ─────────────────────────────────────────────── */
router.delete("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: "id không hợp lệ." });

  try {
    const [result] = await pool.execute(
      "DELETE FROM learned_keywords WHERE id = ?",
      [id]
    );
    return res.json({ deleted: result.affectedRows });
  } catch (err) {
    console.error("[keywords/delete]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapKeyword(r) {
  return {
    id: r.id,
    keyword: r.keyword,
    type: r.type,
    addedBy: r.added_by,
    enabled: !!r.enabled,
    createdAt: r.created_at,
  };
}

export default router;
