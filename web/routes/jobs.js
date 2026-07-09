/**
 * routes/jobs.js — Hàng đợi tự động hoá (đăng bài / bình luận / nhắn tin) theo
 * TÀI KHOẢN người dùng.
 *
 * Trước đây là chrome.storage.local "localJobs" phía extension (giới hạn ~10MB
 * toàn thiết bị, dễ tràn khi kèm nhiều ảnh base64, và KHÔNG đồng bộ giữa máy).
 * Nay mỗi job MỘT DÒNG trong bảng `jobs`, cô lập theo user_id.
 *
 * Client (src/db.js) gọi các endpoint này và GIỮ NGUYÊN tên hàm + hình dạng bản
 * ghi trả về nên crawl.js / background.js không phải đổi gì:
 *
 *   POST   /api/jobs                       { job }   → record
 *   POST   /api/jobs/batch                 { jobs }  → record[]
 *   GET    /api/jobs?type=                            → record[] (mới nhất trước)
 *   GET    /api/jobs/due?now=                         → record[] (pending tới hạn)
 *   GET    /api/jobs/message-count-today?now=         → { count }
 *   GET    /api/jobs/live-message?authorProfile=      → { job } | { job: null }
 *   PATCH  /api/jobs/:id                   { patch } → record | 404
 *   POST   /api/jobs/recover-stuck         { now }   → { changed }
 *   POST   /api/jobs/clear-finished                   → { deleted }
 *   POST   /api/jobs/clear-all                        → { deleted }
 *   DELETE /api/jobs/:id                              → { ok, deleted }
 *
 * Giữ nguyên các hằng số an toàn từ client cũ.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

// Một job "running" lâu hơn ngưỡng này coi là KẸT (client MV3 bị tắt giữa chừng).
const STUCK_RUNNING_MS = 3 * 60 * 1000; // 3 phút
// Số lần thử tối đa trước khi đánh "error" (tránh lặp vô hạn / đăng trùng mãi).
const MAX_JOB_ATTEMPTS = 3;
// Trần số tin nhắn chào hàng mỗi ngày (theo ngày địa phương của client -> client
// truyền `now` để tính mốc 00:00). Cố tình để thấp cho an toàn.
const MESSAGE_DAILY_CAP = 15;

/** Parse cột JSON (mysql2 có thể trả object hoặc chuỗi). */
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return null;
  }
}

/** Row DB → bản ghi client (data JSON là nguồn chính, overlay id/cột điều phối). */
function rowToRecord(row) {
  const data = parseJson(row.data) || {};
  return {
    ...data,
    id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    scheduledAt: row.scheduled_at != null ? Number(row.scheduled_at) : data.scheduledAt ?? null,
    createdAt: row.created_at != null ? Number(row.created_at) : data.createdAt ?? null,
    updatedAt: row.updated_at != null ? Number(row.updated_at) : data.updatedAt ?? null,
  };
}

/** Chèn một job (dùng cho create + createBatch). Trả về bản ghi đã lưu. */
async function insertJob(userId, job) {
  const j = job || {};
  const now = Date.now();
  const record = {
    type: "post",
    status: "pending",
    attempts: 0,
    result: null,
    error: null,
    createdAt: now,
    scheduledAt: j.scheduledAt || now,
    ...j,
  };
  // id do DB cấp (AUTO_INCREMENT) — bỏ id do caller truyền để không ghi đè PK.
  delete record.id;
  const [r] = await pool.execute(
    `INSERT INTO jobs (user_id, type, status, attempts, scheduled_at, created_at, updated_at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
    [
      userId,
      String(record.type || "post"),
      String(record.status || "pending"),
      Number(record.attempts || 0),
      record.scheduledAt != null ? Number(record.scheduledAt) : null,
      record.createdAt != null ? Number(record.createdAt) : now,
      null,
      JSON.stringify(record),
    ]
  );
  return { ...record, id: r.insertId };
}

/* ── POST /api/jobs — tạo một job ─────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  try {
    const record = await insertJob(req.userId, req.body && req.body.job);
    return res.json(record);
  } catch (err) {
    console.error("[jobs POST]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/jobs/batch — tạo nhiều job ─────────────────────────────────── */
router.post("/batch", requireAuth, async (req, res) => {
  const jobs = Array.isArray(req.body && req.body.jobs) ? req.body.jobs : [];
  try {
    const out = [];
    for (const j of jobs) out.push(await insertJob(req.userId, j));
    return res.json(out);
  } catch (err) {
    console.error("[jobs POST batch]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/jobs?type= — danh sách, mới nhất trước ──────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const type = req.query.type ? String(req.query.type) : null;
  try {
    let sql = "SELECT * FROM jobs WHERE user_id = ?";
    const params = [req.userId];
    if (type) {
      sql += " AND type = ?";
      params.push(type);
    }
    sql += " ORDER BY created_at DESC, id DESC";
    const [rows] = await pool.execute(sql, params);
    return res.json(rows.map(rowToRecord));
  } catch (err) {
    console.error("[jobs GET]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/jobs/due?now= — pending tới hạn, sớm nhất trước ─────────────── */
router.get("/due", requireAuth, async (req, res) => {
  const now = parseInt(req.query.now, 10) || Date.now();
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM jobs
        WHERE user_id = ? AND status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= ?)
        ORDER BY scheduled_at ASC, id ASC`,
      [req.userId, now]
    );
    return res.json(rows.map(rowToRecord));
  } catch (err) {
    console.error("[jobs GET due]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/jobs/message-count-today?now= ───────────────────────────────── */
router.get("/message-count-today", requireAuth, async (req, res) => {
  const now = parseInt(req.query.now, 10) || Date.now();
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const from = d.getTime();
  try {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM jobs
        WHERE user_id = ? AND type = 'message' AND status <> 'error' AND created_at >= ?`,
      [req.userId, from]
    );
    return res.json({ count: rows[0] ? Number(rows[0].c) : 0, cap: MESSAGE_DAILY_CAP });
  } catch (err) {
    console.error("[jobs GET message-count-today]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/jobs/live-message?authorProfile= — chống trùng chào hàng ────── */
router.get("/live-message", requireAuth, async (req, res) => {
  const key = String(req.query.authorProfile || "").trim();
  if (!key) return res.json({ job: null });
  try {
    const [rows] = await pool.execute(
      `SELECT * FROM jobs
        WHERE user_id = ? AND type = 'message' AND status <> 'error'
        ORDER BY id DESC`,
      [req.userId]
    );
    const match =
      rows
        .map(rowToRecord)
        .find((j) => String((j.meta && j.meta.authorProfile) || "").trim() === key) || null;
    return res.json({ job: match });
  } catch (err) {
    console.error("[jobs GET live-message]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/jobs/:id — gộp patch vào job ──────────────────────────────── */
router.patch("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const patch = (req.body && req.body.patch) || {};
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM jobs WHERE id = ? AND user_id = ?",
      [id, req.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Không tìm thấy job." });
    const current = rowToRecord(rows[0]);
    // Pin id cuối để patch { id } không đổi được khoá chính (đối xứng client cũ).
    const merged = { ...current, ...patch, updatedAt: Date.now(), id: current.id };
    await pool.execute(
      `UPDATE jobs
          SET type = ?, status = ?, attempts = ?, scheduled_at = ?, updated_at = ?, data = CAST(? AS JSON)
        WHERE id = ? AND user_id = ?`,
      [
        String(merged.type || "post"),
        String(merged.status || "pending"),
        Number(merged.attempts || 0),
        merged.scheduledAt != null ? Number(merged.scheduledAt) : null,
        Number(merged.updatedAt),
        JSON.stringify(merged),
        id,
        req.userId,
      ]
    );
    return res.json(merged);
  } catch (err) {
    console.error("[jobs PATCH]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/jobs/recover-stuck — đưa job "running" kẹt về pending/error ── */
router.post("/recover-stuck", requireAuth, async (req, res) => {
  const now = parseInt(req.body && req.body.now, 10) || Date.now();
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM jobs WHERE user_id = ? AND status = 'running'",
      [req.userId]
    );
    let changed = 0;
    for (const row of rows) {
      const j = rowToRecord(row);
      const last = j.updatedAt || j.createdAt || 0;
      if (now - last <= STUCK_RUNNING_MS) continue; // còn chạy hợp lệ
      if ((j.attempts || 0) >= MAX_JOB_ATTEMPTS) {
        j.status = "error";
        j.error = "Bị gián đoạn nhiều lần (client tắt giữa chừng).";
      } else {
        j.status = "pending"; // thử lại ở tick sau
      }
      j.updatedAt = now;
      await pool.execute(
        `UPDATE jobs SET status = ?, updated_at = ?, data = CAST(? AS JSON) WHERE id = ? AND user_id = ?`,
        [j.status, now, JSON.stringify(j), j.id, req.userId]
      );
      changed++;
    }
    return res.json({ changed });
  } catch (err) {
    console.error("[jobs POST recover-stuck]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/jobs/clear-finished — xoá job done/error ───────────────────── */
router.post("/clear-finished", requireAuth, async (req, res) => {
  try {
    const [r] = await pool.execute(
      "DELETE FROM jobs WHERE user_id = ? AND status IN ('done','error')",
      [req.userId]
    );
    return res.json({ deleted: r.affectedRows || 0 });
  } catch (err) {
    console.error("[jobs POST clear-finished]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── POST /api/jobs/clear-all — xoá toàn bộ job ───────────────────────────── */
router.post("/clear-all", requireAuth, async (req, res) => {
  try {
    const [r] = await pool.execute("DELETE FROM jobs WHERE user_id = ?", [req.userId]);
    return res.json({ deleted: r.affectedRows || 0 });
  } catch (err) {
    console.error("[jobs POST clear-all]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/jobs/:id ─────────────────────────────────────────────────── */
router.delete("/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const [r] = await pool.execute(
      "DELETE FROM jobs WHERE id = ? AND user_id = ?",
      [id, req.userId]
    );
    return res.json({ ok: true, deleted: r.affectedRows || 0 });
  } catch (err) {
    console.error("[jobs DELETE]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

export default router;
