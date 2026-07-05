/**
 * gql-comments.js — Bộ phân tích PURE (không DOM, không chrome.*) để bóc
 * BÌNH LUẬN + TRẢ LỜI (reply) từ response GraphQL nội bộ của Facebook.
 *
 * VÌ SAO tách riêng khỏi gql-parse.js:
 *   gql-parse.js chuyên bóc BÀI VIẾT (feed). Bình luận có shape khác hẳn
 *   (Comment node: body.text, author, legacy_fbid, replies_connection…). Gộp
 *   chung dễ lẫn "message.text" (bài) với "body.text" (bình luận). Tách ra để:
 *     (a) test riêng bằng fixture (test/gql-comments.test.js), và
 *     (b) tái dùng cho cả 2 luồng: BẮT bình luận vừa đăng (mutation) và GOM
 *         reply dưới bình luận của ta (comment-list query).
 *
 * THIẾT KẾ "XÁC MINH, KHÔNG ĐOÁN MÒ" (giống gql-parse.js):
 *   GraphQL FB không có tài liệu và đổi shape thường xuyên => KHÔNG hardcode
 *   đường dẫn cứng. Dùng deep-search theo NHIỀU dấu hiệu:
 *     - Comment node phân biệt với bài viết bằng `body.text` (bài dùng
 *       `message.text`) hoặc __typename==="Comment".
 *     - legacy_fbid = id SỐ của bình luận (khớp `comment_id=` trong URL FB).
 *     - Quan hệ CHA-CON: reply nằm trong một connection key khớp /repl/ dưới
 *       node bình luận cha => gắn parentLegacyId cho reply đó (đây là tín hiệu
 *       ĐÁNG TIN để biết reply thuộc bình luận NÀO, thay cho dò text mờ ở DOM).
 *
 * Là ES module để test bằng `node --test`. content.js / hàm inject nạp động qua
 * import(chrome.runtime.getURL("src/gql-comments.js")) (cần web_accessible_resources).
 */

// ---- Tiện ích deep-search (bản THUẦN, tự chứa để module độc lập) ----------
// (Sao chép có chủ đích từ gql-parse.js: giữ 2 module không phụ thuộc lẫn nhau,
//  tránh vòng import khi nạp động trong trang.)

function walk(obj, cb, depthMax = 16) {
  const stack = [{ v: obj, k: null, p: null, d: 0 }];
  const seen = new Set();
  while (stack.length) {
    const { v, k, p, d } = stack.pop();
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

function deepCollect(obj, predicate) {
  const out = [];
  walk(obj, (v, k, p) => {
    try {
      if (predicate(v, k, p)) out.push(v);
    } catch (e) {}
  });
  return out;
}

// ---- Chuẩn hoá text (khớp bền tiếng Việt) --------------------------------
// Bỏ dấu (NFD + xoá dấu tổ hợp + đ->d) để so text không lệch do khác chuẩn
// hoá Unicode (NFC vs NFD) — cùng lý do đã dùng ở runWatchRepliesInPage.
export function deaccent(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

export function normText(s) {
  return deaccent(s).replace(/\s+/g, " ").trim().toLowerCase();
}

// ---- Nhận diện request bình luận qua friendly name ------------------------
// Dùng để content.js/hook lọc gói GraphQL liên quan bình luận (tạo mới / liệt
// kê / phân trang reply). Cố ý "rộng tay": thà giữ dư còn hơn lọt gói.
const COMMENT_FRIENDLY_SIGNS = [
  "createcomment",
  "ufi", // UFI = Unified Feedback Interface (khối like/comment của FB)
  "commentslist",
  "commentlist",
  "comments_paginated",
  "commentspagination",
  "focusedstoryview",
  "repliesfield",
  "replylist",
];

export function isCommentRequest(friendly, bodyStr) {
  const f = String(friendly || "").toLowerCase();
  if (f) {
    // UFI (khối feedback like/comment) => luôn liên quan bình luận.
    if (f.indexOf("ufi") !== -1) return true;
    // "comment" + động từ/loại truy vấn thường gặp (create/list/repl/pagination…).
    if (
      f.indexOf("comment") !== -1 &&
      (f.indexOf("create") !== -1 ||
        f.indexOf("list") !== -1 ||
        f.indexOf("repl") !== -1 ||
        f.indexOf("pagination") !== -1 ||
        f.indexOf("paginated") !== -1 ||
        f.indexOf("focusedstory") !== -1)
    ) {
      return true;
    }
    for (const sign of COMMENT_FRIENDLY_SIGNS) {
      if (f.indexOf(sign) !== -1) return true;
    }
  }
  const b = String(bodyStr || "").toLowerCase();
  if (!b) return false;
  // Dự phòng theo body: có "comment" + (create/replies/pagination/ufi).
  return (
    b.indexOf("comment") !== -1 &&
    (b.indexOf("create") !== -1 ||
      b.indexOf("repl") !== -1 ||
      b.indexOf("ufi") !== -1 ||
      b.indexOf("pagination") !== -1)
  );
}

// ---- Nhận diện & lấy id SỐ của bình luận ----------------------------------

// legacy_fbid là id SỐ (khớp comment_id= trên URL). Ngoài ra id base64 dạng
// "comment:<postid>_<commentid>" => giải mã lấy đoạn số CUỐI. token dạng
// "<postid>_<commentid>" cũng lấy đoạn cuối.
// Rút id SỐ của bình luận từ một chuỗi. Ưu tiên đoạn số SAU dấu "_" cuối cùng
// (id FB dạng "<postid>_<commentid>"), nếu không có "_" thì lấy chuỗi số nếu
// bản thân nó là số. Chấp nhận id ngắn (test) lẫn id dài thật của FB.
function numericTail(str) {
  const s = String(str || "");
  if (!s) return null;
  // đoạn sau dấu "_" cuối, nếu toàn số.
  const us = s.match(/_(\d+)$/);
  if (us) return us[1];
  // toàn bộ là số?
  if (/^\d+$/.test(s)) return s;
  return null;
}

function decodeLegacyFromId(id) {
  const s = String(id || "");
  if (!s) return null;
  const direct = numericTail(s);
  if (direct) return direct;
  // thử giải base64 (an toàn: bọc try) — id comet thường base64 "comment:<post>_<cmt>".
  try {
    let decoded = "";
    if (typeof atob === "function") decoded = atob(s);
    else if (typeof Buffer !== "undefined") decoded = Buffer.from(s, "base64").toString("utf8");
    if (decoded) {
      const tail = numericTail(decoded);
      if (tail) return tail;
      // dự phòng: cụm số dài nhất trong chuỗi giải mã.
      const runs = decoded.match(/\d+/g);
      if (runs && runs.length) return runs.sort((a, b) => b.length - a.length)[0];
    }
  } catch (e) {}
  return null;
}

function getLegacyId(node) {
  if (!node || typeof node !== "object") return null;
  const cands = [node.legacy_fbid, node.legacyFbid, node.legacy_token];
  for (const c of cands) {
    if (c == null) continue;
    const t = numericTail(c);
    if (t) return t;
  }
  const fromId = decodeLegacyFromId(node.id);
  if (fromId) return fromId;
  return null;
}

// Một object có "trông giống" node bình luận không? Phân biệt với BÀI VIẾT:
// bình luận dùng `body.text`, còn bài dùng `message.text`. Cũng nhận
// __typename==="Comment". Bắt buộc có tín hiệu định danh (id/legacy) để tránh
// vơ nhầm object văn bản linh tinh.
function isCommentNode(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const isType = v.__typename === "Comment";
  const hasBody = v.body && typeof v.body === "object" && typeof v.body.text === "string";
  if (!isType && !hasBody) return false;
  // phải có id/legacy để định danh + tránh nhầm khối con của bình luận.
  return v.id != null || v.legacy_fbid != null || v.legacy_token != null;
}

// Lấy tác giả {id, name}. FB để author là object User/Page.
function getAuthor(node) {
  const a = node && node.author;
  if (a && typeof a === "object") {
    return {
      authorId: a.id != null ? String(a.id) : "",
      authorName: String(a.name || a.short_name || "").trim(),
    };
  }
  return { authorId: "", authorName: "" };
}

function getText(node) {
  if (node && node.body && typeof node.body.text === "string") return node.body.text;
  return "";
}

function getCreatedMs(node) {
  const t = node && node.created_time;
  if (typeof t === "number" && t > 1000000000) return t * 1000;
  return null;
}

/** Chuẩn hoá 1 node bình luận -> object gọn của dự án. */
export function normComment(node, parentLegacyId = null) {
  const { authorId, authorName } = getAuthor(node);
  return {
    legacyId: getLegacyId(node),
    gqlId: node && node.id != null ? String(node.id) : "",
    parentLegacyId: parentLegacyId != null ? String(parentLegacyId) : null,
    authorId,
    authorName,
    text: getText(node),
    createdTime: getCreatedMs(node),
    depth: typeof (node && node.depth) === "number" ? node.depth : null,
  };
}

// Tìm connection reply NGAY dưới một node bình luận (shallow: chỉ soi các key
// khớp /repl/ của chính node đó và feedback của nó) -> trả mảng node reply.
function findReplyNodes(commentNode) {
  const out = [];
  const scanConn = (conn) => {
    if (!conn || typeof conn !== "object") return;
    const edges = conn.edges;
    if (!Array.isArray(edges)) return;
    for (const e of edges) {
      const n = e && e.node ? e.node : e;
      if (isCommentNode(n)) out.push(n);
    }
  };
  const scanHost = (host) => {
    if (!host || typeof host !== "object") return;
    for (const k in host) {
      if (/repl/i.test(k)) scanConn(host[k]);
    }
  };
  scanHost(commentNode);
  if (commentNode.feedback) scanHost(commentNode.feedback);
  return out;
}

/**
 * Bóc TOÀN BỘ bình luận + reply từ một (hoặc nhiều) chunk JSON GraphQL.
 * Trả mảng comment đã chuẩn hoá, DEDUP theo legacyId (hoặc gqlId), có
 * parentLegacyId cho reply. Reply được nhận cha DỰA TRÊN cấu trúc lồng
 * (connection /repl/ dưới node cha) — KHÔNG đoán theo text.
 *
 * @param {Array} chunks - mảng object JSON (mỗi response có thể nhiều chunk).
 * @returns {Array} comment[]
 */
export function extractComments(chunks) {
  const list = Array.isArray(chunks) ? chunks : [chunks];
  const byKey = new Map(); // dedup key -> comment

  const keyOf = (c) => (c.legacyId ? "L:" + c.legacyId : c.gqlId ? "G:" + c.gqlId : null);

  // LƯU Ý: KHÔNG chặn theo object identity ở đây. Cùng một node có thể được
  // thêm 2 lần: 1 lần khi deepCollect gặp nó độc lập (parent chưa biết -> null)
  // và 1 lần khi cha của nó gọi findReplyNodes() (biết đúng parentLegacyId).
  // Việc dedup/merge theo `key` (legacyId/gqlId) bên dưới xử lý đúng cả 2 lần
  // gọi bất kể thứ tự — nếu chặn theo identity thì lần gọi mang parentLegacyId
  // đúng có thể bị bỏ qua khi nó xảy ra SAU lần gọi với parent=null.
  const add = (node, parentLegacyId) => {
    if (!node) return;
    const c = normComment(node, parentLegacyId);
    const k = keyOf(c);
    if (!k) return; // không định danh -> bỏ (tránh rác)
    // Giữ bản có nhiều thông tin hơn nếu trùng (vd bản có text/parent).
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, c);
    } else {
      if (!prev.parentLegacyId && c.parentLegacyId) prev.parentLegacyId = c.parentLegacyId;
      if (!prev.text && c.text) prev.text = c.text;
      if (!prev.authorName && c.authorName) prev.authorName = c.authorName;
      if (!prev.authorId && c.authorId) prev.authorId = c.authorId;
      if (prev.createdTime == null && c.createdTime != null) prev.createdTime = c.createdTime;
    }
  };

  for (const chunk of list) {
    if (!chunk) continue;
    // Mọi node bình luận trong chunk (kể cả lồng sâu).
    const nodes = deepCollect(chunk, isCommentNode);
    for (const node of nodes) {
      const parentId = getLegacyId(node);
      // Thêm CHÍNH node (parent chưa biết -> null; sẽ được điền khi gặp qua cha).
      add(node, null);
      // Reply trực tiếp dưới node này -> gắn cha = node.legacyId.
      if (parentId) {
        for (const reply of findReplyNodes(node)) {
          add(reply, parentId);
        }
      }
    }
  }

  return [...byKey.values()];
}

/**
 * Từ response mutation TẠO bình luận (hoặc feed sau khi đăng), tìm ĐÚNG bình
 * luận vừa tạo của TA. Chấm điểm theo:
 *   - Khớp text (chuẩn hoá): bằng nhau > chứa/được chứa > không.
 *   - Ưu tiên tác giả trùng (authorId, rồi authorName).
 * Trả comment đã chuẩn hoá tốt nhất, hoặc null.
 *
 * @param {Array} chunks
 * @param {{text?:string, authorId?:string, authorName?:string}} me
 */
export function findCreatedComment(chunks, me = {}) {
  const comments = extractComments(chunks);
  if (!comments.length) return null;

  const wantText = normText(me.text || "");
  const wantAuthorId = String(me.authorId || "");
  const wantAuthorName = normText(me.authorName || "");

  let best = null;
  let bestScore = -1;
  for (const c of comments) {
    let score = 0;
    const ct = normText(c.text || "");
    if (wantText) {
      if (ct && ct === wantText) score += 100;
      else if (ct && (ct.indexOf(wantText) !== -1 || wantText.indexOf(ct) !== -1)) score += 60;
      else score -= 20; // có text mong muốn nhưng không khớp -> ít khả năng
    }
    if (wantAuthorId && c.authorId && String(c.authorId) === wantAuthorId) score += 40;
    if (wantAuthorName && normText(c.authorName) === wantAuthorName) score += 25;
    // Bình luận gốc (không phải reply) hợp lý hơn cho "vừa đăng".
    if (!c.parentLegacyId) score += 5;
    // Mới nhất ưu tiên nhẹ (khi hoà điểm).
    if (c.createdTime) score += 0.001 * (c.createdTime / 1e10);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  // Chỉ nhận khi có tín hiệu tối thiểu (khớp text hoặc tác giả), tránh bắt bừa.
  if (best && bestScore <= 0 && (wantText || wantAuthorId || wantAuthorName)) return null;
  return best;
}

/**
 * Gom các REPLY thuộc ĐÚNG một bình luận cha (parentLegacyId). Kèm nhận diện
 * "của ta" theo authorId (bền hơn so tên): reply có authorId === me.authorId,
 * hoặc (khi thiếu id) authorName trùng.
 *
 * @param {Array} chunks
 * @param {string} parentLegacyId - id SỐ của bình luận cha (của ta).
 * @param {{authorId?:string, authorName?:string}} me
 * @returns {{parentText:string, parentAuthor:string, replies:Array}}
 */
export function extractRepliesForParent(chunks, parentLegacyId, me = {}) {
  const comments = extractComments(chunks);
  const pid = String(parentLegacyId || "");
  const meId = String(me.authorId || "");
  const meName = normText(me.authorName || "");

  let parentText = "";
  let parentAuthor = "";
  const replies = [];
  for (const c of comments) {
    if (pid && String(c.legacyId) === pid) {
      // Chính bình luận cha (của ta) -> lấy text/author gốc.
      if (!parentText && c.text) parentText = c.text;
      if (!parentAuthor && c.authorName) parentAuthor = c.authorName;
      continue;
    }
    if (!pid || String(c.parentLegacyId) !== pid) continue; // chỉ reply của cha này
    const mine =
      (meId && c.authorId && String(c.authorId) === meId) ||
      (!meId && meName && normText(c.authorName) === meName);
    replies.push({
      id: c.legacyId || c.gqlId,
      author: c.authorName,
      authorId: c.authorId,
      text: c.text,
      createdTime: c.createdTime,
      mine: !!mine,
    });
  }
  // Sắp theo thời gian tăng dần để luồng hội thoại đúng thứ tự.
  replies.sort((a, b) => (a.createdTime || 0) - (b.createdTime || 0));
  return { parentText, parentAuthor, replies };
}
