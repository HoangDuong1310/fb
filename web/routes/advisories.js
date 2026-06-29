/**
 * routes/advisories.js — AI advisory draft endpoints.
 *
 *   POST   /api/advisories           (full adv incl postId) → { advisory }
 *   GET    /api/advisories           ?status                → { advisories: [] }
 *   GET    /api/advisories/:postId                          → { advisory } | { advisory: null }
 *   PATCH  /api/advisories/:postId   (patch object)         → { ok: true }
 *   DELETE /api/advisories/:postId                          → { ok: true }
 *
 * Keyed by (post_id, user_id) — each user gets their own draft per post.
 * Reads return caller's own rows only (no cross-user share for advisories).
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/advisories ─────────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const adv = req.body || {};
  const postId = adv.postId;
  if (!postId) {
    return res.status(400).json({ error: "Thiếu postId." });
  }
  try {
    await pool.execute(
      `INSERT INTO advisories
         (post_id, user_id, status, draft, used_products, needs_human_check, check_note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status             = VALUES(status),
         draft              = VALUES(draft),
         used_products      = VALUES(used_products),
         needs_human_check  = VALUES(needs_human_check),
         check_note         = VALUES(check_note),
         updated_at         = CURRENT_TIMESTAMP`,
      [
        String(postId),
        req.userId,
        String(adv.status || "draft"),
        adv.draft != null ? String(adv.draft) : null,
        adv.usedProducts != null ? JSON.stringify(adv.usedProducts) : null,
        adv.needsHumanCheck ? 1 : 0,
        adv.checkNote != null ? String(adv.checkNote) : null,
      ]
    );
    // Fetch back the saved row
    const [rows] = await pool.execute(
      "SELECT * FROM advisories WHERE post_id = ? AND user_id = ?",
      [String(postId), req.userId]
    );
    return res.json({ advisory: rows.length ? mapAdvisory(rows[0]) : null });
  } catch (err) {
    console.error("[advisories/post]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/advisories ──────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    let sql = "SELECT * FROM advisories WHERE user_id = ?";
    const params = [req.userId];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY updated_at DESC";
    const [rows] = await pool.execute(sql, params);
    return res.json({ advisories: rows.map(mapAdvisory) });
  } catch (err) {
    console.error("[advisories/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/advisories/:postId ──────────────────────────────────────────── */
router.get("/:postId", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM advisories WHERE post_id = ? AND user_id = ?",
      [req.params.postId, req.userId]
    );
    return res.json({ advisory: rows.length ? mapAdvisory(rows[0]) : null });
  } catch (err) {
    console.error("[advisories/get-one]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/advisories/:postId ───────────────────────────────────────── */
router.patch("/:postId", requireAuth, async (req, res) => {
  const patch = req.body || {};
  const setClauses = [];
  const params = [];

  if (patch.status !== undefined) { setClauses.push("status = ?"); params.push(String(patch.status)); }
  if (patch.draft !== undefined) { setClauses.push("draft = ?"); params.push(patch.draft != null ? String(patch.draft) : null); }
  if (patch.usedProducts !== undefined) { setClauses.push("used_products = ?"); params.push(JSON.stringify(patch.usedProducts)); }
  if (patch.needsHumanCheck !== undefined) { setClauses.push("needs_human_check = ?"); params.push(patch.needsHumanCheck ? 1 : 0); }
  if (patch.checkNote !== undefined) { setClauses.push("check_note = ?"); params.push(patch.checkNote != null ? String(patch.checkNote) : null); }

  if (setClauses.length === 0) return res.json({ ok: true });

  setClauses.push("updated_at = CURRENT_TIMESTAMP");
  params.push(req.params.postId, req.userId);

  try {
    await pool.execute(
      `UPDATE advisories SET ${setClauses.join(", ")} WHERE post_id = ? AND user_id = ?`,
      params
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[advisories/patch]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/advisories/:postId ──────────────────────────────────────── */
router.delete("/:postId", requireAuth, async (req, res) => {
  try {
    await pool.execute(
      "DELETE FROM advisories WHERE post_id = ? AND user_id = ?",
      [req.params.postId, req.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[advisories/delete]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapAdvisory(r) {
  return {
    id: Number(r.id),
    postId: r.post_id,
    userId: r.user_id,
    status: r.status,
    draft: r.draft,
    usedProducts: parseJson(r.used_products, []),
    needsHumanCheck: !!r.needs_human_check,
    checkNote: r.check_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
