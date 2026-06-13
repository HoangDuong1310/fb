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
