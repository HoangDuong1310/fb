import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setTimeout = (fn, _ms, ...args) => {
  fn(...args);
  return 0;
};
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => {};

globalThis.chrome = {
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: {
      get: (_key, cb) => cb && cb({}),
      set: (_value, cb) => cb && cb(),
      remove: (_key, cb) => cb && cb(),
    },
  },
  tabs: {
    query: (_query, cb) => cb && cb([]),
    create: (_options, cb) => cb && cb({ id: 17 }),
    get: (_tabId, cb) => cb && cb({ id: 17, url: "https://www.facebook.com/notifications?ref=secret" }),
    update: (_tabId, _options, cb) => cb && cb(),
    remove: async () => {},
    onUpdated: { addListener() {}, removeListener() {} },
    sendMessage: async () => ({}),
  },
  scripting: { executeScript: async () => [] },
  runtime: { sendMessage: () => {}, lastError: null },
  alarms: {
    create() {},
    clear: async () => true,
    get: async () => null,
    onAlarm: { addListener() {} },
  },
};

const crawl = await import("../src/crawl.js");

beforeEach(() => {
  chrome.runtime.lastError = null;
  chrome.tabs.get = (_tabId, cb) =>
    cb && cb({ id: 17, url: "https://www.facebook.com/notifications?ref=secret" });
  chrome.tabs.update = (_tabId, _options, cb) => cb && cb();
});

after(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

test("executeWarmingAction exposes structured action-injection diagnostics", async () => {
  let calls = 0;
  chrome.scripting.executeScript = async () => {
    calls += 1;
    if (calls === 1) {
      return [{ frameId: 0, result: { navigated: true, verified: true } }];
    }
    throw new Error("Cannot access contents of the page");
  };

  const result = await crawl.executeWarmingAction("openNotifications", 17);

  assert.equal(result.ok, false);
  assert.equal(result.action, "openNotifications");
  assert.equal(result.detail.status, "error");
  assert.equal(result.detail.stage, "action-injection");
  assert.equal(result.detail.note, "execute-script-error");
  assert.match(result.detail.error, /Cannot access contents/);
  assert.equal(result.detail.tabUrl, "https://www.facebook.com/notifications");
  assert.equal(result.detail.navigation.method, "soft");
});

test("executeWarmingAction reports a missing main-frame result", async () => {
  let calls = 0;
  chrome.scripting.executeScript = async () => {
    calls += 1;
    if (calls === 1) {
      return [{ frameId: 0, result: { navigated: true, verified: true } }];
    }
    return [];
  };

  const result = await crawl.executeWarmingAction("openNotifications", 17);

  assert.equal(result.ok, false);
  assert.equal(result.detail.stage, "action-result");
  assert.equal(result.detail.note, "missing-script-result");
  assert.equal(result.detail.resultCount, 0);
  assert.equal(result.detail.tabUrl, "https://www.facebook.com/notifications");
});

test("executeWarmingAction rejects a subframe-only action result", async () => {
  let calls = 0;
  chrome.scripting.executeScript = async () => {
    calls += 1;
    if (calls === 1) {
      return [{ frameId: 0, result: { navigated: true, verified: true } }];
    }
    return [{ frameId: 9, result: { ok: true, status: "done" } }];
  };

  const result = await crawl.executeWarmingAction("openNotifications", 17);

  assert.equal(result.ok, false);
  assert.equal(result.detail.stage, "action-result");
  assert.equal(result.detail.note, "missing-main-frame-result");
  assert.equal(result.detail.resultCount, 1);
});

test("executeWarmingAction selects the main-frame result and preserves explicit status", async () => {
  let calls = 0;
  chrome.scripting.executeScript = async () => {
    calls += 1;
    if (calls === 1) {
      return [{ frameId: 0, result: { navigated: true, verified: true } }];
    }
    return [
      { frameId: 9, result: { ok: false, status: "error", note: "wrong-frame" } },
      { frameId: 0, result: { ok: true, status: "no_op", note: "no-notification-items" } },
    ];
  };

  const result = await crawl.executeWarmingAction("openNotifications", 17);

  assert.equal(result.ok, true);
  assert.equal(result.detail.status, "no_op");
  assert.equal(result.detail.note, "no-notification-items");
  assert.equal(result.detail.navigation.verified, true);
});

test("executeWarmingAction exposes hard-navigation callback errors", async () => {
  chrome.scripting.executeScript = async () => [
    { frameId: 0, result: { navigated: false, verified: false, note: "no-nav-link" } },
  ];
  chrome.tabs.update = (_tabId, _options, cb) => {
    chrome.runtime.lastError = { message: "No tab with id: 17" };
    cb && cb();
    chrome.runtime.lastError = null;
  };

  const result = await crawl.executeWarmingAction("openNotifications", 17);

  assert.equal(result.ok, false);
  assert.equal(result.detail.stage, "navigation");
  assert.equal(result.detail.note, "hard-navigation-error");
  assert.match(result.detail.error, /No tab with id/);
  assert.equal(result.detail.navigation.method, "hard");
});

test("executeWarmingAction does not inject after hard-navigation timeout", async () => {
  let calls = 0;
  chrome.scripting.executeScript = async () => {
    calls += 1;
    return [{ frameId: 0, result: { navigated: false, verified: false } }];
  };

  const result = await crawl.executeWarmingAction("openNotifications", 17);

  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.detail.status, "unverified");
  assert.equal(result.detail.stage, "navigation");
  assert.equal(result.detail.note, "hard-navigation-timeout");
});

test("runNotificationsInPage does not accept a global header button as page verification", async () => {
  const genericItem = {
    getBoundingClientRect: () => ({ width: 300, height: 60, left: 0, top: 0 }),
    scrollIntoView() {},
    dispatchEvent() {},
  };
  globalThis.location = { pathname: "/" };
  globalThis.window = { scrollBy() {} };
  globalThis.MouseEvent = class {};
  globalThis.document = {
    querySelector: () => ({ getAttribute: () => "Notifications" }),
    querySelectorAll: () => [genericItem],
  };

  const result = await crawl.runNotificationsInPage();

  assert.equal(result.status, "unverified");
  assert.equal(result.note, "notification-landmark-missing");
});

test("runReactPostInPage never dispatches a fallback click after click() throws", async () => {
  let syntheticClicks = 0;
  const button = {
    getAttribute(name) {
      if (name === "aria-label") return "Like";
      if (name === "aria-pressed") return null;
      return null;
    },
    getBoundingClientRect: () => ({
      width: 40,
      height: 30,
      left: 10,
      right: 50,
      top: 10,
      bottom: 40,
    }),
    scrollIntoView() {},
    dispatchEvent(event) {
      if (event.type === "click") syntheticClicks += 1;
    },
    click() {
      throw new Error("uncertain click failure");
    },
  };
  globalThis.window = { innerHeight: 800, scrollBy() {} };
  globalThis.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.document = {
    body: {},
    documentElement: { clientHeight: 800 },
    querySelectorAll: () => [button],
  };

  const result = await crawl.runReactPostInPage();

  assert.equal(syntheticClicks, 0);
  assert.equal(result.status, "unverified");
  assert.equal(result.note, "react-click-uncertain");
  assert.equal(result.pressedBefore, null);
  assert.equal(result.labelBefore, "like");
});

test("runReactPostInPage verifies reaction state on a replacement button", async () => {
  const rect = {
    width: 40,
    height: 30,
    left: 10,
    right: 50,
    top: 10,
    bottom: 40,
  };
  const replacement = {
    getAttribute(name) {
      if (name === "aria-label") return "Unlike";
      if (name === "aria-pressed") return null;
      return null;
    },
    getBoundingClientRect: () => rect,
  };
  let currentButton;
  const original = {
    getAttribute(name) {
      if (name === "aria-label") return "Like";
      if (name === "aria-pressed") return null;
      return null;
    },
    getBoundingClientRect: () => rect,
    scrollIntoView() {},
    dispatchEvent() {},
    click() {
      currentButton = replacement;
    },
  };
  currentButton = original;
  globalThis.window = { innerHeight: 800, scrollBy() {} };
  globalThis.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    body: {},
    documentElement: { clientHeight: 800 },
    querySelectorAll: () => [currentButton],
  };

  const result = await crawl.runReactPostInPage();

  assert.equal(result.status, "done");
  assert.equal(result.verified, true);
  assert.deepEqual(result.verificationSignals, {
    pressedBefore: null,
    pressedAfter: null,
    labelBefore: "like",
    labelAfter: "unlike",
    nodeReplaced: true,
  });
});

test("runReactReelsInPage verifies Facebook's Vietnamese Gỡ thích label", async () => {
  let label = "Thích";
  const button = {
    getAttribute(name) {
      if (name === "aria-label") return label;
      if (name === "aria-pressed") return null;
      return null;
    },
    getBoundingClientRect: () => ({
      width: 40,
      height: 30,
      left: 10,
      right: 50,
      top: 10,
      bottom: 40,
    }),
    scrollIntoView() {},
    dispatchEvent() {},
    click() {
      label = "Gỡ thích";
    },
  };
  globalThis.location = { pathname: "/reel/1" };
  globalThis.window = { innerHeight: 800 };
  globalThis.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.KeyboardEvent = class {};
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    body: { dispatchEvent() {} },
    documentElement: { clientHeight: 800 },
    querySelectorAll: () => [button],
  };

  const result = await crawl.runReactReelsInPage();

  assert.equal(result.status, "done");
  assert.equal(result.verified, true);
  assert.equal(result.verificationSignals.labelBefore, "thích");
  assert.equal(result.verificationSignals.labelAfter, "gỡ thích");
});

test("runReactPostInPage does not verify from an unrelated distant reaction button", async () => {
  const originalRect = {
    width: 40,
    height: 30,
    left: 10,
    right: 50,
    top: 10,
    bottom: 40,
  };
  const unrelatedRect = {
    width: 40,
    height: 30,
    left: 10,
    right: 50,
    top: 500,
    bottom: 530,
  };
  const unrelated = {
    getAttribute(name) {
      if (name === "aria-label") return "Unlike";
      if (name === "aria-pressed") return null;
      return null;
    },
    getBoundingClientRect: () => unrelatedRect,
  };
  const original = {
    getAttribute(name) {
      if (name === "aria-label") return "Like";
      if (name === "aria-pressed") return null;
      return null;
    },
    getBoundingClientRect: () => originalRect,
    scrollIntoView() {},
    dispatchEvent() {},
    click() {},
  };
  globalThis.window = { innerHeight: 800, scrollBy() {} };
  globalThis.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    body: {},
    documentElement: { clientHeight: 800 },
    querySelectorAll: () => [original, unrelated],
  };

  const result = await crawl.runReactPostInPage();

  assert.equal(result.status, "unverified");
  assert.equal(result.verified, false);
  assert.equal(result.labelAfter, "like");
  assert.equal(result.nodeReplaced, false);
});

test("runReactReelsInPage never dispatches a fallback click after click() throws", async () => {
  let syntheticClicks = 0;
  const button = {
    getAttribute(name) {
      if (name === "aria-label") return "Like";
      if (name === "aria-pressed") return "false";
      return null;
    },
    getBoundingClientRect: () => ({
      width: 40,
      height: 30,
      left: 10,
      right: 50,
      top: 10,
      bottom: 40,
    }),
    scrollIntoView() {},
    dispatchEvent(event) {
      if (event.type === "click") syntheticClicks += 1;
    },
    click() {
      throw new Error("uncertain click failure");
    },
  };
  globalThis.location = { pathname: "/reel/1" };
  globalThis.window = { innerHeight: 800 };
  globalThis.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.KeyboardEvent = class {};
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    body: { dispatchEvent() {} },
    documentElement: { clientHeight: 800 },
    querySelectorAll: () => [button],
  };

  const result = await crawl.runReactReelsInPage();

  assert.equal(syntheticClicks, 0);
  assert.equal(result.status, "unverified");
  assert.equal(result.note, "react-click-uncertain");
});
