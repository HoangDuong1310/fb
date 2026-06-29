/**
 * config.js — Load environment variables and export typed config for the web server.
 *
 * Usage: import { db as dbConfig, jwt as jwtConfig, port } from "./config.js";
 */

import "dotenv/config";

/**
 * Parse a MySQL connection URL into a mysql2-compatible config object.
 * Format: mysql://user:password@host:port/database
 *
 * @param {string} url
 * @returns {{ host: string, port: number, user: string, password: string, database: string }}
 */
export function parseDatabaseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname || "localhost",
    port: parseInt(u.port || "3306", 10),
    user: decodeURIComponent(u.username || "root"),
    password: decodeURIComponent(u.password || ""),
    database: (u.pathname || "/fb_crawler").replace(/^\//, ""),
  };
}

const DATABASE_URL =
  process.env.DATABASE_URL || "mysql://root:@localhost:3306/fb_crawler";

/** mysql2 pool config derived from DATABASE_URL */
export const db = {
  ...parseDatabaseUrl(DATABASE_URL),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "+00:00",
};

/** JWT signing options */
export const jwt = {
  secret: process.env.JWT_SECRET || "dev-secret-change-me",
  expiresIn: process.env.JWT_EXPIRES || "30d",
};

/** HTTP port */
export const port = parseInt(process.env.PORT || "3300", 10);
