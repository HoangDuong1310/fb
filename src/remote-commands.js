/**
 * remote-commands.js
 *
 * Extension-side module that polls the web server for pending remote commands,
 * dispatches them to the appropriate handler, and reports results back.
 *
 * Lifecycle:  pending → running → completed | failed | expired
 *
 * Alarm: "cmdPoll" fires every 30 s while the service worker is alive.
 */

import { apiFetch, getBaseUrl, getToken } from "./api.js";
import * as DB from "./db.js";
import { crawlGroupInTab, scanJoinedGroups, executeDeletePost } from "./crawl.js";
import { approveAdvisory } from "./advisory.js";
import { broadcast } from "./util.js";

// ---------------------------------------------------------------------------
// Deduplication — track command IDs already processed (via WS or poll) so a
// command delivered by both channels is only executed once.
// ---------------------------------------------------------------------------

/** @type {Set<number|string>} */
const processedIds = new Set();

/** @param {number|string} id */
function markProcessed(id) {
  processedIds.add(id);
  // Cap size: keep last 500 to avoid unbounded growth.
  if (processedIds.size > 500) {
    const first = processedIds.values().next().value;
    processedIds.delete(first);
  }
}

/**
 * Returns true if the command was already handled (WS push or earlier poll).
 * @param {number|string} id
 * @returns {boolean}
 */
export function isCommandProcessed(id) {
  return processedIds.has(id);
}

// ---------------------------------------------------------------------------
// Polling (fallback — keeps running via chrome.alarms every 30 s)
// ---------------------------------------------------------------------------

/**
 * Fetch all pending commands from the server and dispatch each one.
 * Called by the "cmdPoll" alarm handler in background.js.
 */
export async function pollRemoteCommands() {
  try {
    const data = await apiFetch("/api/remote-commands/pending");
    const commands = data?.commands || data || [];
    if (!Array.isArray(commands) || commands.length === 0) return;

    // Process sequentially to avoid tab/DB contention.
    for (const cmd of commands) {
      // Skip commands already handled by the WebSocket push path.
      if (cmd.id && processedIds.has(cmd.id)) continue;
      await handleCommand(cmd);
    }
  } catch (err) {
    console.error("[remote-commands] poll error:", err);
  }
}

// ---------------------------------------------------------------------------
// Single-command handler
// ---------------------------------------------------------------------------

async function handleCommand(cmd) {
  const id = cmd.id;
  if (!id) return;

  // Deduplicate: if WS already triggered this command, skip.
  if (processedIds.has(id)) return;
  markProcessed(id);

  try {
    // Mark as running.
    await reportResult(id, "running");

    // Dispatch based on type.
    const result = await dispatchCommand(cmd);

    // Report success.
    await reportResult(id, "completed", result);
  } catch (err) {
    console.error(`[remote-commands] command ${id} failed:`, err);
    try {
      await reportResult(id, "failed", null, String(err?.message || err));
    } catch (_) {
      // Best-effort report; swallow secondary errors.
    }
  }
}

// ---------------------------------------------------------------------------
// Dispatch — maps command type → existing extension functions
// ---------------------------------------------------------------------------

/**
 * Dispatch a single command to the matching handler.
 *
 * @param {Object} cmd  Command row from the server.
 *   { id, type, payload, status, … }
 *
 * @returns {Object}  Handler-specific result (JSON-serialisable).
 */
async function dispatchCommand(cmd) {
  const { type, payload = {} } = cmd;

  switch (type) {
    // ── Post creation ──────────────────────────────────────────────
    case "create_post": {
      const job = await DB.createJob({
        type: "post",
        groupId: payload.groupId || null,
        postToProfile: !!payload.postToProfile,
        content: payload.content || "",
        images: Array.isArray(payload.images) ? payload.images : [],
        scheduledAt: Date.now(),
        meta: {
          source: "remote-command",
          commandId: cmd.id,
          ...(payload.meta || {}),
        },
      });
      return { jobId: job.id };
    }

    // ── Comment creation ──────────────────────────────────────────
    case "create_comment": {
      const job = await DB.createJob({
        type: "comment",
        targetUrl: payload.targetUrl || "",
        content: payload.content || "",
        images: Array.isArray(payload.images) ? payload.images : [],
        scheduledAt: Date.now(),
        meta: {
          source: "remote-command",
          commandId: cmd.id,
          groupId: payload.groupId || "",
          groupName: payload.groupName || "",
          ...(payload.meta || {}),
        },
      });
      return { jobId: job.id };
    }

    // ── Crawl a single group ─────────────────────────────────────
    case "crawl_group": {
      const options = {
        minDelay: payload.minDelay ?? 1500,
        maxDelay: payload.maxDelay ?? 3000,
        maxScrolls: payload.maxScrolls ?? 30,
        maxPosts: payload.maxPosts ?? 50,
        ...(payload.options || {}),
      };
      const res = await crawlGroupInTab(payload.groupId, options);
      return res;
    }

    // ── Scan all joined groups ────────────────────────────────────
    case "scan_groups": {
      const res = await scanJoinedGroups();
      return res;
    }

    // ── Approve an advisory (creates a comment job) ───────────────
    case "approve_advisory": {
      const res = await approveAdvisory(payload.postId);
      return res;
    }

    // ── Approve a conversation reply ──────────────────────────────
    case "approve_conversation": {
      const convId = payload.conversationId;
      if (!convId) throw new Error("Missing conversationId");

      const conv = await DB.getConversation(convId);
      if (!conv) throw new Error(`Conversation ${convId} not found`);

      const reply =
        (payload.reply != null
          ? String(payload.reply)
          : (conv.draft && conv.draft.reply) || ""
        ).trim();
      if (!reply) throw new Error("Empty reply, nothing to post");

      const url = conv.myCommentUrl || conv.postUrl;
      if (!url) throw new Error("Missing target URL on conversation");

      const job = await DB.createJob({
        type: "comment",
        targetUrl: url,
        content: reply,
        scheduledAt: Date.now(),
        meta: {
          postId: conv.postId || "",
          groupId: conv.groupId || "",
          groupName: conv.groupName || "",
          postText: conv.postText || "",
          source: "remote-command",
          conversationId: conv.id,
          commandId: cmd.id,
        },
      });

      await DB.updateConversation(convId, {
        status: "replied",
        lastReplyJobId: job.id,
      });

      return { jobId: job.id, conversationId: convId };
    }

    // ── Delete a post ─────────────────────────────────────────────
    case "delete_post": {
      const res = await executeDeletePost(payload.postUrl);
      return res;
    }

    // ── Unknown type ──────────────────────────────────────────────
    default:
      throw new Error(`Unknown command type: ${type}`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket real-time client
// ---------------------------------------------------------------------------
//
// Opens a WebSocket to the server for instant command delivery.  The Chrome MV3
// service worker is killed after ~30 s of idle, so the socket is opened once per
// wake and reconnects with exponential backoff on unexpected closes.  The
// existing "cmdPoll" alarm (pollRemoteCommands) remains as a fallback to cover
// edge-cases where the socket never connects (e.g. network hiccup during wake).

/** @type {WebSocket|null} */
let ws = null;

/** @type {ReturnType<typeof setTimeout>|null} */
let reconnectTimer = null;

/** Current backoff delay in ms (resets on successful open). */
let backoffMs = 0;

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Build the WebSocket URL from the current HTTP base URL + JWT token.
 * http(s)://host → ws(s)://host
 */
function buildWsUrl() {
  const base = getBaseUrl().replace(/^http/, "ws");
  const token = getToken();
  const qs = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${base}/ws/commands${qs}`;
}

/**
 * Open (or re-open) a WebSocket connection to the server.
 * Safe to call multiple times — closes any existing socket first.
 */
export function connectRealtime() {
  // If already connected (OPEN or CONNECTING), nothing to do.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  // Tear down any lingering socket.
  try { ws?.close(); } catch (_) { /* swallow */ }

  const url = buildWsUrl();
  console.log("[remote-commands] WS connecting:", url.replace(/token=[^&]+/, "token=***"));

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.warn("[remote-commands] WS constructor failed:", err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[remote-commands] WS connected");
    backoffMs = 0; // Reset backoff on success.
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return; // Ignore non-JSON frames.
    }

    // Server sends { type: "command", command: { id, type, payload, … } }
    if (msg?.type === "command" && msg.command) {
      const cmd = msg.command;
      console.log(`[remote-commands] WS received command ${cmd.id} (${cmd.type})`);
      // Fire-and-forget: process the command (handleCommand dedupes internally).
      handleCommand(cmd).catch((err) => {
        console.error("[remote-commands] WS handleCommand error:", err);
      });
    }

    // Heartbeat pong — server sends { type: "pong" }, no action needed.
  };

  ws.onclose = (ev) => {
    console.log(`[remote-commands] WS closed (code=${ev.code})`);
    ws = null;
    // Abnormal close (1006) or server-initiated → reconnect.
    if (ev.code !== 1000) {
      scheduleReconnect();
    }
  };

  ws.onerror = (err) => {
    console.warn("[remote-commands] WS error:", err);
    // onclose will fire after this — reconnect handled there.
  };
}

/**
 * Close the WebSocket cleanly (no reconnect).
 */
export function disconnectRealtime() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  backoffMs = 0;
  if (ws) {
    try { ws.close(1000); } catch (_) { /* swallow */ }
    ws = null;
  }
}

/** Schedule a reconnect with exponential backoff. */
function scheduleReconnect() {
  if (reconnectTimer) return; // Already scheduled.
  if (backoffMs === 0) backoffMs = INITIAL_BACKOFF_MS;
  else backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);

  console.log(`[remote-commands] WS reconnecting in ${backoffMs} ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRealtime();
  }, backoffMs);
}

// ---------------------------------------------------------------------------
// Report results back to the server
// ---------------------------------------------------------------------------

/**
 * Patch a remote-command record on the server.
 *
 * @param {string} id        Command ID (from the server).
 * @param {string} status    "running" | "completed" | "failed" | "expired".
 * @param {*}      [result]  JSON-serialisable result payload.
 * @param {string}  [error]  Error message (when status = "failed").
 */
export async function reportResult(id, status, result, error) {
  try {
    const body = { status };
    if (result !== undefined && result !== null) body.result = result;
    if (error) body.error = error;

    await apiFetch("/api/remote-commands/" + encodeURIComponent(id), {
      method: "PATCH",
      body: JSON.stringify(body),
    });

    // Notify dashboard so it can refresh if open.
    broadcast("REMOTE_COMMAND_UPDATED", { id, status });
  } catch (err) {
    console.warn(`[remote-commands] failed to report status for ${id}:`, err);
  }
}
