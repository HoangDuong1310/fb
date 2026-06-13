/**
 * db.js — Lớp truy cập IndexedDB cho extension.
 *
 * Được nạp vào service worker (background.js) thông qua importScripts(),
 * nên các hàm được gắn vào `self` để background dùng chung.
 *
 * Schema (version 4):
 *  - DB:    "fb_group_crawler"
 *  - Store: "posts"  keyPath = "postId"
 *      index "by_group"     -> groupId
 *      index "by_crawledAt" -> crawledAt
 *      index "by_time"      -> timestamp
 *  - Store: "groups" keyPath = "groupId"   (nhóm đã tham gia / theo dõi)
 *      index "by_name" -> groupName
 *  - Store: "jobs"   keyPath = "id" (autoIncrement)  (hàng đợi đăng bài / bình luận)
 *      index "by_status" -> status
 *      index "by_type"   -> type
 *  - Store: "products" keyPath = "productId"  (kho sản phẩm/giá để AI tư vấn bán hàng)
 *      index "by_source"   -> source     (tên nguồn: hoanghapc/hacom/...)
 *      index "by_category" -> category   (cpu/vga/ram/...)
 *      index "by_updatedAt"-> updatedAt
 *  - Store: "sources" keyPath = "id"  (cấu hình nguồn dữ liệu: URL API nội bộ + ánh xạ trường)
 *  - Store: "advisories" keyPath = "postId"  (nháp tư vấn/chào giá do AI soạn cho từng bài)
 *      index "by_status"    -> status   (pending/approved/sent/rejected)
 *      index "by_group"     -> groupId
 *      index "by_createdAt" -> createdAt
 *
 * Chính các key của store "posts" là tập "ID đã thấy" dùng để lọc bài mới.
 */

const DB_NAME = "fb_group_crawler";
const DB_VERSION = 5;
const STORE_POSTS = "posts";
const STORE_GROUPS = "groups";
const STORE_JOBS = "jobs";
const STORE_PRODUCTS = "products";
const STORE_SOURCES = "sources";
const STORE_ADVISORIES = "advisories";
const STORE_CONVERSATIONS = "conversations";

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_POSTS)) {
        const store = db.createObjectStore(STORE_POSTS, { keyPath: "postId" });
        store.createIndex("by_group", "groupId", { unique: false });
        store.createIndex("by_crawledAt", "crawledAt", { unique: false });
        store.createIndex("by_time", "timestamp", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_GROUPS)) {
        const g = db.createObjectStore(STORE_GROUPS, { keyPath: "groupId" });
        g.createIndex("by_name", "groupName", { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_JOBS)) {
        const j = db.createObjectStore(STORE_JOBS, {
          keyPath: "id",
          autoIncrement: true,
        });
        j.createIndex("by_status", "status", { unique: false });
        j.createIndex("by_type", "type", { unique: false });
      }

      // v3: kho sản phẩm/giá để AI tư vấn bán hàng.
      if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
        const p = db.createObjectStore(STORE_PRODUCTS, { keyPath: "productId" });
        p.createIndex("by_source", "source", { unique: false });
        p.createIndex("by_category", "category", { unique: false });
        p.createIndex("by_updatedAt", "updatedAt", { unique: false });
      }

      // v3: cấu hình nguồn dữ liệu (URL API nội bộ + cách ánh xạ trường).
      if (!db.objectStoreNames.contains(STORE_SOURCES)) {
        db.createObjectStore(STORE_SOURCES, { keyPath: "id" });
      }

      // v4: nháp tư vấn/chào giá do AI soạn cho từng bài. Khoá theo postId để
      // 1 bài chỉ có 1 nháp (dedupe tự nhiên: không trả lời trùng).
      if (!db.objectStoreNames.contains(STORE_ADVISORIES)) {
        const adv = db.createObjectStore(STORE_ADVISORIES, { keyPath: "postId" });
        adv.createIndex("by_status", "status", { unique: false });
        adv.createIndex("by_group", "groupId", { unique: false });
        adv.createIndex("by_createdAt", "createdAt", { unique: false });
      }

      // v5: HỘI THOẠI bình luận. Mỗi lần ta đăng một bình luận thành công -> tạo
      // 1 conversation gắn với permalink bài + permalink bình luận của ta, kèm
      // mảng `replies` (các phản hồi của người khác dưới bình luận đó). Theo dõi
      // nền định kỳ sẽ MERGE reply mới vào mảng này (không ghi đè). CHỈ THÊM store
      // mới — không đụng tới bất kỳ store cũ nào, nên dữ liệu cũ được bảo toàn.
      if (!db.objectStoreNames.contains(STORE_CONVERSATIONS)) {
        const cv = db.createObjectStore(STORE_CONVERSATIONS, {
          keyPath: "id",
          autoIncrement: true,
        });
        cv.createIndex("by_status", "status", { unique: false });
        cv.createIndex("by_postId", "postId", { unique: false });
        cv.createIndex("by_updatedAt", "updatedAt", { unique: false });
        cv.createIndex("by_jobId", "jobId", { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return _dbPromise;
}

function tx(store, mode) {
  return openDB().then((db) => {
    const transaction = db.transaction(store, mode);
    return transaction.objectStore(store);
  });
}

/* ============================ POSTS ====================================== */

/**
 * Lưu (hoặc cập nhật) nhiều bài viết. Trả về số bài MỚI thực sự được thêm.
 * Bài đã tồn tại (cùng postId) sẽ được cập nhật nhưng không tính là mới.
 */
async function savePosts(posts) {
  if (!Array.isArray(posts) || posts.length === 0) {
    return { added: 0, updated: 0 };
  }

  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_POSTS, "readwrite");
    const store = transaction.objectStore(STORE_POSTS);

    let added = 0;
    let updated = 0;
    let pending = posts.length;

    for (const post of posts) {
      if (!post || !post.postId) {
        pending -= 1;
        continue;
      }
      const getReq = store.get(post.postId);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          updated += 1;
          const merged = {
            ...existing,
            ...post,
            crawledAt: existing.crawledAt,
            updatedAt: Date.now(),
          };
          store.put(merged);
        } else {
          added += 1;
          store.put({
            ...post,
            crawledAt: post.crawledAt || Date.now(),
            updatedAt: Date.now(),
          });
        }
        pending -= 1;
        if (pending === 0) resolve({ added, updated });
      };
      getReq.onerror = () => {
        pending -= 1;
        if (pending === 0) resolve({ added, updated });
      };
    }

    if (pending === 0) resolve({ added, updated });
    transaction.onerror = () => reject(transaction.error);
  });
}

/**
 * Lấy tập postId đã lưu (toàn bộ hoặc theo nhóm) dưới dạng mảng string.
 * Dùng làm danh sách "đã thấy" để content script bỏ qua bài cũ.
 */
async function getKnownIds(groupId) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_POSTS, "readonly");
    const store = transaction.objectStore(STORE_POSTS);

    if (groupId) {
      const index = store.index("by_group");
      const ids = [];
      const req = index.openKeyCursor(IDBKeyRange.only(groupId));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          ids.push(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve(ids);
        }
      };
      req.onerror = () => reject(req.error);
    } else {
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }
  });
}

/** Lấy toàn bộ bài viết (tùy chọn lọc theo nhóm), sắp theo thời gian crawl giảm dần. */
async function getAllPosts(groupId) {
  const store = await tx(STORE_POSTS, "readonly");

  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      let result = req.result || [];
      if (groupId) result = result.filter((p) => p.groupId === groupId);
      result.sort((a, b) => (b.crawledAt || 0) - (a.crawledAt || 0));
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Thống kê: tổng số bài + số bài theo từng nhóm. */
async function getStats() {
  const posts = await getAllPosts();
  const byGroup = {};
  for (const p of posts) {
    const key = p.groupId || "unknown";
    if (!byGroup[key]) {
      byGroup[key] = { groupId: key, groupName: p.groupName || key, count: 0 };
    }
    byGroup[key].count += 1;
    if (p.groupName) byGroup[key].groupName = p.groupName;
  }
  return { total: posts.length, groups: Object.values(byGroup) };
}

/** Xóa toàn bộ dữ liệu (hoặc theo nhóm). Trả về số bài đã xóa. */
async function clearPosts(groupId) {
  const db = await openDB();

  if (!groupId) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_POSTS, "readwrite");
      const store = transaction.objectStore(STORE_POSTS);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const n = countReq.result;
        const clearReq = store.clear();
        clearReq.onsuccess = () => resolve(n);
        clearReq.onerror = () => reject(clearReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_POSTS, "readwrite");
    const store = transaction.objectStore(STORE_POSTS);
    const index = store.index("by_group");
    let deleted = 0;
    const req = index.openCursor(IDBKeyRange.only(groupId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        deleted += 1;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/* ============================ GROUPS ===================================== */

/** Thêm/cập nhật một nhóm. Giữ nguyên addedAt nếu đã có. */
async function saveGroup(group) {
  if (!group || !group.groupId) throw new Error("Thiếu groupId.");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_GROUPS, "readwrite");
    const store = transaction.objectStore(STORE_GROUPS);
    const getReq = store.get(group.groupId);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const merged = {
        autoCrawl: false,
        tags: [],
        note: "",
        ...existing,
        ...group,
        addedAt: existing.addedAt || Date.now(),
        updatedAt: Date.now(),
      };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Lưu nhiều nhóm (dùng khi quét nhóm đã tham gia). Trả về {added, updated}. */
async function saveGroups(groups) {
  if (!Array.isArray(groups) || !groups.length) return { added: 0, updated: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_GROUPS, "readwrite");
    const store = transaction.objectStore(STORE_GROUPS);
    let added = 0;
    let updated = 0;
    let pending = groups.length;
    for (const g of groups) {
      if (!g || !g.groupId) {
        pending -= 1;
        continue;
      }
      const getReq = store.get(g.groupId);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          updated += 1;
          store.put({ ...existing, ...g, addedAt: existing.addedAt, updatedAt: Date.now() });
        } else {
          added += 1;
          store.put({ autoCrawl: false, tags: [], note: "", ...g, addedAt: Date.now(), updatedAt: Date.now() });
        }
        pending -= 1;
        if (pending === 0) resolve({ added, updated });
      };
      getReq.onerror = () => {
        pending -= 1;
        if (pending === 0) resolve({ added, updated });
      };
    }
    if (pending === 0) resolve({ added, updated });
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Lấy toàn bộ nhóm, kèm số bài đã crawl của từng nhóm. */
async function getGroups() {
  const store = await tx(STORE_GROUPS, "readonly");
  const groups = await new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const stats = await getStats();
  const countMap = {};
  for (const g of stats.groups) countMap[g.groupId] = g.count;
  return groups
    .map((g) => ({ ...g, postCount: countMap[g.groupId] || 0 }))
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

/** Xóa một nhóm (không xóa bài đã crawl của nhóm đó). */
async function deleteGroup(groupId) {
  const store = await tx(STORE_GROUPS, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(groupId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/* ============================= JOBS ====================================== */

/** Tạo một job (đăng bài / bình luận). Trả về job đã lưu (kèm id). */
async function createJob(job) {
  const db = await openDB();
  const record = {
    type: "post",
    status: "pending",
    attempts: 0,
    result: null,
    error: null,
    createdAt: Date.now(),
    scheduledAt: job.scheduledAt || Date.now(),
    ...job,
  };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_JOBS, "readwrite");
    const store = transaction.objectStore(STORE_JOBS);
    const req = store.add(record);
    req.onsuccess = () => resolve({ ...record, id: req.result });
    req.onerror = () => reject(req.error);
  });
}

/** Cập nhật một job theo id (gộp các trường truyền vào). */
async function updateJob(id, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_JOBS, "readwrite");
    const store = transaction.objectStore(STORE_JOBS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        resolve(null);
        return;
      }
      const merged = { ...existing, ...patch, updatedAt: Date.now() };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Lấy toàn bộ job (tùy chọn lọc theo type), mới nhất trước. */
async function getJobs(type) {
  const store = await tx(STORE_JOBS, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      let result = req.result || [];
      if (type) result = result.filter((j) => j.type === type);
      result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Lấy các job đang chờ tới hạn chạy (status=pending và scheduledAt<=now). */
async function getDueJobs(now) {
  const t = now || Date.now();
  const store = await tx(STORE_JOBS, "readonly");
  return new Promise((resolve, reject) => {
    const idx = store.index("by_status");
    const out = [];
    const req = idx.openCursor(IDBKeyRange.only("pending"));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const j = cursor.value;
        if ((j.scheduledAt || 0) <= t) out.push(j);
        cursor.continue();
      } else {
        out.sort((a, b) => (a.scheduledAt || 0) - (b.scheduledAt || 0));
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** Xóa một job theo id. */
async function deleteJob(id) {
  const store = await tx(STORE_JOBS, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/** Xóa các job đã hoàn tất hoặc lỗi (dọn dẹp). Trả về số job đã xóa. */
async function clearFinishedJobs() {
  const store = await tx(STORE_JOBS, "readwrite");
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        const s = cursor.value.status;
        if (s === "done" || s === "error") {
          cursor.delete();
          deleted += 1;
        }
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/* ============================ PRODUCTS =================================== */

/**
 * Lưu (hoặc cập nhật) nhiều sản phẩm. Khóa theo productId.
 * Trả về { added, updated }. Sản phẩm cũ cùng productId sẽ được cập nhật giá/tồn.
 */
async function saveProducts(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return { added: 0, updated: 0 };
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_PRODUCTS, "readwrite");
    const store = transaction.objectStore(STORE_PRODUCTS);
    let added = 0;
    let updated = 0;
    let pending = products.length;
    for (const prod of products) {
      if (!prod || !prod.productId) {
        pending -= 1;
        continue;
      }
      const getReq = store.get(prod.productId);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (existing) {
          updated += 1;
          store.put({
            ...existing,
            ...prod,
            firstSeenAt: existing.firstSeenAt || Date.now(),
            updatedAt: Date.now(),
          });
        } else {
          added += 1;
          store.put({
            ...prod,
            firstSeenAt: Date.now(),
            updatedAt: Date.now(),
          });
        }
        pending -= 1;
        if (pending === 0) resolve({ added, updated });
      };
      getReq.onerror = () => {
        pending -= 1;
        if (pending === 0) resolve({ added, updated });
      };
    }
    if (pending === 0) resolve({ added, updated });
    transaction.onerror = () => reject(transaction.error);
  });
}

/** Lấy toàn bộ sản phẩm (tùy chọn lọc theo source), mới cập nhật trước. */
async function getProducts(source) {
  const store = await tx(STORE_PRODUCTS, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      let result = req.result || [];
      if (source) result = result.filter((p) => p.source === source);
      result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Tìm sản phẩm theo từ khóa + khoảng giá + danh mục (lọc trong bộ nhớ).
 * opts: { query, minPrice, maxPrice, category, source, limit }
 */
async function searchProducts(opts = {}) {
  const all = await getProducts(opts.source);
  const q = (opts.query || "").trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const min = Number.isFinite(opts.minPrice) ? opts.minPrice : null;
  const max = Number.isFinite(opts.maxPrice) ? opts.maxPrice : null;
  const cat = (opts.category || "").toLowerCase();
  const limit = opts.limit || 50;

  const scored = [];
  for (const p of all) {
    if (cat && (p.category || "").toLowerCase() !== cat) continue;
    const price = Number(p.price) || 0;
    if (min != null && price < min) continue;
    if (max != null && price > max) continue;

    const hay = ((p.name || "") + " " + (p.category || "") + " " + (p.brand || "")).toLowerCase();
    let score = 0;
    if (terms.length) {
      let matched = 0;
      for (const t of terms) if (hay.includes(t)) matched += 1;
      if (matched === 0) continue; // không khớp từ nào -> loại
      score = matched / terms.length;
    } else {
      score = 1;
    }
    scored.push({ product: p, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.product.price || 0) - (b.product.price || 0));
  return scored.slice(0, limit).map((s) => s.product);
}

/** Xóa toàn bộ sản phẩm (hoặc theo source). Trả về số sản phẩm đã xóa. */
async function clearProducts(source) {
  const db = await openDB();
  if (!source) {
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_PRODUCTS, "readwrite");
      const store = transaction.objectStore(STORE_PRODUCTS);
      const countReq = store.count();
      countReq.onsuccess = () => {
        const n = countReq.result;
        const clearReq = store.clear();
        clearReq.onsuccess = () => resolve(n);
        clearReq.onerror = () => reject(clearReq.error);
      };
      countReq.onerror = () => reject(countReq.error);
    });
  }
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_PRODUCTS, "readwrite");
    const store = transaction.objectStore(STORE_PRODUCTS);
    const index = store.index("by_source");
    let deleted = 0;
    const req = index.openCursor(IDBKeyRange.only(source));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        deleted += 1;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** Xóa một sản phẩm theo productId. */
async function deleteProduct(productId) {
  const store = await tx(STORE_PRODUCTS, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(productId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/* ============================ SOURCES =================================== */

/**
 * Lưu/cập nhật một cấu hình nguồn dữ liệu.
 * Cấu trúc: { id, name, url, method, headers, bodyTemplate, itemsPath, mapping, enabled }
 *  - itemsPath: đường dẫn tới mảng sản phẩm trong JSON trả về (vd "data.products").
 *  - mapping: ánh xạ field { productId, name, price, category, brand, url, image, stock }
 *    mỗi giá trị là đường dẫn trong từng item (vd "id", "attributes.price").
 */
async function saveSource(source) {
  if (!source || !source.id) throw new Error("Thiếu id nguồn dữ liệu.");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_SOURCES, "readwrite");
    const store = transaction.objectStore(STORE_SOURCES);
    const getReq = store.get(source.id);
    getReq.onsuccess = () => {
      const existing = getReq.result || {};
      const merged = {
        method: "GET",
        headers: {},
        bodyTemplate: "",
        itemsPath: "",
        mapping: {},
        enabled: true,
        ...existing,
        ...source,
        createdAt: existing.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Lấy toàn bộ cấu hình nguồn dữ liệu. */
async function getSources() {
  const store = await tx(STORE_SOURCES, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      const result = req.result || [];
      result.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Xóa một cấu hình nguồn theo id. */
async function deleteSource(id) {
  const store = await tx(STORE_SOURCES, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/* ========================== ADVISORIES =================================== */

/**
 * Lưu (hoặc cập nhật) một nháp tư vấn. Khoá theo postId nên gọi lại trên cùng
 * bài sẽ GHI ĐÈ (dedupe). Trả về bản ghi đã lưu.
 */
async function saveAdvisory(adv) {
  if (!adv || !adv.postId) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_ADVISORIES, "readwrite");
    const store = transaction.objectStore(STORE_ADVISORIES);
    const getReq = store.get(adv.postId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const record = {
        status: "pending",
        createdAt: Date.now(),
        ...(existing || {}),
        ...adv,
        updatedAt: Date.now(),
      };
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve(record);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Lấy toàn bộ nháp tư vấn (tùy chọn lọc theo status), mới nhất trước. */
async function getAdvisories(status) {
  const store = await tx(STORE_ADVISORIES, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      let result = req.result || [];
      if (status) result = result.filter((a) => a.status === status);
      result.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Lấy 1 nháp theo postId (để biết bài đã có nháp chưa). */
async function getAdvisory(postId) {
  const store = await tx(STORE_ADVISORIES, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(postId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Cập nhật một nháp theo postId (gộp các trường truyền vào). */
async function updateAdvisory(postId, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_ADVISORIES, "readwrite");
    const store = transaction.objectStore(STORE_ADVISORIES);
    const getReq = store.get(postId);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        resolve(null);
        return;
      }
      const merged = { ...existing, ...patch, updatedAt: Date.now() };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Xóa một nháp theo postId. */
async function deleteAdvisory(postId) {
  const store = await tx(STORE_ADVISORIES, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(postId);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

/** Xóa toàn bộ nháp tư vấn (hoặc theo status). Trả về số bản ghi đã xóa. */
async function clearAdvisories(status) {
  const store = await tx(STORE_ADVISORIES, "readwrite");
  return new Promise((resolve, reject) => {
    let deleted = 0;
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        if (!status || cursor.value.status === status) {
          cursor.delete();
          deleted += 1;
        }
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/* ----------------------- HỘI THOẠI (conversations) --------------------- */

/**
 * Tạo một hội thoại mới (sau khi đăng bình luận thành công). Trả về bản ghi
 * kèm id. `replies` luôn khởi tạo rỗng; theo dõi nền sẽ merge dần vào sau.
 */
async function createConversation(conv) {
  const db = await openDB();
  const record = {
    status: "watching", // watching | drafted | replied | closed
    postId: "",
    postUrl: "",
    groupId: "",
    groupName: "",
    jobId: null,
    myComment: "", // nội dung bình luận của ta
    myCommentUrl: "", // permalink bình luận của ta (nếu bắt được)
    replies: [], // [{ id, author, text, ts, seenAt }]
    draft: null, // nháp phản hồi do AI soạn { reply, confidence, ... }
    lastWatchedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...conv,
  };
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_CONVERSATIONS, "readwrite");
    const store = transaction.objectStore(STORE_CONVERSATIONS);
    const req = store.add(record);
    req.onsuccess = () => resolve({ ...record, id: req.result });
    req.onerror = () => reject(req.error);
  });
}

/** Lấy toàn bộ hội thoại (tùy chọn lọc theo status), mới cập nhật trước. */
async function getConversations(status) {
  const store = await tx(STORE_CONVERSATIONS, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => {
      let result = req.result || [];
      if (status) result = result.filter((c) => c.status === status);
      result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(result);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Lấy một hội thoại theo id. */
async function getConversation(id) {
  const store = await tx(STORE_CONVERSATIONS, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Cập nhật một hội thoại theo id (gộp trường, KHÔNG ghi đè cả bản ghi). */
async function updateConversation(id, patch) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_CONVERSATIONS, "readwrite");
    const store = transaction.objectStore(STORE_CONVERSATIONS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        resolve(null);
        return;
      }
      const merged = { ...existing, ...patch, updatedAt: Date.now() };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve(merged);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * MERGE các reply mới vào hội thoại (KHÔNG ghi đè reply cũ). Dedupe theo
 * replyId nếu có, nếu không thì theo cặp (author|text). Trả về { added, total }.
 */
async function mergeReplies(id, incoming) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_CONVERSATIONS, "readwrite");
    const store = transaction.objectStore(STORE_CONVERSATIONS);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      if (!existing) {
        resolve({ added: 0, total: 0 });
        return;
      }
      const have = Array.isArray(existing.replies) ? existing.replies.slice() : [];
      const keyOf = (r) =>
        (r && r.id) ? "id:" + r.id : "tx:" + ((r && r.author) || "") + "|" + ((r && r.text) || "");
      const seen = new Set(have.map(keyOf));
      let added = 0;
      for (const r of Array.isArray(incoming) ? incoming : []) {
        if (!r || !r.text) continue;
        const k = keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
        have.push({
          id: r.id || null,
          author: r.author || "",
          text: String(r.text).slice(0, 2000),
          ts: r.ts || null,
          timeText: r.timeText || "",
          seenAt: Date.now(),
        });
        added += 1;
      }
      const patch = {
        replies: have,
        lastWatchedAt: Date.now(),
        updatedAt: Date.now(),
      };
      // Có reply mới của người khác -> đánh dấu để người dùng chú ý (nếu đang chỉ "watching").
      if (added > 0 && existing.status === "watching") patch.status = "replied";
      const merged = { ...existing, ...patch };
      const putReq = store.put(merged);
      putReq.onsuccess = () => resolve({ added, total: have.length });
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Xóa một hội thoại theo id. */
async function deleteConversation(id) {
  const store = await tx(STORE_CONVERSATIONS, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// Xuất dưới dạng ES module. background.js nạp qua `import * as DB from "./db.js"`.
export {
  // posts
  savePosts,
  getKnownIds,
  getAllPosts,
  getStats,
  clearPosts,
  // groups
  saveGroup,
  saveGroups,
  getGroups,
  deleteGroup,
  // jobs
  createJob,
  updateJob,
  getJobs,
  getDueJobs,
  deleteJob,
  clearFinishedJobs,
  // products
  saveProducts,
  getProducts,
  searchProducts,
  clearProducts,
  deleteProduct,
  // sources
  saveSource,
  getSources,
  deleteSource,
  // advisories (nháp tư vấn AI)
  saveAdvisory,
  getAdvisories,
  getAdvisory,
  updateAdvisory,
  deleteAdvisory,
  clearAdvisories,
  // conversations (hội thoại bình luận + theo dõi reply)
  createConversation,
  getConversations,
  getConversation,
  updateConversation,
  mergeReplies,
  deleteConversation,
};
