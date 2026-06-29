/**
 * auth.js — bcrypt helpers, JWT sign/verify, and Express auth middleware.
 *
 * Exports:
 *   hashPassword(plain)          → Promise<string>   bcrypt hash
 *   verifyPassword(plain, hash)  → Promise<boolean>
 *   signToken(userId)            → string            JWT
 *   verifyToken(token)           → { userId: number } | null
 *   requireAuth                  → Express middleware — sets req.userId or 401
 */

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { jwt as jwtConfig } from "./config.js";

const SALT_ROUNDS = 12;

/** Hash a plain-text password. */
export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

/** Compare plain text against a bcrypt hash. */
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/** Sign a JWT containing { sub: userId }. */
export function signToken(userId) {
  return jwt.sign({ sub: userId }, jwtConfig.secret, {
    expiresIn: jwtConfig.expiresIn,
  });
}

/**
 * Verify and decode a JWT.
 * @returns {{ userId: number }} on success, or null on failure.
 */
export function verifyToken(token) {
  try {
    const payload = jwt.verify(token, jwtConfig.secret);
    const userId = parseInt(payload.sub, 10);
    if (!Number.isFinite(userId)) return null;
    return { userId };
  } catch {
    return null;
  }
}

/**
 * Express middleware: validates Bearer token, injects req.userId.
 * Returns 401 { error: "..." } when token is missing or invalid.
 */
export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn." });
  }
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: "Token không hợp lệ hoặc đã hết hạn." });
  }
  req.userId = decoded.userId;
  next();
}
