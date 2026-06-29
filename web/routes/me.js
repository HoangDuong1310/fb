/**
 * routes/me.js — Authenticated user's own settings.
 *
 *   GET   /api/me/share-prefs              → { shareCrawledDefault, shareCommentedDefault, shareGroupPricesDefault }
 *   PATCH /api/me/share-prefs  { patch }  → same shape (updated values)
 *
 * When a pref is changed, the cascade update propagates to existing rows so
 * future reads reflect the new default immediately.
 *
 * Cascade rules:
 *   shareCrawledDefault      → UPDATE posts      SET share_crawled       WHERE crawled_by_user_id = userId
 *   shareCommentedDefault    → UPDATE comments   SET share_commented     WHERE user_id = userId
 *   shareGroupPricesDefault  → UPDATE group_prices SET share_group_prices WHERE crawled_by_user_id = userId
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── GET /api/me/share-prefs ──────────────────────────────────────────────── */
router.get("/share-prefs", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT share_crawled_default, share_commented_default, share_group_prices_default
         FROM user_share_prefs WHERE user_id = ?`,
      [req.userId]
    );

    if (rows.length === 0) {
      // Row might be missing for very old accounts — auto-create defaults
      await pool.execute(
        "INSERT IGNORE INTO user_share_prefs (user_id) VALUES (?)",
        [req.userId]
      );
      return res.json({
        shareCrawledDefault: true,
        shareCommentedDefault: true,
        shareGroupPricesDefault: true,
      });
    }

    const r = rows[0];
    return res.json({
      shareCrawledDefault: !!r.share_crawled_default,
      shareCommentedDefault: !!r.share_commented_default,
      shareGroupPricesDefault: !!r.share_group_prices_default,
    });
  } catch (err) {
    console.error("[me/share-prefs GET]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/me/share-prefs ────────────────────────────────────────────── */
router.patch("/share-prefs", requireAuth, async (req, res) => {
  const patch = req.body || {};
  const sets = [];
  const params = [];

  // Map camelCase → column, cascade table/column
  const fieldMap = {
    shareCrawledDefault: {
      col: "share_crawled_default",
      cascade: { table: "posts", col: "share_crawled", ownerCol: "crawled_by_user_id" },
    },
    shareCommentedDefault: {
      col: "share_commented_default",
      cascade: { table: "comments", col: "share_commented", ownerCol: "user_id" },
    },
    shareGroupPricesDefault: {
      col: "share_group_prices_default",
      cascade: { table: "group_prices", col: "share_group_prices", ownerCol: "crawled_by_user_id" },
    },
  };

  const cascades = [];

  for (const [key, meta] of Object.entries(fieldMap)) {
    if (patch[key] !== undefined) {
      const val = patch[key] ? 1 : 0;
      sets.push(`${meta.col} = ?`);
      params.push(val);
      cascades.push({ ...meta.cascade, val });
    }
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: "Không có trường nào để cập nhật." });
  }

  params.push(req.userId);

  try {
    // 1. Update prefs row (upsert in case row is missing).
    // ON DUPLICATE KEY UPDATE needs the SET values only (no userId again).
    // params already contains [val, val, ...] for the SET clause; append userId for the INSERT.
    await pool.execute(
      `INSERT INTO user_share_prefs (user_id) VALUES (?)
       ON DUPLICATE KEY UPDATE ${sets.join(", ")}`,
      [req.userId, ...params.slice(0, sets.length)]
    );

    // 2. Cascade to existing rows
    for (const c of cascades) {
      await pool.execute(
        `UPDATE \`${c.table}\` SET ${c.col} = ? WHERE ${c.ownerCol} = ?`,
        [c.val, req.userId]
      );
    }

    // 3. Return updated prefs
    const [rows] = await pool.execute(
      `SELECT share_crawled_default, share_commented_default, share_group_prices_default
         FROM user_share_prefs WHERE user_id = ?`,
      [req.userId]
    );
    const r = rows[0] || {};
    return res.json({
      shareCrawledDefault: !!r.share_crawled_default,
      shareCommentedDefault: !!r.share_commented_default,
      shareGroupPricesDefault: !!r.share_group_prices_default,
    });
  } catch (err) {
    console.error("[me/share-prefs PATCH]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

export default router;
