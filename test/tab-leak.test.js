/**
 * Test CHỐNG RÒ TAB (tab-leak) cho luồng crawl handoff.
 *
 * VÌ SAO CẦN TEST NÀY:
 * Tab crawl được background MỞ rồi ĐĂNG KÝ vào registry `crawlTabs`
 * (chrome.storage.session), và chỉ ĐÓNG LẠI về sau khi content.js gửi CRAWL_DONE.
 * Nếu CRAWL_DONE KHÔNG BAO GIỜ tới — injection lỗi, tab crash, người dùng đóng tay,
 * hoặc lệnh START_CRAWL ném lỗi — thì id tab đó KẸT LẠI trong registry và tab thật
 * có thể không bao giờ được đóng => "xong nhiệm vụ mà tab không đóng".
 *
 * Hai lớp phòng thủ được khoá bởi test này:
 *   1. `sweepOrphanCrawlTabs` (chạy theo jobTick mỗi 60s): đối chiếu registry với
 *      tab thực mở. Tab đã biến mất => TỈA khỏi registry (không remove, đã chết rồi).
 *      Tab còn sống nhưng QUÁ GIÀ (> CRAWL_TAB_MAX_AGE_MS) => CƯỠNG BỨC ĐÓNG.
 *      Tab còn sống & còn tươi => giữ nguyên (survivor).
 *   2. Registry `{ id, ts }` phải TƯƠNG THÍCH NGƯỢC với entry số nguyên cũ
 *      (chuẩn hoá về `{ id, ts: 0 }` => coi như rất già => quét sẽ đóng nếu còn sống).
 *
 * LƯU Ý KỸ THUẬT: crawl.js chạm `chrome` ngay ở tầng module nên phải dựng stub
 * TRƯỚC khi import động. Ta KHÔNG test crawlGroupInTab/executeDeletePost trực tiếp
 * ở đây vì chúng gọi sleep()/waitTabComplete() thật từ util.js (trễ vài giây / treo
 * chờ onUpdated) — sweepOrphanCrawlTabs không gọi bất kỳ độ trễ nào nên là mục tiêu
 * unit test SẠCH nhất, phủ đúng logic đối chiếu registry ↔ tab thực.
 */
import test from "node:test";
import assert from "node:assert/strict";

/* --------- Stub chrome: điều khiển được tab tồn tại + ghi lại lệnh đóng ------- */
const sessionStore = new Map();
// Tập id tab "đang thực sự mở" trong trình duyệt giả lập.
const existingTabs = new Set();
// Nhật ký các id đã bị chrome.tabs.remove gọi (spy để kiểm chứng cưỡng bức đóng).
const removedTabs = [];

globalThis.chrome = {
  storage: {
    session: {
      get: async (key) => {
        const k = typeof key === "string" ? key : null;
        if (!k) return Object.fromEntries(sessionStore);
        return sessionStore.has(k) ? { [k]: sessionStore.get(k) } : {};
      },
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) sessionStore.set(k, v);
      },
      remove: async (key) => {
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
    onRemoved: { addListener() {}, removeListener() {} },
    sendMessage: async () => ({}),
    // get(id, cb): mô phỏng chrome.tabs.get — nếu id không tồn tại thì set
    // runtime.lastError (như Chrome thật) và trả tab undefined. sweep đọc lastError
    // NGAY trong callback nên ta set trước khi gọi cb, rồi dọn lại sau.
    get: (id, cb) => {
      if (existingTabs.has(id)) {
        globalThis.chrome.runtime.lastError = null;
        cb && cb({ id });
      } else {
        globalThis.chrome.runtime.lastError = { message: "No tab with id " + id };
        cb && cb(undefined);
        globalThis.chrome.runtime.lastError = null;
      }
    },
    // remove(id, cb): ghi lại id bị đóng + gỡ khỏi tập tab đang mở.
    remove: (id, cb) => {
      removedTabs.push(id);
      existingTabs.delete(id);
      globalThis.chrome.runtime.lastError = null;
      cb && cb();
    },
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
  CRAWL_TABS_KEY,
  CRAWL_TAB_MAX_AGE_MS,
  getCrawlTabs,
  addCrawlTab,
  removeCrawlTab,
  sweepOrphanCrawlTabs,
} = await import("../src/crawl.js");

/* ------------------------------ Tiện ích test --------------------------------- */
function reset() {
  sessionStore.clear();
  existingTabs.clear();
  removedTabs.length = 0;
  globalThis.chrome.runtime.lastError = null;
}

// Nạp thẳng registry với entry đã định sẵn ts (để điều khiển tuổi tab).
function seedRegistry(entries) {
  sessionStore.set(CRAWL_TABS_KEY, entries);
}

// Đọc registry thô hiện tại (mảng entry còn lại sau khi quét).
function readRegistry() {
  return sessionStore.has(CRAWL_TABS_KEY)
    ? sessionStore.get(CRAWL_TABS_KEY)
    : [];
}

const NOW = 1_000_000_000_000; // mốc thời gian cố định cho mọi phép tính tuổi.

/* ---------------------- 1. sweepOrphanCrawlTabs cơ bản ------------------------ */

test("sweep: registry rỗng trả {pruned:0, closed:0}, không đóng tab nào", async () => {
  reset();
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.deepEqual(res, { pruned: 0, closed: 0 });
  assert.equal(removedTabs.length, 0, "không được gọi tabs.remove khi registry rỗng");
});

test("sweep: tab đã BIẾN MẤT bị TỈA khỏi registry (không remove — nó đã chết)", async () => {
  reset();
  // Đăng ký id 10 nhưng KHÔNG thêm vào existingTabs => coi như tab đã biến mất.
  seedRegistry([{ id: 10, ts: NOW }]); // ts còn tươi để chắc chắn không phải do già.
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.equal(res.pruned, 1, "phải tỉa đúng 1 entry ma");
  assert.equal(res.closed, 0, "tab đã chết thì KHÔNG được cố đóng lại");
  assert.equal(removedTabs.length, 0, "không gọi tabs.remove cho tab đã biến mất");
  assert.deepEqual(readRegistry(), [], "registry phải sạch id ma sau khi quét");
});

test("sweep: tab CÒN SỐNG nhưng QUÁ GIÀ bị CƯỠNG BỨC ĐÓNG (closed + pruned)", async () => {
  reset();
  existingTabs.add(20); // tab 20 đang mở thật.
  // ts đủ cũ để age = NOW - ts > CRAWL_TAB_MAX_AGE_MS.
  seedRegistry([{ id: 20, ts: NOW - CRAWL_TAB_MAX_AGE_MS - 1 }]);
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.equal(res.closed, 1, "tab già còn sống phải bị đóng");
  assert.equal(res.pruned, 1, "tab bị đóng cũng được tính là pruned (gỡ khỏi registry)");
  assert.deepEqual(removedTabs, [20], "phải gọi tabs.remove đúng id 20");
  assert.deepEqual(readRegistry(), [], "registry không còn giữ tab đã cưỡng bức đóng");
});

test("sweep: tab CÒN SỐNG & CÒN TƯƠI được GIỮ LẠI (survivor)", async () => {
  reset();
  existingTabs.add(30);
  seedRegistry([{ id: 30, ts: NOW }]); // vừa mở => age 0.
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.deepEqual(res, { pruned: 0, closed: 0 }, "không tỉa, không đóng tab còn tươi");
  assert.equal(removedTabs.length, 0);
  assert.deepEqual(readRegistry(), [{ id: 30, ts: NOW }], "tab tươi vẫn nằm nguyên registry");
});

test("sweep: tab CÒN SỐNG đúng NGƯỠNG tuổi (age == MAX_AGE) vẫn được GIỮ", async () => {
  reset();
  existingTabs.add(31);
  // age = MAX_AGE (đúng bằng, KHÔNG lớn hơn) => điều kiện `age > MAX` sai => giữ.
  seedRegistry([{ id: 31, ts: NOW - CRAWL_TAB_MAX_AGE_MS }]);
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.deepEqual(res, { pruned: 0, closed: 0 }, "đúng ngưỡng chưa vượt => không đóng");
  assert.deepEqual(readRegistry(), [{ id: 31, ts: NOW - CRAWL_TAB_MAX_AGE_MS }]);
});

/* ----------------- 2. Tương thích ngược entry số nguyên cũ -------------------- */

test("sweep: entry SỐ NGUYÊN cũ (legacy) => ts:0 => coi như rất già => đóng nếu còn sống", async () => {
  reset();
  existingTabs.add(40);
  // Registry kiểu cũ: mảng số nguyên thuần (chưa có ts). Chuẩn hoá về {id, ts:0}.
  seedRegistry([40]);
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.equal(res.closed, 1, "entry cũ ts:0 => age = NOW > MAX => cưỡng bức đóng");
  assert.equal(res.pruned, 1);
  assert.deepEqual(removedTabs, [40]);
  assert.deepEqual(readRegistry(), []);
});

test("sweep: entry SỐ NGUYÊN cũ đã biến mất => chỉ TỈA, không remove", async () => {
  reset();
  // Số nguyên cũ, tab không còn mở => chuẩn hoá {id,ts:0} rồi tỉa vì đã chết.
  seedRegistry([41]);
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.equal(res.pruned, 1);
  assert.equal(res.closed, 0, "tab cũ đã biến mất thì không cố remove");
  assert.equal(removedTabs.length, 0);
  assert.deepEqual(readRegistry(), []);
});

/* ------------------------ 3. Kịch bản HỖN HỢP nhiều tab ----------------------- */

test("sweep: hỗn hợp — 1 tươi giữ, 1 già đóng, 1 ma tỉa cùng lúc", async () => {
  reset();
  existingTabs.add(50); // tươi, còn sống
  existingTabs.add(51); // già, còn sống
  // 52 KHÔNG add => tab ma.
  seedRegistry([
    { id: 50, ts: NOW },                              // survivor
    { id: 51, ts: NOW - CRAWL_TAB_MAX_AGE_MS - 5 },   // aged => close
    { id: 52, ts: NOW },                              // vanished => prune
  ]);
  const res = await sweepOrphanCrawlTabs(NOW);
  assert.equal(res.closed, 1, "chỉ 51 bị cưỡng bức đóng");
  assert.equal(res.pruned, 2, "51 (đóng) + 52 (ma) = 2 pruned");
  assert.deepEqual(removedTabs, [51], "chỉ remove đúng tab già còn sống");
  assert.deepEqual(readRegistry(), [{ id: 50, ts: NOW }], "chỉ tab tươi 50 sống sót");
});

/* ---------------- 4. Helper registry {id, ts} & tương thích ngược ------------- */

test("registry: addCrawlTab lưu {id, ts} và getCrawlTabs trả về mảng id", async () => {
  reset();
  await addCrawlTab(60);
  await addCrawlTab(61);
  const ids = await getCrawlTabs();
  assert.deepEqual(ids, [60, 61], "getCrawlTabs chỉ trả id, không trả {id,ts}");
  const raw = readRegistry();
  assert.equal(raw.length, 2);
  for (const e of raw) {
    assert.ok(typeof e === "object" && e.id != null, "mỗi entry phải là object {id,ts}");
    assert.ok(typeof e.ts === "number" && e.ts > 0, "ts phải là timestamp thực khi thêm");
  }
});

test("registry: addCrawlTab KHÔNG thêm trùng id", async () => {
  reset();
  await addCrawlTab(70);
  await addCrawlTab(70);
  const ids = await getCrawlTabs();
  assert.deepEqual(ids, [70], "id trùng không được nhân đôi trong registry");
});

test("registry: addCrawlTab bỏ qua id null/undefined", async () => {
  reset();
  await addCrawlTab(null);
  await addCrawlTab(undefined);
  assert.deepEqual(await getCrawlTabs(), [], "id null/undefined không được ghi vào registry");
});

test("registry: removeCrawlTab trả TRUE khi gỡ được, FALSE khi không có id đó", async () => {
  reset();
  await addCrawlTab(80);
  const removed = await removeCrawlTab(80);
  assert.equal(removed, true, "gỡ được id đang có => true (báo cho background biết 'là tab của ta')");
  assert.deepEqual(await getCrawlTabs(), []);
  const removedAgain = await removeCrawlTab(80);
  assert.equal(removedAgain, false, "gỡ id không tồn tại => false (không phải tab của ta)");
});

test("registry: getCrawlTabs chuẩn hoá entry SỐ NGUYÊN cũ về id", async () => {
  reset();
  // Trộn kiểu cũ (số) và kiểu mới ({id,ts}) để chắc chắn đọc ngược tương thích.
  seedRegistry([90, { id: 91, ts: NOW }]);
  const ids = await getCrawlTabs();
  assert.deepEqual(ids, [90, 91], "cả entry cũ (số) lẫn mới ({id,ts}) đều ra id đúng");
});

test("registry: removeCrawlTab hoạt động trên entry SỐ NGUYÊN cũ", async () => {
  reset();
  seedRegistry([92, 93]);
  const removed = await removeCrawlTab(92);
  assert.equal(removed, true, "gỡ được id trong registry kiểu cũ");
  assert.deepEqual(await getCrawlTabs(), [93], "phần còn lại giữ nguyên");
});
