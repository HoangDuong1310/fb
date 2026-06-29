/**
 * server.js — Express + WebSocket entry point.
 *
 * Startup sequence:
 *   1. Run DB migrations (CREATE TABLE IF NOT EXISTS)
 *   2. Mount all API routes under /api
 *   3. Attach WebSocket server at /ws/commands?token=...
 *   4. Listen on PORT (default 3300)
 */

import http from "http";
import { WebSocketServer } from "ws";
import express from "express";
import { runMigrations } from "./db.js";
import { verifyToken } from "./auth.js";
import { port } from "./config.js";

// Route handlers
import authRoutes from "./routes/auth.js";
import postsRoutes from "./routes/posts.js";
import groupsRoutes from "./routes/groups.js";
import productsRoutes from "./routes/products.js";
import sourcesRoutes from "./routes/sources.js";
import promptProfilesRoutes from "./routes/prompt-profiles.js";
import advisoriesRoutes from "./routes/advisories.js";
import conversationsRoutes from "./routes/conversations.js";
import remoteCommandsRoutes, {
  registerWsClient,
  deregisterWsClient,
} from "./routes/remote-commands.js";
import keywordsRoutes from "./routes/keywords.js";
import groupPricesRoutes from "./routes/group-prices.js";
import meRoutes from "./routes/me.js";

/* ── Express app ──────────────────────────────────────────────────────────── */
const app = express();

app.use(express.json({ limit: "10mb" }));

// CORS: allow extension (chrome-extension://) and local web UIs
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  // Allow chrome-extension origins and any localhost origin
  if (
    origin.startsWith("chrome-extension://") ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1")
  ) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ── API routes ───────────────────────────────────────────────────────────── */
app.use("/api/auth", authRoutes);

// Stats endpoint lives in postsRoutes but needs to be at /api/stats
// We mount it via the posts router which handles /stats internally.
app.use("/api/posts", postsRoutes);
app.use("/api/stats", (req, res, next) => {
  // Delegate to the stats sub-handler inside postsRoutes
  req.url = "/stats";
  postsRoutes(req, res, next);
});

app.use("/api/groups", groupsRoutes);
app.use("/api/products", productsRoutes);
app.use("/api/sources", sourcesRoutes);
app.use("/api/prompt-profiles", promptProfilesRoutes);
app.use("/api/advisories", advisoriesRoutes);
app.use("/api/conversations", conversationsRoutes);
app.use("/api/remote-commands", remoteCommandsRoutes);
app.use("/api/keywords", keywordsRoutes);
app.use("/api/group-prices", groupPricesRoutes);
app.use("/api/me", meRoutes);

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

/* ── 404 catch-all ────────────────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint không tồn tại." });
});

/* ── Global error handler ─────────────────────────────────────────────────── */
app.use((err, req, res, _next) => {
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Lỗi server." });
});

/* ── HTTP + WebSocket server ──────────────────────────────────────────────── */
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

// Upgrade handler: only accept /ws/commands?token=...
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://localhost`);
  if (url.pathname !== "/ws/commands") {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token");
  if (!token) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, decoded.userId);
  });
});

wss.on("connection", (ws, _req, userId) => {
  registerWsClient(userId, ws);
  console.log(`[ws] client connected userId=${userId}`);

  // Keep-alive ping every 30s
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify({ type: "pong" }));
    }
  }, 30_000);

  ws.on("close", () => {
    clearInterval(pingInterval);
    deregisterWsClient(userId, ws);
    console.log(`[ws] client disconnected userId=${userId}`);
  });

  ws.on("error", (err) => {
    console.error(`[ws] error userId=${userId}:`, err.message);
  });
});

/* ── Startup ──────────────────────────────────────────────────────────────── */
async function start() {
  try {
    await runMigrations();
    server.listen(port, () => {
      console.log(`[server] listening on http://localhost:${port}`);
    });
  } catch (err) {
    console.error("[server] startup failed:", err);
    process.exit(1);
  }
}

start();
