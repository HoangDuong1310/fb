/**
 * crawl-await-done.test.js — Khoá lại việc crawl in-tab phải ĐỢI tab cào xong.
 *
 * VÌ SAO CẦN TEST NÀY (bug đã sửa):
 * crawlGroupInTab / crawlGroupApiInTab chỉ GỬI lệnh START_CRAWL rồi trả về.
 * Phía content.js, handler START_CRAWL gọi runCrawl() KHÔNG await rồi
 * sendResponse ngay — đúng thiết kế, vì kênh message của Chrome không giữ nổi
 * một tác vụ dài hàng phút. Hệ quả: hàm resolve chỉ vài giây sau khi mở tab,
 * trong khi tab đó còn cào tiếp 1–5 phút.
 *
 * Vòng lặp auto-crawl vì thế tưởng nhóm đã xong, ngủ jitter rồi MỞ TIẾP nhóm
 * sau — chồng lên tab trước vẫn đang chạy. Đây chính là nguyên nhân "2 nhóm ghi
 * bài trong cùng một giây dù threads = 1", và là lý do crawl hàng loạt hụt bài:
 * nhiều tab foreground cùng sống thì cướp focus của nhau, tab mất focus bị
 * Chrome đóng băng lazy-load nên ngừng cào giữa chừng.
 *
 * Bốn tính chất bắt buộc:
 *   1. Không trả về trước khi CRAWL_DONE của ĐÚNG tab đó tới.
 *   2. CRAWL_DONE của tab KHÁC không được đánh thức nhầm.
 *   3. Tab treo => timeout giải phóng (không kẹt vĩnh viễn cả chu kỳ).
 *   4. Gửi lệnh lỗi => huỷ chờ ngay, không treo tới hết timeout.
 *
 * LƯU Ý KỸ THUẬT: crawl.js chạm `chrome` ngay ở tầng module nên phải dựng stub
 * TRƯỚC khi import động (giống autocrawl-lock.test.js).
 */
import test from "node:test";
import assert from "node:assert/strict";

const sessionStore = new Map();

// Ghi lại các tab đã tạo/đóng để khẳng định vòng đời tab đúng.
const created = [];
const removed = [];
// Điều khiển kết quả của tabs.sendMessage cho từng kịch bản.
let sendMessageImpl = async () => ({ ok: true, started: true });
let nextTabId = 100;

// Listener của chrome.tabs.onUpdated. waitTabComplete (util.js) đăng ký vào đây
// và chờ status:"complete"; nếu stub không bao giờ bắn thì nó đứng đủ 30s
// timeout, làm test treo. Stub bắn "complete" ngay sau khi tab được tạo, đúng
// như Chrome thật làm khi trang tải xong.
const updatedListeners = new Set();
function fireTabComplete(tabId) {
  for (const fn of [...updatedListeners]) {
    try {
      fn(tabId, { status: "complete" });
    } catch {
      /* listener lỗi không được làm hỏng stub */
    }
  }
}

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
    create: (opts, cb) => {
      const tab = { id: nextTabId++, windowId: 1, url: opts && opts.url };
      created.push({ ...tab, active: !!(opts && opts.active) });
      if (cb) cb(tab);
      // Báo trang đã tải xong ở tick sau, để waitTabComplete kịp đăng ký listener.
      setTimeout(() => fireTabComplete(tab.id), 0);
      return Promise.resolve(tab);
    },
    update: async () => {},
    remove: async (id) => {
      removed.push(id);
    },
    onUpdated: {
      addListener: (fn) => updatedListeners.add(fn),
      removeListener: (fn) => updatedListeners.delete(fn),
    },
    sendMessage: (...args) => sendMessageImpl(...args),
  },
  windows: {
    getLastFocused: (_o, cb) => cb && cb({ id: 1 }),
    update: (_id, _o, cb) => cb && cb(),
  },
  scripting: { executeScript: async () => [] },
  runtime: { sendMessage: () => {}, lastError: null },
  alarms: {
    create() {},
    get: async () => null,
    onAlarm: { addListener() {} },
    clear: async () => {},
  },
  declarativeNetRequest: { updateSessionRules: async () => {} },
};

const {
  crawlGroupInTab,
  crawlGroupApiInTab,
  settleCrawlTab,
  waitForCrawlDone,
  cancelCrawlWait,
  CRAWL_DONE_TIMEOUT_MS,
} = await import("../src/crawl.js");

function reset() {
  sessionStore.clear();
  created.length = 0;
  removed.length = 0;
  sendMessageImpl = async () => ({ ok: true, started: true });
}

/* ------------------------- waitForCrawlDone thuần ------------------------ */

test("waitForCrawlDone: chỉ resolve khi settleCrawlTab gọi ĐÚNG tabId", async () => {
  reset();
  let settled = false;
  const p = waitForCrawlDone(7, 5000).then((r) => {
    settled = true;
    return r;
  });

  // Tab KHÁC báo xong: không được đánh thức lượt chờ của tab 7.
  assert.equal(settleCrawlTab(999, { newCount: 3 }), false, "không có ai đợi tab 999");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settled, false, "tab khác báo xong không được resolve nhầm");

  assert.equal(settleCrawlTab(7, { newCount: 12, reason: "xong" }), true);
  const out = await p;
  assert.equal(out.timedOut, false);
  assert.equal(out.result.newCount, 12);
});

test("waitForCrawlDone: quá hạn thì tự giải phóng với timedOut", async () => {
  reset();
  const out = await waitForCrawlDone(8, 30);
  assert.equal(out.timedOut, true);
  assert.equal(out.result, null);
  // Sau khi hết hạn, settle muộn không còn ai để đánh thức.
  assert.equal(settleCrawlTab(8, { newCount: 1 }), false);
});

test("waitForCrawlDone: gọi heartbeat định kỳ trong lúc chờ", async () => {
  reset();
  let beats = 0;
  // Nhịp heartbeat thật là 45s nên không quan sát được trong test; ở đây chỉ
  // khẳng định hàm được NHẬN và không làm hỏng luồng resolve bình thường.
  const p = waitForCrawlDone(9, 5000, () => {
    beats += 1;
  });
  settleCrawlTab(9, { newCount: 0 });
  const out = await p;
  assert.equal(out.timedOut, false);
  assert.equal(beats, 0, "chưa tới nhịp heartbeat đầu tiên thì không gọi");
});

test("cancelCrawlWait: giải phóng ngay, không đợi hết timeout", async () => {
  reset();
  const started = Date.now();
  const p = waitForCrawlDone(10, 60_000);
  cancelCrawlWait(10);
  const out = await p;
  assert.equal(out.timedOut, true);
  assert.ok(Date.now() - started < 1000, "phải giải phóng tức thì");
});

test("waitForCrawlDone: đăng ký đè lên cùng tabId giải phóng lượt cũ", async () => {
  reset();
  const first = waitForCrawlDone(11, 60_000);
  const second = waitForCrawlDone(11, 5000);
  const out1 = await first;
  assert.equal(out1.timedOut, true, "lượt cũ phải được giải phóng, không treo");

  settleCrawlTab(11, { newCount: 5 });
  const out2 = await second;
  assert.equal(out2.timedOut, false);
  assert.equal(out2.result.newCount, 5);
});

/* --------------------- crawlGroupInTab / ApiInTab ------------------------ */

test("crawlGroupInTab KHÔNG trả về trước khi tab gửi CRAWL_DONE (awaitDone)", async () => {
  reset();
  let resolved = false;
  const p = crawlGroupInTab("123456", { awaitDone: true }).then((r) => {
    resolved = true;
    return r;
  });

  // crawlGroupInTab có `await sleep(2500)` chờ feed render lười sau khi mở tab,
  // nên phải đợi qua mốc đó mới chắc nó đã gửi lệnh và đang nằm chờ CRAWL_DONE.
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(resolved, false, "gửi lệnh xong KHÔNG có nghĩa là cào xong");
  assert.equal(created.length, 1, "đã mở đúng một tab");

  const tabId = created[0].id;
  assert.equal(settleCrawlTab(tabId, { newCount: 42, reason: "hết bài mới" }), true);

  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.tabId, tabId);
  assert.equal(res.timedOut, false);
  assert.equal(res.newCount, 42);
  assert.equal(res.reason, "hết bài mới");
});

test("KHÔNG có awaitDone => trả về ngay (lệnh từ UI đi qua kênh message)", async () => {
  reset();
  // Đây là hành vi BẮT BUỘC cho đường đi từ dashboard: giữ kênh
  // chrome.runtime.sendMessage mở hàng phút sẽ chạm "message port closed", và
  // lớp bg() của UI coi đó là lỗi tạm thời rồi GỬI LẠI lệnh — crawl trùng nhóm.
  const res = await crawlGroupInTab("123456", {});
  assert.equal(res.ok, true);
  assert.equal(res.started, true);
  assert.equal(res.timedOut, undefined, "không chờ thì không có trường timedOut");
  // Không có ai đợi tab này => CRAWL_DONE về sau chỉ dùng để đóng tab.
  assert.equal(settleCrawlTab(created[0].id, { newCount: 5 }), false);
});

test("crawlGroupApiInTab cũng đợi CRAWL_DONE và mang kết quả về", async () => {
  reset();
  let resolved = false;
  const p = crawlGroupApiInTab("789012", { awaitDone: true }, false).then((r) => {
    resolved = true;
    return r;
  });

  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(resolved, false);
  assert.equal(created.length, 1);
  assert.equal(created[0].active, false, "active:false => mở tab nền, không cướp focus");

  settleCrawlTab(created[0].id, { newCount: 7 });
  const res = await p;
  assert.equal(res.ok, true);
  assert.equal(res.mode, "api");
  assert.equal(res.newCount, 7);
  assert.equal(res.timedOut, false);
});

test("gửi lệnh lỗi => đóng tab, huỷ chờ ngay (không treo tới timeout)", async () => {
  reset();
  sendMessageImpl = async () => {
    throw new Error("Receiving end does not exist");
  };
  const started = Date.now();
  const res = await crawlGroupInTab("123456", {});
  const elapsed = Date.now() - started;

  assert.equal(res.ok, false);
  assert.match(String(res.error), /Không gửi được lệnh crawl/);
  assert.ok(
    elapsed < CRAWL_DONE_TIMEOUT_MS / 10,
    `phải hỏng ngay, không đợi hết timeout (mất ${elapsed}ms)`
  );
  assert.deepEqual(removed, [created[0].id], "tab rác phải được đóng");
});

test("tab treo (không bao giờ báo xong) vẫn giải phóng theo timeout", async () => {
  reset();
  // Đăng ký chờ thủ công với timeout ngắn để không phải đợi 6 phút thật: đây là
  // cùng một cơ chế mà crawlGroupInTab dùng, chỉ khác giá trị timeout.
  const out = await waitForCrawlDone(12345, 40);
  assert.equal(out.timedOut, true, "chu kỳ auto-crawl không được kẹt vĩnh viễn");
});
