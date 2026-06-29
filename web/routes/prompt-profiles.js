/**
 * routes/prompt-profiles.js — AI prompt profile endpoints.
 *
 *   GET    /api/prompt-profiles            → { profiles: [{ id, name, config, isActive, updatedAt }] }
 *   GET    /api/prompt-profiles/active     → { profile } | { profile: null }
 *   POST   /api/prompt-profiles            { id, name, config, isActive } → { ok: true }
 *   POST   /api/prompt-profiles/:id/activate                              → { ok: true }
 *   DELETE /api/prompt-profiles/:id                                       → { ok: true }
 *
 * Profiles are shared across all users (no per-user scope).
 * isActive is stored as a TINYINT; only one profile should be active at a time
 * (activate endpoint clears all others).
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── GET /api/prompt-profiles/active ─────────────────────────────────────── */
// Must be before /:id to avoid shadowing
router.get("/active", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM prompt_profiles WHERE is_active = 1 LIMIT 1"
    );
    if (rows.length === 0) return res.json({ profile: null });
    return res.json({ profile: mapProfile(rows[0]) });
  } catch (err) {
    console.error("[prompt-profiles/active]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/prompt-profiles ─────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM prompt_profiles ORDER BY name"
    );
    return res.json({ profiles: rows.map(mapProfile) });
  } catch (err) {
    console.error("[prompt-profiles/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/prompt-profiles ────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const { id, name, config, isActive } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: "Thiếu id hồ sơ ngành." });
  }
  try {
    await pool.execute(
      `INSERT INTO prompt_profiles (id, name, config, is_active)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name       = VALUES(name),
         config     = VALUES(config),
         is_active  = VALUES(is_active),
         updated_at = CURRENT_TIMESTAMP`,
      [
        String(id),
        String(name || id),
        JSON.stringify(config ?? {}),
        isActive ? 1 : 0,
      ]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[prompt-profiles/post]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/prompt-profiles/:id/activate ──────────────────────────────── */
router.post("/:id/activate", requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Deactivate all, then activate target
    await pool.execute("UPDATE prompt_profiles SET is_active = 0");
    await pool.execute(
      "UPDATE prompt_profiles SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[prompt-profiles/activate]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/prompt-profiles/:id ─────────────────────────────────────── */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await pool.execute("DELETE FROM prompt_profiles WHERE id = ?", [
      req.params.id,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[prompt-profiles/delete]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapProfile(r) {
  return {
    id: r.id,
    name: r.name,
    config: parseJson(r.config, {}),
    isActive: !!r.is_active,
    updatedAt: r.updated_at,
  };
}

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
