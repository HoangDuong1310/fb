# Web Backend + Group Prices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the FB Group crawler's data store from in-browser IndexedDB to a multi-user Node.js + Express + MySQL backend, add login, and extract per-seller "group prices" from already-crawled posts via a 3-tier filter→AI funnel.

**Architecture:** Option B (thin client). Crawling stays on the browser DOM; all data read/write moves to an HTTP API. `src/db.js` is rewritten as an API client preserving every public function name so `crawl.js`, `advisory.js`, and dashboard views call it unchanged. The MySQL backend (single source of truth) owns auth (JWT + bcrypt), the 11-table schema, and server-side share-filtering. Group-price extraction reads existing `posts` rows: a cheap deterministic filter (money pattern + sell-signal keyword) gates which posts reach a batched AI extractor, whose output is regex-verified against post text and which feeds new sell-signal keywords back into the filter (self-learning).

**Tech Stack:** Node.js (ESM), Express, mysql2 (promise pool), bcrypt, jsonwebtoken, dotenv; Node built-in test runner (`node --test`) + supertest for API tests; existing Chrome MV3 extension (vanilla ES modules).

---

## Source of Truth

- Design doc: [`docs/superpowers/specs/2026-06-13-web-backend-group-prices-design.md`](docs/superpowers/specs/2026-06-13-web-backend-group-prices-design.md) — authoritative for schema (section 3), funnel (section 4), comment-avoidance (section 5), auth (section 6), UI (section 7), share-filter (section 8), config (section 9), YAGNI (section 10).
- Key constraint: **group-price data is extracted from posts already crawled** ("data sẽ được lấy từ các bài viết đã crawl"), not from a separate crawl.
- `DATABASE_URL="mysql://root:@localhost:3306/<db>"` (local, empty password).

## File Structure

Backend (new, all under `web/`):
- `web/package.json` — deps + `node --test` script
- `web/.env.example` — DATABASE_URL, JWT_SECRET, JWT_EXPIRES, PORT
- `web/config.js` — env load + mysql2 pool from DATABASE_URL
- `web/schema.js` — 11-table migration run at startup
- `web/auth.js` — bcrypt hash/verify, JWT sign/verify, auth middleware (`req.userId`)
- `web/routes.js` — all data routes with API-tier share-filtering
- `web/server.js` — express app wiring (auth + data routes), startup migration
- `web/public/index.html`, `web/public/app.js` — simple read-only web dashboard (Phase G)
- `web/test/*.test.js` — API tests

Extension (modify/new):
- `src/db.js` — rewrite IndexedDB → API client (same public fn names)
- `src/api.js` (new) — low-level fetch wrapper attaching JWT + 401 handling
- `src/background.js` — hold/attach JWT, relay login/logout, 401 broadcast
- `src/popup.html` / `src/popup.js` — login form + auth state
- `src/group-prices.js` (new) — 3-tier funnel
- `src/dashboard/nav.js`, `src/dashboard.html` — register new views
- `src/dashboard/views/groupprices.js`, `keywords.js`, `sharing.js` (new) — Phase F views

## Bite-Sized Task Granularity

Each step is one of: write a failing test → run it (see it fail) → minimal implementation → run it (see it pass) → commit. No step bundles unrelated work.

---

## Task 1: Backend scaffold + config (MySQL pool)

**Files:**
- Create: `web/package.json`, `web/.env.example`, `web/config.js`
- Create (test): `web/test/config.test.js`

- [ ] Write `web/package.json` with deps and test script:
  ```json
  {
    "name": "fb-crawler-web",
    "version": "1.0.0",
    "type": "module",
    "scripts": {
      "start": "node server.js",
      "test": "node --test"
    },
    "dependencies": {
      "bcrypt": "5.1.1",
      "dotenv": "16.4.5",
      "express": "4.19.2",
      "jsonwebtoken": "9.0.2",
      "mysql2": "3.11.0"
    },
    "devDependencies": {
      "supertest": "7.0.0"
    }
  }
  ```
- [ ] Write `web/.env.example`:
  ```
  DATABASE_URL="mysql://root:@localhost:3306/fb_crawler"
  JWT_SECRET="change-me-to-a-long-random-string"
  JWT_EXPIRES="30d"
  PORT=3300
  ```
- [ ] Write failing test `web/test/config.test.js`:
  ```js
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { parseDatabaseUrl } from "../config.js";

  test("parseDatabaseUrl extracts mysql parts with empty password", () => {
    const c = parseDatabaseUrl("mysql://root:@localhost:3306/fb_crawler");
    assert.equal(c.host, "localhost");
    assert.equal(c.port, 3306);
    assert.equal(c.user, "root");
    assert.equal(c.password, "");
    assert.equal(c.database, "fb_crawler");
  });
  ```
- [ ] Run `cd web && npm install` then `npm test` — expect FAIL (parseDatabaseUrl not exported).
- [ ] Implement `web/config.js`:
  ```js
  import "dotenv/config";
  import mysql from "mysql2/promise";

  export function parseDatabaseUrl(url) {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password || ""),
      database: u.pathname.replace(/^\//, ""),
    };
  }

  export const env = {
    databaseUrl: process.env.DATABASE_URL || "mysql://root:@localhost:3306/fb_crawler",
    jwtSecret: process.env.JWT_SECRET || "dev-secret",
    jwtExpires: process.env.JWT_EXPIRES || "30d",
    port: Number(process.env.PORT || 3300),
  };

  let _pool = null;
  export function getPool() {
    if (!_pool) {
      const c = parseDatabaseUrl(env.databaseUrl);
      _pool = mysql.createPool({
        host: c.host, port: c.port, user: c.user,
        password: c.password, database: c.database,
        waitForConnections: true, connectionLimit: 10, namedPlaceholders: true,
      });
    }
    return _pool;
  }
  ```
- [ ] Run `npm test` — expect PASS.
- [ ] Commit: `feat(web): scaffold backend with config + mysql pool`.

---

## Task 2: Schema migration (11 tables)

**Files:**
- Create: `web/schema.js`
- Modify: `web/config.js` (add `ensureDatabase` to create the DB if missing)
- Create (test): `web/test/schema.test.js`

- [ ] Add `ensureDatabase()` to `web/config.js` (connects without database, runs `CREATE DATABASE IF NOT EXISTS`):
  ```js
  export async function ensureDatabase() {
    const c = parseDatabaseUrl(env.databaseUrl);
    const conn = await mysql.createConnection({
      host: c.host, port: c.port, user: c.user, password: c.password,
    });
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${c.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    await conn.end();
  }
  ```
- [ ] Write failing test `web/test/schema.test.js` (requires a reachable MySQL; skips if unreachable):
  ```js
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { ensureDatabase, getPool } from "../config.js";
  import { runMigrations } from "../schema.js";

  test("runMigrations creates all 11 tables", async (t) => {
    try { await ensureDatabase(); } catch { return t.skip("MySQL not reachable"); }
    await runMigrations();
    const [rows] = await getPool().query("SHOW TABLES");
    const names = rows.map((r) => Object.values(r)[0]);
    for (const want of [
      "users","user_share_prefs","posts","groups","comments","conversations",
      "advisories","products","group_prices","sources","learned_keywords",
    ]) assert.ok(names.includes(want), `missing table ${want}`);
    await getPool().end();
  });
  ```
- [ ] Run `npm test` — expect FAIL (runMigrations missing).
- [ ] Implement `web/schema.js` with `runMigrations()` issuing `CREATE TABLE IF NOT EXISTS` for all 11 tables per design doc section 3. Columns (authoritative):
  - `users`(id PK AI, email VARCHAR UNIQUE, password_hash VARCHAR, display_name VARCHAR, created_at DATETIME default now)
  - `user_share_prefs`(user_id PK FK→users, share_crawled_default BOOL default 1, share_commented_default BOOL default 1, share_group_prices_default BOOL default 1)
  - `posts`(post_id VARCHAR PK, group_id VARCHAR, group_name VARCHAR, author_name VARCHAR, author_profile VARCHAR, text MEDIUMTEXT, images JSON, timestamp BIGINT, permalink VARCHAR, crawled_by_user_id INT FK→users, crawled_at DATETIME, updated_at DATETIME, share_crawled BOOL default 1, parsed_at DATETIME NULL) — note `parsed_at` for funnel Tier 2
  - `groups`(group_id VARCHAR PK, group_name VARCHAR, crawled_by_user_id INT, created_at DATETIME, updated_at DATETIME)
  - `comments`(id PK AI, post_id VARCHAR FK→posts, user_id INT FK→users, content MEDIUMTEXT, commented_at DATETIME, share_commented BOOL default 1)
  - `conversations`(id PK AI, post_id VARCHAR, user_id INT, comment_permalink VARCHAR, replies JSON, status VARCHAR, created_at DATETIME, updated_at DATETIME)
  - `advisories`(id PK AI, post_id VARCHAR, user_id INT, content MEDIUMTEXT, status VARCHAR, used_products JSON, needs_human_check BOOL default 0, check_note VARCHAR, created_at DATETIME, updated_at DATETIME, UNIQUE(post_id,user_id))
  - `products`(product_id VARCHAR PK, source VARCHAR, name VARCHAR, price BIGINT, url VARCHAR, category VARCHAR, raw JSON, updated_at DATETIME)
  - `group_prices`(id PK AI, post_id VARCHAR FK→posts, name VARCHAR, price BIGINT, `condition` VARCHAR, warranty VARCHAR, category VARCHAR, seller_name VARCHAR, seller_profile VARCHAR, group_id VARCHAR, posted_at BIGINT, parsed_at DATETIME, parser VARCHAR, confidence FLOAT, crawled_by_user_id INT FK→users, share_group_prices BOOL default 1)
  - `sources`(id VARCHAR PK, config JSON, updated_at DATETIME)
  - `learned_keywords`(id PK AI, keyword VARCHAR, type VARCHAR, added_by VARCHAR, enabled BOOL default 1, created_at DATETIME, UNIQUE(keyword,type))
  - On migration, seed `user_share_prefs` defaults at user creation (handled in Task 3), and seed initial `learned_keywords` sell-signals: "bán","pass","thanh lý","ib giá","fix nhẹ","fix","cần bán","để lại","ra đi" with type='sell_signal', added_by='user'.
- [ ] Run `npm test` — expect PASS (or skip if no MySQL).
- [ ] Commit: `feat(web): mysql schema migration for 11 tables`.

---

## Task 3: Auth — bcrypt + JWT + register/login

**Files:**
- Create: `web/auth.js`
- Create (test): `web/test/auth.test.js`

- [ ] Write failing test `web/test/auth.test.js`:
  ```js
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { hashPassword, verifyPassword, signToken, verifyToken } from "../auth.js";

  test("password hash round-trips", async () => {
    const h = await hashPassword("secret123");
    assert.notEqual(h, "secret123");
    assert.equal(await verifyPassword("secret123", h), true);
    assert.equal(await verifyPassword("wrong", h), false);
  });

  test("jwt sign/verify carries userId", () => {
    const tok = signToken({ userId: 42 });
    assert.equal(verifyToken(tok).userId, 42);
  });

  test("verifyToken throws on tampered token", () => {
    assert.throws(() => verifyToken("not.a.jwt"));
  });
  ```
- [ ] Run `npm test` — expect FAIL.
- [ ] Implement `web/auth.js`:
  ```js
  import bcrypt from "bcrypt";
  import jwt from "jsonwebtoken";
  import { env } from "./config.js";

  export async function hashPassword(pw) { return bcrypt.hash(pw, 10); }
  export async function verifyPassword(pw, hash) { return bcrypt.compare(pw, hash); }
  export function signToken(payload) {
    return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpires });
  }
  export function verifyToken(token) { return jwt.verify(token, env.jwtSecret); }

  export function authRequired(req, res, next) {
    const h = req.headers.authorization || "";
    const m = h.match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: "missing token" });
    try { req.userId = verifyToken(m[1]).userId; next(); }
    catch { return res.status(401).json({ error: "invalid token" }); }
  }
  ```
- [ ] Run `npm test` — expect PASS.
- [ ] Commit: `feat(web): bcrypt + jwt auth helpers and middleware`.

---

## Task 4: Auth routes + server wiring

**Files:**
- Create: `web/server.js`
- Create: `web/routes.js` (auth routes first)
- Create (test): `web/test/auth-routes.test.js`

- [ ] Write failing test `web/test/auth-routes.test.js` (uses supertest against the express app; skips if MySQL unreachable):
  ```js
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import request from "supertest";
  import { buildApp } from "../server.js";
  import { ensureDatabase, getPool } from "../config.js";
  import { runMigrations } from "../schema.js";

  test("register then login returns a token", async (t) => {
    try { await ensureDatabase(); await runMigrations(); }
    catch { return t.skip("MySQL not reachable"); }
    const app = buildApp();
    const email = `u${Date.now()}@t.io`;
    const reg = await request(app).post("/api/auth/register")
      .send({ email, password: "secret123", displayName: "U" });
    assert.equal(reg.status, 200);
    const login = await request(app).post("/api/auth/login")
      .send({ email, password: "secret123" });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    await getPool().end();
  });
  ```
- [ ] Run `npm test` — expect FAIL.
- [ ] Implement `web/server.js` exporting `buildApp()` (express json, mounts auth + data routers) and a `start()` that calls `ensureDatabase()` + `runMigrations()` then `app.listen(env.port)`. Guard `start()` behind `if (import.meta.url === ...)` so tests can import without listening.
- [ ] Implement auth routes in `web/routes.js`:
  - `POST /api/auth/register` — validate email/password, reject duplicate email, `hashPassword`, insert user, insert `user_share_prefs` defaults (all TRUE), return `{ token, user }`.
  - `POST /api/auth/login` — look up by email, `verifyPassword`, on success `signToken({ userId })`, return `{ token, user }`; on failure 401.
- [ ] Run `npm test` — expect PASS (or skip).
- [ ] Commit: `feat(web): auth routes (register/login) + server wiring`.

---

## Task 5: Data API with share-filtering

**Files:**
- Modify: `web/routes.js` (add data routers behind `authRequired`)
- Create (test): `web/test/data-routes.test.js`

The read rule (design doc section 8): a read returns the caller's own rows (always) PLUS other users' rows where the matching share flag is TRUE. Toggling share off hides from others immediately; owner still sees; no deletion.

- [ ] Write failing test `web/test/data-routes.test.js` covering: user A saves a post with `share_crawled=true` → user B sees it; A toggles share off → B no longer sees it but A still does. Skip if MySQL unreachable.
- [ ] Run `npm test` — expect FAIL.
- [ ] Implement routers in `web/routes.js`, all using `authRequired`, mapping 1:1 to current `db.js` public functions so the client rewrite is mechanical:
  - Posts: `GET /api/posts?groupId=` (share-filtered), `GET /api/posts/known-ids?groupId=` (returns post_id list for incremental crawl), `POST /api/posts` (bulk upsert by post_id, set crawled_by_user_id=req.userId, inherit share default), `GET /api/stats`, `DELETE /api/posts?groupId=`.
  - Groups: `GET /api/groups`, `POST /api/groups` (bulk upsert), `DELETE /api/groups/:id`.
  - Comments: `GET /api/posts/:id/comments` (share-filtered for avoid-list), `POST /api/comments`.
  - Conversations: `GET /api/conversations?status=`, `POST /api/conversations`, `PATCH /api/conversations/:id`, `DELETE /api/conversations/:id`, plus replies merge endpoint.
  - Advisories: `GET /api/advisories?status=`, `GET /api/advisories/:postId` (scoped to req.userId), `POST /api/advisories` (upsert by post_id+user_id), `PATCH`, `DELETE`.
  - Products: `GET /api/products?source=`, `GET /api/products/search`, `POST /api/products` (bulk upsert, shared), `DELETE`.
  - Sources: `GET /api/sources`, `POST /api/sources`, `DELETE /api/sources/:id`.
  - Learned keywords: `GET /api/keywords`, `POST /api/keywords`, `PATCH /api/keywords/:id` (enable toggle), `DELETE /api/keywords/:id`.
  - Group prices: `GET /api/group-prices` (share-filtered, filters: groupId/category/condition/priceMin/priceMax/mineOnly), `POST /api/group-prices` (bulk insert).
  - Share prefs: `GET /api/me/share-prefs`, `PATCH /api/me/share-prefs` (3 master toggles).
- [ ] Run `npm test` — expect PASS (or skip).
- [ ] Commit: `feat(web): data API with server-side share-filtering`.

---

## Task 6: Extension API client + JWT plumbing

**Files:**
- Create: `src/api.js`
- Modify: `src/background.js`
- Create (test): `web/test/.gitkeep` not needed; client tests live in `test/api.test.js` at repo root (Node test runner)
- Create (test): `test/api-client.test.js`

- [ ] Write failing test `test/api-client.test.js` that mocks `fetch` and asserts `apiFetch` attaches `Authorization: Bearer <token>` and, on 401, calls the registered `onUnauthorized` handler. Run `node --test test/` — expect FAIL.
- [ ] Implement `src/api.js`: `setBaseUrl`, `setToken`, `getToken`, `onUnauthorized(cb)`, and `apiFetch(path, init)` that injects the bearer header, parses JSON, throws on non-2xx, and invokes the 401 handler (clears token) before throwing. Token persisted in `chrome.storage.local` (guard for non-extension test env).
- [ ] Run `node --test test/` — expect PASS.
- [ ] Modify `src/background.js`: on startup load token from storage into `api.js`; add message handlers `AUTH_LOGIN` (call `/api/auth/login`, store token), `AUTH_LOGOUT` (clear token), `AUTH_STATE` (return logged-in + display_name); register `onUnauthorized` to clear token and `broadcast("AUTH_REQUIRED")`.
- [ ] Commit: `feat(ext): api client with jwt + 401 handling, background auth handlers`.

---

## Task 7: Rewrite src/db.js as API client (preserve public names)

**Files:**
- Modify: `src/db.js` (full rewrite of internals; same exports)
- Create (test): `test/db-shim.test.js`

The whole point: `crawl.js`, `advisory.js`, `prices.js`, dashboard views call `DB.savePosts`, `DB.getAllPosts`, `DB.getKnownIds`, `DB.saveGroups`, `DB.getGroups`, `DB.createJob` (jobs stay client-local in `chrome.storage` since they're transient device state — keep job functions backed by storage, not the API), `DB.saveProducts`, `DB.searchProducts`, `DB.getSources`, `DB.saveAdvisory`, `DB.getAdvisory`, `DB.createConversation`, `DB.updateConversation`, `DB.mergeReplies`, etc. — unchanged signatures.

- [ ] Write failing test `test/db-shim.test.js` asserting `db.js` still exports every name currently exported (snapshot the export list) and that `getAllPosts` calls `apiFetch('/api/posts...')`. Run — expect FAIL.
- [ ] Implement: replace IndexedDB bodies with `apiFetch` calls to the Task 5 endpoints. Keep transient job queue functions (`createJob`, `getDueJobs`, `updateJob`, `clearFinishedJobs`) backed by `chrome.storage.local` (jobs are device-local automation state, not shared data). Map data functions to API. Preserve return shapes (e.g., `getKnownIds` returns a Set, `getStats` returns the same fields).
- [ ] Run `node --test test/` — expect PASS.
- [ ] Commit: `refactor(ext): db.js becomes API client, public API unchanged`.

---

## Task 8: Popup login UI + auth state

**Files:**
- Modify: `src/popup.html`, `src/popup.js`

- [ ] Add a login section to `src/popup.html` (email, password, "Đăng nhập" button, error line) and a logged-in header showing display_name + "Đăng xuất".
- [ ] In `src/popup.js`: on load call `AUTH_STATE`; if logged out, show login form and hide crawl controls; on submit send `AUTH_LOGIN`, on success show controls; "Đăng xuất" sends `AUTH_LOGOUT`. Listen for `AUTH_REQUIRED` broadcast → switch to login view with a "Phiên đăng nhập hết hạn" note.
- [ ] Manual verification: load unpacked extension, confirm login → controls appear, logout → form returns. (No automated test; DOM-in-popup.)
- [ ] Commit: `feat(ext): popup login form + auth state handling`.

---

## Task 9: Group-price 3-tier funnel

**Files:**
- Create: `src/group-prices.js`
- Create (test): `test/group-prices.test.js`

Reads already-crawled `posts` (via `DB.getAllPosts`). Reuses [`extractMoneyFigures()`](src/advisory.js:81) from advisory.js and `learned_keywords` from the API.

- [ ] Write failing tests `test/group-prices.test.js`:
  - `tier1Pass(text, sellKeywords)` returns TRUE only when text has BOTH a money figure AND a sell-signal keyword; FALSE for a buy/ask post ("cần mua ... giá bao nhiêu") even with a number.
  - `verifyExtraction(post, items)` discards any item whose `price` does not literally appear in the post text (anti-hallucination), keeps those that do.
  - Run `node --test test/` — expect FAIL.
- [ ] Implement `src/group-prices.js`:
  - `tier1Pass(text, sellKeywords)`: `extractMoneyFigures(text).length > 0 && sellKeywords.some(k => textLower.includes(k))`.
  - `selectForAI(posts)`: Tier 2 — keep only posts with no `parsed_at` AND `tier1Pass`.
  - `extractBatch(posts)`: Tier 3 — call AI once per ~10-15 posts; prompt returns per-post `{items:[{name,price,condition,warranty,category}], new_keywords:[...]}`. AI must NOT invent regex.
  - `verifyExtraction(post, items)`: drop items whose normalized price string isn't found in normalized post text.
  - `runGroupPriceExtraction()`: orchestrate — load enabled sell keywords from API, `getAllPosts`, `selectForAI`, batch, verify, `POST /api/group-prices`, mark posts `parsed_at`, and `POST /api/keywords` any returned `new_keywords` (added_by='ai', enabled=true).
- [ ] Run `node --test test/` — expect PASS (AI call mocked in tests).
- [ ] Commit: `feat(ext): 3-tier group-price extraction funnel over crawled posts`.

---

## Task 10: Dashboard views — Giá Group, Từ khóa học, Cài đặt chia sẻ, login state

**Files:**
- Modify: `src/dashboard/nav.js` (VIEW_META + switchView), `src/dashboard.html` (nav buttons + sections)
- Create: `src/dashboard/views/groupprices.js`, `src/dashboard/views/keywords.js`, `src/dashboard/views/sharing.js`

- [ ] Register three new views in [`VIEW_META`](src/dashboard/nav.js:21) and add matching `<button data-view>` + `<section data-view>` blocks in [`dashboard.html`](src/dashboard.html:21).
- [ ] `groupprices.js`: render cards (name, bold price, condition mới/cũ/likenew, warranty, seller, group, post time, source-post link); group-by-product low→high range; filters group/category/price-range/condition + "Tất cả (chung)/Chỉ của tôi" toggle; 🌐/🔒 share icon per card calling the share toggle. A "Trích xuất giá" button runs `runGroupPriceExtraction()`.
- [ ] `keywords.js`: table of `learned_keywords` (word, type, source AI/me, enable toggle, delete; "mới bởi AI" badge; manual add form) wired to `/api/keywords`.
- [ ] `sharing.js`: three master toggles (share_crawled_default, share_commented_default, share_group_prices_default) with short explanations, wired to `/api/me/share-prefs`.
- [ ] Add a logged-out state: when `bg('AUTH_STATE')` reports logged out, dashboard shows "Cần đăng nhập" instead of misleading empty data; on `AUTH_REQUIRED` broadcast show the same.
- [ ] Manual verification in the dashboard. Commit: `feat(ext): group-prices, keywords, sharing dashboard views + login state`.

---

## Task 11: Simple web dashboard (read-only)

**Files:**
- Create: `web/public/index.html`, `web/public/app.js`
- Modify: `web/server.js` (serve `web/public` static)

- [ ] Add `express.static("public")` to the app.
- [ ] `index.html` + `app.js`: login form → store token in localStorage → fetch `/api/group-prices`, `/api/posts`, `/api/stats` and render simple tables for viewing the shared data on the web.
- [ ] Manual verification: `npm start`, open `http://localhost:3300`, log in, see data. Note the API requires auth; the static dashboard is read-only over the same endpoints.
- [ ] Commit: `feat(web): minimal read-only web dashboard`.

---

## Task 12: Full verification

- [ ] Run `cd web && npm test` (all backend tests pass or skip cleanly without MySQL).
- [ ] Run `node --test test/` at repo root (extension client tests pass).
- [ ] Syntax-check changed extension files (`node --check src/db.js`, `node --check src/group-prices.js`, etc.).
- [ ] Load the unpacked extension; smoke test: login → crawl a group → posts appear → run group-price extraction → prices appear → toggle a share flag.
- [ ] Commit: `test: full verification pass for web backend + group prices`.

---

## No Placeholders Verification

Every step above contains complete code or a precise, resolvable instruction (exact endpoints, exact column lists from design doc section 3, exact function names mirroring current `db.js` exports). No "TODO", no "similar to Task N", no hand-waved error handling.

## Self-Review Checklist (run before execution)

1. **Spec coverage:** schema (§3 ✓ Task 2), funnel (§4 ✓ Task 9), comment-avoidance (§5 — note: avoid-list is fed via `/api/posts/:id/comments` in Task 5 + consumed by `draftAdvisory`; if deeper integration is wanted, add a Task 9b), auth (§6 ✓ Tasks 3–4, 6, 8), UI (§7 ✓ Task 10), share-filter (§8 ✓ Task 5), config (§9 ✓ Task 1), YAGNI (§10 — no refresh token, no roles, no websocket, no IndexedDB migration ✓).
2. **Placeholder scan:** none.
3. **Type/name consistency:** `db.js` exports preserved (Task 7 snapshot test guards this); `getKnownIds` returns a Set; jobs stay storage-backed.

## Execution Handoff

Choose how to implement:
1. **Subagent-Driven (recommended):** superpowers:subagent-driven-development — dispatch each Task to a fresh subagent.
2. **Inline Execution:** superpowers:executing-plans — work through tasks in this session.
