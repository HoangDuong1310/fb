/**
 * routes/posted-groups.js — Lịch sử đăng bài theo TÀI KHOẢN FACEBOOK, cô lập
 * theo user web (JWT).
 *
 * Trước đây là chrome.storage.local "postedGroups" (map theo FB account id).
 * GIỮ NGUYÊN ngữ nghĩa: một reseller có thể chạy nhiều nick FB nên lịch sử tách
 * theo `fbAccountId` (mặc định "_local" khi chưa xác định nick).
 *
 *   POST /api/posted-groups/record  { fbAccountId, groups }  → PostedGroup[]
 *   GET  /api/posted-groups?fbAccountId=&limit=              → { recent, frequent }
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

// Số nhóm tối đa giữ lại cho mỗi (user, nick FB).
const MAX_POSTED_GROUPS = 100;

function fbKey(v) {
  const s = String(v == null ? "" : v).trim();
  return s || "_local";
}

function rowToItem(r) {
  return {
    groupId: String(r.group_id),
    groupName: r.group_name || String(r.group_id),
    count: Number(r.post_count) || 0,
    lastPostedAt: r.last_posted_at != null ? Number(r.last_posted_at) : null,
  };
}

/* ── POST /api/posted-groups/record ───────────────────────────────────────── */
router.post("/record", requireAuth, async (req, res) => {
  const fbAccountId = fbKey(req.body && req.body.fbAccountId);
  const groups = Array.isArray(req.body && req.body.groups) ? req.body.groups : [];
  const now = Date.now();
  try {
    for (const g of groups) {
      const groupId = g && g.groupId != null ? String(g.groupId) : "";
      if (!groupId) continue;
      const groupName = (g && g.groupName) || groupId;
      await pool.execute(
        `INSERT INTO posted_groups (user_id, fb_account_id, group_id, group_name, post_count, last_posted_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE
           post_count = post_count + 1,
           group_name = VALUES(group_name),
           last_posted_at = VALUES(last_posted_at)`,
        [req.userId, fbAccountId, groupId, groupName, now]
      );
    }

    // Cắt bớt nếu vượt trần: giữ các nhóm đăng gần nhất.
    const [cntRows] = await pool.execute(
      "SELECT COUNT(*) AS c FROM posted_groups WHERE user_id = ? AND fb_account_id = ?",
      [req.userId, fbAccountId]
    );
    const total = cntRows[0] ? Number(cntRows[0].c) : 0;
    if (total > MAX_POSTED_GROUPS) {
      const excess = total - MAX_POSTED_GROUPS;
      const [oldRows] = await pool.query(
        `SELECT group_id FROM posted_groups
          WHERE user_id = ? AND fb_account_id = ?
          ORDER BY last_posted_at ASC LIMIT ?`,
        [req.userId, fbAccountId, excess]
      );
      for (const r of oldRows) {
        await pool.execute(
          "DELETE FROM posted_groups WHERE user_id = ? AND fb_account_id = ? AND group_id = ?",
          [req.userId, fbAccountId, r.group_id]
        );
      }
    }

    const [rows] = await pool.execute(
      `SELECT * FROM posted_groups WHERE user_id = ? AND fb_account_id = ?
        ORDER BY last_posted_at DESC`,
      [req.userId, fbAccountId]
    );
    return res.json(rows.map(rowToItem));
  } catch (err) {
    console.error("[posted-groups POST record]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/posted-groups?fbAccountId=&limit= ───────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const fbAccountId = fbKey(req.query.fbAccountId);
  const limit =
    Number.isFinite(parseInt(req.query.limit, 10)) && parseInt(req.query.limit, 10) > 0
      ? parseInt(req.query.limit, 10)
      : 10;
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM posted_groups WHERE user_id = ? AND fb_account_id = ?",
      [req.userId, fbAccountId]
    );
    const items = rows.map(rowToItem);
    const recent = items
      .slice()
      .sort((a, b) => (b.lastPostedAt || 0) - (a.lastPostedAt || 0))
      .slice(0, limit);
    const frequent = items
      .slice()
      .sort(
        (a, b) =>
          (b.count || 0) - (a.count || 0) || (b.lastPostedAt || 0) - (a.lastPostedAt || 0)
      )
      .slice(0, limit);
    return res.json({ recent, frequent });
  } catch (err) {
    console.error("[posted-groups GET]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

export default router;
