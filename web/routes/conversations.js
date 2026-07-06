/**
 * routes/conversations.js — Comment-conversation tracking endpoints.
 *
 *   POST   /api/conversations            { postId, commentPermalink, commentId, replies,
 *                                          status, postUrl, groupId, groupName,
 *                                          myComment, myCommentUrl, postText,
 *                                          draft, jobId, lastWatchedAt }   → { id }
 *   GET    /api/conversations            ?status                           → { conversations: [] }
 *   PATCH  /api/conversations/:id        (patch object)                    → { ok: true }
 *   POST   /api/conversations/:id/replies { replies }                      → { added, total }
 *   DELETE /api/conversations/:id                                          → { ok: true }
 *
 * Scoped per user — each user sees only their own conversations.
 * mergeReplies deduplicates by reply.id (or reply content hash as fallback).
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/conversations ──────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const c = req.body || {};
  try {
    const [result] = await pool.execute(
      `INSERT INTO conversations
         (post_id, user_id, comment_permalink, comment_id, replies, status,
          post_url, group_id, group_name, my_comment, my_comment_url,
          my_author_id, my_author_name, post_text, draft, job_id, last_watched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(c.postId || ""),
        req.userId,
        String(c.commentPermalink || ""),
        c.commentId != null ? String(c.commentId) : null,
        JSON.stringify(Array.isArray(c.replies) ? c.replies : []),
        String(c.status || "watching"),
        String(c.postUrl || ""),
        String(c.groupId || ""),
        String(c.groupName || ""),
        c.myComment != null ? String(c.myComment) : null,
        String(c.myCommentUrl || ""),
        c.myAuthorId != null ? String(c.myAuthorId) : null,
        c.myAuthorName != null ? String(c.myAuthorName) : null,
        c.postText != null ? String(c.postText) : null,
        c.draft != null ? String(c.draft) : null,
        c.jobId != null ? String(c.jobId) : null,
        c.lastWatchedAt != null ? Number(c.lastWatchedAt) : null,
      ]
    );
    return res.status(201).json({ id: Number(result.insertId) });
  } catch (err) {
    console.error("[conversations/post]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/conversations ───────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const { status } = req.query;
  try {
    let sql = "SELECT * FROM conversations WHERE user_id = ?";
    const params = [req.userId];
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY updated_at DESC";
    const [rows] = await pool.execute(sql, params);
    return res.json({ conversations: rows.map(mapConversation) });
  } catch (err) {
    console.error("[conversations/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/conversations/:id ────────────────────────────────────────── */
router.patch("/:id", requireAuth, async (req, res) => {
  const patch = req.body || {};
  const setClauses = [];
  const params = [];

  const fieldMap = {
    status:           ["status",            (v) => String(v)],
    postId:           ["post_id",           (v) => String(v)],
    postUrl:          ["post_url",          (v) => String(v)],
    groupId:          ["group_id",          (v) => String(v)],
    groupName:        ["group_name",        (v) => String(v)],
    commentPermalink: ["comment_permalink", (v) => String(v)],
    commentId:        ["comment_id",        (v) => v != null ? String(v) : null],
    myComment:        ["my_comment",        (v) => v != null ? String(v) : null],
    myCommentUrl:     ["my_comment_url",    (v) => String(v)],
    myAuthorId:       ["my_author_id",      (v) => v != null ? String(v) : null],
    myAuthorName:     ["my_author_name",    (v) => v != null ? String(v) : null],
    postText:         ["post_text",         (v) => v != null ? String(v) : null],
    draft:            ["draft",             (v) => v != null ? String(v) : null],
    jobId:            ["job_id",            (v) => v != null ? String(v) : null],
    lastWatchedAt:    ["last_watched_at",   (v) => v != null ? Number(v) : null],
    replies:          ["replies",           (v) => JSON.stringify(Array.isArray(v) ? v : [])],
  };

  for (const [key, [col, transform]] of Object.entries(fieldMap)) {
    if (patch[key] !== undefined) {
      setClauses.push(`${col} = ?`);
      params.push(transform(patch[key]));
    }
  }

  if (setClauses.length === 0) return res.json({ ok: true });
  setClauses.push("updated_at = CURRENT_TIMESTAMP");
  params.push(req.params.id, req.userId);

  try {
    await pool.execute(
      `UPDATE conversations SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
      params
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[conversations/patch]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/conversations/:id/replies ──────────────────────────────────── */
router.post("/:id/replies", requireAuth, async (req, res) => {
  const incoming = Array.isArray(req.body?.replies) ? req.body.replies : [];
  try {
    const [rows] = await pool.execute(
      "SELECT replies FROM conversations WHERE id = ? AND user_id = ?",
      [req.params.id, req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy hội thoại." });
    }

    const existing = parseJson(rows[0].replies, []);
    // Deduplicate: use reply.id if present, else fall back to commentId field
    const existingIds = new Set(
      existing.map((r) => r?.id ?? r?.commentId).filter(Boolean)
    );

    let added = 0;
    for (const reply of incoming) {
      const rid = reply?.id ?? reply?.commentId;
      if (rid && existingIds.has(rid)) continue;
      existing.push(reply);
      if (rid) existingIds.add(rid);
      added++;
    }

    await pool.execute(
      "UPDATE conversations SET replies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
      [JSON.stringify(existing), req.params.id, req.userId]
    );
    return res.json({ added, total: existing.length });
  } catch (err) {
    console.error("[conversations/replies]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/conversations/:id ───────────────────────────────────────── */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    await pool.execute(
      "DELETE FROM conversations WHERE id = ? AND user_id = ?",
      [req.params.id, req.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[conversations/delete]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapConversation(r) {
  return {
    id: Number(r.id),
    postId: r.post_id,
    userId: r.user_id,
    commentPermalink: r.comment_permalink,
    commentId: r.comment_id,
    replies: parseJson(r.replies, []),
    status: r.status,
    postUrl: r.post_url,
    groupId: r.group_id,
    groupName: r.group_name,
    myComment: r.my_comment,
    myCommentUrl: r.my_comment_url,
    myAuthorId: r.my_author_id,
    myAuthorName: r.my_author_name,
    postText: r.post_text,
    draft: r.draft,
    jobId: r.job_id,
    lastWatchedAt: r.last_watched_at != null ? Number(r.last_watched_at) : null,
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
