import { pathToFileURL } from "node:url";
import express from "express";
import { authRouter } from "./routes.js";
import { authRequired } from "./auth.js";
import { env, ensureDatabase } from "./config.js";
import { runMigrations } from "./schema.js";

export function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  // Debug probe used to exercise authRequired. Gated so it never ships to
  // production; tests do not set NODE_ENV=production, so it stays mounted there.
  if (process.env.NODE_ENV !== "production") {
    app.get("/api/_whoami", authRequired, (req, res) => {
      res.json({ userId: req.userId });
    });
  }
  // Terminal error-handling middleware. Mounted AFTER all routers so that any
  // error forwarded via next(err) (e.g. from asyncHandler-wrapped async route
  // handlers) produces a clean 500 instead of an unhandled rejection / hung
  // request. Internals are logged server-side and never leaked to the client.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });
  return app;
}

export async function start() {
  await ensureDatabase();
  await runMigrations();
  const app = buildApp();
  app.listen(env.port, () => {
    console.log(`web backend listening on :${env.port}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
