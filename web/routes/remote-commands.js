/**
 * routes/remote-commands.js — Remote command management endpoints.
 *
 *   POST  /api/remote-commands            { type, payload, targetUserId? } → 201 { command }
 *   GET   /api/remote-commands/pending                                      → { commands: [] }
 *   GET   /api/remote-commands            ?status&page&limit                → { commands, total }
 *   GET   /api/remote-commands/:id                                          → { command }
 *   PATCH /api/remote-commands/:id        { status, result?, error? }       → { ok: true }
 *
 * Security:
 *   - Rate limit: max 10 pending commands per user.
 *   - Auto-expire pending commands older than 1 hour (checked on GET /pending).
 *   - Command type whitelist (400 on unknown type).
 *
 * WebSocket server (/ws/commands?token=...) is set up in server.js and
 * calls broadcastCommand() exported from this module.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── Allowed command types ────────────────────────────────────────────────── */
const ALLOWED_TYPES = new Set([
  "create_post",
  "create_comment",
  "crawl_group",
  "scan_groups",
  "approve_advisory",
  "approve_conversation",
  "delete_post",
]);

const MAX_PENDING = 10;
const EXPIRE_HOURS = 1;

/* ── WebSocket broadcast registry ────────────────────────────────────────── */
// Map<userId, Set<WebSocket>>
const _wsClients = new Map();

/** Register a WebSocket connection for a user (called from server.js). */
export function registerWsClient(userId, ws) {
  if (!_wsClients.has(userId)) _wsClients.set(userId, new Set());
  _wsClients.get(userId).add(ws);
}

/** Deregister a closed WebSocket. */
export function deregisterWsClient(userId, ws) {
  const set = _wsClients.get(userId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) _wsClients.delete(userId);
  }
}

/** Push a command to all open WebSocket connections of a user. */
export function broadcastCommand(userId, command) {
  const set = _wsClients.get(userId);
  if (!set) return;
  const msg = JSON.stringify({ type: "command", command });
  for (const ws of set) {
    try {
      if (ws.readyState === 1 /* OPEN */) ws.send(msg);
    } catch (_) {
      // Best-effort; stale sockets will be cleaned up on close.
    }
  }
}

/* ── Auto-expire helper ───────────────────────────────────────────────────── */
async function expireOldCommands() {
  await pool.execute(
    `UPDATE remote_commands
     SET status = 'expired'
     WHERE status = 'pending'
       AND created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [EXPIRE_HOURS]
  );
}

/* ── POST /api/remote-commands ────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const { type, payload, targetUserId } = req.body || {};

  if (!type || !ALLOWED_TYPES.has(type)) {
    return res.status(400).json({ error: `Loại lệnh không hợp lệ: ${type}` });
  }

  // Target is the caller unless explicitly overridden
  const targetId = targetUserId ? parseInt(targetUserId, 10) : req.userId;

  try {
    // Rate limit: count pending commands for target user
    const [countRows] = await pool.execute(
      "SELECT COUNT(*) AS cnt FROM remote_commands WHERE user_id = ? AND status = 'pending'",
      [targetId]
    );
    if (countRows[0].cnt >= MAX_PENDING) {
      return res.status(429).json({
        error: `Người dùng đã có ${MAX_PENDING} lệnh đang chờ. Hãy đợi lệnh cũ hoàn thành.`,
      });
    }

    const [result] = await pool.execute(
      `INSERT INTO remote_commands (user_id, type, payload, created_by)
       VALUES (?, ?, ?, ?)`,
      [targetId, type, JSON.stringify(payload ?? {}), req.userId]
    );
    const id = Number(result.insertId);

    const [rows] = await pool.execute(
      "SELECT * FROM remote_commands WHERE id = ?",
      [id]
    );
    const command = rows.length ? mapCommand(rows[0]) : null;

    // Immediately push via WebSocket if client is connected
    if (command) broadcastCommand(targetId, command);

    return res.status(201).json({ command });
  } catch (err) {
    console.error("[remote-commands/post]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/remote-commands/pending ────────────────────────────────────── */
// Must be declared BEFORE /:id
router.get("/pending", requireAuth, async (req, res) => {
  try {
    // Auto-expire stale commands first
    await expireOldCommands();

    const [rows] = await pool.execute(
      `SELECT * FROM remote_commands
       WHERE user_id = ? AND status = 'pending'
       ORDER BY created_at ASC`,
      [req.userId]
    );
    return res.json({ commands: rows.map(mapCommand) });
  } catch (err) {
    console.error("[remote-commands/pending]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/remote-commands ─────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const { status, page = "1", limit = "20" } = req.query;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  try {
    let whereSql = "WHERE user_id = ?";
    const params = [req.userId];
    if (status) {
      whereSql += " AND status = ?";
      params.push(status);
    }

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS total FROM remote_commands ${whereSql}`,
      params
    );
    const total = Number(countRows[0].total);

    const [rows] = await pool.execute(
      `SELECT * FROM remote_commands ${whereSql} ORDER BY created_at DESC LIMIT ${limitNum} OFFSET ${offset}`,
      params
    );

    return res.json({ commands: rows.map(mapCommand), total });
  } catch (err) {
    console.error("[remote-commands/list]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/remote-commands/:id ─────────────────────────────────────────── */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      "SELECT * FROM remote_commands WHERE id = ? AND user_id = ?",
      [req.params.id, req.userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Không tìm thấy lệnh." });
    }
    return res.json({ command: mapCommand(rows[0]) });
  } catch (err) {
    console.error("[remote-commands/get-one]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── PATCH /api/remote-commands/:id ──────────────────────────────────────── */
router.patch("/:id", requireAuth, async (req, res) => {
  const { status, result, error } = req.body || {};
  const setClauses = ["updated_at = updated_at"]; // force touch to avoid empty SET
  const params = [];

  const validStatuses = new Set(["pending", "running", "completed", "failed", "expired"]);
  if (status && validStatuses.has(status)) {
    setClauses.push("status = ?");
    params.push(status);
    if (status === "running") {
      setClauses.push("started_at = COALESCE(started_at, CURRENT_TIMESTAMP)");
    }
    if (status === "completed" || status === "failed" || status === "expired") {
      setClauses.push("completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)");
    }
  }
  if (result !== undefined) {
    setClauses.push("result = ?");
    params.push(result != null ? JSON.stringify(result) : null);
  }
  if (error !== undefined) {
    setClauses.push("error = ?");
    params.push(error != null ? String(error) : null);
  }

  params.push(req.params.id, req.userId);

  try {
    await pool.execute(
      `UPDATE remote_commands SET ${setClauses.join(", ")} WHERE id = ? AND user_id = ?`,
      params
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("[remote-commands/patch]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapCommand(r) {
  return {
    id: Number(r.id),
    userId: r.user_id,
    type: r.type,
    payload: parseJson(r.payload, {}),
    status: r.status,
    result: parseJson(r.result, null),
    error: r.error,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
