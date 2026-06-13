import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDatabaseUrl } from "../config.js";

test("parseDatabaseUrl extracts mysql parts with empty password", () => {
  const c = parseDatabaseUrl("mysql://root:@localhost:3306/fb_crawler");
  assert.equal(c.host, "localhost");
  assert.equal(c.port, 3306);
  assert.equal(c.user, "root");
  assert.equal(c.password, "");
  assert.equal(c.database, "fb_crawler");
});
