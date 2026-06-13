import { ensureDatabase, getPool } from "./config.js";

const TABLES = [
  `CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS user_share_prefs (
    user_id INT PRIMARY KEY,
    share_crawled_default BOOL DEFAULT 1,
    share_commented_default BOOL DEFAULT 1,
    share_group_prices_default BOOL DEFAULT 1,
    CONSTRAINT fk_usp_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS posts (
    post_id VARCHAR(64) PRIMARY KEY,
    group_id VARCHAR(64),
    group_name VARCHAR(255),
    author_name VARCHAR(255),
    author_profile VARCHAR(512),
    text MEDIUMTEXT,
    images JSON,
    timestamp BIGINT,
    permalink VARCHAR(1024),
    crawled_by_user_id INT NULL,
    crawled_at DATETIME,
    updated_at DATETIME,
    share_crawled BOOL DEFAULT 1,
    parsed_at DATETIME NULL,
    CONSTRAINT fk_posts_user FOREIGN KEY (crawled_by_user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS \`groups\` (
    group_id VARCHAR(64) PRIMARY KEY,
    group_name VARCHAR(255),
    crawled_by_user_id INT NULL,
    created_at DATETIME,
    updated_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS comments (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id VARCHAR(64),
    user_id INT NULL,
    content MEDIUMTEXT,
    commented_at DATETIME,
    share_commented BOOL DEFAULT 1,
    CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(post_id),
    CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id VARCHAR(64),
    user_id INT NULL,
    comment_permalink VARCHAR(1024),
    replies JSON,
    status VARCHAR(32),
    created_at DATETIME,
    updated_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS advisories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id VARCHAR(64),
    user_id INT NULL,
    content MEDIUMTEXT,
    status VARCHAR(32),
    used_products JSON,
    needs_human_check BOOL DEFAULT 0,
    check_note VARCHAR(512),
    created_at DATETIME,
    updated_at DATETIME,
    UNIQUE KEY uq_advisory_post_user (post_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS products (
    product_id VARCHAR(128) PRIMARY KEY,
    source VARCHAR(64),
    name VARCHAR(512),
    price BIGINT,
    url VARCHAR(1024),
    category VARCHAR(128),
    raw JSON,
    updated_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS group_prices (
    id INT PRIMARY KEY AUTO_INCREMENT,
    post_id VARCHAR(64),
    name VARCHAR(512),
    price BIGINT,
    \`condition\` VARCHAR(64),
    warranty VARCHAR(128),
    category VARCHAR(128),
    seller_name VARCHAR(255),
    seller_profile VARCHAR(512),
    group_id VARCHAR(64),
    posted_at BIGINT,
    parsed_at DATETIME,
    parser VARCHAR(64),
    confidence FLOAT,
    crawled_by_user_id INT NULL,
    share_group_prices BOOL DEFAULT 1,
    UNIQUE KEY uq_gp_line (post_id, name(255), price, seller_name(255)),
    CONSTRAINT fk_gp_post FOREIGN KEY (post_id) REFERENCES posts(post_id),
    CONSTRAINT fk_gp_user FOREIGN KEY (crawled_by_user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS sources (
    id VARCHAR(64) PRIMARY KEY,
    config JSON,
    updated_at DATETIME
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS learned_keywords (
    id INT PRIMARY KEY AUTO_INCREMENT,
    keyword VARCHAR(128),
    type VARCHAR(32),
    added_by VARCHAR(64),
    enabled BOOL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_keyword_type (keyword, type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

const SELL_SIGNALS = [
  "bán", "pass", "thanh lý", "ib giá", "fix nhẹ",
  "fix", "cần bán", "để lại", "ra đi",
];

export async function runMigrations() {
  await ensureDatabase();
  const pool = getPool();
  for (const sql of TABLES) {
    await pool.query(sql);
  }
  for (const kw of SELL_SIGNALS) {
    await pool.query(
      "INSERT IGNORE INTO learned_keywords (keyword, type, added_by, enabled) VALUES (?, 'sell_signal', 'user', 1)",
      [kw]
    );
  }
}
