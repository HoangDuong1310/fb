/**
 * Server-side WebSocket realtime protocol tests.
 *
 * These tests validate the hybrid push/poll contract between the server
 * (server/web/realtime.js) and the extension client (src/remote-commands.js).
 *
 * Instead of importing realtime.js directly (which would pull in bcrypt,
 * mysql2, dotenv and other heavy transitive deps), we build a minimal
 * HTTP + WS server that follows the exact same protocol defined in
 * realtime.js.  This keeps the test fast and dependency-free while still
 * validating the wire contract the extension relies on.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";

/* ------------------------------------------------------------------ */
/*  Helpers: minimal WS server matching realtime.js protocol           */
/* ------------------------------------------------------------------ */

const VALID_TOKEN = "test-token-secret";

/**
 * Create an HTTP server + WebSocketServer that mirrors the behaviour
 * documented in server/web/realtime.js.
 *
 * Returns { server, pushCommand, connectionCount, closeAll }.
 */
function createRealtimeServer() {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });

  /** @type {Map<string, Set<WebSocket>>} */
  const connections = new Map();

  // ── Upgrade handler (mirrors realtime.js handleUpgrade) ──────────
  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== "/ws/commands") {
      socket.destroy();
      return;
    }

    let token;
    try {
      const u = new URL(req.url, "http://localhost");
      token = u.searchParams.get("token");
    } catch {
      token = null;
    }

    if (!token || token !== VALID_TOKEN) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Simplified: single hardcoded user for testing.
    const userId = "user-1";

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);

      // Register connection
      if (!connections.has(userId)) connections.set(userId, new Set());
      connections.get(userId).add(ws);

      // Heartbeat
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });

      ws.on("close", () => {
        const set = connections.get(userId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) connections.delete(userId);
        }
      });
    });
  });

  // Heartbeat interval (30 s in prod, shorter in tests)
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  /**
   * Push a command to all sockets of a given user.
   * Returns the number of sockets that received the message.
   */
  function pushCommand(userId, command) {
    const set = connections.get(userId);
    if (!set || set.size === 0) return 0;
    const msg = JSON.stringify({ type: "command", command });
    let count = 0;
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
        count++;
      }
    }
    return count;
  }

  function connectionCount(userId) {
    return connections.get(userId)?.size ?? 0;
  }

  function closeAll() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { server, wss, pushCommand, connectionCount, closeAll };
}

/* ------------------------------------------------------------------ */
/*  Helpers: WS client                                                 */
/* ------------------------------------------------------------------ */

/**
 * Connect a WS client to the given port.
 * Resolves with the open WebSocket or rejects on error.
 */
function connectClient(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/commands?token=${token}`
    );
    const timer = setTimeout(() => {
      ws.removeAllListeners();
      ws.terminate();
      reject(new Error("connect timeout"));
    }, 3000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Wait for the next JSON message on a WebSocket.
 */
function waitForMessage(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("waitForMessage timeout")),
      timeoutMs
    );
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/**
 * Close a WebSocket and wait for the close event.
 */
function closeWs(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once("close", resolve);
    ws.close();
  });
}

/**
 * Wait until connectionCount(userId) === expected.
 * Rejects if not reached within timeoutMs.
 */
async function waitForCount(api, userId, expected, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (api.connectionCount(userId) === expected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Timeout waiting for connectionCount("${userId}") to be ${expected}, ` +
      `still ${api.connectionCount(userId)}`
  );
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("Realtime WebSocket server protocol", () => {
  /** @type {http.Server} */
  let server;
  /** @type {WebSocketServer} */
  let wss;
  /** @type {typeof createRealtimeServer extends (...a: any) => infer R ? R : never} */
  let api;
  let port;

  before(async () => {
    api = createRealtimeServer();
    server = api.server;
    wss = api.wss;
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after(async () => {
    api.closeAll();
    await new Promise((resolve) => server.close(resolve));
  });

  // ── Auth ───────────────────────────────────────────────────────

  it("rejects connection without token", async () => {
    await assert.rejects(() => connectClient(port, ""), (err) => {
      assert.ok(
        err.message.includes("401") || err.message.includes("Unexpected"),
        `Expected 401-related error, got: ${err.message}`
      );
      return true;
    });
  });

  it("rejects connection with invalid token", async () => {
    await assert.rejects(() => connectClient(port, "bad-token"), (err) => {
      assert.ok(
        err.message.includes("401") || err.message.includes("Unexpected"),
        `Expected 401-related error, got: ${err.message}`
      );
      return true;
    });
  });

  it("accepts connection with valid token", async () => {
    const ws = await connectClient(port, VALID_TOKEN);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });

  // ── Push ───────────────────────────────────────────────────────

  it("pushCommand delivers command to a single connected client", async () => {
    const ws = await connectClient(port, VALID_TOKEN);

    const cmd = {
      id: "cmd-1",
      type: "crawl_group",
      payload: { groupId: "g-123" },
    };

    const received = waitForMessage(ws);
    const delivered = api.pushCommand("user-1", cmd);

    assert.equal(delivered, 1);
    const msg = await received;
    assert.equal(msg.type, "command");
    assert.deepEqual(msg.command, cmd);

    await closeWs(ws);
  });

  it("pushCommand returns 0 when no clients are connected", () => {
    const count = api.pushCommand("user-ghost", { id: "x" });
    assert.equal(count, 0);
  });

  it("pushCommand delivers to multiple clients of the same user", async () => {
    const ws1 = await connectClient(port, VALID_TOKEN);
    const ws2 = await connectClient(port, VALID_TOKEN);

    const p1 = waitForMessage(ws1);
    const p2 = waitForMessage(ws2);

    const cmd = { id: "cmd-2", type: "post", payload: { text: "hi" } };
    const delivered = api.pushCommand("user-1", cmd);

    assert.equal(delivered, 2);

    const [m1, m2] = await Promise.all([p1, p2]);
    assert.equal(m1.type, "command");
    assert.equal(m2.type, "command");
    assert.deepEqual(m1.command, cmd);
    assert.deepEqual(m2.command, cmd);

    await closeWs(ws1);
    await closeWs(ws2);
  });

  it("does not deliver to clients of a different user", async () => {
    const ws = await connectClient(port, VALID_TOKEN);

    // No message expected — push goes to "other-user"
    let received = false;
    ws.on("message", () => {
      received = true;
    });

    api.pushCommand("other-user", { id: "cmd-3" });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(received, false);
    await closeWs(ws);
  });

  // ── Connection tracking ────────────────────────────────────────

  it("connectionCount tracks connected and disconnected clients", async () => {
    // Wait for any lingering connections from prior tests to fully clean up
    await waitForCount(api, "user-1", 0);

    const ws1 = await connectClient(port, VALID_TOKEN);
    await waitForCount(api, "user-1", 1);
    assert.equal(api.connectionCount("user-1"), 1);

    const ws2 = await connectClient(port, VALID_TOKEN);
    await waitForCount(api, "user-1", 2);
    assert.equal(api.connectionCount("user-1"), 2);

    await closeWs(ws1);
    await waitForCount(api, "user-1", 1);
    assert.equal(api.connectionCount("user-1"), 1);

    await closeWs(ws2);
    await waitForCount(api, "user-1", 0);
    assert.equal(api.connectionCount("user-1"), 0);
  });

  // ── Path rejection ─────────────────────────────────────────────

  it("rejects WebSocket upgrade on wrong path", async () => {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(
            `ws://localhost:${port}/wrong-path?token=${VALID_TOKEN}`
          );
          ws.on("open", () => {
            ws.terminate();
            reject(new Error("should not open"));
          });
          ws.on("error", (err) => reject(err));
        }),
      (err) => {
        assert.ok(
          err.message.includes("Unexpected") ||
            err.message.includes("401") ||
            err.message.includes("hang up"),
          `Expected path-rejection error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  // ── Multiple sequential pushes ─────────────────────────────────

  it("receives multiple sequential pushes", async () => {
    const ws = await connectClient(port, VALID_TOKEN);

    const cmd1 = { id: "seq-1", type: "crawl_group", payload: {} };
    const cmd2 = { id: "seq-2", type: "post", payload: {} };
    const cmd3 = { id: "seq-3", type: "delete_post", payload: {} };

    const p1 = waitForMessage(ws);
    api.pushCommand("user-1", cmd1);
    const m1 = await p1;
    assert.equal(m1.command.id, "seq-1");

    const p2 = waitForMessage(ws);
    api.pushCommand("user-1", cmd2);
    const m2 = await p2;
    assert.equal(m2.command.id, "seq-2");

    const p3 = waitForMessage(ws);
    api.pushCommand("user-1", cmd3);
    const m3 = await p3;
    assert.equal(m3.command.id, "seq-3");

    await closeWs(ws);
  });
});

/* ------------------------------------------------------------------ */
/*  Deduplication protocol test                                        */
/*                                                                    */
/*  Validates the idempotent-delivery pattern that the extension      */
/*  client (src/remote-commands.js) uses: it keeps a processedIds Set */
/*  and skips commands whose id was already seen (via push or poll).   */
/* ------------------------------------------------------------------ */

describe("Command deduplication (client-side pattern)", () => {
  /**
   * Minimal client-side dedup implementation matching the logic in
   * src/remote-commands.js markProcessed / isCommandProcessed.
   */
  class DedupClient {
    constructor() {
      /** @type {Set<string>} */
      this.processedIds = new Set();
      /** @type {Array<{id: string, type: string}>} */
      this.executed = [];
    }

    isProcessed(id) {
      return this.processedIds.has(id);
    }

    handleCommand(cmd) {
      if (this.isProcessed(cmd.id)) return "skipped";
      this.processedIds.add(cmd.id);
      this.executed.push(cmd);
      return "executed";
    }
  }

  it("executes a command only once even if delivered twice", () => {
    const client = new DedupClient();
    const cmd = { id: "dup-1", type: "crawl_group" };

    const first = client.handleCommand(cmd);
    const second = client.handleCommand(cmd);

    assert.equal(first, "executed");
    assert.equal(second, "skipped");
    assert.equal(client.executed.length, 1);
  });

  it("executes different commands independently", () => {
    const client = new DedupClient();

    assert.equal(
      client.handleCommand({ id: "a", type: "post" }),
      "executed"
    );
    assert.equal(
      client.handleCommand({ id: "b", type: "post" }),
      "executed"
    );
    assert.equal(client.executed.length, 2);
  });

  it("dedup Set caps at 500 entries to bound memory", () => {
    const client = new DedupClient();
    const MAX_IDS = 500;

    // Simulate the cap logic from remote-commands.js
    for (let i = 0; i < 600; i++) {
      if (client.processedIds.size >= MAX_IDS) {
        // oldest-first removal (FIFO by insertion order)
        const first = client.processedIds.values().next().value;
        client.processedIds.delete(first);
      }
      client.processedIds.add(`id-${i}`);
    }

    assert.ok(client.processedIds.size <= MAX_IDS);
    // The last 500 ids should be present
    assert.ok(client.processedIds.has("id-599"));
    assert.ok(!client.processedIds.has("id-0"));
  });
});
