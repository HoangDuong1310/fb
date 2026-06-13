import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureDatabase, getPool } from "../config.js";
import { runMigrations } from "../schema.js";

test("runMigrations creates all 11 tables, seeds sell signals, and is idempotent", async (t) => {
  try { await ensureDatabase(); } catch { return t.skip("MySQL not reachable"); }
  await runMigrations();
  const [rows] = await getPool().query("SHOW TABLES");
  const names = rows.map((r) => Object.values(r)[0]);
  for (const want of [
    "users","user_share_prefs","posts","groups","comments","conversations",
    "advisories","products","group_prices","sources","learned_keywords",
  ]) assert.ok(names.includes(want), `missing table ${want}`);

  const [seed] = await getPool().query(
    "SELECT COUNT(*) AS n FROM learned_keywords WHERE type='sell_signal'"
  );
  assert.equal(seed[0].n, 9, "expected 9 seeded sell_signal keywords");

  // Idempotency: a second run must not throw and must not duplicate seeds.
  await runMigrations();
  const [seed2] = await getPool().query(
    "SELECT COUNT(*) AS n FROM learned_keywords WHERE type='sell_signal'"
  );
  assert.equal(seed2[0].n, 9, "seed count must stay 9 after re-run (INSERT IGNORE)");

  await getPool().end();
});
