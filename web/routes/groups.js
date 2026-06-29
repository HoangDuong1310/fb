/**
 * routes/groups.js — Group registry endpoints.
 *
 *   POST   /api/groups          { groups }  → { added, updated }
 *   GET    /api/groups                      → { groups: [] }   (each with postCount)
 *   DELETE /api/groups/:groupId             → { ok: true }
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/groups ─────────────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const groups = req.body?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    return res.json({ added: 0, updated: 0 });
  }

  let added = 0;
  let updated = 0;

  for (const g of groups) {
    if (!g || !g.groupId) continue;
    const [result] = await pool.execute(
      `INSERT INTO \`groups\` (group_id, group_name, saved_by_user_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         group_name       = VALUES(group_name),
         saved_by_user_id = saved_by_user_id`,
      [String(g.groupId), String(g.groupName || ""), req.userId]
    );
    if (result.affectedRows === 1) added++;
    else updated++;
  }

  return res.json({ added, updated });
});

/* ── GET /api/groups ──────────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT g.group_id, g.group_name, g.saved_by_user_id, g.created_at, g.updated_at,
              COUNT(p.post_id) AS post_count
       FROM \`groups\` g
       LEFT JOIN posts p ON p.group_id = g.group_id
         AND (p.crawled_by_user_id = ? OR p.share_crawled = 1)
       GROUP BY g.group_id
       ORDER BY g.group_name`,
      [req.userId]
    );
    return res.json({
      groups: rows.map((r) => ({
        groupId: r.group_id,
        groupName: r.group_name,
        savedByUserId: r.saved_by_user_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        postCount: Number(r.post_count),
      })),
    });
  } catch (err) {
    console.error("[groups/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/groups/:groupId ──────────────────────────────────────────── */
router.delete("/:groupId", requireAuth, async (req, res) => {
  try {
    await pool.execute("DELETE FROM `groups` WHERE group_id = ?", [
      req.params.groupId,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[groups/delete]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

export default router;
