import "dotenv/config";
import mysql from "mysql2/promise";

export function parseDatabaseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid DATABASE_URL: " + url);
  }
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password || ""),
    database: u.pathname.replace(/^\//, ""),
  };
}

export function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set in production");
  }
  return "dev-secret";
}

export const env = {
  databaseUrl: process.env.DATABASE_URL || "mysql://root:@localhost:3306/fb_crawler",
  get jwtSecret() {
    return resolveJwtSecret();
  },
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
