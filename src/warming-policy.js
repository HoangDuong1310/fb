/**
 * warming-policy.js — pure policy helpers for account warming.
 *
 * No chrome/DOM deps so Node unit tests can cover scheduling and planning.
 * crawl.js imports these for config normalize, next-run delay, session plan,
 * write-action eligibility, and result aggregation.
 */

export const WARMING_ACTIONS = [
  "scrollFeed",
  "watchVideo",
  "openNotifications",
  "scrollGroups",
  "scrollReels",
  "reactPost",
  "reactReels",
];

export const WARMING_WRITE_ACTIONS = ["reactPost", "reactReels"];

export const WARMING_REACTION_CHANCE_PERCENT = 30;
export const WARMING_REACT_CHANCE = WARMING_REACTION_CHANCE_PERCENT / 100;
export const WARMING_REACT_REELS_CHANCE = WARMING_REACTION_CHANCE_PERCENT / 100;
export const WARMING_JITTER = 0.4;
/** Default quiet hours [start, end) in local hours (0–6). */
export const WARMING_QUIET_START = 0;
export const WARMING_QUIET_END = 6;

/** Defaults for warmingConfig (server setting). */
export const WARMING_DEFAULT = {
  enabled: false,
  intervalMinutes: 90,
  actionsPerRun: 3,
  actions: ["scrollFeed", "watchVideo", "openNotifications", "scrollGroups", "scrollReels"],
  // Prefer a dedicated owned tab; do not hijack the user's active FB tab by default.
  useOwnedTabOnly: true,
  maxSessionsPerDay: 8,
  maxWritePerDay: 3,
  writeCooldownMinutes: 90,
  minSessionGapMinutes: 20,
  // Configurable quiet hours (local machine clock). start inclusive, end exclusive.
  quietHoursStart: WARMING_QUIET_START,
  quietHoursEnd: WARMING_QUIET_END,
  // One shared probability for both post and Reels reactions.
  reactionChancePercent: WARMING_REACTION_CHANCE_PERCENT,
  // Basic risk throttle: after N recent failures, stretch next delay.
  riskFailThreshold: 3,
  riskBackoffMultiplier: 1.5,
};

/** Runtime state key shape (also stored under settings). */
export const WARMING_STATE_DEFAULT = {
  dayKey: "",
  sessionsToday: 0,
  writeCountToday: 0,
  lastSessionAt: 0,
  lastWriteAt: {}, // { reactPost: ts, reactReels: ts }
  recentActions: [], // last N action ids across sessions
  // Rolling risk signals (not necessarily day-scoped).
  recentFailCount: 0,
  lastRiskAt: 0,
  riskLevel: 0, // 0..3 soft score used for throttle
};

/**
 * Keep only known action ids; unique; fallback to default read-only set.
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizeWarmingActions(list) {
  const arr = Array.isArray(list) ? list.filter((a) => WARMING_ACTIONS.includes(a)) : [];
  const uniq = Array.from(new Set(arr));
  return uniq.length ? uniq : WARMING_DEFAULT.actions.slice();
}

/**
 * Normalize saved warming config with clamps and defaults.
 * @param {object|null|undefined} saved
 */
/**
 * Clamp hour-of-day 0..23. Invalid -> fallback.
 * @param {unknown} v
 * @param {number} fallback
 */
export function normalizeHour(v, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(23, n));
}

/**
 * Whether local hour `h` falls in quiet window [start, end).
 * Supports wrap-around (e.g. 22..6).
 * @param {number} h
 * @param {number} start
 * @param {number} end
 */
export function isInQuietHours(h, start, end) {
  const hour = ((h % 24) + 24) % 24;
  const s = normalizeHour(start, WARMING_QUIET_START);
  const e = normalizeHour(end, WARMING_QUIET_END);
  if (s === e) return false; // empty window = no quiet hours
  if (s < e) return hour >= s && hour < e;
  // Wrap: e.g. 22..6 → hour >= 22 || hour < 6
  return hour >= s || hour < e;
}

export function normalizeWarmingConfig(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  return {
    enabled: !!s.enabled,
    intervalMinutes: Math.max(
      15,
      Math.min(1440, parseInt(s.intervalMinutes, 10) || WARMING_DEFAULT.intervalMinutes)
    ),
    actionsPerRun: Math.max(
      1,
      Math.min(8, parseInt(s.actionsPerRun, 10) || WARMING_DEFAULT.actionsPerRun)
    ),
    actions: normalizeWarmingActions(s.actions),
    useOwnedTabOnly: s.useOwnedTabOnly != null ? !!s.useOwnedTabOnly : WARMING_DEFAULT.useOwnedTabOnly,
    maxSessionsPerDay: Math.max(
      1,
      Math.min(48, parseInt(s.maxSessionsPerDay, 10) || WARMING_DEFAULT.maxSessionsPerDay)
    ),
    // 0 is valid (disable writes); do not treat as missing via || default.
    maxWritePerDay: (() => {
      const n = parseInt(s.maxWritePerDay, 10);
      return Math.max(0, Math.min(20, Number.isFinite(n) ? n : WARMING_DEFAULT.maxWritePerDay));
    })(),
    writeCooldownMinutes: Math.max(
      15,
      Math.min(1440, parseInt(s.writeCooldownMinutes, 10) || WARMING_DEFAULT.writeCooldownMinutes)
    ),
    // 0 is valid (no min gap between sessions).
    minSessionGapMinutes: (() => {
      const n = parseInt(s.minSessionGapMinutes, 10);
      return Math.max(0, Math.min(720, Number.isFinite(n) ? n : WARMING_DEFAULT.minSessionGapMinutes));
    })(),
    quietHoursStart: normalizeHour(
      s.quietHoursStart != null ? s.quietHoursStart : WARMING_DEFAULT.quietHoursStart,
      WARMING_DEFAULT.quietHoursStart
    ),
    quietHoursEnd: normalizeHour(
      s.quietHoursEnd != null ? s.quietHoursEnd : WARMING_DEFAULT.quietHoursEnd,
      WARMING_DEFAULT.quietHoursEnd
    ),
    reactionChancePercent: (() => {
      const n = Number(s.reactionChancePercent);
      if (!Number.isFinite(n)) return WARMING_DEFAULT.reactionChancePercent;
      return Math.max(0, Math.min(100, n));
    })(),
    riskFailThreshold: Math.max(
      1,
      Math.min(20, parseInt(s.riskFailThreshold, 10) || WARMING_DEFAULT.riskFailThreshold)
    ),
    riskBackoffMultiplier: (() => {
      const n = Number(s.riskBackoffMultiplier);
      if (!Number.isFinite(n)) return WARMING_DEFAULT.riskBackoffMultiplier;
      return Math.max(1, Math.min(4, n));
    })(),
  };
}

/** Local calendar day key YYYY-MM-DD for a Date. */
export function dayKeyOf(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Roll daily counters when the calendar day changes.
 * @param {object} state
 * @param {Date} [now]
 */
export function rollWarmingStateDay(state, now = new Date()) {
  const base = { ...WARMING_STATE_DEFAULT, ...(state && typeof state === "object" ? state : {}) };
  const key = dayKeyOf(now);
  if (base.dayKey !== key) {
    return {
      ...base,
      dayKey: key,
      sessionsToday: 0,
      writeCountToday: 0,
      lastWriteAt: base.lastWriteAt && typeof base.lastWriteAt === "object" ? base.lastWriteAt : {},
      recentActions: Array.isArray(base.recentActions) ? base.recentActions.slice(-20) : [],
    };
  }
  return {
    ...base,
    lastWriteAt: base.lastWriteAt && typeof base.lastWriteAt === "object" ? base.lastWriteAt : {},
    recentActions: Array.isArray(base.recentActions) ? base.recentActions.slice(-20) : [],
  };
}

/**
 * Minutes until next warming fire (jitter + quiet hours + optional risk backoff).
 * Quiet hours [quietStart, quietEnd) local time (configurable via opts or defaults).
 * If fire would land in quiet hours, postpone to quiet end + 0..90 random minutes.
 *
 * @param {number} baseMinutes
 * @param {Date} [now]
 * @param {{
 *   random?: () => number,
 *   quietHoursStart?: number,
 *   quietHoursEnd?: number,
 *   riskLevel?: number,
 *   riskBackoffMultiplier?: number,
 * }} [opts]
 */
export function warmingNextDelayMinutes(baseMinutes, now = new Date(), opts = {}) {
  const rnd = typeof opts.random === "function" ? opts.random : Math.random;
  const base = Math.max(15, Math.min(1440, baseMinutes || WARMING_DEFAULT.intervalMinutes));
  const factor = 1 + (rnd() * 2 - 1) * WARMING_JITTER; // 0.6..1.4
  let delay = Math.max(15, Math.round(base * factor));

  // Basic risk throttle: stretch delay when riskLevel > 0.
  const riskLevel = Math.max(0, Math.min(3, Number(opts.riskLevel) || 0));
  const multRaw = Number(opts.riskBackoffMultiplier);
  const mult = Number.isFinite(multRaw) && multRaw >= 1 ? Math.min(4, multRaw) : WARMING_DEFAULT.riskBackoffMultiplier;
  if (riskLevel > 0) {
    delay = Math.max(15, Math.round(delay * Math.pow(mult, riskLevel)));
  }

  const quietStart = normalizeHour(
    opts.quietHoursStart != null ? opts.quietHoursStart : WARMING_QUIET_START,
    WARMING_QUIET_START
  );
  const quietEnd = normalizeHour(
    opts.quietHoursEnd != null ? opts.quietHoursEnd : WARMING_QUIET_END,
    WARMING_QUIET_END
  );

  const fireAt = new Date(now.getTime() + delay * 60000);
  const h = fireAt.getHours();

  if (isInQuietHours(h, quietStart, quietEnd)) {
    const wake = new Date(fireAt);
    wake.setHours(quietEnd, 0, 0, 0);
    if (wake.getTime() <= fireAt.getTime()) wake.setDate(wake.getDate() + 1);
    // 0..90 extra minutes so machines don't all wake at the same second.
    wake.setTime(wake.getTime() + Math.floor(rnd() * 90) * 60000);
    delay = Math.max(15, Math.round((wake.getTime() - now.getTime()) / 60000));
  }
  return delay;
}

/**
 * Soft risk score from recent failures / blocks.
 * @param {object} state
 * @param {object} [config]
 * @returns {number} 0..3
 */
export function computeRiskLevel(state, config) {
  const cfg = normalizeWarmingConfig(config || {});
  const st = state && typeof state === "object" ? state : {};
  const fails = Math.max(0, parseInt(st.recentFailCount, 10) || 0);
  const threshold = cfg.riskFailThreshold || WARMING_DEFAULT.riskFailThreshold;
  if (fails <= 0) return 0;
  if (fails < threshold) return 1;
  if (fails < threshold * 2) return 2;
  return 3;
}

/**
 * Update risk counters after a session outcome.
 * @param {object} state
 * @param {{ failed?: number, blocked?: boolean, succeeded?: number, sessionError?: boolean }} outcome
 */
export function applyRiskToWarmingState(state, outcome = {}) {
  const st = rollWarmingStateDay(state);
  let fails = Math.max(0, parseInt(st.recentFailCount, 10) || 0);
  const failed = Math.max(0, parseInt(outcome.failed, 10) || 0);
  if (outcome.blocked || outcome.sessionError || failed > 0) {
    fails += 1 + (failed > 1 ? 1 : 0);
  } else if ((outcome.succeeded || 0) > 0) {
    // Successful clean session decays risk.
    fails = Math.max(0, fails - 1);
  }
  const riskLevel = computeRiskLevel({ ...st, recentFailCount: fails }, {});
  return {
    ...st,
    recentFailCount: fails,
    lastRiskAt: Date.now(),
    riskLevel,
  };
}

/**
 * Session/day policy gate before starting a run.
 * @returns {{ ok: true } | { ok: false, reason: string, code: string }}
 */
export function canStartWarmingSession(cfg, state, now = new Date()) {
  const c = normalizeWarmingConfig(cfg);
  const st = rollWarmingStateDay(state, now);
  if (st.sessionsToday >= c.maxSessionsPerDay) {
    return {
      ok: false,
      code: "daily_session_cap",
      reason: `Đã đạt tối đa ${c.maxSessionsPerDay} phiên nuôi trong ngày.`,
    };
  }
  if (c.minSessionGapMinutes > 0 && st.lastSessionAt) {
    const gapMs = c.minSessionGapMinutes * 60000;
    const elapsed = now.getTime() - Number(st.lastSessionAt || 0);
    if (elapsed >= 0 && elapsed < gapMs) {
      const waitMin = Math.ceil((gapMs - elapsed) / 60000);
      return {
        ok: false,
        code: "session_gap",
        reason: `Cần nghỉ thêm ~${waitMin} phút giữa các phiên nuôi.`,
      };
    }
  }
  return { ok: true };
}

/**
 * Weighted shuffle: actions that appeared recently get lower weight.
 * @param {string[]} actions
 * @param {string[]} recentActions
 * @param {() => number} [random]
 */
export function weightedShuffle(actions, recentActions = [], random = Math.random) {
  const recent = Array.isArray(recentActions) ? recentActions : [];
  const scored = actions.map((a, idx) => {
    // More recent occurrences penalize more.
    let penalty = 0;
    for (let i = 0; i < recent.length; i++) {
      if (recent[recent.length - 1 - i] === a) {
        penalty += 1 / (i + 1);
      }
    }
    // Lower score = more preferred after inversion via random/score.
    const weight = 1 / (1 + penalty * 2);
    return { a, idx, key: random() / weight };
  });
  scored.sort((x, y) => x.key - y.key);
  return scored.map((s) => s.a);
}

/**
 * Build the ordered action plan for one warming session.
 *
 * Rules:
 * - Read-only actions: pick random count in 1..min(perRun, pool) (or fixed if forceAllRead).
 * - Manual runs respect actionsPerRun (no longer force all).
 * - Write actions use their configured human-like probability.
 * - forceWrite bypasses chance only; budget/cooldown still apply.
 * - Write actions appended at end.
 *
 * @param {object} args
 * @param {string[]} args.enabledActions
 * @param {number} args.actionsPerRun
 * @param {boolean} [args.manual]
 * @param {boolean} [args.forceAllRead] test mode: all read actions
 * @param {boolean} [args.forceWrite] test mode: bypass write probability only
 * @param {object} [args.state] warming state (daily counters / lastWriteAt / recent)
 * @param {object} [args.config] full config for write limits
 * @param {Date} [args.now]
 * @param {() => number} [args.random]
 */
export function planWarmingActions(args = {}) {
  const random = typeof args.random === "function" ? args.random : Math.random;
  const now = args.now || new Date();
  const cfg = normalizeWarmingConfig(args.config || {});
  const state = rollWarmingStateDay(args.state, now);
  const enabled = normalizeWarmingActions(args.enabledActions || cfg.actions);
  const perRun = Math.max(
    1,
    Math.min(8, parseInt(args.actionsPerRun, 10) || cfg.actionsPerRun)
  );

  const readonlyPool = enabled.filter((a) => !WARMING_WRITE_ACTIONS.includes(a));
  const writeEnabled = enabled.filter((a) => WARMING_WRITE_ACTIONS.includes(a));

  const shuffled = weightedShuffle(readonlyPool, state.recentActions, random);
  let readCount;
  if (args.forceAllRead) {
    readCount = shuffled.length;
  } else if (shuffled.length === 0) {
    readCount = 0;
  } else {
    // Random 1..min(perRun, pool) — not always the max (BUG-10).
    const maxN = Math.min(perRun, shuffled.length);
    readCount = 1 + Math.floor(random() * maxN);
  }

  const plan = [];
  for (let i = 0; i < readCount; i++) plan.push(shuffled[i]);

  for (const wa of writeEnabled) {
    const elig = evaluateWriteActionEligibility({
      action: wa,
      state,
      config: cfg,
      now,
      force: !!args.forceWrite,
      random,
    });
    if (elig.ok) plan.push(wa);
  }

  return {
    plan,
    readCount,
    writePlanned: plan.filter((a) => WARMING_WRITE_ACTIONS.includes(a)),
    skippedWrites: writeEnabled
      .filter((wa) => !plan.includes(wa))
      .map((wa) => ({
        action: wa,
        ...evaluateWriteActionEligibility({
          action: wa,
          state,
          config: cfg,
          now,
          force: !!args.forceWrite,
          random: () => 1, // deterministic "would skip chance" path for reporting
          skipChance: true,
        }),
      })),
  };
}

/**
 * Whether a write action may run this session.
 * @returns {{ ok: boolean, code?: string, reason?: string }}
 */
export function evaluateWriteActionEligibility({
  action,
  state,
  config,
  now = new Date(),
  force = false,
  random = Math.random,
  skipChance = false,
} = {}) {
  if (!WARMING_WRITE_ACTIONS.includes(action)) {
    return { ok: false, code: "not_write", reason: "Không phải hành động ghi." };
  }
  const cfg = normalizeWarmingConfig(config);
  const st = rollWarmingStateDay(state, now);

  if (st.writeCountToday >= cfg.maxWritePerDay) {
    return {
      ok: false,
      code: "write_daily_cap",
      reason: `Đã đạt trần ${cfg.maxWritePerDay} tương tác ghi trong ngày.`,
    };
  }

  const last = Number((st.lastWriteAt && st.lastWriteAt[action]) || 0);
  const coolMs = cfg.writeCooldownMinutes * 60000;
  if (last && now.getTime() - last < coolMs) {
    const waitMin = Math.ceil((coolMs - (now.getTime() - last)) / 60000);
    return {
      ok: false,
      code: "write_cooldown",
      reason: `Cooldown ${action}: còn ~${waitMin} phút.`,
    };
  }

  if (!force && !skipChance) {
    const configuredChance = Number(cfg.reactionChancePercent);
    const reactChance = Number.isFinite(configuredChance)
      ? Math.max(0, Math.min(100, configuredChance)) / 100
      : WARMING_REACT_CHANCE;
    if (random() >= reactChance) {
      return {
        ok: false,
        code: "write_chance",
        reason: "Bỏ qua theo xác suất (giống người, không react mỗi lượt).",
      };
    }
  }

  return { ok: true };
}

/**
 * Aggregate per-action results into session summary counters.
 * @param {Array<{ status: string }>} results
 */
export function aggregateWarmingResults(results = []) {
  const out = {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    unverified: 0,
    noOp: 0,
    deferred: 0,
    blocked: 0,
  };
  for (const r of results) {
    out.attempted += 1;
    const s = String((r && r.status) || "");
    if (s === "done" || s === "success") out.succeeded += 1;
    else if (s === "error") out.failed += 1;
    else if (s === "skipped") out.skipped += 1;
    else if (s === "unverified") out.unverified += 1;
    else if (s === "no_op") out.noOp += 1;
    else if (s === "deferred") out.deferred += 1;
    else if (s === "blocked") out.blocked += 1;
    else out.failed += 1;
  }
  return out;
}

/**
 * Map action detail → log status.
 * Execution failure always wins; explicit statuses must belong to the persisted
 * status vocabulary so malformed page output cannot poison aggregates.
 */
export function statusFromActionDetail(detail, okFlag) {
  if (okFlag === false) return "error";
  if (detail && detail.status) {
    const status = String(detail.status);
    const supported = new Set([
      "done",
      "success",
      "error",
      "blocked",
      "stopped",
      "no_op",
      "unverified",
      "skipped",
      "deferred",
    ]);
    return supported.has(status) ? status : "error";
  }
  if (!detail || typeof detail !== "object") return "done";
  if (detail.note === "no-video" || detail.note === "no-like-button" || detail.note === "no-content") {
    return "no_op";
  }
  if (detail.played === false) return "unverified";
  if (detail.reacted === false && detail.note) return "no_op";
  if (detail.reacted === true && detail.verified === false) return "unverified";
  if (detail.navigated === true && detail.verified === false) return "unverified";
  return "done";
}

/**
 * Update state after a finished session.
 * @param {object} state
 * @param {{ plan: string[], results: Array<{action:string,status:string}>, now?: Date }} session
 */
export function applySessionToWarmingState(state, session = {}) {
  const now = session.now || new Date();
  const st = rollWarmingStateDay(state, now);
  const plan = Array.isArray(session.plan) ? session.plan : [];
  const results = Array.isArray(session.results) ? session.results : [];

  const next = {
    ...st,
    sessionsToday: st.sessionsToday + 1,
    lastSessionAt: now.getTime(),
    recentActions: [...(st.recentActions || []), ...plan].slice(-20),
    lastWriteAt: { ...(st.lastWriteAt || {}) },
    recentFailCount: Math.max(0, parseInt(st.recentFailCount, 10) || 0),
    riskLevel: Math.max(0, parseInt(st.riskLevel, 10) || 0),
    lastRiskAt: st.lastRiskAt || 0,
  };

  for (const r of results) {
    if (!r || !WARMING_WRITE_ACTIONS.includes(r.action)) continue;
    if (r.status === "done" || r.status === "success" || r.status === "unverified") {
      // Count attempts that likely touched the write surface.
      next.writeCountToday = (next.writeCountToday || 0) + 1;
      next.lastWriteAt[r.action] = now.getTime();
    }
  }

  // Optional inline risk update when session provides outcome flags.
  if (session.applyRisk) {
    const failed = results.filter((r) => r && r.status === "error").length;
    const blocked = results.some((r) => r && r.status === "blocked") || !!session.blocked;
    const succeeded = results.filter(
      (r) => r && (r.status === "done" || r.status === "success")
    ).length;
    return applyRiskToWarmingState(next, {
      failed,
      blocked,
      succeeded,
      sessionError: !!session.sessionError,
    });
  }

  return next;
}
