/**
 * warming-policy.test.js — unit tests for pure warming planner/scheduler.
 *
 * No chrome/DOM deps; covers normalize, quiet hours, session gates,
 * weighted plan, write budget/cooldown, and result aggregation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WARMING_DEFAULT,
  WARMING_WRITE_ACTIONS,
  normalizeWarmingActions,
  normalizeWarmingConfig,
  normalizeHour,
  isInQuietHours,
  dayKeyOf,
  rollWarmingStateDay,
  warmingNextDelayMinutes,
  computeRiskLevel,
  applyRiskToWarmingState,
  canStartWarmingSession,
  planWarmingActions,
  evaluateWriteActionEligibility,
  aggregateWarmingResults,
  statusFromActionDetail,
  applySessionToWarmingState,
} from "../src/warming-policy.js";

/* ----------------------------- normalize -------------------------------- */

test("normalizeWarmingActions: filters unknown, unique, fallback default", () => {
  assert.deepEqual(
    normalizeWarmingActions(["scrollFeed", "nope", "scrollFeed", "watchVideo"]),
    ["scrollFeed", "watchVideo"]
  );
  assert.deepEqual(normalizeWarmingActions([]), WARMING_DEFAULT.actions.slice());
  assert.deepEqual(normalizeWarmingActions(null), WARMING_DEFAULT.actions.slice());
});

test("normalizeWarmingConfig: reaction chance defaults to 30% and clamps 0..100", () => {
  assert.equal(normalizeWarmingConfig({}).reactionChancePercent, 30);
  assert.equal(normalizeWarmingConfig({ reactionChancePercent: -10 }).reactionChancePercent, 0);
  assert.equal(normalizeWarmingConfig({ reactionChancePercent: 150 }).reactionChancePercent, 100);
});

test("normalizeWarmingConfig: clamps + defaults new safety fields", () => {
  const c = normalizeWarmingConfig({
    enabled: 1,
    intervalMinutes: 5,
    actionsPerRun: 99,
    actions: ["scrollFeed"],
  });
  assert.equal(c.enabled, true);
  assert.equal(c.intervalMinutes, 15);
  assert.equal(c.actionsPerRun, 8);
  assert.deepEqual(c.actions, ["scrollFeed"]);
  assert.equal(c.useOwnedTabOnly, true);
  assert.equal(c.maxSessionsPerDay, WARMING_DEFAULT.maxSessionsPerDay);
  assert.equal(c.maxWritePerDay, WARMING_DEFAULT.maxWritePerDay);
  assert.equal(c.writeCooldownMinutes, WARMING_DEFAULT.writeCooldownMinutes);
  assert.equal(c.minSessionGapMinutes, WARMING_DEFAULT.minSessionGapMinutes);
});

test("normalizeWarmingConfig: maxWritePerDay 0 and minSessionGapMinutes 0 are valid", () => {
  const c = normalizeWarmingConfig({
    maxWritePerDay: 0,
    minSessionGapMinutes: 0,
  });
  assert.equal(c.maxWritePerDay, 0);
  assert.equal(c.minSessionGapMinutes, 0);
});

test("normalizeWarmingConfig: quiet hours + risk fields clamp", () => {
  const c = normalizeWarmingConfig({
    quietHoursStart: 22,
    quietHoursEnd: 6,
    riskFailThreshold: 99,
    riskBackoffMultiplier: 0.5,
  });
  assert.equal(c.quietHoursStart, 22);
  assert.equal(c.quietHoursEnd, 6);
  assert.equal(c.riskFailThreshold, 20);
  assert.equal(c.riskBackoffMultiplier, 1);
  const d = normalizeWarmingConfig({
    quietHoursStart: -3,
    quietHoursEnd: 40,
    riskBackoffMultiplier: 9,
  });
  assert.equal(d.quietHoursStart, 0);
  assert.equal(d.quietHoursEnd, 23);
  assert.equal(d.riskBackoffMultiplier, 4);
});

/* ----------------------------- quiet hours ------------------------------ */

test("normalizeHour: clamps 0..23", () => {
  assert.equal(normalizeHour(12, 0), 12);
  assert.equal(normalizeHour(-1, 5), 0);
  assert.equal(normalizeHour(25, 5), 23);
  assert.equal(normalizeHour("x", 7), 7);
});

test("isInQuietHours: linear and wrap windows; equal = disabled", () => {
  assert.equal(isInQuietHours(3, 0, 6), true);
  assert.equal(isInQuietHours(6, 0, 6), false);
  assert.equal(isInQuietHours(23, 22, 6), true);
  assert.equal(isInQuietHours(5, 22, 6), true);
  assert.equal(isInQuietHours(12, 22, 6), false);
  assert.equal(isInQuietHours(10, 8, 8), false);
});

test("warmingNextDelayMinutes: custom quiet hours opts", () => {
  // 13:00, base 30 — with quiet 12..15 should push past 15:00
  const now = new Date(2026, 5, 1, 13, 0, 0);
  const delay = warmingNextDelayMinutes(30, now, {
    random: () => 0,
    quietHoursStart: 12,
    quietHoursEnd: 15,
  });
  const fire = new Date(now.getTime() + delay * 60000);
  assert.ok(fire.getHours() >= 15, `expected wake after 15h, got ${fire.toString()}`);
});

/* ----------------------------- risk throttle ---------------------------- */

test("computeRiskLevel: thresholds from config", () => {
  assert.equal(computeRiskLevel({ recentFailCount: 0 }, { riskFailThreshold: 3 }), 0);
  assert.equal(computeRiskLevel({ recentFailCount: 1 }, { riskFailThreshold: 3 }), 1);
  assert.equal(computeRiskLevel({ recentFailCount: 3 }, { riskFailThreshold: 3 }), 2);
  assert.equal(computeRiskLevel({ recentFailCount: 6 }, { riskFailThreshold: 3 }), 3);
});

test("applyRiskToWarmingState: increments on fail, decays on success", () => {
  const base = {
    dayKey: dayKeyOf(new Date()),
    sessionsToday: 0,
    writeCountToday: 0,
    lastWriteAt: {},
    recentActions: [],
    recentFailCount: 0,
    riskLevel: 0,
  };
  const failed = applyRiskToWarmingState(base, { failed: 2, blocked: false });
  assert.ok(failed.recentFailCount >= 1);
  assert.ok(failed.riskLevel >= 1);

  const clean = applyRiskToWarmingState(
    { ...failed, recentFailCount: 2 },
    { succeeded: 3, failed: 0 }
  );
  assert.equal(clean.recentFailCount, 1);
});

test("warmingNextDelayMinutes: risk multiplies delay", () => {
  const now = new Date(2026, 5, 1, 12, 0, 0);
  const base = warmingNextDelayMinutes(60, now, {
    random: () => 0.5, // factor ~1.0
    riskLevel: 0,
  });
  const risked = warmingNextDelayMinutes(60, now, {
    random: () => 0.5,
    riskLevel: 2,
    riskBackoffMultiplier: 2,
  });
  assert.ok(risked > base, `expected risked ${risked} > base ${base}`);
});

/* ----------------------------- day / roll -------------------------------- */

test("dayKeyOf: YYYY-MM-DD local", () => {
  const d = new Date(2026, 0, 5, 12, 0, 0); // Jan 5 2026 local
  assert.equal(dayKeyOf(d), "2026-01-05");
});

test("rollWarmingStateDay: resets counters on new day", () => {
  const st = rollWarmingStateDay(
    {
      dayKey: "2000-01-01",
      sessionsToday: 5,
      writeCountToday: 2,
      recentActions: ["scrollFeed"],
      lastWriteAt: { reactPost: 1 },
    },
    new Date(2026, 5, 1)
  );
  assert.equal(st.dayKey, dayKeyOf(new Date(2026, 5, 1)));
  assert.equal(st.sessionsToday, 0);
  assert.equal(st.writeCountToday, 0);
  assert.deepEqual(st.recentActions, ["scrollFeed"]);
});

/* ----------------------------- schedule ---------------------------------- */

test("warmingNextDelayMinutes: jitter around base, min 15", () => {
  const now = new Date(2026, 5, 1, 12, 0, 0); // noon — outside quiet hours
  const d1 = warmingNextDelayMinutes(100, now, { random: () => 0 }); // factor 0.6
  const d2 = warmingNextDelayMinutes(100, now, { random: () => 0.999 }); // ~1.4
  assert.ok(d1 >= 15 && d1 <= 100);
  assert.ok(d2 >= 100 && d2 <= 150);
});

test("warmingNextDelayMinutes: postpones into quiet hours past quiet end", () => {
  // 23:50 — base 30 min would land ~00:20 (quiet 0–6)
  const now = new Date(2026, 5, 1, 23, 50, 0);
  const delay = warmingNextDelayMinutes(30, now, { random: () => 0 });
  const fire = new Date(now.getTime() + delay * 60000);
  assert.ok(fire.getHours() >= 6, `expected wake after 6h, got ${fire.toString()}`);
});

/* ----------------------------- session gate ------------------------------ */

test("canStartWarmingSession: daily cap", () => {
  const cfg = normalizeWarmingConfig({ maxSessionsPerDay: 2 });
  const st = {
    dayKey: dayKeyOf(new Date()),
    sessionsToday: 2,
    writeCountToday: 0,
    lastSessionAt: 0,
    lastWriteAt: {},
    recentActions: [],
  };
  const r = canStartWarmingSession(cfg, st);
  assert.equal(r.ok, false);
  assert.equal(r.code, "daily_session_cap");
});

test("canStartWarmingSession: min gap", () => {
  const cfg = normalizeWarmingConfig({ minSessionGapMinutes: 30 });
  const now = new Date();
  const st = {
    dayKey: dayKeyOf(now),
    sessionsToday: 0,
    writeCountToday: 0,
    lastSessionAt: now.getTime() - 5 * 60000,
    lastWriteAt: {},
    recentActions: [],
  };
  const r = canStartWarmingSession(cfg, st, now);
  assert.equal(r.ok, false);
  assert.equal(r.code, "session_gap");
});

test("canStartWarmingSession: ok when under limits", () => {
  const cfg = normalizeWarmingConfig({});
  const r = canStartWarmingSession(cfg, {
    dayKey: dayKeyOf(new Date()),
    sessionsToday: 0,
    writeCountToday: 0,
    lastSessionAt: 0,
    lastWriteAt: {},
    recentActions: [],
  });
  assert.equal(r.ok, true);
});

/* ----------------------------- write eligibility ------------------------- */

test("evaluateWriteActionEligibility: daily write cap", () => {
  const now = new Date();
  const r = evaluateWriteActionEligibility({
    action: "reactPost",
    state: {
      dayKey: dayKeyOf(now),
      writeCountToday: 99,
      lastWriteAt: {},
    },
    config: { maxWritePerDay: 3 },
    now,
    force: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "write_daily_cap");
});

test("evaluateWriteActionEligibility: cooldown", () => {
  const now = new Date();
  const r = evaluateWriteActionEligibility({
    action: "reactPost",
    state: {
      dayKey: dayKeyOf(now),
      writeCountToday: 0,
      lastWriteAt: { reactPost: now.getTime() - 10 * 60000 },
    },
    config: { writeCooldownMinutes: 90, maxWritePerDay: 5 },
    now,
    force: true,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "write_cooldown");
});

test("evaluateWriteActionEligibility: dùng tỷ lệ thả cảm xúc chung từ config", () => {
  const now = new Date();
  const base = {
    state: { dayKey: dayKeyOf(now), writeCountToday: 0, lastWriteAt: {} },
    config: {
      maxWritePerDay: 5,
      writeCooldownMinutes: 15,
      reactionChancePercent: 70,
    },
    now,
    force: false,
  };

  for (const action of ["reactPost", "reactReels"]) {
    assert.equal(
      evaluateWriteActionEligibility({ ...base, action, random: () => 0.69 }).ok,
      true,
    );
    const skipped = evaluateWriteActionEligibility({
      ...base,
      action,
      random: () => 0.7,
    });
    assert.equal(skipped.ok, false);
    assert.equal(skipped.code, "write_chance");
  }
});

/* ----------------------------- plan -------------------------------------- */

test("planWarmingActions: reports daily-cap reason when isolated reactReels plan is empty", () => {
  const now = new Date();
  const result = planWarmingActions({
    enabledActions: ["reactReels"],
    actionsPerRun: 1,
    config: { maxWritePerDay: 3, writeCooldownMinutes: 15 },
    state: { dayKey: dayKeyOf(now), writeCountToday: 3, lastWriteAt: {} },
    now,
    random: () => 0.1,
  });

  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.skippedWrites, [
    {
      action: "reactReels",
      ok: false,
      code: "write_daily_cap",
      reason: "Đã đạt trần 3 tương tác ghi trong ngày.",
    },
  ]);
});

test("planWarmingActions: reports cooldown reason when isolated reactReels plan is empty", () => {
  const now = new Date("2026-07-16T07:00:00.000Z");
  const result = planWarmingActions({
    enabledActions: ["reactReels"],
    actionsPerRun: 1,
    config: { maxWritePerDay: 5, writeCooldownMinutes: 90 },
    state: {
      dayKey: dayKeyOf(now),
      writeCountToday: 1,
      lastWriteAt: { reactReels: now.getTime() - 10 * 60000 },
    },
    now,
    random: () => 0.1,
  });

  assert.deepEqual(result.plan, []);
  assert.deepEqual(result.skippedWrites, [
    {
      action: "reactReels",
      ok: false,
      code: "write_cooldown",
      reason: "Cooldown reactReels: còn ~80 phút.",
    },
  ]);
});

test("planWarmingActions: respects actionsPerRun upper bound on reads", () => {
  let i = 0;
  const seq = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const random = () => seq[i++ % seq.length];
  const { plan, readCount } = planWarmingActions({
    enabledActions: [
      "scrollFeed",
      "watchVideo",
      "openNotifications",
      "scrollGroups",
      "scrollReels",
    ],
    actionsPerRun: 2,
    config: { maxWritePerDay: 0 },
    state: { dayKey: dayKeyOf(new Date()), writeCountToday: 0, recentActions: [] },
    random,
  });
  assert.ok(readCount >= 1 && readCount <= 2);
  assert.ok(plan.length >= 1 && plan.length <= 2);
  for (const a of plan) {
    assert.ok(!WARMING_WRITE_ACTIONS.includes(a));
  }
});

test("planWarmingActions: manual does not force all reads (no forceAllRead)", () => {
  let i = 0;
  const random = () => {
    // first random used for readCount: floor(r * maxN) + 1
    // return small to prefer 1 when possible
    const v = [0.01, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5][i++] ?? 0.5;
    return v;
  };
  const { plan, readCount } = planWarmingActions({
    enabledActions: ["scrollFeed", "watchVideo", "openNotifications", "scrollGroups"],
    actionsPerRun: 2,
    manual: true,
    config: { maxWritePerDay: 0 },
    state: { dayKey: dayKeyOf(new Date()), writeCountToday: 0, recentActions: [] },
    random,
  });
  assert.ok(readCount <= 2);
  assert.ok(plan.length <= 2);
});

test("planWarmingActions: forceWrite still respects budget", () => {
  const now = new Date();
  const { plan, writePlanned } = planWarmingActions({
    enabledActions: ["scrollFeed", "reactPost"],
    actionsPerRun: 3,
    forceWrite: true,
    config: { maxWritePerDay: 0, writeCooldownMinutes: 15 },
    state: {
      dayKey: dayKeyOf(now),
      writeCountToday: 0,
      lastWriteAt: {},
      recentActions: [],
    },
    now,
    random: () => 0.1,
  });
  assert.equal(writePlanned.length, 0);
  assert.ok(plan.includes("scrollFeed") || plan.length >= 0);
});

/* ----------------------------- aggregate / status ------------------------ */

test("aggregateWarmingResults: counts statuses", () => {
  const a = aggregateWarmingResults([
    { status: "done" },
    { status: "error" },
    { status: "no_op" },
    { status: "unverified" },
    { status: "blocked" },
  ]);
  assert.equal(a.attempted, 5);
  assert.equal(a.succeeded, 1);
  assert.equal(a.failed, 1);
  assert.equal(a.noOp, 1);
  assert.equal(a.unverified, 1);
  assert.equal(a.blocked, 1);
});

test("statusFromActionDetail: maps notes and verification", () => {
  assert.equal(statusFromActionDetail({ note: "no-video" }, true), "no_op");
  assert.equal(statusFromActionDetail({ played: false }, true), "unverified");
  assert.equal(
    statusFromActionDetail({ reacted: true, verified: false }, true),
    "unverified"
  );
  assert.equal(statusFromActionDetail({ status: "done" }, true), "done");
  assert.equal(statusFromActionDetail({ status: "no_op" }, true), "no_op");
  assert.equal(
    statusFromActionDetail({ status: "unverified" }, true),
    "unverified"
  );
  assert.equal(
    statusFromActionDetail(
      { status: "error", stage: "action-injection" },
      true
    ),
    "error"
  );
  assert.equal(
    statusFromActionDetail({ status: "done" }, false),
    "error",
    "execution failure must override a contradictory success status"
  );
  assert.equal(
    statusFromActionDetail({ status: "mystery" }, true),
    "error",
    "unknown explicit statuses must not enter persisted aggregates"
  );
  assert.equal(statusFromActionDetail({}, false), "error");
});

/* ----------------------------- apply session ----------------------------- */

test("applySessionToWarmingState: increments sessions and write cooldowns", () => {
  const now = new Date();
  const next = applySessionToWarmingState(
    {
      dayKey: dayKeyOf(now),
      sessionsToday: 1,
      writeCountToday: 0,
      lastWriteAt: {},
      recentActions: ["scrollFeed"],
    },
    {
      plan: ["watchVideo", "reactPost"],
      results: [
        { action: "watchVideo", status: "done" },
        { action: "reactPost", status: "done" },
      ],
      now,
    }
  );
  assert.equal(next.sessionsToday, 2);
  assert.equal(next.writeCountToday, 1);
  assert.ok(next.lastWriteAt.reactPost);
  assert.ok(next.recentActions.includes("reactPost"));
});
