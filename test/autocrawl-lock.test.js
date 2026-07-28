/**
 * Test hồi quy cho CHỐT BỀN của chu kỳ auto-crawl (B1).
 *
 * VÌ SAO CẦN TEST NÀY:
 * Trước đây chống chạy chồng chỉ bằng `let _autoCrawling` — một biến RAM trong
 * service worker. MV3 kill SW sau ~30s rảnh, còn chu kỳ auto-crawl NGỦ 20–90s
 * giữa 2 nhóm => SW chết trong lúc ngủ, alarm sau đánh thức SW mới với cờ
 * false, chu kỳ mới chạy chồng lên tab/tiến trình của chu kỳ trước. Đó là cách
 * 2 nhóm ghi bài trong CÙNG một giây dù threads = 1.
 *
 * Các test dưới đây khoá 5 tính chất bắt buộc của lock:
 *   1. Lock còn sống  => chu kỳ mới KHÔNG được chiếm.
 *   2. Lock quá TTL   => coi là rác, PHẢI chiếm lại (không kẹt vĩnh viễn).
 *   3. Heartbeat gia hạn được lock của chính mình.
 *   4. Lock đã bị chủ khác chiếm => heartbeat trả false (tín hiệu tự dừng).
 *   5. release chỉ xoá lock của MÌNH, không xoá lock của chu kỳ khác.
 *
 * LƯU Ý KỸ THUẬT: crawl.js chạm `chrome` ngay ở tầng module nên phải dựng stub
 * TRƯỚC khi import động (giống test/crawl-inbox-plan.test.js). Stub ở đây có
 * thêm storage.session.remove — releaseAutoCrawlLock cần hàm này.
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
  AUTOCRAWL_LOCK_KEY,
  AUTOCRAWL_LOCK_TTL_MS,
  isAutoCrawlLockStale,
  acquireAutoCrawlLock,
  touchAutoCrawlLock,
  releaseAutoCrawlLock,
} = await import("../src/crawl.js");

function reset() {
  sessionStore.clear();
  sessionBroken = false;
}

/* ------------------------- isAutoCrawlLockStale -------------------------- */

test("isAutoCrawlLockStale: không có lock => rác (cho phép chiếm)", () => {
  const now = 1_000_000;
  assert.equal(isAutoCrawlLockStale(undefined, now), true);
  assert.equal(isAutoCrawlLockStale(null, now), true);
  assert.equal(isAutoCrawlLockStale("khong-phai-object", now), true);
});

test("isAutoCrawlLockStale: thiếu/sai heartbeatAt => rác", () => {
  const now = 1_000_000;
  assert.equal(isAutoCrawlLockStale({ token: "a" }, now), true);
  assert.equal(isAutoCrawlLockStale({ token: "a", heartbeatAt: 0 }, now), true);
  assert.equal(isAutoCrawlLockStale({ token: "a", heartbeatAt: -5 }, now), true);
  assert.equal(isAutoCrawlLockStale({ token: "a", heartbeatAt: "xxx" }, now), true);
});

test("isAutoCrawlLockStale: heartbeat vừa mới => CÒN SỐNG", () => {
  const now = 1_000_000;
  assert.equal(isAutoCrawlLockStale({ token: "a", heartbeatAt: now }, now), false);
  // sát mép TTL vẫn còn sống
  assert.equal(
    isAutoCrawlLockStale({ token: "a", heartbeatAt: now - AUTOCRAWL_LOCK_TTL_MS }, now),
    false
  );
});

test("isAutoCrawlLockStale: quá TTL => rác, không kẹt vĩnh viễn khi SW chết", () => {
  const now = 10 * 60 * 1000;
  const beat = now - AUTOCRAWL_LOCK_TTL_MS - 1;
  assert.equal(isAutoCrawlLockStale({ token: "a", heartbeatAt: beat }, now), true);
});

test("isAutoCrawlLockStale: heartbeat ở TƯƠNG LAI xa (đồng hồ nhảy) => rác", () => {
  const now = 1_000_000;
  const beat = now + AUTOCRAWL_LOCK_TTL_MS + 1;
  assert.equal(isAutoCrawlLockStale({ token: "a", heartbeatAt: beat }, now), true);
});

/* --------------------------- acquire / release --------------------------- */

test("acquire: lần đầu chiếm được và ghi lock kèm heartbeat", async () => {
  reset();
  const now = 1_700_000_000_000;
  const token = await acquireAutoCrawlLock(now);
  assert.ok(token, "phải trả về token");
  const lock = sessionStore.get(AUTOCRAWL_LOCK_KEY);
  assert.equal(lock.token, token);
  assert.equal(lock.startedAt, now);
  assert.equal(lock.heartbeatAt, now);
});

test("acquire: lock CÒN SỐNG => chu kỳ thứ hai bị từ chối (đây là lỗi B đã sửa)", async () => {
  reset();
  const now = 1_700_000_000_000;
  const first = await acquireAutoCrawlLock(now);
  assert.ok(first);
  // SW bị kill rồi khởi động lại 30s sau: biến RAM mất, nhưng lock vẫn còn.
  const second = await acquireAutoCrawlLock(now + 30_000);
  assert.equal(second, "", "không được chiếm khi chu kỳ trước còn sống");
  // lock cũ không bị ghi đè
  assert.equal(sessionStore.get(AUTOCRAWL_LOCK_KEY).token, first);
});

test("acquire: lock quá TTL (SW chết hẳn) => chiếm lại được", async () => {
  reset();
  const now = 1_700_000_000_000;
  const dead = await acquireAutoCrawlLock(now);
  const later = now + AUTOCRAWL_LOCK_TTL_MS + 1;
  const fresh = await acquireAutoCrawlLock(later);
  assert.ok(fresh, "lock rác phải chiếm lại được, nếu không auto-crawl chết vĩnh viễn");
  assert.notEqual(fresh, dead);
  assert.equal(sessionStore.get(AUTOCRAWL_LOCK_KEY).token, fresh);
});

test("acquire: storage.session lỗi => vẫn cho chạy (chốt RAM là tuyến còn lại)", async () => {
  reset();
  sessionBroken = true;
  const token = await acquireAutoCrawlLock(1_700_000_000_000);
  assert.ok(token, "không được chặn chu kỳ chỉ vì storage lỗi");
});

test("release: xoá đúng lock của mình", async () => {
  reset();
  const token = await acquireAutoCrawlLock(1_700_000_000_000);
  await releaseAutoCrawlLock(token);
  assert.equal(sessionStore.has(AUTOCRAWL_LOCK_KEY), false);
  // sau khi nhả, chu kỳ sau chiếm được ngay
  const next = await acquireAutoCrawlLock(1_700_000_001_000);
  assert.ok(next);
});

test("release: KHÔNG xoá lock của chu kỳ khác", async () => {
  reset();
  const mine = await acquireAutoCrawlLock(1_700_000_000_000);
  // chu kỳ khác đã chiếm lock (SW này ngủ quá lâu)
  sessionStore.set(AUTOCRAWL_LOCK_KEY, {
    token: "cua-nguoi-khac",
    startedAt: 1,
    heartbeatAt: 1_700_000_100_000,
  });
  await releaseAutoCrawlLock(mine);
  assert.equal(
    sessionStore.get(AUTOCRAWL_LOCK_KEY).token,
    "cua-nguoi-khac",
    "nhả lock sai chủ sẽ mở đường cho chu kỳ thứ ba chạy chồng"
  );
});

test("release: token rỗng => không làm gì", async () => {
  reset();
  sessionStore.set(AUTOCRAWL_LOCK_KEY, {
    token: "x",
    startedAt: 1,
    heartbeatAt: 1_700_000_000_000,
  });
  await releaseAutoCrawlLock("");
  assert.equal(sessionStore.has(AUTOCRAWL_LOCK_KEY), true);
});

/* ------------------------------ heartbeat -------------------------------- */

test("touch: gia hạn lock của mình, giữ nguyên startedAt", async () => {
  reset();
  const now = 1_700_000_000_000;
  const token = await acquireAutoCrawlLock(now);
  const later = now + 120_000;
  assert.equal(await touchAutoCrawlLock(token, later), true);
  const lock = sessionStore.get(AUTOCRAWL_LOCK_KEY);
  assert.equal(lock.heartbeatAt, later, "heartbeat phải nhích lên");
  assert.equal(lock.startedAt, now, "startedAt là mốc bắt đầu chu kỳ, không đổi");
});

test("touch: chu kỳ dài vẫn sống nhờ heartbeat (không tự cướp lock của mình)", async () => {
  reset();
  const start = 1_700_000_000_000;
  const token = await acquireAutoCrawlLock(start);
  // 10 nhóm, mỗi nhóm cách nhau 90s (jitter tối đa) => tổng 900s > TTL 300s.
  let t = start;
  for (let i = 0; i < 10; i++) {
    t += 90_000;
    assert.equal(await touchAutoCrawlLock(token, t), true, "nhóm thứ " + i);
  }
  // Vì heartbeat liên tục nên lock KHÔNG bao giờ thành rác giữa chu kỳ.
  assert.equal(isAutoCrawlLockStale(sessionStore.get(AUTOCRAWL_LOCK_KEY), t), false);
});

test("touch: lock đã bị chu kỳ khác chiếm => false để chu kỳ cũ tự dừng", async () => {
  reset();
  const token = await acquireAutoCrawlLock(1_700_000_000_000);
  sessionStore.set(AUTOCRAWL_LOCK_KEY, {
    token: "chu-ky-moi",
    startedAt: 1_700_000_400_000,
    heartbeatAt: 1_700_000_400_000,
  });
  assert.equal(
    await touchAutoCrawlLock(token, 1_700_000_401_000),
    false,
    "phải báo dừng, nếu không 2 chu kỳ cùng crawl => 2 nhóm ghi bài cùng giây"
  );
  // và không được ghi đè lock của chu kỳ mới
  assert.equal(sessionStore.get(AUTOCRAWL_LOCK_KEY).token, "chu-ky-moi");
});

test("touch: token rỗng => false (không có lock thì không chạy tiếp)", async () => {
  reset();
  assert.equal(await touchAutoCrawlLock("", Date.now()), false);
});

test("touch: storage lỗi => true (không bẻ chu kỳ đang chạy vì lỗi hạ tầng)", async () => {
  reset();
  const token = await acquireAutoCrawlLock(1_700_000_000_000);
  sessionBroken = true;
  assert.equal(await touchAutoCrawlLock(token, 1_700_000_090_000), true);
});
