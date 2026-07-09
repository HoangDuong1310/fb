/**
 * routes/inbox.js — Hộp thư Messenger quét từ DOM, theo TÀI KHOẢN người dùng.
 *
 * Trước đây là chrome.storage.local "inboxThreads" phía extension. Nay mỗi
 * thread MỘT DÒNG trong bảng `inbox_threads` (PK user_id + thread_id), toàn bộ
 * bản ghi nằm trong `data` JSON để GIỮ NGUYÊN hình dạng phía client.
 *
 *   GET    /api/inbox                 → thread[] (mới cập nhật trước)
 *   GET    /api/inbox/:threadId       → thread | null
 *   POST   /api/inbox/upsert  { threads } → { added, updated, total }
 *   PATCH  /api/inbox/:threadId { patch } → thread | 404
 *   DELETE /api/inbox/:threadId       → { ok: true }
 *
 * Logic UPSERT (giữ draft/nháp, tên hợp lệ, tin nhắn cũ, trạng thái đọc) được
 * PORT NGUYÊN từ client cũ để hành vi không đổi.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

// Số hội thoại tối đa giữ lại mỗi user (tránh phình vô hạn).
const MAX_INBOX_THREADS = 200;
// Số tin nhắn tối đa giữ cho mỗi hội thoại.
const MAX_INBOX_MESSAGES = 60;

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return null;
  }
}

/** Chuẩn hoá + cắt bớt mảng tin nhắn của một thread. */
function normalizeMessages(list) {
  const arr = Array.isArray(list) ? list : [];
  const cleaned = arr
    .map((m) => ({
      mine: !!(m && m.mine),
      text: String((m && m.text) || "").slice(0, 8000),
      ts: m && typeof m.ts === "number" ? m.ts : null,
    }))
    .filter((m) => m.text);
  return cleaned.slice(-MAX_INBOX_MESSAGES);
}

// Nhãn UI/hệ thống chung — KHÔNG coi là tên hội thoại hợp lệ.
const isGenericName = (s) =>
  /^(đoạn chat|thông báo|notifications?|đang hoạt động|active( now)?|messenger|tin nhắn|messages?|chat|menu|trang chủ|home|marketplace)$/i.test(
    String(s || "").trim()
  );

/* ── GET /api/inbox ───────────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT data FROM inbox_threads WHERE user_id = ? ORDER BY updated_at DESC",
      [req.userId]
    );
    return res.json(rows.map((r) => parseJson(r.data)).filter(Boolean));
  } catch (err) {
    console.error("[inbox GET]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/inbox/:threadId ─────────────────────────────────────────────── */
router.get("/:threadId", requireAuth, async (req, res) => {
  const key = String(req.params.threadId || "").trim();
  if (!key) return res.json(null);
  try {
    const [rows] = await pool.execute(
      "SELECT data FROM inbox_threads WHERE user_id = ? AND thread_id = ?",
      [req.userId, key]
    );
    return res.json(rows.length ? parseJson(rows[0].data) : null);
  } catch (err) {
    console.error("[inbox GET :id]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/inbox/upsert ───────────────────────────────────────────────── */
router.post("/upsert", requireAuth, async (req, res) => {
  const incoming = Array.isArray(req.body && req.body.threads) ? req.body.threads : [];
  const now = Date.now();
  try {
    let added = 0;
    let updated = 0;
    // Nạp các bản ghi hiện có (chỉ những thread liên quan) để MERGE.
    const ids = incoming
      .map((r) => String((r && r.threadId) || "").trim())
      .filter(Boolean);
    const prevById = new Map();
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const [rows] = await pool.execute(
        `SELECT thread_id, data FROM inbox_threads WHERE user_id = ? AND thread_id IN (${placeholders})`,
        [req.userId, ...ids]
      );
      for (const r of rows) prevById.set(String(r.thread_id), parseJson(r.data) || {});
    }

    for (const raw of incoming) {
      const threadId = String((raw && raw.threadId) || "").trim();
      if (!threadId) continue;
      const prev = prevById.get(threadId);
      const hasMessages = Array.isArray(raw.messages) && raw.messages.length > 0;
      const rawName = String((raw && raw.name) || "").trim();
      const goodNewName = rawName && !isGenericName(rawName) ? rawName : "";
      const keep = (rawVal, prevKey, def) =>
        rawVal !== undefined
          ? rawVal
          : prev && prev[prevKey] !== undefined
          ? prev[prevKey]
          : def;
      const record = {
        threadId,
        name: String(goodNewName || (prev && prev.name) || "").slice(0, 200),
        threadUrl:
          String((raw && raw.threadUrl) || (prev && prev.threadUrl) || "") ||
          "https://www.facebook.com/messages/t/" + threadId,
        preview: String((raw && raw.preview) || (prev && prev.preview) || "").slice(0, 400),
        unread: raw && raw.unread != null ? !!raw.unread : !!(prev && prev.unread),
        messages: hasMessages
          ? normalizeMessages(raw.messages)
          : prev && Array.isArray(prev.messages)
          ? prev.messages
          : [],
        draft: prev && prev.draft != null ? prev.draft : null,
        lastJobId: prev ? prev.lastJobId ?? null : null,
        readAt: keep(raw && raw.readAt, "readAt", null),
        readAttempts: keep(raw && raw.readAttempts, "readAttempts", 0),
        nextReadAt: keep(raw && raw.nextReadAt, "nextReadAt", null),
        emptyReads: keep(raw && raw.emptyReads, "emptyReads", 0),
        lastReadError: keep(raw && raw.lastReadError, "lastReadError", null),
        createdAt: prev ? prev.createdAt || now : now,
        scannedAt: hasMessages ? now : prev ? prev.scannedAt ?? null : null,
        updatedAt: now,
      };
      await pool.execute(
        `INSERT INTO inbox_threads (user_id, thread_id, updated_at, data)
         VALUES (?, ?, ?, CAST(? AS JSON))
         ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at), data = VALUES(data)`,
        [req.userId, threadId, now, JSON.stringify(record)]
      );
      if (prev) updated += 1;
      else added += 1;
    }

    // Cắt bớt nếu vượt trần: xoá các thread cũ nhất theo updated_at.
    const [cntRows] = await pool.execute(
      "SELECT COUNT(*) AS c FROM inbox_threads WHERE user_id = ?",
      [req.userId]
    );
    const total = cntRows[0] ? Number(cntRows[0].c) : 0;
    if (total > MAX_INBOX_THREADS) {
      const excess = total - MAX_INBOX_THREADS;
      // MySQL không cho LIMIT trong subquery IN trực tiếp ở nhiều phiên bản, nên
      // lấy danh sách thread_id cũ nhất rồi DELETE theo id.
      const [oldRows] = await pool.query(
        "SELECT thread_id FROM inbox_threads WHERE user_id = ? ORDER BY updated_at ASC LIMIT ?",
        [req.userId, excess]
      );
      for (const r of oldRows) {
        await pool.execute(
          "DELETE FROM inbox_threads WHERE user_id = ? AND thread_id = ?",
          [req.userId, r.thread_id]
        );
      }
    }

    const kept = Math.min(total, MAX_INBOX_THREADS);
    return res.json({ added, updated, total: kept });
  } catch (err) {
    console.error("[inbox POST upsert]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/inbox/:threadId ───────────────────────────────────────────── */
router.patch("/:threadId", requireAuth, async (req, res) => {
  const key = String(req.params.threadId || "").trim();
  const patch = (req.body && req.body.patch) || {};
  if (!key) return res.status(400).json({ error: "Thiếu threadId." });
  try {
    const [rows] = await pool.execute(
      "SELECT data FROM inbox_threads WHERE user_id = ? AND thread_id = ?",
      [req.userId, key]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy hội thoại." });
    const current = parseJson(rows[0].data) || {};
    const merged = { ...current, ...patch, updatedAt: Date.now(), threadId: key };
    if (patch && patch.messages) merged.messages = normalizeMessages(patch.messages);
    await pool.execute(
      `UPDATE inbox_threads SET updated_at = ?, data = CAST(? AS JSON) WHERE user_id = ? AND thread_id = ?`,
      [merged.updatedAt, JSON.stringify(merged), req.userId, key]
    );
    return res.json(merged);
  } catch (err) {
    console.error("[inbox PATCH]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/inbox/:threadId ──────────────────────────────────────────── */
router.delete("/:threadId", requireAuth, async (req, res) => {
  const key = String(req.params.threadId || "").trim();
  try {
    await pool.execute(
      "DELETE FROM inbox_threads WHERE user_id = ? AND thread_id = ?",
      [req.userId, key]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[inbox DELETE]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

export default router;
