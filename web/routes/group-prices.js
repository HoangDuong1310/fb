/**
 * routes/group-prices.js — Group price rows extracted from posts.
 *
 *   POST /api/group-prices  { groupPrices: [] }  → { inserted }
 *   GET  /api/group-prices  ?mineOnly&groupId&category&condition&priceMin&priceMax
 *                                                → { groupPrices: [] }
 *
 * Share-filter on GET: caller's own rows + others' rows where share_group_prices=1
 * (unless mineOnly=1, then only caller's own rows).
 *
 * POST sets crawled_by_user_id = caller and share_group_prices from the caller's
 * share_group_prices_default pref.  parsed_at is set to NOW() on every insert.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/group-prices ───────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const groupPrices = req.body?.groupPrices;
  if (!Array.isArray(groupPrices) || groupPrices.length === 0) {
    return res.json({ inserted: 0 });
  }

  // Fetch caller's share pref
  const [prefRows] = await pool.execute(
    "SELECT share_group_prices_default FROM user_share_prefs WHERE user_id = ?",
    [req.userId]
  );
  const shareDefault = prefRows.length > 0
    ? prefRows[0].share_group_prices_default
    : 1;

  let inserted = 0;
  for (const row of groupPrices) {
    if (!row || !row.postId) continue;
    try {
      await pool.execute(
        `INSERT INTO group_prices
           (post_id, name, price, condition_val, warranty, category,
            seller_name, seller_profile, group_id, posted_at,
            parsed_at, parser, confidence,
            crawled_by_user_id, share_group_prices)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`,
        [
          String(row.postId),
          String(row.name || ""),
          row.price != null ? Number(row.price) : null,
          String(row.condition || ""),
          String(row.warranty || ""),
          String(row.category || ""),
          String(row.sellerName || ""),
          String(row.sellerProfile || ""),
          String(row.groupId || ""),
          row.postedAt != null ? Number(row.postedAt) : null,
          String(row.parser || "regex"),
          row.confidence != null ? Number(row.confidence) : null,
          req.userId,
          shareDefault,
        ]
      );
      inserted++;
    } catch (err) {
      // Log but continue inserting remaining rows
      console.error("[group-prices/post] row error:", err.message);
    }
  }

  return res.status(201).json({ inserted });
});

/* ── GET /api/group-prices ────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const {
    mineOnly,
    groupId,
    category,
    condition,
    priceMin,
    priceMax,
  } = req.query;

  try {
    let sql;
    const params = [];

    if (mineOnly === "1") {
      sql = "SELECT * FROM group_prices WHERE crawled_by_user_id = ?";
      params.push(req.userId);
    } else {
      sql = `SELECT * FROM group_prices
             WHERE (crawled_by_user_id = ? OR share_group_prices = 1)`;
      params.push(req.userId);
    }

    if (groupId) {
      sql += " AND group_id = ?";
      params.push(String(groupId));
    }
    if (category) {
      sql += " AND category = ?";
      params.push(String(category));
    }
    if (condition) {
      sql += " AND condition_val = ?";
      params.push(String(condition));
    }
    if (priceMin != null && priceMin !== "") {
      sql += " AND price >= ?";
      params.push(Number(priceMin));
    }
    if (priceMax != null && priceMax !== "") {
      sql += " AND price <= ?";
      params.push(Number(priceMax));
    }

    sql += " ORDER BY parsed_at DESC";

    const [rows] = await pool.execute(sql, params);
    return res.json({ groupPrices: rows.map(mapGroupPrice) });
  } catch (err) {
    console.error("[group-prices/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapGroupPrice(r) {
  return {
    id: Number(r.id),
    postId: r.post_id,
    name: r.name,
    price: r.price != null ? Number(r.price) : null,
    condition: r.condition_val,
    warranty: r.warranty,
    category: r.category,
    sellerName: r.seller_name,
    sellerProfile: r.seller_profile,
    groupId: r.group_id,
    postedAt: r.posted_at != null ? Number(r.posted_at) : null,
    parsedAt: r.parsed_at,
    parser: r.parser,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    crawledByUserId: r.crawled_by_user_id,
    shareGroupPrices: !!r.share_group_prices,
  };
}

export default router;
