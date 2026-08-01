/**
 * Test loại-trừ-chéo cho FOREGROUND MUTEX dùng chung (Hướng B).
 *
 * VÌ SAO CẦN TEST NÀY:
 * Trước Hướng B, 4 scheduler nền (auto-crawl, warming, reply-watch, jobTick) mỗi
 * cái chỉ tự canh bằng một cờ RAM riêng, KHÔNG biết đến nhau, nhưng lại cùng
 * tranh MỘT tài nguyên duy nhất: tab Facebook foreground (focus). Hai tab
 * foreground chạy song song sẽ cướp focus của nhau => hỏng bắt template GraphQL,
 * và cùng lúc dễ khiến FB gắn cờ hành vi bất thường.
 *
 * Hướng B gộp về MỘT `foregroundLock` trong chrome.storage.session (bền qua các
 * lần SW ngủ/thức) kèm `owner` + heartbeat + TTL. Các test dưới đây khoá các
 * tính chất LIÊN-SCHEDULER mà bộ test cũ (autocrawl-lock) chưa phủ:
 *   1. warming KHÔNG chiếm được khi autocrawl đang giữ lock còn sống, và ngược lại.
 *   2. `owner` được ghi đúng để telemetry biết ai đang giữ (readForegroundLock).
 *   3. Lock rác (owner đã chết, quá TTL) được BẤT KỲ scheduler nào khác chiếm lại.
 *   4. Chỉ MỘT scheduler thắng khi 4 cái cùng giành trên cùng state (mutex thật).
 *   5. release chỉ nhả lock của MÌNH — nhả nhầm không xoá lock owner khác.
 *   6. touch của owner đang giữ trả false khi lock đã bị owner khác chiếm mất.
 *
 * LƯU Ý KỸ THUẬT: crawl.js chạm `chrome` ngay ở tầng module nên phải dựng stub
 * TRƯỚC khi import động (giống test/autocrawl-lock.test.js).
 */
import test from "node:test";
import assert from "node:assert/strict";

/* --------- Stub chrome: storage.session có state thật để kiểm tra --------- */
const sessionStore = new Map();
// Bật cờ này để mô phỏng storage.session không dùng được (môi trường lạ).
let sessionBroken = false;

function assertUsable() {
  if (sessionBroken) throw new Error("session storage unavailable");
}

globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => {
        assertUsable();
        const k = typeof key === "string" ? key : null;
        if (!k) return Object.fromEntries(sessionStore);
        return sessionStore.has(k) ? { [k]: sessionStore.get(k) } : {};
      },
      set: async (obj) => {
        assertUsable();
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
      remove: async (key) => {
        assertUsable();
        sessionStore.delete(key);
      },
    },
    local: {
      get: (_k, cb) => cb && cb({}),
      set: (_o, cb) => cb && cb(),
    },
  },
  tabs: {
    query: (_q, cb) => cb && cb([]),
    create: (_o, cb) => cb && cb({ id: 1 }),
    update: async () => {},
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async () => ({}),
  },
  scripting: { executeScript: async () => [] },
  runtime: { sendMessage: () => {}, lastError: null },
  alarms: {
    create() {},
    get: async () => null,
    onAlarm: { addListener() {} },
    clear: async () => {},
  },
};

const {
  FOREGROUND_LOCK_KEY,
  FOREGROUND_LOCK_TTL_MS,
  isForegroundLockStale,
  acquireForegroundLock,
  touchForegroundLock,
  releaseForegroundLock,
} = await import("../src/crawl.js");

// readForegroundLock không nằm trong export (nội bộ dùng cho telemetry), nên đọc
// trực tiếp state qua stub để kiểm chứng `owner` được ghi đúng.
function readLock() {
  return sessionStore.has(FOREGROUND_LOCK_KEY)
    ? sessionStore.get(FOREGROUND_LOCK_KEY)
    : null;
}

function reset() {
  sessionStore.clear();
  sessionBroken = false;
}

/* ---------------- 1. Loại trừ chéo giữa các scheduler ------------------- */

test("cross: warming KHÔNG chiếm được khi autocrawl đang giữ lock còn sống", async () => {
  reset();
  const now = 1_000_000;
  const crawlToken = await acquireForegroundLock("autocrawl", now);
  assert.ok(crawlToken, "autocrawl phải chiếm được lock lần đầu");

  // warming giành ngay sau đó (cùng thời điểm còn sống) => phải bị từ chối.
  const warmToken = await acquireForegroundLock("warming", now + 1000);
  assert.equal(warmToken, "", "warming phải bị chặn khi autocrawl còn giữ lock");

  // Lock vẫn thuộc autocrawl, không bị warming ghi đè owner.
  assert.equal(readLock().owner, "autocrawl");
  assert.equal(readLock().token, crawlToken);
});

test("cross: autocrawl KHÔNG chiếm được khi warming đang giữ lock còn sống", async () => {
  reset();
  const now = 2_000_000;
  const warmToken = await acquireForegroundLock("warming", now);
  assert.ok(warmToken);

  const crawlToken = await acquireForegroundLock("autocrawl", now + 500);
  assert.equal(crawlToken, "", "autocrawl phải bị chặn khi warming còn giữ lock");
  assert.equal(readLock().owner, "warming");
});

test("cross: replywatch và jobtick cũng bị chặn khi có owner khác giữ lock", async () => {
  reset();
  const now = 3_000_000;
  const warmToken = await acquireForegroundLock("warming", now);
  assert.ok(warmToken);

  assert.equal(await acquireForegroundLock("replywatch", now + 100), "");
  assert.equal(await acquireForegroundLock("jobtick", now + 200), "");
  // Vẫn còn nguyên owner warming.
  assert.equal(readLock().owner, "warming");
});

/* ---------------- 2. owner được ghi đúng cho telemetry ------------------ */

test("owner: mỗi scheduler ghi đúng nhãn owner của mình vào lock", async () => {
  for (const owner of ["autocrawl", "warming", "replywatch", "jobtick"]) {
    reset();
    const token = await acquireForegroundLock(owner, 5_000_000);
    assert.ok(token);
    assert.equal(readLock().owner, owner, `owner phải là "${owner}"`);
    assert.equal(readLock().token, token);
    // startedAt và heartbeatAt được đặt bằng thời điểm chiếm.
    assert.equal(readLock().startedAt, 5_000_000);
    assert.equal(readLock().heartbeatAt, 5_000_000);
  }
});

test("owner mặc định là 'unknown' khi gọi không truyền owner", async () => {
  reset();
  const token = await acquireForegroundLock(undefined, 5_500_000);
  assert.ok(token);
  assert.equal(readLock().owner, "unknown");
});

/* ---------- 3. Lock rác (owner đã chết) được owner khác chiếm lại ------- */

test("stale: lock của owner đã chết (quá TTL) => owner khác chiếm lại được", async () => {
  reset();
  const start = 10_000_000;
  const deadToken = await acquireForegroundLock("warming", start);
  assert.ok(deadToken);

  // SW giữ lock (warming) chết hẳn, không heartbeat. Quá TTL sau đó, một
  // scheduler KHÁC (autocrawl) thức dậy phải chiếm lại được — không kẹt vĩnh viễn.
  const later = start + FOREGROUND_LOCK_TTL_MS + 1;
  const crawlToken = await acquireForegroundLock("autocrawl", later);
  assert.ok(crawlToken, "autocrawl phải chiếm lại được lock rác");
  assert.notEqual(crawlToken, deadToken);
  assert.equal(readLock().owner, "autocrawl", "owner phải đổi sang autocrawl");
});

test("stale: lock rác chiếm lại được bởi CẢ 4 owner (không phân biệt ai)", async () => {
  const start = 20_000_000;
  for (const owner of ["autocrawl", "warming", "replywatch", "jobtick"]) {
    reset();
    // Dựng sẵn một lock rác của owner "khác" đã chết.
    sessionStore.set(FOREGROUND_LOCK_KEY, {
      token: "dead-token",
      owner: "someone-else",
      startedAt: start,
      heartbeatAt: start,
    });
    const later = start + FOREGROUND_LOCK_TTL_MS + 1;
    const token = await acquireForegroundLock(owner, later);
    assert.ok(token, `${owner} phải chiếm lại được lock rác`);
    assert.equal(readLock().owner, owner);
  }
});

/* ---------------- 4. Mutex thật: chỉ MỘT scheduler thắng --------------- */

test("mutex: 4 scheduler cùng giành trên cùng state => chỉ 1 thắng", async () => {
  reset();
  const now = 30_000_000;
  // Chạy tuần tự trên CÙNG một sessionStore (mô phỏng cùng một instance SW đọc
  // cùng state). Vì get/set không nguyên tử ở MV3, đây là kịch bản re-entry
  // trong cùng instance — kẻ đầu tiên chiếm, phần còn lại phải bị chặn.
  const results = [];
  for (const owner of ["autocrawl", "warming", "replywatch", "jobtick"]) {
    results.push(await acquireForegroundLock(owner, now));
  }
  const winners = results.filter((t) => t !== "");
  assert.equal(winners.length, 1, "chỉ đúng MỘT scheduler được chiếm lock");
  // Người thắng là kẻ giành đầu tiên (autocrawl).
  assert.equal(results[0], winners[0]);
  assert.equal(readLock().owner, "autocrawl");
});

/* ------------- 5. release chỉ nhả lock của MÌNH (liên owner) ----------- */

test("release: warming nhả token của mình KHÔNG xoá lock autocrawl đang giữ", async () => {
  reset();
  const now = 40_000_000;
  const crawlToken = await acquireForegroundLock("autocrawl", now);
  assert.ok(crawlToken);

  // warming thua (token rỗng) rồi lỡ gọi release với token rỗng => không xoá.
  await releaseForegroundLock("");
  assert.ok(readLock(), "lock autocrawl vẫn còn sau release token rỗng");

  // warming cầm một token cũ/khác (giả lập nhầm lẫn) => cũng không được xoá.
  await releaseForegroundLock("token-cua-warming-cu");
  assert.ok(readLock(), "release token lạ không được xoá lock owner khác");
  assert.equal(readLock().owner, "autocrawl");

  // Chính chủ autocrawl nhả thì mới xoá.
  await releaseForegroundLock(crawlToken);
  assert.equal(readLock(), null, "chính chủ nhả => lock được xoá");
});

/* -------- 6. touch của owner cũ trả false khi bị owner mới chiếm ------- */

test("touch: owner cũ heartbeat trả false sau khi owner mới đã chiếm lock rác", async () => {
  reset();
  const start = 50_000_000;
  const oldToken = await acquireForegroundLock("replywatch", start);
  assert.ok(oldToken);

  // replywatch ngủ quá TTL, warming chiếm lại.
  const later = start + FOREGROUND_LOCK_TTL_MS + 1;
  const newToken = await acquireForegroundLock("warming", later);
  assert.ok(newToken);
  assert.notEqual(newToken, oldToken);

  // replywatch thức lại, heartbeat bằng token cũ => phải trả false để TỰ DỪNG,
  // không chạy chồng lên tab của warming.
  const beat = await touchForegroundLock(oldToken, later + 1000);
  assert.equal(beat, false, "owner cũ phải nhận false để tự dừng");
  // Lock vẫn thuộc warming, heartbeat của owner cũ không cướp lại được.
  assert.equal(readLock().owner, "warming");
  assert.equal(readLock().token, newToken);
});

test("touch: chính chủ heartbeat giữ nguyên owner và startedAt, chỉ dời heartbeatAt", async () => {
  reset();
  const start = 60_000_000;
  const token = await acquireForegroundLock("warming", start);
  assert.ok(token);

  const beatAt = start + 30_000;
  const ok = await touchForegroundLock(token, beatAt);
  assert.equal(ok, true);
  assert.equal(readLock().owner, "warming", "owner giữ nguyên qua heartbeat");
  assert.equal(readLock().startedAt, start, "startedAt không đổi");
  assert.equal(readLock().heartbeatAt, beatAt, "heartbeatAt được dời lên");
});

/* -------- 7. storage lỗi: acquire vẫn cho chạy (chốt RAM là tuyến cuối) - */

test("storage lỗi: acquire trả token (cho chạy) — chốt RAM của scheduler là tuyến cuối", async () => {
  reset();
  sessionBroken = true;
  const token = await acquireForegroundLock("autocrawl", 70_000_000);
  assert.ok(token, "storage hỏng => vẫn trả token để scheduler chạy được");
});

test("storage lỗi: touch trả true (không bẻ chu kỳ đang chạy vì lỗi hạ tầng)", async () => {
  reset();
  sessionBroken = true;
  const ok = await touchForegroundLock("bat-ky-token", 70_000_000);
  assert.equal(ok, true);
});
