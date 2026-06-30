/**
 * routes/posts.js — Post storage endpoints.
 *
 *   POST   /api/posts             { posts }           → { added, updated }
 *   GET    /api/posts/known-ids   ?groupId            → { ids: string[] }
 *   GET    /api/posts             ?groupId            → { posts: [] }
 *   GET    /api/stats                                 → { total, groups: [{groupId,groupName,count}] }
 *   PATCH  /api/posts/:id         { parsedAt?, shareCrawled? } → { updated }
 *   DELETE /api/posts             ?groupId            → { deleted }
 *
 * Share-filter: reads return caller's own rows + other users' rows where share_crawled=1.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/posts ──────────────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const posts = req.body?.posts;
  if (!Array.isArray(posts) || posts.length === 0) {
    return res.json({ added: 0, updated: 0 });
  }

  let added = 0;
  let updated = 0;

  // Fetch caller's share_crawled_default
  const [prefRows] = await pool.execute(
    "SELECT share_crawled_default FROM user_share_prefs WHERE user_id = ?",
    [req.userId]
  );
  const shareCrawled = prefRows.length > 0 ? prefRows[0].share_crawled_default : 1;

  for (const p of posts) {
    if (!p || !p.postId) continue;
    const images = p.images != null ? JSON.stringify(p.images) : null;
    const [result] = await pool.execute(
      `INSERT INTO posts
         (post_id, group_id, group_name, author_name, author_profile, \`text\`,
          images, \`timestamp\`, permalink, reactions, comments,
          crawled_by_user_id, share_crawled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         group_name         = VALUES(group_name),
         author_name        = VALUES(author_name),
         author_profile     = VALUES(author_profile),
         \`text\`           = VALUES(\`text\`),
         images             = VALUES(images),
         \`timestamp\`      = VALUES(\`timestamp\`),
         permalink          = VALUES(permalink),
         reactions          = VALUES(reactions),
         comments           = VALUES(comments),
         updated_at         = CURRENT_TIMESTAMP`,
      [
        String(p.postId),
        String(p.groupId || ""),
        String(p.groupName || ""),
        String(p.authorName || ""),
        String(p.authorProfile || ""),
        p.text != null ? String(p.text) : null,
        images,
        p.timestamp != null ? Number(p.timestamp) : null,
        String(p.permalink || ""),
        p.reactions != null ? Number(p.reactions) : null,
        p.comments != null ? Number(p.comments) : null,
        req.userId,
        shareCrawled,
      ]
    );
    if (result.affectedRows === 1) added++;
    else updated++;
  }

  return res.json({ added, updated });
});

/* ── GET /api/posts/known-ids ─────────────────────────────────────────────── */
router.get("/known-ids", requireAuth, async (req, res) => {
  const { groupId } = req.query;
  try {
    let sql = `SELECT post_id FROM posts
               WHERE (crawled_by_user_id = ? OR share_crawled = 1)`;
    const params = [req.userId];
    if (groupId) {
      sql += " AND group_id = ?";
      params.push(groupId);
    }
    const [rows] = await pool.execute(sql, params);
    return res.json({ ids: rows.map((r) => r.post_id) });
  } catch (err) {
    console.error("[posts/known-ids]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/posts ───────────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const { groupId } = req.query;
  // mine=1 → only the caller's own crawled posts (ignore shared rows)
  const mineOnly = String(req.query.mine || "") === "1";
  try {
    let sql;
    const params = [req.userId];
    if (mineOnly) {
      sql = `SELECT * FROM posts WHERE crawled_by_user_id = ?`;
    } else {
      sql = `SELECT * FROM posts
             WHERE (crawled_by_user_id = ? OR share_crawled = 1)`;
    }
    if (groupId) {
      sql += " AND group_id = ?";
      params.push(groupId);
    }
    sql += " ORDER BY crawled_at DESC";
    const [rows] = await pool.execute(sql, params);
    return res.json({ posts: rows.map(mapPost) });
  } catch (err) {
    console.error("[posts/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/stats ───────────────────────────────────────────────────────── */
router.get("/stats", requireAuth, async (req, res) => {
  try {
    const [totalRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM posts
       WHERE (crawled_by_user_id = ? OR share_crawled = 1)`,
      [req.userId]
    );
    const [groupRows] = await pool.execute(
      `SELECT group_id AS groupId, group_name AS groupName, COUNT(*) AS count
       FROM posts
       WHERE (crawled_by_user_id = ? OR share_crawled = 1)
       GROUP BY group_id, group_name
       ORDER BY count DESC`,
      [req.userId]
    );
    return res.json({
      total: totalRows[0].total,
      groups: groupRows.map((r) => ({
        groupId: r.groupId,
        groupName: r.groupName,
        count: Number(r.count),
      })),
    });
  } catch (err) {
    console.error("[posts/stats]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/posts/:id/comments ──────────────────────────────────────────── */
router.get("/:id/comments", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, post_id, user_id, content, commented_at, share_commented
         FROM comments
        WHERE post_id = ? AND (user_id = ? OR share_commented = 1)
        ORDER BY commented_at ASC`,
      [req.params.id, req.userId]
    );
    return res.json({
      comments: rows.map((r) => ({
        id: r.id,
        postId: r.post_id,
        userId: r.user_id,
        content: r.content,
        commentedAt: r.commented_at,
        shareCommented: !!r.share_commented,
      })),
    });
  } catch (err) {
    console.error("[posts/comments]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/posts/:id ─────────────────────────────────────────────────── */
router.patch("/:id", requireAuth, async (req, res) => {
  const postId = req.params.id;
  const { parsedAt, shareCrawled } = req.body || {};

  // Build dynamic SET clause — only accepted fields
  const sets = [];
  const params = [];

  if (parsedAt !== undefined) {
    // Accept ISO string or null; store as DATETIME or NULL
    if (parsedAt === null) {
      sets.push("parsed_at = NULL");
    } else {
      const d = new Date(parsedAt);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: "parsedAt không hợp lệ." });
      }
      sets.push("parsed_at = ?");
      // MySQL DATETIME: 'YYYY-MM-DD HH:MM:SS'
      params.push(d.toISOString().slice(0, 19).replace("T", " "));
    }
  }

  if (shareCrawled !== undefined) {
    sets.push("share_crawled = ?");
    params.push(shareCrawled ? 1 : 0);
  }

  if (sets.length === 0) {
    return res.status(400).json({ error: "Không có trường nào để cập nhật." });
  }

  // Only allow owner to patch their own posts
  params.push(postId, req.userId);

  try {
    const [result] = await pool.execute(
      `UPDATE posts SET ${sets.join(", ")} WHERE post_id = ? AND crawled_by_user_id = ?`,
      params
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Không tìm thấy bài hoặc không có quyền." });
    }
    return res.json({ updated: result.affectedRows });
  } catch (err) {
    console.error("[posts/patch]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/posts ────────────────────────────────────────────────────── */
router.delete("/", requireAuth, async (req, res) => {
  const { groupId } = req.query;
  try {
    let sql = "DELETE FROM posts WHERE crawled_by_user_id = ?";
    const params = [req.userId];
    if (groupId) {
      sql += " AND group_id = ?";
      params.push(groupId);
    }
    const [result] = await pool.execute(sql, params);
    return res.json({ deleted: result.affectedRows });
  } catch (err) {
    console.error("[posts/delete]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapPost(r) {
  return {
    postId: r.post_id,
    groupId: r.group_id,
    groupName: r.group_name,
    authorName: r.author_name,
    authorProfile: r.author_profile,
    text: r.text,
    images: parseJson(r.images, []),
    timestamp: r.timestamp != null ? Number(r.timestamp) : null,
    permalink: r.permalink,
    reactions: r.reactions != null ? Number(r.reactions) : null,
    comments: r.comments != null ? Number(r.comments) : null,
    crawledBy: r.crawled_by_user_id,
    crawledAt: r.crawled_at,
    updatedAt: r.updated_at,
    shareCrawled: !!r.share_crawled,
  };
}

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
