/**
 * remote-commands.test.js — Tests for the extension-side remote-command runner
 * (src/remote-commands.js).
 *
 * Runs under plain Node via `node --test "test/*.test.js"` (NOT in an
 * extension), so there is no `chrome` global here. src/db.js falls back to an
 * in-memory job store in that case, so the create_post dispatch path runs
 * end-to-end and returns a real { jobId } without any DB mocking. We mock the
 * global `fetch` to capture every request and assert the PATCH lifecycle
 * (running -> completed | failed) the runner reports back to the server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { pollRemoteCommands, reportResult, isCommandProcessed, connectRealtime, disconnectRealtime } from "../src/remote-commands.js";
import { setBaseUrl, setToken } from "../src/api.js";

const BASE = "http://localhost:3300";

// Helper: build a minimal Response-like object the client can consume.
function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// Helper: parse a captured PATCH/POST body back into an object.
function parseBody(init) {
  if (!init || init.body == null) return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return null;
  }
}

test("reportResult issues a PATCH to /api/remote-commands/<id> with the status", async () => {
  setBaseUrl(BASE);
  setToken("tok-rc");

  let captured = null;
  global.fetch = async (url, init) => {
    captured = { url, init };
    return jsonResponse(200, { ok: true });
  };

  await reportResult("cmd-42", "running");

  assert.ok(captured, "fetch should have been called");
  assert.equal(captured.url, `${BASE}/api/remote-commands/cmd-42`);
  assert.equal(captured.init.method, "PATCH");
  assert.deepEqual(parseBody(captured.init), { status: "running" });
});

test("reportResult includes result and error fields only when provided", async () => {
  setBaseUrl(BASE);
  setToken("tok-rc");

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(200, { ok: true });
  };

  await reportResult("cmd-1", "completed", { jobId: 7 });
  await reportResult("cmd-2", "failed", null, "boom");

  assert.deepEqual(parseBody(calls[0].init), {
    status: "completed",
    result: { jobId: 7 },
  });
  // result is null -> must be omitted; error string -> must be present.
  assert.deepEqual(parseBody(calls[1].init), {
    status: "failed",
    error: "boom",
  });
});

test("pollRemoteCommands runs a create_post command: GET pending then running + completed PATCH with a jobId", async () => {
  setBaseUrl(BASE);
  setToken("tok-rc");

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, method: (init && init.method) || "GET" });
    // First call: the GET for pending commands.
    if (String(url).endsWith("/api/remote-commands/pending")) {
      return jsonResponse(200, {
        commands: [
          {
            id: "cmd-post-1",
            type: "create_post",
            payload: { content: "hello world", groupId: "g1" },
          },
        ],
      });
    }
    // Subsequent calls: the PATCH status reports.
    return jsonResponse(200, { ok: true });
  };

  await pollRemoteCommands();

  // 1 GET + 2 PATCH (running, completed).
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2, "should report running then completed");

  const patchUrl = `${BASE}/api/remote-commands/cmd-post-1`;
  assert.equal(patches[0].url, patchUrl);
  assert.equal(patches[1].url, patchUrl);

  assert.equal(parseBody(patches[0].init).status, "running");

  const done = parseBody(patches[1].init);
  assert.equal(done.status, "completed");
  assert.ok(done.result, "completed report must carry a result");
  assert.equal(typeof done.result.jobId, "number");
});

test("pollRemoteCommands on an unknown command type reports running then failed with an error", async () => {
  setBaseUrl(BASE);
  setToken("tok-rc");

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, method: (init && init.method) || "GET" });
    if (String(url).endsWith("/api/remote-commands/pending")) {
      return jsonResponse(200, {
        commands: [{ id: "cmd-bad-1", type: "no_such_type", payload: {} }],
      });
    }
    return jsonResponse(200, { ok: true });
  };

  await pollRemoteCommands();

  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2, "should report running then failed");

  assert.equal(parseBody(patches[0].init).status, "running");

  const failed = parseBody(patches[1].init);
  assert.equal(failed.status, "failed");
  assert.ok(
    typeof failed.error === "string" && failed.error.length > 0,
    "failed report must carry an error message"
  );
  assert.match(failed.error, /no_such_type/);
});

test("pollRemoteCommands does nothing when there are no pending commands", async () => {
  setBaseUrl(BASE);
  setToken("tok-rc");

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, method: (init && init.method) || "GET" });
    return jsonResponse(200, { commands: [] });
  };

  await pollRemoteCommands();

  // Only the single GET for pending; no PATCH reports.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.ok(String(calls[0].url).endsWith("/api/remote-commands/pending"));
});

// ---------------------------------------------------------------------------
// Deduplication tests
// ---------------------------------------------------------------------------

test("isCommandProcessed returns false for a new command id", () => {
  // Use a unique id that won't collide with prior tests' processed commands.
  assert.equal(isCommandProcessed("dedup-new-999"), false);
});

test("pollRemoteCommands skips a command whose id was already processed", async () => {
  setBaseUrl(BASE);
  setToken("tok-rc");

  const commands = [
    { id: "dedup-dup-1", type: "create_post", payload: { content: "first", groupId: "g1" } },
    { id: "dedup-dup-1", type: "create_post", payload: { content: "second", groupId: "g1" } },
  ];

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, method: (init && init.method) || "GET" });
    if (String(url).endsWith("/api/remote-commands/pending")) {
      return jsonResponse(200, { commands });
    }
    return jsonResponse(200, { ok: true });
  };

  await pollRemoteCommands();

  // The first command should be dispatched (running + completed = 2 PATCHes).
  // The second command with the same id should be skipped.
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 2, "only the first command should be dispatched");

  // Both patches must target the first command's id.
  const patchUrl = `${BASE}/api/remote-commands/dedup-dup-1`;
  assert.equal(patches[0].url, patchUrl);
  assert.equal(patches[1].url, patchUrl);
});

test("pollRemoteCommands processes two different command ids", async () => {
  setBaseUrl(BASE);
  setToken("tok-rc");

  const commands = [
    { id: "dedup-a-1", type: "create_post", payload: { content: "A", groupId: "g1" } },
    { id: "dedup-b-1", type: "create_post", payload: { content: "B", groupId: "g2" } },
  ];

  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init, method: (init && init.method) || "GET" });
    if (String(url).endsWith("/api/remote-commands/pending")) {
      return jsonResponse(200, { commands });
    }
    return jsonResponse(200, { ok: true });
  };

  await pollRemoteCommands();

  // Each command → 2 PATCHes (running + completed) = 4 total.
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 4, "both commands should be dispatched");

  // Verify both ids appear in PATCH urls.
  const patchUrls = patches.map((c) => c.url);
  assert.ok(patchUrls.some((u) => u.includes("dedup-a-1")), "first command patched");
  assert.ok(patchUrls.some((u) => u.includes("dedup-b-1")), "second command patched");
});

// ---------------------------------------------------------------------------
// WebSocket client tests (connectRealtime / disconnectRealtime)
// ---------------------------------------------------------------------------

test("connectRealtime creates a WebSocket with token in query string", () => {
  setBaseUrl("http://localhost:3300");
  setToken("ws-tok-42");

  // Track WebSocket constructor calls.
  const wsInstances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0; // CONNECTING
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      wsInstances.push(this);
    }
    close() {}
  }
  global.WebSocket = FakeWebSocket;

  connectRealtime();

  assert.equal(wsInstances.length, 1, "should create exactly one WebSocket");
  const wsUrl = wsInstances[0].url;
  assert.ok(wsUrl.startsWith("ws://localhost:3300/ws/commands"), "URL must point to /ws/commands");
  assert.ok(wsUrl.includes("token=ws-tok-42"), "URL must include the JWT token");

  // Clean up.
  disconnectRealtime();
  delete global.WebSocket;
});

test("connectRealtime is idempotent — calling twice does not create a second socket", () => {
  setBaseUrl("http://localhost:3300");
  setToken("ws-tok-idem");

  const wsInstances = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = 1; // OPEN — pretend connected immediately
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      wsInstances.push(this);
    }
    close() {}
  }
  global.WebSocket = FakeWebSocket;

  connectRealtime();
  connectRealtime(); // second call should be a no-op

  assert.equal(wsInstances.length, 1, "should still be only one WebSocket");

  disconnectRealtime();
  delete global.WebSocket;
});

test("disconnectRealtime closes the socket and clears reconnect timer", () => {
  setBaseUrl("http://localhost:3300");
  setToken("ws-tok-disc");

  let closed = false;
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1; // OPEN
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
    }
    close(code) { this.readyState = 3; closed = true; }
  }
  global.WebSocket = FakeWebSocket;

  connectRealtime();
  assert.equal(closed, false, "socket should still be open");

  disconnectRealtime();
  assert.equal(closed, true, "disconnectRealtime must close the socket");

  delete global.WebSocket;
});
