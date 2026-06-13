import { Router } from "express";
import { getPool } from "./config.js";
import { hashPassword, verifyPassword, signToken, authRequired } from "./auth.js";

export const authRouter = Router();

// Express 4.x does not catch rejections from async handlers; this wrapper
// forwards any rejection to the terminal error-handling middleware via next().
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Validates the register request body. Returns an error message string when the
// input is invalid, or null when it is acceptable. Kept small and pure so the
// route handler stays focused on persistence concerns.
export function validateRegisterInput(body) {
  const { email, password } = body || {};
  if (typeof email !== "string" || !email.trim() ||
      typeof password !== "string" || password.length < 6 ||
      password.length > 72) {
    // bcrypt silently truncates input past 72 bytes, so an upper bound is a
    // security requirement, not just hygiene: two long passwords sharing a
    // 72-byte prefix would otherwise authenticate interchangeably.
    if (typeof password === "string" &&
        (password.length < 6 || password.length > 72)) {
      return "password must be 6-72 characters";
    }
    return "email and password (>=6 chars) required";
  }
  // Simple structural email check; the DB UNIQUE constraint enforces identity.
  if (!/.+@.+\..+/.test(email)) {
    return "invalid email";
  }
  return null;
}

authRouter.post("/register", asyncHandler(async (req, res) => {
  const validationError = validateRegisterInput(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }
  const { email, password, displayName } = req.body;
  const password_hash = await hashPassword(password);

  // Both inserts must succeed or fail atomically: an orphaned users row with no
  // matching user_share_prefs row breaks every later feature that reads share
  // defaults through the FK. Wrap them in a single transaction on one connection.
  const conn = await getPool().getConnection();
  let userId;
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      "INSERT INTO users (email, password_hash, display_name) VALUES (:email, :password_hash, :display_name)",
      { email, password_hash, display_name: displayName ?? null }
    );
    userId = result.insertId;
    await conn.query(
      "INSERT INTO user_share_prefs (user_id) VALUES (:userId)",
      { userId }
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    // The DB UNIQUE constraint on users.email is the source of truth. Translate
    // the violation (including the concurrent-registration race) into a 409.
    if (err && err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "email already registered" });
    }
    // Any other error propagates to the terminal middleware as a 500.
    throw err;
  } finally {
    conn.release();
  }

  const token = signToken({ userId });
  return res.status(200).json({
    token,
    user: { id: userId, email, displayName: displayName ?? null },
  });
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const pool = getPool();
  const [rows] = await pool.query(
    "SELECT id, email, password_hash, display_name FROM users WHERE email = :email",
    { email }
  );
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  const token = signToken({ userId: user.id });
  return res.status(200).json({
    token,
    user: { id: user.id, email: user.email, displayName: user.display_name },
  });
}));

/* ======================================================================== */
/* DATA ROUTER                                                              */
/* ======================================================================== */
//
// Every data route lives behind authRequired (mounted in server.js), so each
// handler can trust req.userId. All handlers are wrapped in asyncHandler so
// rejections reach the terminal error middleware instead of hanging.
//
// THE SHARE-FILTERING RULE (design doc section 8):
//   A read of shared data returns the caller's OWN rows (always) PLUS other
//   users' rows whose matching per-row share flag = 1. Expressed as:
//       WHERE (<owner_col> = :userId OR <share_col> = 1)
//   The owner always sees their row regardless of the flag; flipping the flag
//   off hides it from everyone else immediately without deleting anything.
//
// On INSERT, a row's share flag is inherited from the owner's
// user_share_prefs default for that category. The master toggle in
// PATCH /api/me/share-prefs cascades to existing rows (see that handler) so the
// per-row column stays the single authoritative filter.

export const dataRouter = Router();

// Reads the caller's three share defaults, creating the row lazily if missing
// (older accounts predating user_share_prefs, or any edge case). Returns the
// numeric 0/1 values straight from MySQL BOOL columns.
async function getShareDefaults(conn, userId) {
  const [rows] = await conn.query(
    `SELECT share_crawled_default, share_commented_default, share_group_prices_default
       FROM user_share_prefs WHERE user_id = :userId`,
    { userId }
  );
  if (rows.length) return rows[0];
  await conn.query(
    "INSERT IGNORE INTO user_share_prefs (user_id) VALUES (:userId)",
    { userId }
  );
  return {
    share_crawled_default: 1,
    share_commented_default: 1,
    share_group_prices_default: 1,
  };
}

// Maps a posts row to the camelCase shape the old IndexedDB layer exposed, so
// the later client rewrite (src/db.js) is a mechanical swap.
function mapPostRow(r) {
  return {
    postId: r.post_id,
    groupId: r.group_id,
    groupName: r.group_name,
    authorName: r.author_name,
    authorProfile: r.author_profile,
    text: r.text,
    images: r.images,
    timestamp: r.timestamp,
    permalink: r.permalink,
    crawledBy: r.crawled_by_user_id,
    crawledAt: r.crawled_at,
    updatedAt: r.updated_at,
    shareCrawled: r.share_crawled,
    parsedAt: r.parsed_at,
  };
}

/* ------------------------------- POSTS --------------------------------- */

// GET /api/posts?groupId= — share-filtered list, newest crawl first.
dataRouter.get("/posts", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { groupId } = req.query;
  const where = ["(crawled_by_user_id = :userId OR share_crawled = 1)"];
  const params = { userId };
  if (groupId) {
    where.push("group_id = :groupId");
    params.groupId = groupId;
  }
  const [rows] = await getPool().query(
    `SELECT * FROM posts WHERE ${where.join(" AND ")} ORDER BY crawled_at DESC`,
    params
  );
  res.json({ posts: rows.map(mapPostRow) });
}));

// GET /api/posts/known-ids?groupId= — post_id list for incremental crawl
// (own + shared), so the client can skip posts already in the shared pool.
dataRouter.get("/posts/known-ids", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { groupId } = req.query;
  const where = ["(crawled_by_user_id = :userId OR share_crawled = 1)"];
  const params = { userId };
  if (groupId) {
    where.push("group_id = :groupId");
    params.groupId = groupId;
  }
  const [rows] = await getPool().query(
    `SELECT post_id FROM posts WHERE ${where.join(" AND ")}`,
    params
  );
  res.json({ ids: rows.map((r) => r.post_id) });
}));

// POST /api/posts — bulk upsert by post_id. Each new row records the caller as
// crawled_by_user_id and inherits share_crawled from their share_crawled_default.
// Re-crawls update content without clobbering attribution or the share flag.
dataRouter.post("/posts", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const posts = Array.isArray(req.body?.posts) ? req.body.posts : [];
  if (!posts.length) return res.json({ added: 0, updated: 0 });

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const defaults = await getShareDefaults(conn, userId);
    const shareCrawled = defaults.share_crawled_default ? 1 : 0;
    let added = 0;
    let updated = 0;
    for (const p of posts) {
      if (!p || !p.postId) continue;
      const [result] = await conn.query(
        `INSERT INTO posts
           (post_id, group_id, group_name, author_name, author_profile, text,
            images, timestamp, permalink, crawled_by_user_id, crawled_at,
            updated_at, share_crawled)
         VALUES
           (:postId, :groupId, :groupName, :authorName, :authorProfile, :text,
            :images, :timestamp, :permalink, :userId, NOW(), NOW(), :shareCrawled)
         ON DUPLICATE KEY UPDATE
           group_id = VALUES(group_id),
           group_name = VALUES(group_name),
           author_name = VALUES(author_name),
           author_profile = VALUES(author_profile),
           text = VALUES(text),
           images = VALUES(images),
           timestamp = VALUES(timestamp),
           permalink = VALUES(permalink),
           updated_at = NOW()`,
        {
          postId: p.postId,
          groupId: p.groupId ?? null,
          groupName: p.groupName ?? null,
          authorName: p.authorName ?? null,
          authorProfile: p.authorProfile ?? null,
          text: p.text ?? null,
          images: p.images ? JSON.stringify(p.images) : null,
          timestamp: p.timestamp ?? null,
          permalink: p.permalink ?? null,
          userId,
          shareCrawled,
        }
      );
      // mysql2 affectedRows is 1 for a fresh insert and 2 for an update.
      if (result.affectedRows === 1) added += 1;
      else updated += 1;
    }
    await conn.commit();
    res.json({ added, updated });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// GET /api/stats — total + per-group counts over the share-filtered set, mirror
// of the old getStats() shape { total, groups:[{groupId, groupName, count}] }.
dataRouter.get("/stats", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const [rows] = await getPool().query(
    `SELECT group_id, MAX(group_name) AS group_name, COUNT(*) AS count
       FROM posts
      WHERE (crawled_by_user_id = :userId OR share_crawled = 1)
      GROUP BY group_id`,
    { userId }
  );
  let total = 0;
  const groups = rows.map((r) => {
    total += Number(r.count);
    return {
      groupId: r.group_id || "unknown",
      groupName: r.group_name || r.group_id || "unknown",
      count: Number(r.count),
    };
  });
  res.json({ total, groups });
}));

// DELETE /api/posts?groupId= — only the caller's OWN rows are removed; shared
// rows owned by others are never touched.
dataRouter.delete("/posts", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { groupId } = req.query;
  const where = ["crawled_by_user_id = :userId"];
  const params = { userId };
  if (groupId) {
    where.push("group_id = :groupId");
    params.groupId = groupId;
  }
  const [result] = await getPool().query(
    `DELETE FROM posts WHERE ${where.join(" AND ")}`,
    params
  );
  res.json({ deleted: result.affectedRows });
}));

/* ------------------------------- GROUPS -------------------------------- */

// GET /api/groups — all groups (shared pool, no per-row share flag), newest
// first. postCount is computed from the caller's visible posts.
dataRouter.get("/groups", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const pool = getPool();
  const [groups] = await pool.query(
    "SELECT * FROM `groups` ORDER BY created_at DESC"
  );
  const [counts] = await pool.query(
    `SELECT group_id, COUNT(*) AS count
       FROM posts
      WHERE (crawled_by_user_id = :userId OR share_crawled = 1)
      GROUP BY group_id`,
    { userId }
  );
  const countMap = {};
  for (const c of counts) countMap[c.group_id] = Number(c.count);
  res.json({
    groups: groups.map((g) => ({
      groupId: g.group_id,
      groupName: g.group_name,
      crawledBy: g.crawled_by_user_id,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      postCount: countMap[g.group_id] || 0,
    })),
  });
}));

// POST /api/groups — bulk upsert by group_id.
dataRouter.post("/groups", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const groups = Array.isArray(req.body?.groups) ? req.body.groups : [];
  if (!groups.length) return res.json({ added: 0, updated: 0 });

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    let added = 0;
    let updated = 0;
    for (const g of groups) {
      if (!g || !g.groupId) continue;
      const [result] = await conn.query(
        `INSERT INTO \`groups\`
           (group_id, group_name, crawled_by_user_id, created_at, updated_at)
         VALUES (:groupId, :groupName, :userId, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           group_name = VALUES(group_name),
           updated_at = NOW()`,
        {
          groupId: g.groupId,
          groupName: g.groupName ?? null,
          userId,
        }
      );
      if (result.affectedRows === 1) added += 1;
      else updated += 1;
    }
    await conn.commit();
    res.json({ added, updated });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// DELETE /api/groups/:id — remove a group entry (does not delete its posts).
dataRouter.delete("/groups/:id", asyncHandler(async (req, res) => {
  const [result] = await getPool().query(
    "DELETE FROM `groups` WHERE group_id = :id",
    { id: req.params.id }
  );
  res.json({ deleted: result.affectedRows });
}));

/* ------------------------------ COMMENTS ------------------------------- */

// GET /api/posts/:id/comments — share-filtered avoid-list for the AI: the
// caller's own comments plus others' comments where share_commented = 1.
dataRouter.get("/posts/:id/comments", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const [rows] = await getPool().query(
    `SELECT id, post_id, user_id, content, commented_at, share_commented
       FROM comments
      WHERE post_id = :postId
        AND (user_id = :userId OR share_commented = 1)
      ORDER BY commented_at ASC`,
    { postId: req.params.id, userId }
  );
  res.json({
    comments: rows.map((r) => ({
      id: r.id,
      postId: r.post_id,
      userId: r.user_id,
      content: r.content,
      commentedAt: r.commented_at,
      shareCommented: r.share_commented,
    })),
  });
}));

// POST /api/comments — record a comment the caller made, inheriting
// share_commented from their share_commented_default.
dataRouter.post("/comments", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { postId, content } = req.body || {};
  if (!postId || typeof content !== "string") {
    return res.status(400).json({ error: "postId and content required" });
  }
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const defaults = await getShareDefaults(conn, userId);
    const shareCommented = defaults.share_commented_default ? 1 : 0;
    const [result] = await conn.query(
      `INSERT INTO comments (post_id, user_id, content, commented_at, share_commented)
       VALUES (:postId, :userId, :content, NOW(), :shareCommented)`,
      { postId, userId, content, shareCommented }
    );
    await conn.commit();
    res.json({ id: result.insertId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

/* ---------------------------- CONVERSATIONS ---------------------------- */

function mapConversationRow(r) {
  return {
    id: r.id,
    postId: r.post_id,
    userId: r.user_id,
    commentPermalink: r.comment_permalink,
    replies: r.replies ?? [],
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/conversations?status= — per-user (scoped to req.userId), matching the
// old db.js semantics where conversations are private device state, not shared.
dataRouter.get("/conversations", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { status } = req.query;
  const where = ["user_id = :userId"];
  const params = { userId };
  if (status) {
    where.push("status = :status");
    params.status = status;
  }
  const [rows] = await getPool().query(
    `SELECT * FROM conversations WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`,
    params
  );
  res.json({ conversations: rows.map(mapConversationRow) });
}));

// POST /api/conversations — create a conversation owned by the caller.
dataRouter.post("/conversations", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const c = req.body || {};
  const [result] = await getPool().query(
    `INSERT INTO conversations
       (post_id, user_id, comment_permalink, replies, status, created_at, updated_at)
     VALUES (:postId, :userId, :commentPermalink, :replies, :status, NOW(), NOW())`,
    {
      postId: c.postId ?? null,
      userId,
      commentPermalink: c.commentPermalink ?? null,
      replies: JSON.stringify(Array.isArray(c.replies) ? c.replies : []),
      status: c.status ?? "watching",
    }
  );
  res.json({ id: result.insertId });
}));

// PATCH /api/conversations/:id — merge-update fields on the caller's own row.
dataRouter.patch("/conversations/:id", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const patch = req.body || {};
  const sets = ["updated_at = NOW()"];
  const params = { id: req.params.id, userId };
  if (patch.status !== undefined) {
    sets.push("status = :status");
    params.status = patch.status;
  }
  if (patch.commentPermalink !== undefined) {
    sets.push("comment_permalink = :commentPermalink");
    params.commentPermalink = patch.commentPermalink;
  }
  if (patch.replies !== undefined) {
    sets.push("replies = :replies");
    params.replies = JSON.stringify(patch.replies);
  }
  const [result] = await getPool().query(
    `UPDATE conversations SET ${sets.join(", ")} WHERE id = :id AND user_id = :userId`,
    params
  );
  res.json({ updated: result.affectedRows });
}));

// POST /api/conversations/:id/replies — merge new replies into the JSON array
// without clobbering existing ones (mirror of the old mergeReplies). Dedupe by
// reply id when present, otherwise by author|text. Returns { added, total }.
dataRouter.post("/conversations/:id/replies", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const incoming = Array.isArray(req.body?.replies) ? req.body.replies : [];
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      "SELECT replies, status FROM conversations WHERE id = :id AND user_id = :userId FOR UPDATE",
      { id: req.params.id, userId }
    );
    if (!rows.length) {
      await conn.commit();
      return res.json({ added: 0, total: 0 });
    }
    const existing = rows[0];
    const have = Array.isArray(existing.replies) ? existing.replies.slice() : [];
    const keyOf = (r) =>
      (r && r.id) ? "id:" + r.id : "tx:" + ((r && r.author) || "") + "|" + ((r && r.text) || "");
    const seen = new Set(have.map(keyOf));
    let added = 0;
    for (const r of incoming) {
      if (!r || !r.text) continue;
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      have.push({
        id: r.id || null,
        author: r.author || "",
        text: String(r.text).slice(0, 2000),
        ts: r.ts || null,
        timeText: r.timeText || "",
        seenAt: Date.now(),
      });
      added += 1;
    }
    let status = existing.status;
    if (added > 0 && status === "watching") status = "replied";
    await conn.query(
      "UPDATE conversations SET replies = :replies, status = :status, updated_at = NOW() WHERE id = :id AND user_id = :userId",
      { replies: JSON.stringify(have), status, id: req.params.id, userId }
    );
    await conn.commit();
    res.json({ added, total: have.length });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// DELETE /api/conversations/:id — remove the caller's own conversation.
dataRouter.delete("/conversations/:id", asyncHandler(async (req, res) => {
  const [result] = await getPool().query(
    "DELETE FROM conversations WHERE id = :id AND user_id = :userId",
    { id: req.params.id, userId: req.userId }
  );
  res.json({ deleted: result.affectedRows });
}));

/* ----------------------------- ADVISORIES ------------------------------ */

function mapAdvisoryRow(r) {
  return {
    id: r.id,
    postId: r.post_id,
    userId: r.user_id,
    content: r.content,
    status: r.status,
    usedProducts: r.used_products ?? [],
    needsHumanCheck: r.needs_human_check,
    checkNote: r.check_note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// GET /api/advisories?status= — per-user (scoped to req.userId): each user keeps
// their own draft per post (advisories UNIQUE(post_id, user_id)).
dataRouter.get("/advisories", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { status } = req.query;
  const where = ["user_id = :userId"];
  const params = { userId };
  if (status) {
    where.push("status = :status");
    params.status = status;
  }
  const [rows] = await getPool().query(
    `SELECT * FROM advisories WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
    params
  );
  res.json({ advisories: rows.map(mapAdvisoryRow) });
}));

// GET /api/advisories/:postId — the caller's draft for one post, or null.
dataRouter.get("/advisories/:postId", asyncHandler(async (req, res) => {
  const [rows] = await getPool().query(
    "SELECT * FROM advisories WHERE post_id = :postId AND user_id = :userId",
    { postId: req.params.postId, userId: req.userId }
  );
  res.json({ advisory: rows.length ? mapAdvisoryRow(rows[0]) : null });
}));

// POST /api/advisories — upsert by (post_id, user_id): one draft per user per
// post. Re-posting overwrites the caller's own draft (dedupe), never another's.
dataRouter.post("/advisories", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const a = req.body || {};
  if (!a.postId) return res.status(400).json({ error: "postId required" });
  await getPool().query(
    `INSERT INTO advisories
       (post_id, user_id, content, status, used_products, needs_human_check,
        check_note, created_at, updated_at)
     VALUES
       (:postId, :userId, :content, :status, :usedProducts, :needsHumanCheck,
        :checkNote, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       content = VALUES(content),
       status = VALUES(status),
       used_products = VALUES(used_products),
       needs_human_check = VALUES(needs_human_check),
       check_note = VALUES(check_note),
       updated_at = NOW()`,
    {
      postId: a.postId,
      userId,
      content: a.content ?? null,
      status: a.status ?? "pending",
      usedProducts: JSON.stringify(Array.isArray(a.usedProducts) ? a.usedProducts : []),
      needsHumanCheck: a.needsHumanCheck ? 1 : 0,
      checkNote: a.checkNote ?? null,
    }
  );
  const [rows] = await getPool().query(
    "SELECT * FROM advisories WHERE post_id = :postId AND user_id = :userId",
    { postId: a.postId, userId }
  );
  res.json({ advisory: rows.length ? mapAdvisoryRow(rows[0]) : null });
}));

// PATCH /api/advisories/:postId — merge-update the caller's draft for a post.
dataRouter.patch("/advisories/:postId", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const patch = req.body || {};
  const sets = ["updated_at = NOW()"];
  const params = { postId: req.params.postId, userId };
  if (patch.content !== undefined) {
    sets.push("content = :content");
    params.content = patch.content;
  }
  if (patch.status !== undefined) {
    sets.push("status = :status");
    params.status = patch.status;
  }
  if (patch.usedProducts !== undefined) {
    sets.push("used_products = :usedProducts");
    params.usedProducts = JSON.stringify(patch.usedProducts);
  }
  if (patch.needsHumanCheck !== undefined) {
    sets.push("needs_human_check = :needsHumanCheck");
    params.needsHumanCheck = patch.needsHumanCheck ? 1 : 0;
  }
  if (patch.checkNote !== undefined) {
    sets.push("check_note = :checkNote");
    params.checkNote = patch.checkNote;
  }
  const [result] = await getPool().query(
    `UPDATE advisories SET ${sets.join(", ")} WHERE post_id = :postId AND user_id = :userId`,
    params
  );
  res.json({ updated: result.affectedRows });
}));

// DELETE /api/advisories/:postId — remove the caller's draft for a post.
dataRouter.delete("/advisories/:postId", asyncHandler(async (req, res) => {
  const [result] = await getPool().query(
    "DELETE FROM advisories WHERE post_id = :postId AND user_id = :userId",
    { postId: req.params.postId, userId: req.userId }
  );
  res.json({ deleted: result.affectedRows });
}));

/* ------------------------------ PRODUCTS ------------------------------- */

function mapProductRow(r) {
  return {
    productId: r.product_id,
    source: r.source,
    name: r.name,
    price: r.price,
    url: r.url,
    category: r.category,
    raw: r.raw,
    updatedAt: r.updated_at,
  };
}

// GET /api/products?source= — shared/global catalog (no per-user share flag),
// newest update first.
dataRouter.get("/products", asyncHandler(async (req, res) => {
  const { source } = req.query;
  const where = [];
  const params = {};
  if (source) {
    where.push("source = :source");
    params.source = source;
  }
  const sql =
    "SELECT * FROM products" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY updated_at DESC";
  const [rows] = await getPool().query(sql, params);
  res.json({ products: rows.map(mapProductRow) });
}));

// GET /api/products/search — keyword + price-range + category filter over the
// shared catalog. Mirrors the old searchProducts opts.
dataRouter.get("/products/search", asyncHandler(async (req, res) => {
  const { query, minPrice, maxPrice, category, source } = req.query;
  // Clamp the limit into [1, 200]: a non-positive value would yield LIMIT 0/-n
  // and throw a SQL error, so floor it at 1 while keeping the 200 ceiling.
  const limit = Math.min(Math.max(Math.floor(Number(req.query.limit) || 50), 1), 200);
  const where = [];
  const params = { limit };
  if (source) {
    where.push("source = :source");
    params.source = source;
  }
  if (category) {
    where.push("LOWER(category) = LOWER(:category)");
    params.category = category;
  }
  if (minPrice !== undefined && minPrice !== "") {
    const v = Number(minPrice);
    if (Number.isNaN(v)) {
      return res.status(400).json({ error: "invalid price filter" });
    }
    where.push("price >= :minPrice");
    params.minPrice = v;
  }
  if (maxPrice !== undefined && maxPrice !== "") {
    const v = Number(maxPrice);
    if (Number.isNaN(v)) {
      return res.status(400).json({ error: "invalid price filter" });
    }
    where.push("price <= :maxPrice");
    params.maxPrice = v;
  }
  if (query) {
    where.push("(LOWER(name) LIKE :q OR LOWER(category) LIKE :q)");
    params.q = "%" + String(query).toLowerCase() + "%";
  }
  const sql =
    "SELECT * FROM products" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY price ASC LIMIT :limit";
  const [rows] = await getPool().query(sql, params);
  res.json({ products: rows.map(mapProductRow) });
}));

// POST /api/products — bulk upsert into the shared catalog by product_id.
dataRouter.post("/products", asyncHandler(async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  if (!products.length) return res.json({ added: 0, updated: 0 });

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    let added = 0;
    let updated = 0;
    for (const p of products) {
      if (!p || !p.productId) continue;
      const [result] = await conn.query(
        `INSERT INTO products
           (product_id, source, name, price, url, category, raw, updated_at)
         VALUES (:productId, :source, :name, :price, :url, :category, :raw, NOW())
         ON DUPLICATE KEY UPDATE
           source = VALUES(source),
           name = VALUES(name),
           price = VALUES(price),
           url = VALUES(url),
           category = VALUES(category),
           raw = VALUES(raw),
           updated_at = NOW()`,
        {
          productId: p.productId,
          source: p.source ?? null,
          name: p.name ?? null,
          price: p.price ?? null,
          url: p.url ?? null,
          category: p.category ?? null,
          raw: p.raw ? JSON.stringify(p.raw) : null,
        }
      );
      if (result.affectedRows === 1) added += 1;
      else updated += 1;
    }
    await conn.commit();
    res.json({ added, updated });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// DELETE /api/products?source= or /api/products/:id — clear by source or delete
// one product, matching the old clearProducts/deleteProduct pair.
dataRouter.delete("/products/:id", asyncHandler(async (req, res) => {
  const [result] = await getPool().query(
    "DELETE FROM products WHERE product_id = :id",
    { id: req.params.id }
  );
  res.json({ deleted: result.affectedRows });
}));

dataRouter.delete("/products", asyncHandler(async (req, res) => {
  const { source } = req.query;
  // Guard: an absent source would produce an unqualified DELETE FROM products,
  // wiping the entire shared catalog for every user. Require an explicit scope.
  if (source === undefined || source === "") {
    return res.status(400).json({ error: "source required for bulk delete" });
  }
  const [result] = await getPool().query(
    "DELETE FROM products WHERE source = :source",
    { source }
  );
  res.json({ deleted: result.affectedRows });
}));

/* ------------------------------- SOURCES ------------------------------- */

// GET /api/sources — shared/global source configs.
dataRouter.get("/sources", asyncHandler(async (req, res) => {
  const [rows] = await getPool().query(
    "SELECT id, config, updated_at FROM sources ORDER BY id ASC"
  );
  res.json({
    sources: rows.map((r) => ({
      id: r.id,
      config: r.config,
      updatedAt: r.updated_at,
    })),
  });
}));

// POST /api/sources — upsert a source config by id.
dataRouter.post("/sources", asyncHandler(async (req, res) => {
  const s = req.body || {};
  if (!s.id) return res.status(400).json({ error: "id required" });
  await getPool().query(
    `INSERT INTO sources (id, config, updated_at)
     VALUES (:id, :config, NOW())
     ON DUPLICATE KEY UPDATE config = VALUES(config), updated_at = NOW()`,
    { id: s.id, config: JSON.stringify(s.config ?? {}) }
  );
  res.json({ id: s.id });
}));

// DELETE /api/sources/:id — remove a source config.
dataRouter.delete("/sources/:id", asyncHandler(async (req, res) => {
  const [result] = await getPool().query(
    "DELETE FROM sources WHERE id = :id",
    { id: req.params.id }
  );
  res.json({ deleted: result.affectedRows });
}));

/* -------------------------- LEARNED KEYWORDS --------------------------- */

// GET /api/keywords — shared/global learned filter words.
dataRouter.get("/keywords", asyncHandler(async (req, res) => {
  const { type } = req.query;
  const where = [];
  const params = {};
  if (type) {
    where.push("type = :type");
    params.type = type;
  }
  const sql =
    "SELECT id, keyword, type, added_by, enabled, created_at FROM learned_keywords" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY created_at DESC";
  const [rows] = await getPool().query(sql, params);
  res.json({
    keywords: rows.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      type: r.type,
      addedBy: r.added_by,
      enabled: r.enabled,
      createdAt: r.created_at,
    })),
  });
}));

// POST /api/keywords — add a keyword (idempotent on UNIQUE(keyword, type)).
dataRouter.post("/keywords", asyncHandler(async (req, res) => {
  const k = req.body || {};
  if (!k.keyword || !k.type) {
    return res.status(400).json({ error: "keyword and type required" });
  }
  await getPool().query(
    `INSERT INTO learned_keywords (keyword, type, added_by, enabled, created_at)
     VALUES (:keyword, :type, :addedBy, :enabled, NOW())
     ON DUPLICATE KEY UPDATE
       added_by = VALUES(added_by),
       enabled = VALUES(enabled)`,
    {
      keyword: k.keyword,
      type: k.type,
      addedBy: k.addedBy ?? "user",
      enabled: k.enabled === false ? 0 : 1,
    }
  );
  res.json({ ok: true });
}));

// PATCH /api/keywords/:id — toggle enabled (or rename).
dataRouter.patch("/keywords/:id", asyncHandler(async (req, res) => {
  const patch = req.body || {};
  const sets = [];
  const params = { id: req.params.id };
  if (patch.enabled !== undefined) {
    sets.push("enabled = :enabled");
    params.enabled = patch.enabled ? 1 : 0;
  }
  if (patch.keyword !== undefined) {
    sets.push("keyword = :keyword");
    params.keyword = patch.keyword;
  }
  if (!sets.length) return res.json({ updated: 0 });
  const [result] = await getPool().query(
    `UPDATE learned_keywords SET ${sets.join(", ")} WHERE id = :id`,
    params
  );
  res.json({ updated: result.affectedRows });
}));

// DELETE /api/keywords/:id — remove a learned keyword.
dataRouter.delete("/keywords/:id", asyncHandler(async (req, res) => {
  const [result] = await getPool().query(
    "DELETE FROM learned_keywords WHERE id = :id",
    { id: req.params.id }
  );
  res.json({ deleted: result.affectedRows });
}));

/* ----------------------------- GROUP PRICES ---------------------------- */

function mapGroupPriceRow(r) {
  return {
    id: r.id,
    postId: r.post_id,
    name: r.name,
    price: r.price,
    condition: r.condition,
    warranty: r.warranty,
    category: r.category,
    sellerName: r.seller_name,
    sellerProfile: r.seller_profile,
    groupId: r.group_id,
    postedAt: r.posted_at,
    parsedAt: r.parsed_at,
    parser: r.parser,
    confidence: r.confidence,
    crawledBy: r.crawled_by_user_id,
    shareGroupPrices: r.share_group_prices,
  };
}

// GET /api/group-prices — share-filtered list with optional filters:
// groupId, category, condition, priceMin, priceMax, mineOnly.
dataRouter.get("/group-prices", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const { groupId, category, condition, priceMin, priceMax, mineOnly } = req.query;
  const where = [];
  const params = { userId };
  if (mineOnly === "1" || mineOnly === "true") {
    where.push("crawled_by_user_id = :userId");
  } else {
    where.push("(crawled_by_user_id = :userId OR share_group_prices = 1)");
  }
  if (groupId) {
    where.push("group_id = :groupId");
    params.groupId = groupId;
  }
  if (category) {
    where.push("category = :category");
    params.category = category;
  }
  if (condition) {
    where.push("`condition` = :condition");
    params.condition = condition;
  }
  if (priceMin !== undefined && priceMin !== "") {
    const v = Number(priceMin);
    if (Number.isNaN(v)) {
      return res.status(400).json({ error: "invalid price filter" });
    }
    where.push("price >= :priceMin");
    params.priceMin = v;
  }
  if (priceMax !== undefined && priceMax !== "") {
    const v = Number(priceMax);
    if (Number.isNaN(v)) {
      return res.status(400).json({ error: "invalid price filter" });
    }
    where.push("price <= :priceMax");
    params.priceMax = v;
  }
  const [rows] = await getPool().query(
    `SELECT * FROM group_prices WHERE ${where.join(" AND ")} ORDER BY price ASC`,
    params
  );
  res.json({ groupPrices: rows.map(mapGroupPriceRow) });
}));

// POST /api/group-prices — bulk insert extracted price rows. Each row records the
// caller and inherits share_group_prices from their share_group_prices_default.
dataRouter.post("/group-prices", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const items = Array.isArray(req.body?.groupPrices) ? req.body.groupPrices : [];
  if (!items.length) return res.json({ inserted: 0 });

  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const defaults = await getShareDefaults(conn, userId);
    const shareGroupPrices = defaults.share_group_prices_default ? 1 : 0;
    let inserted = 0;
    for (const it of items) {
      if (!it) continue;
      await conn.query(
        // ON DUPLICATE KEY UPDATE makes re-submits idempotent against the
        // uq_gp_line natural key (post_id, name, price, seller_name): a retry
        // refreshes the parse metadata instead of inserting a duplicate row.
        `INSERT INTO group_prices
           (post_id, name, price, \`condition\`, warranty, category, seller_name,
            seller_profile, group_id, posted_at, parsed_at, parser, confidence,
            crawled_by_user_id, share_group_prices)
         VALUES
           (:postId, :name, :price, :condition, :warranty, :category, :sellerName,
            :sellerProfile, :groupId, :postedAt, NOW(), :parser, :confidence,
            :userId, :shareGroupPrices)
         ON DUPLICATE KEY UPDATE
           \`condition\` = VALUES(\`condition\`),
           warranty = VALUES(warranty),
           category = VALUES(category),
           seller_profile = VALUES(seller_profile),
           group_id = VALUES(group_id),
           posted_at = VALUES(posted_at),
           parsed_at = NOW(),
           parser = VALUES(parser),
           confidence = VALUES(confidence),
           crawled_by_user_id = VALUES(crawled_by_user_id),
           share_group_prices = VALUES(share_group_prices)`,
        {
          postId: it.postId ?? null,
          name: it.name ?? null,
          price: it.price ?? null,
          condition: it.condition ?? null,
          warranty: it.warranty ?? null,
          category: it.category ?? null,
          sellerName: it.sellerName ?? null,
          sellerProfile: it.sellerProfile ?? null,
          groupId: it.groupId ?? null,
          postedAt: it.postedAt ?? null,
          parser: it.parser ?? null,
          confidence: it.confidence ?? null,
          userId,
          shareGroupPrices,
        }
      );
      inserted += 1;
    }
    await conn.commit();
    res.json({ inserted });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

/* ----------------------------- SHARE PREFS ----------------------------- */

// GET /api/me/share-prefs — the caller's three master toggles.
dataRouter.get("/me/share-prefs", asyncHandler(async (req, res) => {
  const conn = await getPool().getConnection();
  try {
    const prefs = await getShareDefaults(conn, req.userId);
    res.json({
      shareCrawledDefault: !!prefs.share_crawled_default,
      shareCommentedDefault: !!prefs.share_commented_default,
      shareGroupPricesDefault: !!prefs.share_group_prices_default,
    });
  } finally {
    conn.release();
  }
}));

// PATCH /api/me/share-prefs — flip one or more master toggles.
//
// THE CASCADE: the per-row share column is the authoritative filter, so when a
// master toggle flips OFF we also UPDATE all of the caller's existing rows in
// the matching category to share=0, hiding previously-shared rows from others
// immediately. Flipping ON cascades to share=1 so newly-re-enabled sharing
// surfaces past rows too. The owner keeps seeing every row regardless. The
// whole thing runs in one transaction so prefs and rows never diverge.
dataRouter.patch("/me/share-prefs", asyncHandler(async (req, res) => {
  const userId = req.userId;
  const body = req.body || {};
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT IGNORE INTO user_share_prefs (user_id) VALUES (:userId)",
      { userId }
    );

    const prefSets = [];
    const prefParams = { userId };
    // Each entry pairs the pref column with the per-row table/column it cascades
    // to, so toggling the master switch keeps existing rows consistent.
    const cascades = [
      {
        key: "share_crawled_default",
        body: body.share_crawled_default,
        table: "posts",
        col: "share_crawled",
        ownerCol: "crawled_by_user_id",
      },
      {
        key: "share_commented_default",
        body: body.share_commented_default,
        table: "comments",
        col: "share_commented",
        ownerCol: "user_id",
      },
      {
        key: "share_group_prices_default",
        body: body.share_group_prices_default,
        table: "group_prices",
        col: "share_group_prices",
        ownerCol: "crawled_by_user_id",
      },
    ];

    // Table/column names here come from this fixed allow-list, never from user
    // input, so interpolating them into the SQL is safe; values stay bound.
    for (const c of cascades) {
      if (c.body === undefined) continue;
      const val = c.body ? 1 : 0;
      prefSets.push(`${c.key} = :${c.key}`);
      prefParams[c.key] = val;
      // Cascade the new value onto the caller's own rows in that category so the
      // per-row share column stays the single authoritative filter.
      await conn.query(
        `UPDATE \`${c.table}\` SET ${c.col} = :val WHERE ${c.ownerCol} = :userId`,
        { val, userId }
      );
    }

    if (prefSets.length) {
      await conn.query(
        `UPDATE user_share_prefs SET ${prefSets.join(", ")} WHERE user_id = :userId`,
        prefParams
      );
    }

    await conn.commit();

    const prefs = await getShareDefaults(conn, userId);
    res.json({
      shareCrawledDefault: !!prefs.share_crawled_default,
      shareCommentedDefault: !!prefs.share_commented_default,
      shareGroupPricesDefault: !!prefs.share_group_prices_default,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));
