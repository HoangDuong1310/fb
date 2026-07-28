/**
 * Test hồi quy cho TRUY NGUYÊN NGUỒN KÍCH HOẠT CRAWL (B2).
 *
 * VÌ SAO CẦN TEST NÀY:
 * Đã quan sát bài của HAI nhóm được ghi trong CÙNG một giây (10:24:11) trong khi
 * KHÔNG có alarm autoCrawl nào tồn tại và 0 tab nhóm FB đang mở. Không có dữ liệu
 * nào cho biết ĐƯỜNG NÀO đã gọi crawl, nên mọi chốt chống chạy chồng (B1) chỉ là
 * phỏng đoán. B2 ghi 1 sự kiện "crawl.start" mỗi lần crawl để trả lời câu hỏi đó.
 *
 * HAI CÁI BẪY mà telemetry có thể ÂM THẦM XOÁ đúng bằng chứng cần tìm — đây là
 * lý do chính các test dưới đây tồn tại:
 *
 *   BẪY 1 — DEDUP: recordTelemetry gộp các sự kiện cùng (tên + payload) trong cửa
 *   sổ 60s. Hiện tượng cần điều tra CHÍNH LÀ nhiều lần crawl sát nhau. Nếu payload
 *   giống nhau thì lần crawl thứ 2 bị bỏ => bằng chứng chạy chồng biến mất.
 *
 *   BẪY 2 — REDACT: client-telemetry thay mọi chuỗi >= 10 chữ số bằng
 *   "[redacted-id]". groupId của FB dài 14–16 chữ số, nên ghi thô thì MỌI nhóm đều
 *   thành cùng một giá trị => không còn phân biệt được nhóm nào.
 *
 * Test 5 và 6 khoá đúng hai cái bẫy đó. Nếu ai đó "đơn giản hoá" payload (bỏ
 * `stamp`, hoặc ghi groupId thô) thì hai test này đổ ngay.
 *
 * LƯU Ý KỸ THUẬT: crawl.js chạm `chrome` ở tầng module nên phải dựng stub TRƯỚC
 * khi import động. `chrome.storage.local` PHẢI theo kiểu callback vì
 * client-telemetry gọi get/set với callback (không phải promise).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ------------------------------ Stub chrome ------------------------------ */
const localStore = new Map();
// Bật cờ này để mô phỏng storage.local ném lỗi (telemetry không dùng được).
let localBroken = false;

globalThis.chrome = {
  storage: {
    local: {
      get: (key, cb) => {
        if (localBroken) throw new Error("local storage unavailable");
        const k = typeof key === "string" ? key : null;
        const out = k
          ? localStore.has(k)
            ? { [k]: localStore.get(k) }
            : {}
          : Object.fromEntries(localStore);
        if (cb) cb(out);
      },
      set: (obj, cb) => {
        if (localBroken) throw new Error("local storage unavailable");
        for (const [k, v] of Object.entries(obj)) localStore.set(k, v);
        if (cb) cb();
      },
    },
    session: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {},
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

const { CRAWL_TRIGGERS, normalizeCrawlTrigger, recordCrawlTrigger } =
  await import("../src/crawl.js");
const { hashStr } = await import("../src/gql-parse.js");

/** groupId THẬT lấy từ dữ liệu đã quan sát: 15 chữ số => chắc chắn chạm bộ redact. */
const REAL_GROUP_ID = "394490401440251";

function reset() {
  localStore.clear();
  localBroken = false;
}

/** Đọc mọi sự kiện telemetry mà stub đã lưu (không phụ thuộc tên khoá nội bộ). */
function storedEvents() {
  for (const v of localStore.values()) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

function crawlStartEvents() {
  return storedEvents().filter((e) => e && e.name === "crawl.start");
}

/* --------------------------- normalizeCrawlTrigger ----------------------- */

test("normalizeCrawlTrigger: giữ nguyên 4 nhãn đường vào thật", () => {
  assert.equal(normalizeCrawlTrigger("autocrawl"), "autocrawl");
  assert.equal(normalizeCrawlTrigger("bulk"), "bulk");
  assert.equal(normalizeCrawlTrigger("remote"), "remote");
  assert.equal(normalizeCrawlTrigger("manual"), "manual");
});

test("normalizeCrawlTrigger: thiếu nhãn => 'unknown' (KHÔNG im lặng bỏ qua)", () => {
  // Ghi "unknown" thay vì bỏ sự kiện: một đường vào mới chưa gắn nhãn sẽ LỘ RA
  // trong telemetry, thay vì biến mất và lại không truy nguyên được như cũ.
  assert.equal(normalizeCrawlTrigger(undefined), "unknown");
  assert.equal(normalizeCrawlTrigger(null), "unknown");
  assert.equal(normalizeCrawlTrigger(""), "unknown");
  assert.equal(normalizeCrawlTrigger("   "), "unknown");
  assert.equal(normalizeCrawlTrigger("nhan-la"), "unknown");
  assert.equal(normalizeCrawlTrigger(123), "unknown");
});

test("normalizeCrawlTrigger: chuẩn hoá hoa/thường + khoảng trắng", () => {
  assert.equal(normalizeCrawlTrigger("  AutoCrawl "), "autocrawl");
  assert.equal(normalizeCrawlTrigger("REMOTE"), "remote");
});

test("CRAWL_TRIGGERS: đủ 5 nhãn đường vào đã biết", () => {
  for (const t of ["autocrawl", "bulk", "remote", "manual", "activetab"]) {
    assert.equal(CRAWL_TRIGGERS.has(t), true, "thiếu nhãn " + t);
  }
});

/* ---------------------------- recordCrawlTrigger ------------------------- */

test("recordCrawlTrigger: ghi 1 sự kiện crawl.start với đủ trường truy nguyên", async () => {
  reset();
  await recordCrawlTrigger("groupApiSmart", REAL_GROUP_ID, {
    trigger: "autocrawl",
    method: "api",
  });

  const events = crawlStartEvents();
  assert.equal(events.length, 1);
  const d = events[0].data;
  assert.equal(d.entry, "groupApiSmart");
  assert.equal(d.trigger, "autocrawl");
  assert.equal(d.method, "api");
  assert.equal(d.tabless, false);
  assert.equal(typeof d.stamp, "string");
  assert.ok(d.stamp.length > 0);
});

test("recordCrawlTrigger: BẪY REDACT — groupId phải được BĂM, không bị '[redacted-id]'", async () => {
  reset();
  await recordCrawlTrigger("groupInTab", REAL_GROUP_ID, { trigger: "manual" });

  const d = crawlStartEvents()[0].data;
  // Nếu ghi groupId thô thì bộ lọc \b\d{10,}\b biến nó thành "[redacted-id]" và
  // MỌI nhóm sẽ trùng nhau => mất hoàn toàn khả năng phân biệt nhóm.
  assert.ok(
    !String(d.group).includes("redacted"),
    "group bị bộ lọc redact ăn mất: " + d.group,
  );
  assert.equal(d.group, "g:" + hashStr(REAL_GROUP_ID));
  // Và không được để lọt id thật ra telemetry.
  assert.ok(!String(d.group).includes(REAL_GROUP_ID));
});

test("recordCrawlTrigger: hai nhóm khác nhau => hai giá trị group khác nhau", async () => {
  reset();
  await recordCrawlTrigger("groupApiSmart", REAL_GROUP_ID, { trigger: "bulk" });
  await recordCrawlTrigger("groupApiSmart", "1105342423823145", {
    trigger: "bulk",
  });

  const events = crawlStartEvents();
  assert.equal(events.length, 2);
  assert.notEqual(events[0].data.group, events[1].data.group);
});

test("recordCrawlTrigger: BẪY DEDUP — 2 lần crawl sát nhau vẫn ra 2 sự kiện", async () => {
  reset();
  // Đây chính là hiện tượng cần điều tra: cùng nhóm, cùng nhãn, cách nhau < 60s.
  // Nếu payload không có `stamp` duy nhất thì lần thứ 2 bị gộp và bằng chứng
  // chạy chồng biến mất đúng lúc cần nhất.
  await recordCrawlTrigger("groupApiSmart", REAL_GROUP_ID, {
    trigger: "autocrawl",
  });
  await recordCrawlTrigger("groupApiSmart", REAL_GROUP_ID, {
    trigger: "autocrawl",
  });

  const events = crawlStartEvents();
  assert.equal(events.length, 2, "sự kiện thứ 2 bị dedup xoá mất");
  assert.notEqual(events[0].data.stamp, events[1].data.stamp);
});

test("recordCrawlTrigger: nhãn lạ từ cấu hình cũ vẫn ghi được, gắn 'unknown'", async () => {
  reset();
  await recordCrawlTrigger("groupInTab", REAL_GROUP_ID, { trigger: "abc" });
  assert.equal(crawlStartEvents()[0].data.trigger, "unknown");
});

test("recordCrawlTrigger: method mặc định 'api', chỉ 'dom' mới là dom", async () => {
  reset();
  await recordCrawlTrigger("a", REAL_GROUP_ID, { trigger: "manual" });
  await recordCrawlTrigger("b", REAL_GROUP_ID, {
    trigger: "manual",
    method: "dom",
  });
  await recordCrawlTrigger("c", REAL_GROUP_ID, {
    trigger: "manual",
    method: "gi-do",
  });

  const byEntry = {};
  for (const e of crawlStartEvents()) byEntry[e.data.entry] = e.data.method;
  assert.equal(byEntry.a, "api");
  assert.equal(byEntry.b, "dom");
  assert.equal(byEntry.c, "api");
});

test("recordCrawlTrigger: crawl tab đang mở không có groupId => group rỗng", async () => {
  reset();
  await recordCrawlTrigger("activeTab", "", { trigger: "activetab" });
  assert.equal(crawlStartEvents()[0].data.group, "");
});

test("recordCrawlTrigger: telemetry hỏng KHÔNG được ném lỗi (không chặn crawl)", async () => {
  reset();
  localBroken = true;
  // Telemetry chỉ là quan sát. Nếu nó ném lỗi thì sẽ giết cả chu kỳ tự động —
  // biến một công cụ chẩn đoán thành nguyên nhân sự cố mới.
  await recordCrawlTrigger("groupApiSmart", REAL_GROUP_ID, {
    trigger: "autocrawl",
  });
  localBroken = false;
});

/* ------------------- Nhãn ĐÃ ĐƯỢC NỐI ở từng đường vào ------------------ */
/**
 * VÌ SAO KIỂM TRA MÃ NGUỒN TĨNH: 2 trong 4 đường vào nằm ở tầng UI (React/TS),
 * không gọi được từ node:test mà không dựng cả DOM. Nhưng chính việc "quên gắn
 * nhãn ở nơi gọi" là kiểu hồi quy dễ xảy ra nhất khi refactor. Kiểm tra tĩnh khoá
 * được sự nối dây đó với chi phí gần bằng 0.
 */
const SRC = {
  crawl: readFileSync(new URL("../src/crawl.js", import.meta.url), "utf8"),
  remote: readFileSync(
    new URL("../src/remote-commands.js", import.meta.url),
    "utf8",
  ),
  tools: readFileSync(
    new URL("../ui/src/views/Tools.tsx", import.meta.url),
    "utf8",
  ),
  bulk: readFileSync(
    new URL("../ui/src/lib/bulkCrawl.ts", import.meta.url),
    "utf8",
  ),
};

test("nối dây: chu kỳ tự động gắn trigger 'autocrawl'", () => {
  assert.match(SRC.crawl, /opts\.trigger\s*=\s*"autocrawl"/);
});

test("nối dây: lệnh từ server gắn trigger 'remote'", () => {
  assert.match(SRC.remote, /options\.trigger\s*=\s*"remote"/);
});

test("nối dây: bấm crawl 1 nhóm gắn trigger 'manual'", () => {
  assert.match(SRC.tools, /trigger:\s*"manual"/);
});

test("nối dây: crawl hàng loạt gắn trigger 'bulk' trong crawlOne", () => {
  // Gắn trong crawlOne (không phải startBulkCrawl) vì đó là điểm DUY NHẤT mọi
  // nhóm trong hàng đợi đều đi qua, kể cả lần thử lại sau khi dispatch lỗi.
  assert.match(SRC.bulk, /trigger:\s*"bulk"/);
});

test("nối dây: cả 3 hàm phễu crawl đều ghi telemetry", () => {
  // Gắn ở phễu thay vì ở nơi gọi => đường vào MỚI thêm sau này cũng tự được ghi.
  for (const entry of ["activeTab", "groupInTab", "groupApiSmart"]) {
    assert.match(
      SRC.crawl,
      new RegExp('recordCrawlTrigger\\("' + entry + '"'),
      "phễu chưa ghi telemetry: " + entry,
    );
  }
});
