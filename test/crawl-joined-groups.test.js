/**
 * crawl-joined-groups.test.js — Test hồi quy parser tên nhóm ở trang
 * "Nhóm của bạn". Facebook đôi khi gộp badge chưa đọc + câu thông báo bài mới +
 * tên nhóm + thời gian vào cùng textContent của thẻ link.
 *
 * Chạy: node --test test/crawl-joined-groups.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Stub chrome tối thiểu để import crawl.js trong Node.
globalThis.chrome = {
  storage: { session: { get: async () => ({}), set: async () => {} } },
  tabs: {
    query: (_q, cb) => cb && cb([]),
    create: (_o, cb) => cb && cb({ id: 1 }),
    update: async () => {},
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async () => ({}),
  },
  scripting: { executeScript: async () => [] },
  runtime: { sendMessage: () => {}, lastError: null },
  alarms: { create() {}, onAlarm: { addListener() {} }, clear() {} },
};

const {
  formatJoinedGroupsDiagnostic,
  isTrustedJoinedGroupsSnapshot,
  openJoinedGroupsTab,
  runSingleFlight,
  scanJoinedGroupsInPage,
} = await import("../src/crawl.js");

test("joined-group scan creates an active page so Facebook emits lazy page data", async () => {
  let createOptions = null;
  const originalCreate = chrome.tabs.create;
  chrome.tabs.create = (options, callback) => {
    createOptions = options;
    callback({ id: 91, windowId: 7 });
  };

  try {
    const tab = await openJoinedGroupsTab("https://www.facebook.com/groups/joins/");
    assert.deepEqual(createOptions, {
      url: "https://www.facebook.com/groups/joins/",
      active: true,
    });
    assert.equal(tab.id, 91);
  } finally {
    chrome.tabs.create = originalCreate;
  }
});

test("joined-group failure text exposes bounded structural diagnostics", () => {
  assert.equal(
    formatJoinedGroupsDiagnostic({
      friendly: "GroupsCometGroupsTabContentQuery",
      reason: "joined-groups GraphQL request not captured",
      capturedRequests: 1,
      capturedChunks: 2,
      candidateConnections: 0,
      selectedConnection: "",
      selectedPath: "",
      hasPageInfo: false,
      hasNextPage: null,
      topLevelKeys: ["data", "extensions"],
      objectPaths: ["data.viewer.groups_tab_content"],
      hookSeen: 7,
      hookJoinedGroupsSeen: 1,
      hookFriendlyNames: ["BackgroundQuery", "GroupsCometGroupsTabContentQuery"],
    }),
    "friendly=GroupsCometGroupsTabContentQuery; reason=joined-groups GraphQL request not captured; requests=1; chunks=2; connections=0; selected=-; path=-; pageInfo=no; next=null; top=data,extensions; objects=data.viewer.groups_tab_content; hookSeen=7; hookCandidates=1; observed=BackgroundQuery,GroupsCometGroupsTabContentQuery",
  );
});

function installPage(anchors) {
  globalThis.window = {
    scrollTo() {},
  };
  globalThis.document = {
    body: { scrollHeight: 1000 },
    querySelectorAll(selector) {
      assert.equal(selector, 'a[href*="/groups/"]');
      return anchors;
    },
  };
}

function anchor(href, textContent) {
  return { href, textContent };
}

test("single-flight shares one in-flight joined-group synchronization", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let inFlight = null;
  const operation = async () => {
    calls += 1;
    await gate;
    return { ok: true, calls };
  };
  const run = () => runSingleFlight(
    () => inFlight,
    (value) => { inFlight = value; },
    operation,
  );

  const first = run();
  const second = run();

  assert.equal(calls, 1);
  assert.strictEqual(second, first);
  release();
  assert.deepEqual(await first, { ok: true, calls: 1 });
  assert.equal(inFlight, null);
});

test("single-flight releases the lock after a rejected synchronization", async () => {
  let inFlight = null;
  const failure = new Error("scan failed");

  await assert.rejects(
    runSingleFlight(
      () => inFlight,
      (value) => { inFlight = value; },
      async () => { throw failure; },
    ),
    failure,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(inFlight, null);
});

test("trusted complete GraphQL snapshot may be empty to remove all stale memberships", () => {
  assert.equal(isTrustedJoinedGroupsSnapshot({
    ok: true,
    trusted: true,
    complete: true,
    groups: [],
  }), true);
});

test("tách đúng tên khỏi câu thông báo hơn 10 bài viết mới", async () => {
  installPage([
    anchor(
      "https://www.facebook.com/groups/123456/",
      "Chưa đọcĐã có hơn 10 bài viết mới từ lần gần đây nhất bạn truy cập vào nhóm Linh Kiện Máy Tính PC ( Ram, Cpu, Nguồn, Main LCD, SSD).13 giờ",
    ),
  ]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, [
    {
      groupId: "123456",
      groupName: "Linh Kiện Máy Tính PC ( Ram, Cpu, Nguồn, Main LCD, SSD)",
    },
  ]);
});

test("giữ nguyên tên nhóm sạch và bỏ link bài viết con", async () => {
  installPage([
    anchor("https://www.facebook.com/groups/clean-group/", "Nhóm Máy Tính Việt Nam"),
    anchor("https://www.facebook.com/groups/clean-group/posts/999/", "Một bài viết"),
  ]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, [
    { groupId: "clean-group", groupName: "Nhóm Máy Tính Việt Nam" },
  ]);
});

test("tách tên khỏi thẻ chào mừng thành viên mới và bỏ ellipsis UI", async () => {
  installPage([
    anchor(
      "https://www.facebook.com/groups/vga-sieu-re-vn/",
      "Chào mừng bạn đến với VGA Siêu Rẻ VN -... Giờ bạn có thể đăng bài, kết nối với các thành viên khác và hơn thế nữa",
    ),
  ]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, [
    { groupId: "vga-sieu-re-vn", groupName: "VGA Siêu Rẻ VN" },
  ]);
});

test("ưu tiên aria-label đầy đủ thay vì text hiển thị bị cắt", async () => {
  const a = anchor(
    "https://www.facebook.com/groups/vga-full/",
    "Chào mừng bạn đến với VGA Siêu Rẻ VN -... Giờ bạn có thể đăng bài",
  );
  a.getAttribute = (name) => name === "aria-label" ? "VGA Siêu Rẻ VN - Chợ Card Màn Hình" : null;
  installPage([a]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, [
    { groupId: "vga-full", groupName: "VGA Siêu Rẻ VN - Chợ Card Màn Hình" },
  ]);
});

test("ưu tiên heading tên nhóm, không dùng aria-label của thông báo bài viết", async () => {
  const a = anchor(
    "https://www.facebook.com/groups/cho-pc-all-in-one/",
    'Chợ PC All in One: "Thủ Đức.bán bộ máy chơi Game fifa4, liên minh..."',
  );
  a.getAttribute = (name) => name === "aria-label"
    ? 'Đánh dấu là đã đọc, Chợ PC All in One: "Thủ Đức.bán bộ máy chơi Game fifa4,liên minh..Giá 5Triệu cả bộ/H310/i3 9100F/Ram8G/Gtx750ti 4G…"'
    : null;
  a.querySelectorAll = (selector) => {
    if (selector === 'button,[role="button"]') return [];
    assert.equal(selector, 'h1,h2,h3,h4,[role="heading"],[title],[aria-label]');
    return [{
      innerText: "Chợ PC All in One",
      textContent: "Chợ PC All in One",
      getAttribute: () => null,
    }];
  };
  installPage([a]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, [
    { groupId: "cho-pc-all-in-one", groupName: "Chợ PC All in One" },
  ]);
});

test("không lưu nhãn thông báo làm tên khi không có node tên nhóm đáng tin cậy", async () => {
  const a = anchor(
    "https://www.facebook.com/groups/unresolved-notification/",
    'Chợ PC All in One: "Nội dung xem trước của một bài viết rất dài…"',
  );
  a.getAttribute = (name) => name === "aria-label"
    ? 'Đánh dấu là đã đọc, Chợ PC All in One: "Nội dung xem trước của một bài viết rất dài…"'
    : null;
  a.querySelectorAll = (selector) => selector === 'button,[role="button"]' ? [] : [];
  installPage([a]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, []);
});

test("không lưu preview thông báo không có ngoặc kép làm tên nhóm", async () => {
  const a = anchor(
    "https://www.facebook.com/groups/unquoted-notification/",
    "Chợ PC All in One: Nội dung xem trước của một bài viết rất dài…",
  );
  a.getAttribute = (name) => name === "aria-label"
    ? "Đánh dấu là đã đọc, Chợ PC All in One: Nội dung xem trước của một bài viết rất dài…"
    : null;
  a.querySelectorAll = () => [];
  installPage([a]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, []);
});

test("không loại nhóm đã tham gia vì ancestor chung chứa nút Tham gia nhóm của card khác", async () => {
  const joined = anchor("https://www.facebook.com/groups/joined/", "Nhóm đã tham gia");
  joined.getAttribute = () => null;
  joined.querySelectorAll = (selector) => selector === 'button,[role="button"]' ? [] : [];

  const sharedList = {
    parentElement: null,
    getAttribute: () => null,
    querySelectorAll(selector) {
      if (selector === 'a[href*="/groups/"]') return [joined, {}, {}, {}];
      if (selector === 'button,[role="button"]') return [{
        innerText: "Tham gia nhóm",
        textContent: "Tham gia nhóm",
        getAttribute: () => null,
      }];
      return [];
    },
  };
  joined.parentElement = sharedList;
  installPage([joined]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, [
    { groupId: "joined", groupName: "Nhóm đã tham gia" },
  ]);
});

test("bỏ nhóm đề xuất có nút Tham gia nhóm", async () => {
  const suggested = anchor("https://www.facebook.com/groups/suggested/", "Nhóm đề xuất");
  suggested.innerText = "Nhóm đề xuất";
  suggested.querySelectorAll = () => [{
    innerText: "Tham gia nhóm",
    textContent: "Tham gia nhóm",
    getAttribute: () => null,
  }];
  suggested.parentElement = null;
  installPage([suggested]);

  const groups = await scanJoinedGroupsInPage({ scrollRounds: 0, scrollDelayMs: 0 });
  assert.deepEqual(groups, []);
});
