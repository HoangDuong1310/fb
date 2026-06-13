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
  app.get("/api/_whoami", authRequired, (req, res) => {
    res.json({ userId: req.userId });
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
