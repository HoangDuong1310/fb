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
