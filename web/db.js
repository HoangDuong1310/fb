/**
 * db.js — mysql2 connection pool singleton.
 *
 * All route handlers import { pool } and call pool.execute() / pool.query().
 * The schema migration (runMigrations) is called once at server startup.
 */

import mysql from "mysql2/promise";
import { db as dbConfig } from "./config.js";

/** Shared connection pool — import this everywhere you need DB access. */
export const pool = mysql.createPool(dbConfig);

/**
 * Run all CREATE TABLE IF NOT EXISTS migrations.
 * Safe to call on every startup; idempotent.
 */
export async function runMigrations() {
  const stmts = [
    /* ── users ──────────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS users (
      id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      email         VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      display_name  VARCHAR(255) NOT NULL DEFAULT '',
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── user_share_prefs ────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS user_share_prefs (
      user_id                     INT UNSIGNED NOT NULL PRIMARY KEY,
      share_crawled_default       TINYINT(1)   NOT NULL DEFAULT 1,
      share_commented_default     TINYINT(1)   NOT NULL DEFAULT 1,
      share_group_prices_default  TINYINT(1)   NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── groups ──────────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS \`groups\` (
      group_id            VARCHAR(64)  NOT NULL PRIMARY KEY,
      group_name          VARCHAR(255) NOT NULL DEFAULT '',
      saved_by_user_id    INT UNSIGNED DEFAULT NULL,
      created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (saved_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── posts ───────────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS posts (
      post_id             VARCHAR(64)  NOT NULL PRIMARY KEY,
      group_id            VARCHAR(64)  NOT NULL DEFAULT '',
      group_name          VARCHAR(255) NOT NULL DEFAULT '',
      author_name         VARCHAR(255) NOT NULL DEFAULT '',
      author_profile      VARCHAR(512) NOT NULL DEFAULT '',
      \`text\`            MEDIUMTEXT,
      images              JSON,
      \`timestamp\`       BIGINT       DEFAULT NULL,
      reactions           BIGINT       DEFAULT NULL,
      comments            BIGINT       DEFAULT NULL,
      permalink           VARCHAR(512) NOT NULL DEFAULT '',
      crawled_by_user_id  INT UNSIGNED DEFAULT NULL,
      crawled_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      parsed_at           DATETIME     DEFAULT NULL,
      share_crawled       TINYINT(1)   NOT NULL DEFAULT 1,
      INDEX idx_group (group_id),
      INDEX idx_crawled_by (crawled_by_user_id),
      FOREIGN KEY (crawled_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── comments ────────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS comments (
      id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      post_id          VARCHAR(64)  NOT NULL,
      user_id          INT UNSIGNED NOT NULL,
      content          TEXT,
      commented_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      share_commented  TINYINT(1)   NOT NULL DEFAULT 1,
      INDEX idx_post (post_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── conversations ───────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS conversations (
      id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      post_id            VARCHAR(64)  NOT NULL DEFAULT '',
      user_id            INT UNSIGNED NOT NULL,
      comment_permalink  VARCHAR(512) NOT NULL DEFAULT '',
      comment_id         VARCHAR(64)  DEFAULT NULL,
      replies            JSON,
      status             VARCHAR(32)  NOT NULL DEFAULT 'watching',
      post_url           VARCHAR(512) NOT NULL DEFAULT '',
      group_id           VARCHAR(64)  NOT NULL DEFAULT '',
      group_name         VARCHAR(255) NOT NULL DEFAULT '',
      my_comment         TEXT,
      my_comment_url     VARCHAR(512) NOT NULL DEFAULT '',
      my_author_id       VARCHAR(64)  DEFAULT NULL,
      my_author_name     VARCHAR(255) DEFAULT NULL,
      post_text          MEDIUMTEXT,
      draft              TEXT,
      job_id             VARCHAR(64)  DEFAULT NULL,
      last_watched_at    BIGINT       DEFAULT NULL,
      created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_user_status (user_id, status),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── advisories ──────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS advisories (
      id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      post_id            VARCHAR(64)  NOT NULL,
      user_id            INT UNSIGNED NOT NULL,
      status             VARCHAR(32)  NOT NULL DEFAULT 'draft',
      draft              TEXT,
      used_products      JSON,
      needs_human_check  TINYINT(1)   NOT NULL DEFAULT 0,
      check_note         TEXT,
      created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_post_user (post_id, user_id),
      INDEX idx_user_status (user_id, status),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── products ────────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS products (
      product_id   VARCHAR(128) NOT NULL PRIMARY KEY,
      source       VARCHAR(64)  NOT NULL DEFAULT '',
      name         VARCHAR(512) NOT NULL DEFAULT '',
      price        BIGINT       DEFAULT NULL,
      category     VARCHAR(128) NOT NULL DEFAULT '',
      data         JSON,
      updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_source (source),
      FULLTEXT KEY ft_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── group_prices ────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS group_prices (
      id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      post_id             VARCHAR(64)  NOT NULL,
      name                VARCHAR(512) NOT NULL DEFAULT '',
      price               BIGINT       DEFAULT NULL,
      condition_val       VARCHAR(64)  NOT NULL DEFAULT '',
      warranty            VARCHAR(128) NOT NULL DEFAULT '',
      category            VARCHAR(128) NOT NULL DEFAULT '',
      seller_name         VARCHAR(255) NOT NULL DEFAULT '',
      seller_profile      VARCHAR(512) NOT NULL DEFAULT '',
      group_id            VARCHAR(64)  NOT NULL DEFAULT '',
      posted_at           BIGINT       DEFAULT NULL,
      parsed_at           DATETIME     DEFAULT NULL,
      parser              VARCHAR(16)  NOT NULL DEFAULT 'regex',
      confidence          FLOAT        DEFAULT NULL,
      crawled_by_user_id  INT UNSIGNED DEFAULT NULL,
      share_group_prices  TINYINT(1)   NOT NULL DEFAULT 1,
      INDEX idx_post (post_id),
      INDEX idx_group (group_id),
      INDEX idx_crawled_by (crawled_by_user_id),
      FOREIGN KEY (crawled_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── sources ─────────────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS sources (
      id          VARCHAR(128) NOT NULL PRIMARY KEY,
      config      JSON,
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── prompt_profiles ─────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS prompt_profiles (
      id          VARCHAR(128) NOT NULL PRIMARY KEY,
      name        VARCHAR(255) NOT NULL DEFAULT '',
      config      JSON,
      is_active   TINYINT(1)   NOT NULL DEFAULT 0,
      updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── learned_keywords ────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS learned_keywords (
      id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      keyword     VARCHAR(128) NOT NULL UNIQUE,
      type        VARCHAR(32)  NOT NULL DEFAULT 'sell_signal',
      added_by    VARCHAR(16)  NOT NULL DEFAULT 'user',
      enabled     TINYINT(1)   NOT NULL DEFAULT 1,
      created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    /* ── remote_commands ─────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS remote_commands (
      id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id      INT UNSIGNED NOT NULL,
      type         VARCHAR(64)  NOT NULL,
      payload      JSON         NOT NULL,
      status       ENUM('pending','running','completed','failed','expired') NOT NULL DEFAULT 'pending',
      result       JSON         DEFAULT NULL,
      error        TEXT         DEFAULT NULL,
      created_by   INT UNSIGNED DEFAULT NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at   DATETIME     DEFAULT NULL,
      completed_at DATETIME     DEFAULT NULL,
      INDEX idx_pending_user (status, user_id, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of stmts) {
    await pool.execute(sql);
  }

  // Auto-migrate existing tables: thêm cột mới vào bảng đã tồn tại trên DB cũ.
  await ensureColumns(pool, "posts", [
    { name: "reactions", ddl: "reactions BIGINT DEFAULT NULL" },
    { name: "comments", ddl: "comments BIGINT DEFAULT NULL" },
  ]);

  // Bổ sung tác giả bình luận GỐC của ta -> cờ `mine` khi gom reply khớp
  // CHÍNH XÁC theo authorId (bền hơn khớp tên tác giả).
  await ensureColumns(pool, "conversations", [
    { name: "my_author_id", ddl: "my_author_id VARCHAR(64) DEFAULT NULL" },
    { name: "my_author_name", ddl: "my_author_name VARCHAR(255) DEFAULT NULL" },
  ]);

  console.log("[db] migrations complete");
}

/**
 * Idempotent ALTER TABLE ... ADD COLUMN cho các cột còn thiếu.
 * Dùng cho DB đã tồn tại từ trước (runMigrations chỉ CREATE TABLE IF NOT EXISTS,
 * không tự thêm cột mới vào bảng cũ).
 *
 * @param {import("mysql2/promise").Pool} pool
 * @param {string} table
 * @param {{ name: string, ddl: string }[]} columns
 */
async function ensureColumns(pool, table, columns) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  const have = new Set(rows.map((r) => String(r.name).toLowerCase()));
  for (const col of columns) {
    if (have.has(col.name.toLowerCase())) continue;
    try {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${col.ddl}`);
    } catch (e) {
      // ER_DUP_FIELDNAME (cột đã tồn tại do chạy song song) -> bỏ qua an toàn.
      if (e && e.code !== "ER_DUP_FIELDNAME") throw e;
    }
  }
}
