/**
 * routes/sources.js — Data-source configuration endpoints.
 *
 *   POST   /api/sources        { id, config }  → { ok: true }
 *   GET    /api/sources                        → { sources: [{ id, config, updatedAt }] }
 *   DELETE /api/sources/:id                    → { ok: true }
 *
 * Sources are shared across all users (no per-user scope).
 * The client (db.js) flattens { id, config, updatedAt } → a plain object.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/sources ────────────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const { id, config } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: "Thiếu id nguồn dữ liệu." });
  }
  try {
    await pool.execute(
      `INSERT INTO sources (id, config)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE config = VALUES(config), updated_at = CURRENT_TIMESTAMP`,
      [String(id), JSON.stringify(config ?? {})]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[sources/post]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/sources ─────────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute("SELECT * FROM sources ORDER BY id");
    return res.json({
      sources: rows.map((r) => ({
        id: r.id,
        config: parseJson(r.config, {}),
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) {
    console.error("[sources/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/sources/:id ──────────────────────────────────────────────── */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await pool.execute("DELETE FROM sources WHERE id = ?", [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[sources/delete]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
