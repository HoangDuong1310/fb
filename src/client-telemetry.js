/**
 * client-telemetry.js — local, redacted, deduped client telemetry.
 *
 * No server endpoint required. Events stay in chrome.storage.local (or an
 * in-memory fallback for unit tests / non-extension contexts).
 *
 * Guarantees:
 * - Redact tokens, cookies, Authorization, JWT-like strings, long digit IDs.
 * - Dedupe identical (name + fingerprint) events within a window.
 * - Bounded retention (max events + max age).
 * - Never throws to callers (telemetry must not break automation).
 */

export const TELEMETRY_STORAGE_KEY = "clientTelemetryEvents";
export const TELEMETRY_MAX_EVENTS = 200;
export const TELEMETRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const TELEMETRY_DEDUPE_WINDOW_MS = 60 * 1000;

/** Sensitive key substrings (case-insensitive). */
const SENSITIVE_KEY_RE =
  /token|password|passwd|secret|authorization|cookie|jwt|api[_-]?key|session|bearer/i;

/** JWT-ish or long base64 blobs. */
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
/** Long digit runs that look like FB/user ids. */
const LONG_DIGIT_RE = /\b\d{10,}\b/g;
/** Bearer header values. */
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+=/]+/gi;
/** Header-like credential values embedded in diagnostic strings. */
const SENSITIVE_HEADER_RE =
  /\b(authorization|cookie)\s*(:)\s*[^\r\n]+(?:\r?\n[\t ][^\r\n]*)*/gi;
/** Common inline secret assignments found in error messages. */
const INLINE_SECRET_RE =
  /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|password)\s*([:=])\s*([^,;\s]+)/gi;
/** Strip query/hash values from URLs before telemetry leaves the client. */
const URL_DETAIL_RE = /(https?:\/\/[^\s?#]+)[?#][^\s]*/gi;

/**
 * Redact a single string value.
 * @param {string} s
 * @returns {string}
 */
export function redactString(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(JWT_RE, "[redacted-jwt]")
    .replace(SENSITIVE_HEADER_RE, "$1$2 [redacted]")
    .replace(BEARER_RE, "Bearer [redacted]")
    .replace(INLINE_SECRET_RE, "$1$2[redacted]")
    .replace(URL_DETAIL_RE, "$1")
    .replace(LONG_DIGIT_RE, "[redacted-id]");
}

/**
 * Deep-redact objects/arrays/strings. Caps depth and array length.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redactValue(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function") return "[function]";
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((v) => redactValue(v, depth + 1));
  }
  if (typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    const keys = Object.keys(value).slice(0, 40);
    for (const k of keys) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      try {
        // @ts-ignore index
        out[k] = redactValue(value[k], depth + 1);
      } catch {
        out[k] = "[unreadable]";
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Stable-ish fingerprint for dedupe (name + redacted data keys/values).
 * @param {string} name
 * @param {unknown} data
 */
export function fingerprintEvent(name, data) {
  let payload;
  try {
    payload = JSON.stringify(redactValue(data == null ? {} : data));
  } catch {
    payload = String(data);
  }
  // Keep fingerprint bounded.
  if (payload.length > 400) payload = payload.slice(0, 400);
  return String(name || "event") + "|" + payload;
}

/**
 * Prune by age and max length (newest last).
 * @param {Array<object>} events
 * @param {{ now?: number, maxEvents?: number, maxAgeMs?: number }} [opts]
 */
export function pruneEvents(events, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const maxEvents = opts.maxEvents != null ? opts.maxEvents : TELEMETRY_MAX_EVENTS;
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : TELEMETRY_MAX_AGE_MS;
  const minTs = now - maxAgeMs;
  const list = Array.isArray(events) ? events : [];
  const kept = list.filter((e) => e && typeof e.ts === "number" && e.ts >= minTs);
  if (kept.length <= maxEvents) return kept;
  return kept.slice(kept.length - maxEvents);
}

/**
 * Decide whether to accept a new event given recent history.
 * @param {Array<object>} events
 * @param {string} fp
 * @param {number} now
 * @param {number} [windowMs]
 */
export function shouldAcceptEvent(events, fp, now, windowMs = TELEMETRY_DEDUPE_WINDOW_MS) {
  if (!fp) return true;
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (!e || e.fp !== fp) continue;
    if (typeof e.ts === "number" && now - e.ts < windowMs) return false;
    // Older same fingerprint is fine (outside window).
    break;
  }
  return true;
}

/* ------------------------------ storage I/O ---------------------------- */

/** In-memory fallback used by tests / non-extension. */
let _memoryStore = [];

function hasLocalStorage() {
  return (
    typeof chrome !== "undefined" &&
    chrome.storage &&
    chrome.storage.local &&
    typeof chrome.storage.local.get === "function"
  );
}

/**
 * @returns {Promise<object[]>}
 */
export async function loadTelemetryEvents() {
  if (!hasLocalStorage()) {
    return Array.isArray(_memoryStore) ? _memoryStore.slice() : [];
  }
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(TELEMETRY_STORAGE_KEY, (r) => {
        void chrome.runtime.lastError;
        const raw = r && r[TELEMETRY_STORAGE_KEY];
        resolve(Array.isArray(raw) ? raw : []);
      });
    } catch {
      resolve([]);
    }
  });
}

/**
 * @param {object[]} events
 */
export async function saveTelemetryEvents(events) {
  const list = Array.isArray(events) ? events : [];
  _memoryStore = list;
  if (!hasLocalStorage()) return;
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [TELEMETRY_STORAGE_KEY]: list }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/**
 * Reset in-memory store (tests only).
 */
export function _resetTelemetryMemoryForTests() {
  _memoryStore = [];
}

/**
 * Record a telemetry event. Never throws.
 *
 * @param {string} name short event name, e.g. "warming.settings_deferred"
 * @param {object} [data] free-form; will be redacted
 * @param {{ level?: string, now?: number }} [opts]
 * @returns {Promise<{ ok: boolean, recorded: boolean, event?: object, reason?: string }>}
 */
export async function recordTelemetry(name, data = {}, opts = {}) {
  try {
    const now = opts.now != null ? opts.now : Date.now();
    const level = opts.level || "info";
    const safeName = String(name || "event").slice(0, 120);
    const redacted = redactValue(data && typeof data === "object" ? data : { value: data });
    const fp = fingerprintEvent(safeName, redacted);

    let events = await loadTelemetryEvents();
    events = pruneEvents(events, { now });

    if (!shouldAcceptEvent(events, fp, now)) {
      return { ok: true, recorded: false, reason: "deduped" };
    }

    const event = {
      id: now + "-" + Math.floor(Math.random() * 1e9),
      name: safeName,
      level,
      ts: now,
      fp,
      data: redacted,
    };
    events.push(event);
    events = pruneEvents(events, { now });
    await saveTelemetryEvents(events);
    return { ok: true, recorded: true, event };
  } catch (e) {
    return { ok: false, recorded: false, reason: String((e && e.message) || e) };
  }
}

/**
 * List recent events (newest last), after prune.
 * @param {{ limit?: number, now?: number }} [opts]
 */
export async function listTelemetry(opts = {}) {
  try {
    const now = opts.now != null ? opts.now : Date.now();
    let events = pruneEvents(await loadTelemetryEvents(), { now });
    const limit = Math.max(1, Math.min(500, parseInt(opts.limit, 10) || 50));
    if (events.length > limit) events = events.slice(events.length - limit);
    return { ok: true, events };
  } catch (e) {
    return { ok: false, events: [], error: String((e && e.message) || e) };
  }
}

/**
 * Clear all stored telemetry.
 */
export async function clearTelemetry() {
  try {
    await saveTelemetryEvents([]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
