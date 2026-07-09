/**
 * gql-messenger.js — Bộ phân tích PURE (không DOM, không chrome.*) biến response
 * GraphQL nội bộ của MESSENGER (Facebook web) thành object hộp thư chuẩn của dự
 * án, khớp shape mà db.js.upsertInboxThreads mong đợi:
 *   InboxThread  = { threadId, name, threadUrl, preview, unread, messages }
 *   InboxMessage = { mine, text, ts }
 *
 * THIẾT KẾ THEO NGUYÊN TẮC "XÁC MINH, KHÔNG ĐOÁN MÒ" (giống gql-parse.js):
 *   GraphQL nội bộ FB KHÔNG có tài liệu và ĐỔI shape thường xuyên. KHÔNG hardcode
 *   một đường dẫn cứng. Thay vào đó tìm-kiếm-sâu (deep search) theo NHIỀU dấu
 *   hiệu: object có `thread_key`, `last_message`/`snippet`, mảng `message` node
 *   có `text` + `timestamp_precise`… Cách này bền với việc FB lồng field vào các
 *   "comet_sections" / "message_thread" khác nhau.
 *
 * Là ES module để TEST trực tiếp bằng `node --test`. content.js nạp động qua
 * import(chrome.runtime.getURL("src/gql-messenger.js")) (cần web_accessible_resources).
 */

// ---- Bóc tham số request (dùng chung công thức với gql-parse.js) ----------

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

/** Có phải request DANH SÁCH hội thoại (thread list) không? */
export function isThreadListRequest(friendly, variables) {
  const f = String(friendly || "").toLowerCase();
  if (
    f.includes("loadthreadlist") ||
    f.includes("threadlistquery") ||
    f.includes("messengerinbox") ||
    f.includes("inboxthread") ||
    (f.includes("mwchatweb") && !f.includes("message"))
  ) {
    return true;
  }
  const s = JSON.stringify(variables || {}).toLowerCase();
  // Dấu hiệu variables của thread-list: có folder/inbox nhưng KHÔNG khoá vào 1
  // thread cụ thể (không có thread_id / thread_key rõ).
  return (
    (s.includes("inbox") || s.includes("folder") || s.includes("threadlist")) &&
    !s.includes("thread_id") &&
    !s.includes('"threadkey"')
  );
}

/** Có phải request NỘI DUNG một hội thoại (messages của 1 thread) không? */
export function isThreadMessagesRequest(friendly, variables) {
  const f = String(friendly || "").toLowerCase();
  if (
    f.includes("loadmessages") ||
    f.includes("messagerangequery") ||
    f.includes("messagethreadquery") ||
    f.includes("messages")
  ) {
    return true;
  }
  const s = JSON.stringify(variables || {}).toLowerCase();
  return (
    (s.includes("thread_id") || s.includes("threadkey") || s.includes("thread_key")) &&
    (s.includes("message") || s.includes("before") || s.includes("range"))
  );
}

// ---- Tiện ích tìm-kiếm-sâu (bản sao THUẦN của gql-parse.js) ---------------

/**
 * Duyệt đệ quy, gọi cb(value, key, parent) cho MỌI node — KỂ CẢ lá nguyên thuỷ.
 * depthMax chặn lồng quá sâu; seen-set chặn vòng lặp tham chiếu.
 */
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

// ---- Bóc threadId từ thread_key / id --------------------------------------

/** Lấy threadId ổn định từ một object thread_key hoặc node hội thoại. */
function extractThreadId(node) {
  if (!node || typeof node !== "object") return null;
  // 1) thread_key { thread_fbid } (nhóm) | { other_user_id } (1:1).
  const tk = deepFind(
    node,
    (v, k) =>
      (k === "thread_key" || k === "threadKey") &&
      v &&
      typeof v === "object" &&
      (v.thread_fbid != null || v.other_user_id != null)
  );
  if (tk) {
    if (tk.thread_fbid != null && String(tk.thread_fbid)) return String(tk.thread_fbid);
    if (tk.other_user_id != null && String(tk.other_user_id)) return String(tk.other_user_id);
  }
  // 2) field phẳng thread_fbid / other_user_id.
  const flat = deepFind(
    node,
    (v, k) =>
      (k === "thread_fbid" || k === "other_user_id") &&
      (typeof v === "string" || typeof v === "number") &&
      String(v)
  );
  if (flat != null && String(flat)) return String(flat);
  return null;
}

/**
 * Nhãn UI/hệ thống chung của Facebook (KHÔNG phải tên hội thoại). Tên người/nhóm
 * mà trùng một trong các nhãn này sẽ bị loại để tránh lỗi "tất cả tên = Thông báo".
 */
const GENERIC_LABEL =
  /^(thông báo|notifications?|đang hoạt động|active( now)?|hoạt động|marketplace|đã xem|seen|sent|đã gửi|đã nhận|delivered|you|bạn|mới|new|messenger|tin nhắn|messages?|chat|đoạn chat|người liên hệ|contacts?|trang chủ|home|menu|cài đặt|settings?)$/i;

/** Chuỗi có phải nhãn UI chung (không dùng làm tên hội thoại). */
const isGenericLabel = (s) =>
  typeof s === "string" && GENERIC_LABEL.test(s.trim());

/**
 * Object trông giống một "người/thực thể" thật (có tên + dấu hiệu actor như id,
 * __typename User/Group, hoặc profile url) và KHÔNG phải nhãn UI chung.
 */
const looksLikeUserName = (v) =>
  v &&
  typeof v === "object" &&
  typeof v.name === "string" &&
  v.name.trim() &&
  !isGenericLabel(v.name) &&
  (v.id != null ||
    v.user_id != null ||
    v.userID != null ||
    (typeof v.__typename === "string" &&
      /(user|group|person|actor|thread|participant|messaging)/i.test(v.__typename)) ||
    typeof v.profile_url === "string" ||
    typeof v.url === "string");

/** Tên hiển thị của hội thoại (tên nhóm chat hoặc tên người đối diện). */
function extractThreadName(node, selfId) {
  // 1) node.name trực tiếp (nhóm chat / thread có tên) — bỏ qua nhãn UI chung.
  if (
    node &&
    typeof node.name === "string" &&
    node.name.trim() &&
    !isGenericLabel(node.name)
  ) {
    return node.name.trim().slice(0, 200);
  }
  // 2) tên "người tham gia khác" — object actor có name + id KHÁC selfId.
  const other = deepFind(
    node,
    (v, k) =>
      (k === "messaging_actor" || k === "actor" || k === "sender" || k === "participant") &&
      looksLikeUserName(v) &&
      (!selfId || String(v.id || "") !== String(selfId))
  );
  if (other) return String(other.name).trim().slice(0, 200);
  // 3) fallback: object actor bất kỳ có name hợp lệ (không phải nhãn UI chung).
  const any = deepFind(
    node,
    (v) => looksLikeUserName(v) && (!selfId || String(v.id || "") !== String(selfId))
  );
  return any ? String(any.name).trim().slice(0, 200) : "";
}

/** Đoạn xem trước (preview) của hội thoại từ last_message/snippet. */
function extractPreview(node) {
  // snippet là field phổ biến nhất cho preview trong thread list.
  const snip = deepFind(
    node,
    (v, k) => k === "snippet" && typeof v === "string" && v.trim()
  );
  if (snip) return String(snip).trim().slice(0, 400);
  // last_message.{...text} — tìm text trong nhánh last_message.
  const lm = deepFind(
    node,
    (v, k) => (k === "last_message" || k === "lastMessage") && v && typeof v === "object"
  );
  if (lm) {
    const t = deepFind(
      lm,
      (v, k) => k === "text" && typeof v === "string" && v.trim()
    );
    if (t) return String(t).trim().slice(0, 400);
  }
  return "";
}

/** Cờ chưa đọc của hội thoại. */
function extractUnread(node) {
  // unread_count / unreadCount > 0
  const cnt = deepFind(
    node,
    (v, k) =>
      (k === "unread_count" || k === "unreadCount" || k === "unread_message_count") &&
      typeof v === "number"
  );
  if (typeof cnt === "number") return cnt > 0;
  // cờ boolean is_unread / has_unread / read (đảo).
  const flag = deepFind(
    node,
    (v, k) =>
      (k === "is_unread" || k === "has_unread") && typeof v === "boolean"
  );
  if (typeof flag === "boolean") return flag;
  const read = deepFind(node, (v, k) => k === "read" && typeof v === "boolean");
  if (typeof read === "boolean") return !read;
  return false;
}

/**
 * Nhận diện một object có PHẢI node hội thoại (thread) không: có thread_key
 * hoặc __typename kiểu *Thread, và có dấu hiệu preview/last_message.
 */
function looksLikeThreadNode(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const hasKey =
    (v.thread_key && typeof v.thread_key === "object") ||
    v.thread_fbid != null ||
    (typeof v.__typename === "string" && /thread/i.test(v.__typename));
  if (!hasKey) return false;
  // Loại object thread_key trần (chỉ có id) — cần thêm dấu hiệu nội dung.
  const hasContent =
    "snippet" in v ||
    "last_message" in v ||
    "lastMessage" in v ||
    "name" in v ||
    "messages" in v ||
    "unread_count" in v ||
    "updated_time_precise" in v;
  return hasContent;
}

/**
 * Trích DANH SÁCH hội thoại từ mảng chunk JSON. Dedup theo threadId.
 * ctx = { origin, selfId }. Trả { threads, pageInfo }.
 */
export function extractThreadsFromChunks(chunks, ctx) {
  const context = ctx || {};
  const origin = context.origin || "https://www.facebook.com";
  const selfId = context.selfId || "";
  const threads = [];
  const seen = new Set();
  let pageInfo = { endCursor: null, hasNext: false };

  for (const chunk of chunks || []) {
    const nodes = deepCollect(chunk, (v) => looksLikeThreadNode(v));
    for (const node of nodes) {
      const threadId = extractThreadId(node);
      if (!threadId || seen.has(threadId)) continue;
      seen.add(threadId);
      threads.push({
        threadId,
        name: extractThreadName(node, selfId),
        threadUrl: origin + "/messages/t/" + threadId,
        preview: extractPreview(node),
        unread: extractUnread(node),
        messages: [],
        source: "api",
      });
    }
    const pi = findPageInfo(chunk);
    if (pi.endCursor || pi.hasNext) pageInfo = pi;
  }

  return { threads, pageInfo };
}

// ---- Bóc tin nhắn của MỘT hội thoại ---------------------------------------

/** Timestamp (ms) của một message node. */
function extractMessageTs(node) {
  const t = deepFind(
    node,
    (v, k) =>
      (k === "timestamp_precise" || k === "timestamp_ms" || k === "timestamp") &&
      (typeof v === "string" || typeof v === "number") &&
      String(v).length >= 10 &&
      !isNaN(Number(v))
  );
  if (t != null) {
    const n = Number(t);
    if (!isNaN(n) && n > 1000000000000) return n; // đã là ms
    if (!isNaN(n) && n > 1000000000) return n * 1000; // giây -> ms
  }
  return null;
}

/** Text của một message node. */
function extractMessageText(node) {
  // message.text hoặc snippet.
  const msg = deepFind(
    node,
    (v, k) => k === "message" && v && typeof v === "object" && typeof v.text === "string"
  );
  if (msg && typeof msg.text === "string") return String(msg.text);
  const t = deepFind(
    node,
    (v, k) => (k === "text" || k === "snippet") && typeof v === "string" && v.trim()
  );
  return t ? String(t) : "";
}

/** id người gửi của một message node (dò nhiều shape comet khác nhau). */
function extractSenderId(node) {
  // 1) Các key id "phẳng" hay gặp cho người gửi trong Messenger comet.
  const flat = deepFind(
    node,
    (v, k) =>
      (k === "sender_id" ||
        k === "senderID" ||
        k === "author_id" ||
        k === "authorID" ||
        k === "actor_id" ||
        k === "messaging_actor_id") &&
      (typeof v === "string" || typeof v === "number") &&
      /^\d+$/.test(String(v))
  );
  if (flat != null && String(flat)) return String(flat);

  // 2) Object người gửi: message_sender / sender / messaging_actor / author.
  const sender = deepFind(
    node,
    (v, k) =>
      (k === "message_sender" ||
        k === "sender" ||
        k === "messaging_actor" ||
        k === "author") &&
      v &&
      typeof v === "object"
  );
  if (sender) {
    // Ưu tiên id NUMERIC (id user thật) thay vì id base64 của message.
    const numId = deepFind(
      sender,
      (v, k) =>
        (k === "id" || k === "user_id" || k === "userID") &&
        (typeof v === "string" || typeof v === "number") &&
        /^\d+$/.test(String(v))
    );
    if (numId != null) return String(numId);
    const anyId = deepFind(
      sender,
      (v, k) => k === "id" && (typeof v === "string" || typeof v === "number") && String(v)
    );
    if (anyId != null) return String(anyId);
  }
  return "";
}

/**
 * Nhận diện một object có PHẢI message node không: có text nội dung +
 * timestamp, và có dấu hiệu là tin nhắn (message_sender / __typename *Message).
 */
function looksLikeMessageNode(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const isMsgType =
    (typeof v.__typename === "string" && /message/i.test(v.__typename)) ||
    "message_sender" in v ||
    "messageSender" in v ||
    (v.message && typeof v.message === "object" && typeof v.message.text === "string");
  if (!isMsgType) return false;
  const hasTs =
    "timestamp_precise" in v || "timestamp_ms" in v || "timestamp" in v;
  return hasTs;
}

/**
 * Trích TIN NHẮN của một hội thoại từ mảng chunk JSON. Sắp xếp CŨ -> MỚI theo
 * timestamp. Dedup theo (ts + text). ctx = { selfId }. Trả { messages, pageInfo }.
 */
export function extractMessagesFromChunks(chunks, ctx) {
  const context = ctx || {};
  const selfId = String(context.selfId || "");
  // otherId = id người ĐỐI DIỆN (với chat 1:1 chính là threadId/other_user_id).
  // Đây là tín hiệu KHÔNG phụ thuộc selfId: tin do người này gửi => của họ,
  // còn lại => của mình. Rất ổn định cho hộp thoại 1:1 của người bán hàng.
  const otherId = String(context.otherId || "");
  const messages = [];
  const seen = new Set();
  let pageInfo = { endCursor: null, hasNext: false };
  let name = "";

  for (const chunk of chunks || []) {
    // Tên hội thoại (người/nhóm đối diện) — dò trên cả chunk, loại nhãn UI chung
    // như "Đoạn chat"/"Thông báo" nhờ isGenericLabel bên trong extractThreadName.
    if (!name) {
      const nm = extractThreadName(chunk, selfId);
      if (nm && !isGenericLabel(nm)) name = nm;
    }
    const nodes = deepCollect(chunk, (v) => looksLikeMessageNode(v));
    for (const node of nodes) {
      const text = extractMessageText(node);
      if (!text || !text.trim()) continue;
      const ts = extractMessageTs(node);
      const senderId = extractSenderId(node);
      // Xác định "mine" theo tín hiệu ĐÁNG TIN CẬY, KHÔNG suy diễn liều:
      //  1) cờ is_sender do FB trả (nếu có) -> tin tuyệt đối.
      //  2) selfId (cookie c_user) là CHUẨN VÀNG: khớp -> của mình, khác ->
      //     của đối phương. Đúng cho cả nhóm lẫn 1:1.
      //  3) senderId === otherId -> chắc chắn của đối phương (chỉ dùng khi
      //     otherId THỰC SỰ khớp; KHÔNG suy ra "của mình" từ việc không khớp,
      //     vì threadId trong URL KHÔNG phải id người đối diện).
      // Nếu không tín hiệu nào chốt được -> để mineKnown=false, tầng trên sẽ
      // rơi về đọc DOM theo VỊ TRÍ bong bóng (ground-truth).
      let mine = null;
      if (typeof node.is_sender === "boolean") {
        mine = node.is_sender;
      } else if (selfId && senderId) {
        mine = senderId === selfId;
      } else if (otherId && senderId && senderId === otherId) {
        mine = false;
      }
      const key = String(ts || "") + "|" + text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push({
        mine: mine === true,
        mineKnown: mine !== null,
        text: String(text),
        ts,
        senderId: senderId || "",
      });
    }
    const pi = findPageInfo(chunk);
    if (pi.endCursor || pi.hasNext) pageInfo = pi;
  }

  // FB thường trả tin MỚI -> CŨ; chuẩn hoá về CŨ -> MỚI cho UI hiển thị.
  messages.sort((a, b) => {
    const ta = a.ts == null ? 0 : a.ts;
    const tb = b.ts == null ? 0 : b.ts;
    return ta - tb;
  });

  return { messages, pageInfo, name };
}
