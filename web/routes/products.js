/**
 * routes/products.js — Product catalog endpoints.
 *
 *   POST   /api/products           { products }                      → { added, updated }
 *   GET    /api/products           ?source                           → { products: [] }
 *   GET    /api/products/search    ?query&minPrice&maxPrice&category&source&limit → { products: [] }
 *   DELETE /api/products           ?source OR ?all=1                 → { deleted }
 *   DELETE /api/products/:productId                                  → { ok: true }
 *
 * Products are shared (no per-user scope) — all users see all products.
 */

import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

/* ── POST /api/products ───────────────────────────────────────────────────── */
router.post("/", requireAuth, async (req, res) => {
  const products = req.body?.products;
  if (!Array.isArray(products) || products.length === 0) {
    return res.json({ added: 0, updated: 0 });
  }

  let added = 0;
  let updated = 0;

  for (const p of products) {
    if (!p || !p.productId) continue;
    // Store all extra fields in the `data` JSON column
    const { productId, source, name, price, category, ...rest } = p;
    const [result] = await pool.execute(
      `INSERT INTO products (product_id, source, name, price, category, data)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source   = VALUES(source),
         name     = VALUES(name),
         price    = VALUES(price),
         category = VALUES(category),
         data     = VALUES(data),
         updated_at = CURRENT_TIMESTAMP`,
      [
        String(productId),
        String(source || ""),
        String(name || ""),
        price != null ? Number(price) : null,
        String(category || ""),
        JSON.stringify(rest),
      ]
    );
    if (result.affectedRows === 1) added++;
    else updated++;
  }

  return res.json({ added, updated });
});

/* ── GET /api/products/search ─────────────────────────────────────────────── */
// Must be declared BEFORE /:productId to avoid route shadowing
router.get("/search", requireAuth, async (req, res) => {
  const { query, minPrice, maxPrice, category, source, limit } = req.query;
  try {
    let sql = "SELECT * FROM products WHERE 1=1";
    const params = [];

    if (query) {
      sql += " AND name LIKE ?";
      params.push(`%${query}%`);
    }
    if (minPrice !== undefined && minPrice !== "") {
      sql += " AND price >= ?";
      params.push(Number(minPrice));
    }
    if (maxPrice !== undefined && maxPrice !== "") {
      sql += " AND price <= ?";
      params.push(Number(maxPrice));
    }
    if (category) {
      sql += " AND category = ?";
      params.push(category);
    }
    if (source) {
      sql += " AND source = ?";
      params.push(source);
    }

    const limitNum = parseInt(limit || "100", 10);
    sql += ` ORDER BY name LIMIT ${limitNum}`;

    const [rows] = await pool.execute(sql, params);
    return res.json({ products: rows.map(mapProduct) });
  } catch (err) {
    console.error("[products/search]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── GET /api/products ────────────────────────────────────────────────────── */
router.get("/", requireAuth, async (req, res) => {
  const { source } = req.query;
  try {
    let sql = "SELECT * FROM products";
    const params = [];
    if (source) {
      sql += " WHERE source = ?";
      params.push(source);
    }
    sql += " ORDER BY name";
    const [rows] = await pool.execute(sql, params);
    return res.json({ products: rows.map(mapProduct) });
  } catch (err) {
    console.error("[products/get]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/products ─────────────────────────────────────────────────── */
router.delete("/", requireAuth, async (req, res) => {
  const { source, all } = req.query;
  // Require explicit scope to prevent accidental wipe
  if (!source && !all) {
    return res
      .status(400)
      .json({ error: "Cần truyền ?source= hoặc ?all=1 để xác nhận phạm vi xóa." });
  }
  try {
    let sql = "DELETE FROM products";
    const params = [];
    if (source) {
      sql += " WHERE source = ?";
      params.push(source);
    }
    // all=1 → no WHERE clause → delete everything
    const [result] = await pool.execute(sql, params);
    return res.json({ deleted: result.affectedRows });
  } catch (err) {
    console.error("[products/delete-all]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── DELETE /api/products/:productId ──────────────────────────────────────── */
router.delete("/:productId", requireAuth, async (req, res) => {
  try {
    await pool.execute("DELETE FROM products WHERE product_id = ?", [
      req.params.productId,
    ]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("[products/delete-one]", err);
    return res.status(500).json({ error: "Lỗi server." });
  }
});

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function mapProduct(r) {
  const extra = parseJson(r.data, {});
  return {
    productId: r.product_id,
    source: r.source,
    name: r.name,
    price: r.price != null ? Number(r.price) : null,
    category: r.category,
    updatedAt: r.updated_at,
    ...extra,
  };
}

function parseJson(val, fallback) {
  if (val == null) return fallback;
  if (typeof val === "object") return val;
  try { return JSON.parse(val); } catch { return fallback; }
}

export default router;
