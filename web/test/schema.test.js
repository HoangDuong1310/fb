import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureDatabase, getPool } from "../config.js";
import { runMigrations } from "../schema.js";

test("runMigrations creates all 11 tables", async (t) => {
  try { await ensureDatabase(); } catch { return t.skip("MySQL not reachable"); }
  await runMigrations();
  const [rows] = await getPool().query("SHOW TABLES");
  const names = rows.map((r) => Object.values(r)[0]);
  for (const want of [
    "users","user_share_prefs","posts","groups","comments","conversations",
    "advisories","products","group_prices","sources","learned_keywords",
  ]) assert.ok(names.includes(want), `missing table ${want}`);
  await getPool().end();
});
