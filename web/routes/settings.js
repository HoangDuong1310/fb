/**
 * routes/settings.js — Cấu hình/nhỏ theo TÀI KHOẢN người dùng (key/value JSON).
 *
 * Thay cho các khoá nhỏ trước đây ở chrome.storage.local phía extension:
 *   autoCrawlConfig, autoSyncConfig, watchRepliesConfig, aiConfig, aiModelList,
 *   fbSelectors, crawlSettings, uiPrefs, deletedPriceSeedIds...
 *
 * Mỗi (user_id, key_name) một dòng, `value` là JSON tuỳ ý. Nhờ vậy cấu hình đi
 * theo người dùng và đồng bộ trên mọi thiết bị.
 *
 *   GET  /api/settings          → { [key]: value, ... } (toàn bộ của user)
 *   GET  /api/settings/:key     → { key, value } (value = null nếu chưa có)
 *   PUT  /api/settings/:key  { value }  → { key, value } (upsert)
 *   DELETE /api/settings/:key   → { ok: true }
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

// Danh sách khoá hợp lệ — chặn ghi khoá lạ (bảo vệ + tránh phình bảng).
const ALLOWED_KEYS = new Set([
  "autoCrawlConfig",
  "autoSyncConfig",
  "watchRepliesConfig",
  "aiConfig",
  "aiModelList",
  "fbSelectors",
  "crawlSettings",
  "uiPrefs",
  "deletedPriceSeedIds",
]);

/** Parse cột JSON (mysql2 có thể trả về đã-parse hoặc chuỗi tuỳ cấu hình). */
function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    return null;
  }
}

/* ── GET /api/settings — toàn bộ cấu hình của user ────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT key_name, value FROM user_settings WHERE user_id = ?",
      [req.userId]
    );
    const out = {};
    for (const r of rows) out[r.key_name] = parseJson(r.value);
    return res.json(out);
  } catch (err) {
    console.error("[settings GET]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/settings/:key ───────────────────────────────────────────────── */
router.get("/:key", requireAuth, async (req, res) => {
  const key = String(req.params.key || "");
  if (!ALLOWED_KEYS.has(key)) {
    return res.status(400).json({ error: "Khoá không hợp lệ." });
  }
  try {
    const [rows] = await pool.execute(
      "SELECT value FROM user_settings WHERE user_id = ? AND key_name = ?",
      [req.userId, key]
    );
    return res.json({ key, value: rows.length ? parseJson(rows[0].value) : null });
  } catch (err) {
    console.error("[settings GET :key]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PUT /api/settings/:key  { value } — upsert ───────────────────────────── */
router.put("/:key", requireAuth, async (req, res) => {
  const key = String(req.params.key || "");
  if (!ALLOWED_KEYS.has(key)) {
    return res.status(400).json({ error: "Khoá không hợp lệ." });
  }
  const value = req.body && "value" in req.body ? req.body.value : null;
  try {
    await pool.execute(
      `INSERT INTO user_settings (user_id, key_name, value)
       VALUES (?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [req.userId, key, JSON.stringify(value ?? null)]
    );
    return res.json({ key, value: value ?? null });
  } catch (err) {
    console.error("[settings PUT]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/settings/:key ────────────────────────────────────────────── */
router.delete("/:key", requireAuth, async (req, res) => {
  const key = String(req.params.key || "");
  if (!ALLOWED_KEYS.has(key)) {
    return res.status(400).json({ error: "Khoá không hợp lệ." });
  }
  try {
    await pool.execute(
      "DELETE FROM user_settings WHERE user_id = ? AND key_name = ?",
      [req.userId, key]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[settings DELETE]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

export default router;
