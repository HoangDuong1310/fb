/**
 * gql-parse.js — Bộ phân tích PURE (không phụ thuộc DOM, không chrome.*) để
 * biến response GraphQL nội bộ của Facebook thành object "bài viết" chuẩn của
 * dự án (khớp shape do content.js.extractPost trả về).
 *
 * THIẾT KẾ THEO NGUYÊN TẮC "XÁC MINH, KHÔNG ĐOÁN MÒ":
 *   GraphQL nội bộ FB KHÔNG có tài liệu và ĐỔI shape thường xuyên. Vì vậy KHÔNG
 *   hardcode đúng MỘT đường dẫn cứng. Thay vào đó dùng tìm-kiếm-sâu (deep search)
 *   theo NHIỀU dấu hiệu (key tên "message", "actors", "creation_time", url chứa
 *   /posts/…). Cách này bền với việc FB lồng field vào "comet_sections" khác nhau.
 *   Mọi giả định đều được:
 *     (a) unit-test bằng fixture tổng hợp (test/gql-parse.test.js), và
 *     (b) kiểm chứng runtime qua lệnh CAPTURE_GQL (dump shape thật).
 *
 * Là ES module để TEST trực tiếp bằng `node --test`. content.js nạp động qua
 * import(chrome.runtime.getURL("src/gql-parse.js")) (cần web_accessible_resources).
 */

// Token postId: pfbid… (mới) hoặc id số (cũ). Trùng PID trong content.js.
const PID_RE = /(pfbid[A-Za-z0-9]+|\d{5,})/;
// PID phải NEO sau /posts/ hoặc /permalink/ — nếu không, \d{5,} sẽ "ăn nhầm"
// groupId (cũng là chuỗi số) đứng TRƯỚC trong /groups/<gid>/posts/<pid>/.
const POST_URL_RE = /\/(?:posts|permalink)\/(pfbid[A-Za-z0-9]+|\d{5,})/;
const STORY_FBID_RE = /story_fbid=(pfbid[A-Za-z0-9]+|\d{5,})/;

/** Băm djb2 -> base36. Bản sao THUẦN của hashStr trong content.js để module này
 *  không phụ thuộc closure content.js (giữ tính test được). Phải cho cùng kết quả. */
export function hashStr(s) {
  let h = 5381;
  const str = String(s == null ? "" : s);
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Vân tay nội dung cho bài ẩn permalink. Cùng công thức với content.js.fingerprintId.
 *
 *  ĐIỀU KIỆN TỐI THIỂU (chống sinh bài rác — đã xác minh trên DB thật):
 *  phải có TÁC GIẢ **hoặc** có TEXT. Chỉ có ảnh là KHÔNG đủ để định danh, vì khi
 *  authorName="" và text="" thì basis thoái hoá thành ĐÚNG url ảnh. Hệ quả đã
 *  quan sát được: các story video/reel (thumbnail t15.5256-10) bị FB trả về không
 *  kèm actor lẫn message -> sinh bài "Không rõ / thiếu link gốc", và cùng một
 *  thumbnail xuất hiện ở 2 nhóm khác nhau lại cho CÙNG hash (đã thấy sgyc24,
 *  y8howe, ov0a4n lặp ở 2 groupId), tức vân tay mất luôn tính phân biệt. */
export function fingerprintId(groupId, authorName, text, images) {
  const norm = String(text || "").replace(/\s+/g, " ").trim().slice(0, 240);
  const img0 = images && images[0] ? String(images[0]).split("?")[0] : "";
  // Không có tác giả VÀ không có text => không đủ định danh (ảnh đơn độc không tính).
  if (!String(authorName || "").trim() && !norm) return null;
  if (!norm && !img0) return null;
  // GIỮ NGUYÊN công thức basis (không trim authorName) để id vân tay của các bài
  // đã lưu trước đây không đổi -> dedup giữa các phiên crawl vẫn đúng.
  const basis = String(authorName || "") + "|" + norm + "|" + img0;
  return "fp:" + groupId + ":" + hashStr(basis);
}

/** Dựng permalink chuẩn (PURE — nhận origin để không phụ thuộc location). */
export function buildPermalink(origin, groupId, postId) {
  return String(origin || "https://www.facebook.com") + "/groups/" + groupId + "/posts/" + postId + "/";
}

/** Bóc tham số từ body urlencoded của request GraphQL. */
export function parseGqlRequestBody(bodyStr) {
  const out = { raw: String(bodyStr || ""), variables: null };
  try {
    const p = new URLSearchParams(out.raw);
    out.fb_dtsg = p.get("fb_dtsg") || "";
    out.doc_id = p.get("doc_id") || "";
    out.lsd = p.get("lsd") || "";
    out.friendly = p.get("fb_api_req_friendly_name") || "";
    const v = p.get("variables");
    if (v) {
      try {
        out.variables = JSON.parse(v);
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

/** Có phải request feed của NHÓM không? (để chọn template replay phân trang). */
export function isGroupFeedRequest(friendly, variables) {
  const f = String(friendly || "").toLowerCase();
  if (
    f.includes("groupsfeed") ||
    f.includes("group_feed") ||
    f.includes("groupscometfeed") ||
    f.includes("groupscometnewsfeed")
  ) {
    return true;
  }
  const s = JSON.stringify(variables || {}).toLowerCase();
  return s.includes("group") && (s.includes("feed") || s.includes("stories"));
}

// ---- Tiện ích tìm-kiếm-sâu (deep search) --------------------------------

/**
 * Duyệt đệ quy, gọi cb(value, key, parent) cho MỌI node — KỂ CẢ lá nguyên thuỷ
 * (string/number/bool). Điều này TỐI QUAN TRỌNG: nhiều field FB cần bắt là GIÁ
 * TRỊ nguyên thuỷ nhận diện QUA KEY (vd key "url" -> string permalink, key
 * "creation_time" -> number). Nếu chỉ cb trên object thì sẽ BỎ SÓT chúng.
 * depthMax chặn lồng quá sâu; seen-set chặn vòng lặp tham chiếu.
 */
function walk(obj, cb, depthMax = 14) {
  const stack = [{ v: obj, k: null, p: null, d: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { v, k, p, d } = stack.pop();
    // Gọi cb cho MỌI node (kể cả nguyên thuỷ) trừ chính gốc null/undefined.
    if (v !== undefined) cb(v, k, p);
    if (!v || typeof v !== "object" || d > depthMax) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], k: i, p: v, d: d + 1 });
    } else {
      for (const key in v) stack.push({ v: v[key], k: key, p: v, d: d + 1 });
    }
  }
}

/** Tìm giá trị đầu tiên thoả predicate. Trả null nếu không có. */
function deepFind(obj, predicate) {
  let found = null;
  let has = false;
  walk(obj, (v, k, p) => {
    if (has) return;
    try {
      if (predicate(v, k, p)) {
        found = v;
        has = true;
      }
    } catch (e) {}
  });
  return has ? found : null;
}

/** Thu thập MỌI giá trị thoả predicate. */
function deepCollect(obj, predicate) {
  const out = [];
  walk(obj, (v, k, p) => {
    try {
      if (predicate(v, k, p)) out.push(v);
    } catch (e) {}
  });
  return out;
}

/**
 * Tìm object feed chứa MẢNG `edges`. Có thể có nhiều (feed chính, gợi ý…),
 * chọn cụm `edges` LỚN NHẤT = feed bài chính.
 */
export function findFeedEdges(jsonObj) {
  const candidates = deepCollect(
    jsonObj,
    (v) => v && typeof v === "object" && Array.isArray(v.edges) && v.edges.length > 0
  );
  candidates.sort((a, b) => b.edges.length - a.edges.length);
  return candidates[0] || null;
}

/** Tìm page_info { end_cursor, has_next_page } để phân trang replay. */
export function findPageInfo(jsonObj) {
  const pi = deepFind(
    jsonObj,
    (v) =>
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      (v.end_cursor !== undefined || v.has_next_page !== undefined)
  );
  if (!pi) return { endCursor: null, hasNext: false };
  return {
    endCursor: pi.end_cursor != null ? String(pi.end_cursor) : null,
    hasNext: !!pi.has_next_page,
  };
}

// ---- Bóc tách 1 bài từ node ---------------------------------------------

const looksLikeUser = (v) =>
  v &&
  typeof v === "object" &&
  typeof v.name === "string" &&
  v.name.trim() &&
  (v.__typename === "User" || v.__typename === "Page" || v.id || v.url);

/** Lấy tên + link tác giả. */
function extractAuthorFromNode(node) {
  // Ưu tiên mảng "actors" (FB comet) hoặc object "actor"/"owner".
  let actor =
    deepFind(node, (v, k) => k === "actors" && Array.isArray(v) && v.length && looksLikeUser(v[0])) ||
    null;
  if (actor) actor = actor[0];
  if (!actor) {
    const a = deepFind(node, (v, k) => (k === "actor" || k === "owner") && looksLikeUser(v));
    if (a) actor = a;
  }
  if (!actor) {
    // fallback: object User/Page bất kỳ có name + url profile.
    actor = deepFind(node, (v) => looksLikeUser(v) && typeof v.url === "string");
  }
  if (!actor) return { authorName: "", authorProfile: "" };
  return {
    authorName: String(actor.name || "").trim(),
    authorProfile: actor.url ? String(actor.url) : actor.profile_url ? String(actor.profile_url) : "",
  };
}

/** Lấy text nội dung bài. FB để ở message.text (đôi khi nhiều khối). */
function extractTextFromNode(node) {
  // Tìm mọi object {text:string} nằm dưới key "message".
  const msgs = deepCollect(
    node,
    (v, k) => k === "message" && v && typeof v === "object" && typeof v.text === "string" && v.text.trim()
  );
  if (msgs.length) {
    // chọn text dài nhất (nội dung chính).
    msgs.sort((a, b) => b.text.length - a.text.length);
    return String(msgs[0].text);
  }
  // fallback: object {text} dài nhất bất kỳ (tránh nhãn ngắn).
  const texts = deepCollect(
    node,
    (v) => v && typeof v === "object" && typeof v.text === "string" && v.text.trim().length > 20
  );
  texts.sort((a, b) => b.text.length - a.text.length);
  return texts.length ? String(texts[0].text) : "";
}

/** Lấy danh sách URL ảnh. */
function extractImagesFromNode(node) {
  const out = [];
  const push = (u) => {
    if (u && typeof u === "string" && /^https?:\/\//.test(u) && out.indexOf(u) === -1) out.push(u);
  };
  // photo_image{uri}, image{uri}, các biến thể *_image{uri}
  deepCollect(
    node,
    (v, k) =>
      v &&
      typeof v === "object" &&
      typeof v.uri === "string" &&
      typeof k === "string" &&
      /image|photo/i.test(k)
  ).forEach((o) => push(o.uri));
  return out;
}

/** Lấy URL video (playable_url). Bắt GIÁ TRỊ string qua KEY playable_url*. */
function extractVideosFromNode(node) {
  const out = [];
  deepCollect(
    node,
    (v, k) => typeof v === "string" && /^https?:\/\//.test(v) && /playable_url/i.test(String(k))
  ).forEach((u) => {
    if (out.indexOf(u) === -1) out.push(u);
  });
  return out;
}

/** Lấy postId THẬT (pfbid/số) qua field post_id/story_fbid hoặc url /posts/. */
function extractPostIdFromNode(node) {
  // 1) field trực tiếp post_id / story_fbid (GIÁ TRỊ nguyên thuỷ nhận qua KEY).
  const direct = deepFind(
    node,
    (v, k) =>
      (k === "post_id" || k === "story_fbid") &&
      (typeof v === "string" || typeof v === "number") &&
      PID_RE.test(String(v))
  );
  if (direct != null) {
    const m = String(direct).match(PID_RE);
    if (m) return m[1];
  }
  // 2) qua url permalink — bắt mọi string URL (qua KEY) rồi NEO sau /posts/.
  const urls = deepCollect(node, (v, k) => {
    if (typeof v !== "string") return false;
    const key = String(k);
    return key === "url" || key === "wwwURL" || key === "permalink" || key === "permalink_url";
  });
  for (const u of urls) {
    const m1 = u.match(POST_URL_RE);
    if (m1) return m1[1];
    const m2 = u.match(STORY_FBID_RE);
    if (m2) return m2[1];
  }
  return null;
}

/** Số reaction. */
function extractReactionsFromNode(node) {
  const r = deepFind(
    node,
    (v, k) =>
      (k === "reaction_count" || k === "i18n_reaction_count") &&
      v &&
      typeof v === "object" &&
      typeof v.count === "number"
  );
  if (r && typeof r.count === "number") return r.count;
  return 0;
}

/** Số bình luận. */
function extractCommentsFromNode(node) {
  // 1) Field phổ biến nhất trong feedback object thực tế của FB:
  //    total_comment_count là MỘT number nằm ngay cạnh reaction_count.
  //    (Đây là lý do reactions chạy đúng còn comments luôn = 0: trước đây
  //     ta chỉ tìm comment_count.total_count vốn KHÔNG tồn tại trong response thật.)
  const direct = deepFind(
    node,
    (v, k) =>
      (k === "total_comment_count" || k === "comment_count_reduced") &&
      typeof v === "number"
  );
  if (typeof direct === "number") return direct;

  // 2) Object comment_count / i18n_comment_count với total_count | count.
  const c = deepFind(
    node,
    (v, k) =>
      (k === "comment_count" || k === "i18n_comment_count") &&
      v &&
      typeof v === "object" &&
      (typeof v.total_count === "number" || typeof v.count === "number")
  );
  if (c) {
    return typeof c.total_count === "number"
      ? c.total_count
      : typeof c.count === "number"
      ? c.count
      : 0;
  }

  // 3) comment_rendering_instance...comments.{total_count|count}
  const inst = deepFind(
    node,
    (v, k) =>
      k === "comments" &&
      v &&
      typeof v === "object" &&
      (typeof v.total_count === "number" || typeof v.count === "number")
  );
  if (inst) {
    return typeof inst.total_count === "number"
      ? inst.total_count
      : typeof inst.count === "number"
      ? inst.count
      : 0;
  }

  return 0;
}

/** Thời điểm đăng (creation_time / publish_time -> ms). GIÁ TRỊ number qua KEY. */
function extractTimestampFromNode(node) {
  const t = deepFind(
    node,
    (v, k) =>
      (k === "creation_time" || k === "publish_time") &&
      typeof v === "number" &&
      v > 1000000000
  );
  if (typeof t === "number") return t * 1000; // unix giây -> ms
  return null;
}

/**
 * Map MỘT node (story) -> object bài chuẩn. Trả null nếu không đủ định danh.
 * ctx = { groupId, groupName, origin }
 */
export function mapEdgeToPost(node, ctx) {
  if (!node || typeof node !== "object") return null;
  const groupId = ctx.groupId;
  const author = extractAuthorFromNode(node);
  const text = extractTextFromNode(node);
  const images = extractImagesFromNode(node);

  let postId = extractPostIdFromNode(node);

  // ĐIỀU KIỆN TỐI THIỂU (đối xứng với extractPost trong src/content.js):
  // thiếu CẢ permalink/postId thật LẪN tác giả => không phải bài dùng được, bỏ.
  // Đây chính là chữ ký của rác đã quan sát trên DB thật: postId "fp:", tác giả
  // rỗng, text rỗng, timestamp null, đúng 1 ảnh thumbnail video/reel — hiển thị
  // ra Feed thành "Không rõ" + "thiếu link gốc nên chưa bình luận được".
  if (!postId && !String(author.authorName || "").trim()) return null;

  if (!postId) {
    postId = fingerprintId(groupId, author.authorName, text, images);
  }
  if (!postId) return null;

  const isFp = String(postId).indexOf("fp:") === 0;
  const permalink = isFp ? null : buildPermalink(ctx.origin, groupId, postId);
  const ts = extractTimestampFromNode(node);

  return {
    postId: String(postId),
    groupId,
    groupName: ctx.groupName || groupId,
    permalink,
    authorName: author.authorName,
    authorProfile: author.authorProfile,
    timestamp: ts,
    timeText: ts ? new Date(ts).toISOString() : "",
    text,
    images,
    videos: extractVideosFromNode(node),
    links: [],
    reactions: extractReactionsFromNode(node),
    comments: extractCommentsFromNode(node),
    crawledAt: Date.now(),
    source: "api", // đánh dấu nguồn để chẩn đoán (DOM vs API)
  };
}

/**
 * Trích TẤT CẢ bài từ mảng chunk JSON (một response GraphQL có thể nhiều chunk).
 * Dedup theo postId trong phạm vi lần gọi này. Trả { posts, pageInfo }.
 */
export function extractPostsFromChunks(chunks, ctx) {
  const posts = [];
  const seen = new Set();
  let pageInfo = { endCursor: null, hasNext: false };

  for (const chunk of chunks || []) {
    const edgesObj = findFeedEdges(chunk);
    if (edgesObj) {
      for (const edge of edgesObj.edges) {
        const node = edge && edge.node ? edge.node : edge;
        const p = mapEdgeToPost(node, ctx);
        if (!p) continue;
        if (seen.has(p.postId)) continue;
        seen.add(p.postId);
        posts.push(p);
      }
    }
    const pi = findPageInfo(chunk);
    if (pi.endCursor || pi.hasNext) pageInfo = pi;
  }

  return { posts, pageInfo };
}
