/**
 * gql-messenger.test.js — Unit test cho bộ phân tích PURE src/gql-messenger.js.
 *
 * MỤC ĐÍCH (honor "xác minh, không đoán mò"):
 *   GraphQL nội bộ MESSENGER không có tài liệu và đổi shape thường xuyên => trước
 *   khi đấu nối LIVE, ta chứng minh các giả định deep-search bằng FIXTURE TỔNG HỢP
 *   mô phỏng đúng kiểu lồng của FB comet Messenger:
 *     - thread list: viewer.message_threads.nodes[].{thread_key, name, snippet,
 *       last_message, unread_count, read} + page_info.end_cursor
 *     - thread messages: message_thread.messages.nodes[].{message.text,
 *       timestamp_precise, message_sender.messaging_actor.id} + page_info
 *
 *   Chạy: node --test test/gql-messenger.test.js  (Node thuần, không cần chrome).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseGqlRequestBody,
  isThreadListRequest,
  isThreadMessagesRequest,
  findPageInfo,
  extractThreadsFromChunks,
  extractMessagesFromChunks,
} from "../src/gql-messenger.js";

const ORIGIN = "https://www.facebook.com";
const SELF_ID = "100001"; // id của "ta" để suy cờ mine

/* --------------------------- Fixtures tổng hợp --------------------------- */

// Một node hội thoại 1:1 (other_user_id) có snippet + unread_count.
function threadOneToOne(otherUserId, otherName, snippet, unreadCount) {
  return {
    __typename: "MessagingThread",
    thread_key: { other_user_id: otherUserId },
    name: null, // 1:1 không có name; tên lấy từ participant
    snippet,
    unread_count: unreadCount,
    last_message: {
      nodes: [{ snippet, message: { text: snippet } }],
    },
    all_participants: {
      nodes: [
        { messaging_actor: { __typename: "User", id: SELF_ID, name: "Tôi" } },
        {
          messaging_actor: {
            __typename: "User",
            id: otherUserId,
            name: otherName,
          },
        },
      ],
    },
  };
}

// Một node hội thoại NHÓM (thread_fbid) có name + last_message.text.
function threadGroup(threadFbid, groupName, lastText, read) {
  return {
    __typename: "GroupThread",
    thread_key: { thread_fbid: threadFbid },
    name: groupName,
    last_message: { nodes: [{ message: { text: lastText } }] },
    read,
  };
}

// Chunk thread-list kiểu comet: data.viewer.message_threads.nodes[] + page_info.
function threadListChunk(nodes, endCursor, hasNext) {
  return {
    data: {
      viewer: {
        message_threads: {
          nodes,
          page_info: { end_cursor: endCursor, has_next_page: hasNext },
        },
      },
    },
  };
}

// Một message node kiểu comet: message.text + timestamp_precise + sender id.
function messageNode(text, tsMs, senderId) {
  return {
    __typename: "UserMessage",
    message: { text },
    timestamp_precise: String(tsMs),
    message_sender: {
      messaging_actor: { __typename: "User", id: senderId },
    },
  };
}

// Chunk thread-messages: data.message_thread.messages.nodes[] + page_info.
function threadMessagesChunk(nodes, endCursor, hasNext) {
  return {
    data: {
      message_thread: {
        messages: {
          nodes,
          page_info: { end_cursor: endCursor, has_next_page: hasNext },
        },
      },
    },
  };
}

/* ------------------------------ parse body ------------------------------- */

test("parseGqlRequestBody bóc đúng doc_id/friendly/variables", () => {
  const vars = { folderTag: "INBOX", count: 20 };
  const body =
    "fb_dtsg=DTSG123&lsd=LSD456&doc_id=987654321&" +
    "fb_api_req_friendly_name=MWChatWebLoadThreadListQuery&" +
    "variables=" +
    encodeURIComponent(JSON.stringify(vars));
  const req = parseGqlRequestBody(body);
  assert.equal(req.doc_id, "987654321");
  assert.equal(req.fb_dtsg, "DTSG123");
  assert.equal(req.lsd, "LSD456");
  assert.equal(req.friendly, "MWChatWebLoadThreadListQuery");
  assert.deepEqual(req.variables, vars);
});

test("parseGqlRequestBody không ném lỗi với body rỗng", () => {
  const req = parseGqlRequestBody("");
  assert.equal(req.doc_id, "");
  assert.equal(req.variables, null);
});

/* --------------------------- phân loại request --------------------------- */

test("isThreadListRequest nhận diện theo friendly name", () => {
  assert.equal(
    isThreadListRequest("MWChatWebLoadThreadListQuery", {}),
    true
  );
  assert.equal(isThreadListRequest("MessengerInboxQuery", {}), true);
  assert.equal(
    isThreadListRequest("SomeOtherQuery", { folderTag: "INBOX" }),
    true
  );
});

test("isThreadListRequest KHÔNG nhận nhầm request 1 thread", () => {
  assert.equal(
    isThreadListRequest("MWChatWebLoadMessagesQuery", {
      thread_id: "123",
    }),
    false
  );
});

test("isThreadMessagesRequest nhận diện theo friendly + variables", () => {
  assert.equal(
    isThreadMessagesRequest("MWChatWebLoadMessagesQuery", {}),
    true
  );
  assert.equal(
    isThreadMessagesRequest("MessageRangeQuery", {}),
    true
  );
  assert.equal(
    isThreadMessagesRequest("XQuery", { thread_id: "9", before: "c1" }),
    true
  );
});

/* ------------------------------ page_info -------------------------------- */

test("findPageInfo lấy end_cursor + has_next_page ở nhánh lồng sâu", () => {
  const chunk = threadListChunk([], "CURSOR_ABC", true);
  const pi = findPageInfo(chunk);
  assert.equal(pi.endCursor, "CURSOR_ABC");
  assert.equal(pi.hasNext, true);
});

test("findPageInfo trả rỗng khi không có page_info", () => {
  const pi = findPageInfo({ data: {} });
  assert.equal(pi.endCursor, null);
  assert.equal(pi.hasNext, false);
});

/* --------------------------- extract threads ----------------------------- */

test("extractThreadsFromChunks lấy đúng thread 1:1 + nhóm, dedup + pageInfo", () => {
  const nodes = [
    threadOneToOne("200002", "Nguyễn Văn A", "Còn hàng không shop?", 2),
    threadGroup("300003", "Nhóm Sỉ Mỹ Phẩm", "Chốt đơn nhé cả nhà", false),
    // Trùng thread 1:1 (cùng other_user_id) => phải dedup.
    threadOneToOne("200002", "Nguyễn Văn A", "Còn hàng không shop?", 2),
  ];
  const chunk = threadListChunk(nodes, "NEXT_CUR", true);
  const { threads, pageInfo } = extractThreadsFromChunks([chunk], {
    origin: ORIGIN,
    selfId: SELF_ID,
  });

  assert.equal(threads.length, 2);

  const one = threads.find((t) => t.threadId === "200002");
  assert.ok(one, "phải có thread 1:1");
  assert.equal(one.name, "Nguyễn Văn A");
  assert.equal(one.threadUrl, ORIGIN + "/messages/t/200002");
  assert.equal(one.preview, "Còn hàng không shop?");
  assert.equal(one.unread, true);
  assert.deepEqual(one.messages, []);
  assert.equal(one.source, "api");

  const grp = threads.find((t) => t.threadId === "300003");
  assert.ok(grp, "phải có thread nhóm");
  assert.equal(grp.name, "Nhóm Sỉ Mỹ Phẩm");
  assert.equal(grp.preview, "Chốt đơn nhé cả nhà");
  // read=false => chưa đọc => unread=true (extractUnread trả !read).
  assert.equal(grp.unread, true);

  assert.equal(pageInfo.endCursor, "NEXT_CUR");
  assert.equal(pageInfo.hasNext, true);
});

test("extractThreadsFromChunks: read=false => unread=true (đảo cờ read)", () => {
  const chunk = threadListChunk(
    [threadGroup("300004", "Nhóm B", "tin mới", false)],
    null,
    false
  );
  const { threads } = extractThreadsFromChunks([chunk], { origin: ORIGIN });
  assert.equal(threads[0].unread, true);
});

test("extractThreadsFromChunks gộp nhiều trang (chunks)", () => {
  const c1 = threadListChunk(
    [threadOneToOne("111", "A", "p1", 0)],
    "CUR1",
    true
  );
  const c2 = threadListChunk(
    [threadOneToOne("222", "B", "p2", 1)],
    "CUR2",
    false
  );
  const { threads, pageInfo } = extractThreadsFromChunks([c1, c2], {
    origin: ORIGIN,
    selfId: SELF_ID,
  });
  assert.equal(threads.length, 2);
  // pageInfo là của chunk cuối có cursor.
  assert.equal(pageInfo.endCursor, "CUR2");
  assert.equal(pageInfo.hasNext, false);
});

test("extractThreadName KHÔNG lấy nhầm nhãn UI 'Thông báo' làm tên hội thoại", () => {
  // Mô phỏng đúng lỗi user báo: node chứa lẫn object UI tên 'Thông báo'
  // (có id, xuất hiện TRƯỚC actor thật) => tên vẫn phải là người thật.
  const node = {
    __typename: "MessagingThread",
    thread_key: { other_user_id: "200099" },
    name: "Thông báo", // node.name là nhãn UI => phải bị bỏ qua
    snippet: "shop ơi còn hàng không",
    unread_count: 1,
    // Object UI chung chen ngang, có id để "bẫy" fallback tham lam cũ.
    notif_badge: { __typename: "User", id: "999999", name: "Thông báo" },
    all_participants: {
      nodes: [
        { messaging_actor: { __typename: "User", id: SELF_ID, name: "Tôi" } },
        {
          messaging_actor: {
            __typename: "User",
            id: "200099",
            name: "Trần Thị B",
          },
        },
      ],
    },
  };
  const chunk = threadListChunk([node], null, false);
  const { threads } = extractThreadsFromChunks([chunk], {
    origin: ORIGIN,
    selfId: SELF_ID,
  });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].name, "Trần Thị B");
  assert.notEqual(threads[0].name, "Thông báo");
});

test("extractThreadName fallback bỏ qua nhãn UI, giữ tên người thật", () => {
  // Không có actor key chuẩn; chỉ có 1 object UI 'Notifications' và 1 User thật.
  const node = {
    __typename: "MessagingThread",
    thread_key: { other_user_id: "200100" },
    name: null,
    snippet: "ib giá",
    ui_item: { __typename: "UIElement", id: "1", name: "Notifications" },
    author: { __typename: "User", id: "200100", name: "Lê Văn C" },
  };
  const chunk = threadListChunk([node], null, false);
  const { threads } = extractThreadsFromChunks([chunk], {
    origin: ORIGIN,
    selfId: SELF_ID,
  });
  assert.equal(threads[0].name, "Lê Văn C");
});

/* --------------------------- extract messages ---------------------------- */

test("extractMessagesFromChunks: sắp CŨ->MỚI, gắn cờ mine, dedup", () => {
  const nodes = [
    messageNode("Xin chào shop", 1700000002000, "200002"),
    messageNode("Chào bạn, shop còn hàng nhé", 1700000001000, SELF_ID),
    messageNode("Bao nhiêu tiền vậy?", 1700000003000, "200002"),
    // Trùng (cùng ts + text) => dedup.
    messageNode("Bao nhiêu tiền vậy?", 1700000003000, "200002"),
  ];
  const chunk = threadMessagesChunk(nodes, "MSG_CUR", true);
  const { messages, pageInfo } = extractMessagesFromChunks([chunk], {
    selfId: SELF_ID,
  });

  assert.equal(messages.length, 3);
  // Sắp xếp cũ -> mới theo ts.
  assert.equal(messages[0].text, "Chào bạn, shop còn hàng nhé");
  assert.equal(messages[0].mine, true);
  assert.equal(messages[0].ts, 1700000001000);
  assert.equal(messages[1].text, "Xin chào shop");
  assert.equal(messages[1].mine, false);
  assert.equal(messages[2].text, "Bao nhiêu tiền vậy?");
  assert.equal(messages[2].mine, false);

  assert.equal(pageInfo.endCursor, "MSG_CUR");
  assert.equal(pageInfo.hasNext, true);
});

test("extractMessagesFromChunks: timestamp giây được đổi sang ms", () => {
  const chunk = threadMessagesChunk(
    [
      {
        __typename: "UserMessage",
        message: { text: "tin giây" },
        timestamp: 1700000000, // giây
        message_sender: { messaging_actor: { id: "999" } },
      },
    ],
    null,
    false
  );
  const { messages } = extractMessagesFromChunks([chunk], { selfId: SELF_ID });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ts, 1700000000000);
});

test("extractMessagesFromChunks bỏ qua message rỗng text", () => {
  const chunk = threadMessagesChunk(
    [
      {
        __typename: "UserMessage",
        message: { text: "" },
        timestamp_precise: "1700000000000",
        message_sender: { messaging_actor: { id: "999" } },
      },
      messageNode("có nội dung", 1700000005000, SELF_ID),
    ],
    null,
    false
  );
  const { messages } = extractMessagesFromChunks([chunk], { selfId: SELF_ID });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "có nội dung");
});

test("extractMessagesFromChunks: is_sender boolean override selfId", () => {
  const chunk = threadMessagesChunk(
    [
      {
        __typename: "UserMessage",
        message: { text: "tin của tôi" },
        timestamp_precise: "1700000006000",
        is_sender: true,
        message_sender: { messaging_actor: { id: "khac_self" } },
      },
    ],
    null,
    false
  );
  const { messages } = extractMessagesFromChunks([chunk], { selfId: SELF_ID });
  assert.equal(messages[0].mine, true);
  assert.equal(messages[0].mineKnown, true);
});

test("extractMessagesFromChunks: selfId (cookie c_user) tách 2 phía chuẩn", () => {
  // Ca thực tế: có selfId từ cookie c_user. senderId===selfId -> của mình,
  // khác -> của đối phương. mineKnown=true cho mọi tin => API đủ tin cậy.
  const OTHER = "200002";
  const nodes = [
    messageNode("shop ơi còn hàng không", 1700000001000, OTHER),
    messageNode("còn nhé bạn", 1700000002000, SELF_ID),
    messageNode("bao nhiêu tiền", 1700000003000, OTHER),
  ];
  const chunk = threadMessagesChunk(nodes, null, false);
  const { messages } = extractMessagesFromChunks([chunk], { selfId: SELF_ID });
  assert.equal(messages.length, 3);
  assert.equal(messages[0].mine, false);
  assert.equal(messages[1].mine, true);
  assert.equal(messages[2].mine, false);
  assert.ok(messages.every((m) => m.mineKnown === true));
});

test("extractMessagesFromChunks: otherId CHỈ chốt được phía đối phương, KHÔNG suy ra của mình", () => {
  // KHÔNG có selfId. otherId khớp -> chắc chắn của họ (mineKnown=true).
  // Tin có senderId khác otherId nhưng không có selfId -> KHÔNG dám kết luận
  // (mineKnown=false) để tầng trên rơi về đọc DOM theo vị trí.
  const OTHER = "200002";
  const nodes = [
    messageNode("shop ơi còn hàng không", 1700000001000, OTHER),
    messageNode("còn nhé bạn", 1700000002000, "999999"),
  ];
  const chunk = threadMessagesChunk(nodes, null, false);
  const { messages } = extractMessagesFromChunks([chunk], { otherId: OTHER });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].mine, false);
  assert.equal(messages[0].mineKnown, true);
  assert.equal(messages[1].mine, false);
  assert.equal(messages[1].mineKnown, false);
});

test("extractSenderId đọc được id từ key phẳng sender_id", () => {
  const chunk = threadMessagesChunk(
    [
      {
        __typename: "UserMessage",
        message: { text: "tin phẳng" },
        timestamp_precise: "1700000004000",
        sender_id: "200002",
      },
    ],
    null,
    false
  );
  const { messages } = extractMessagesFromChunks([chunk], { otherId: "200002" });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].mine, false);
});

test("extractMessagesFromChunks: trả về tên đối phương từ actor (khác selfId)", () => {
  const chunk = threadMessagesChunk(
    [
      {
        __typename: "UserMessage",
        message: { text: "shop ơi còn hàng không" },
        timestamp_precise: "1700000001000",
        message_sender: {
          messaging_actor: { __typename: "User", id: "200002", name: "Yru Kame" },
        },
      },
      messageNode("còn nhé bạn", 1700000002000, SELF_ID),
    ],
    null,
    false
  );
  const { name } = extractMessagesFromChunks([chunk], { selfId: SELF_ID });
  assert.equal(name, "Yru Kame");
});

test("extractMessagesFromChunks: KHÔNG nhận nhãn UI chung ('Đoạn chat') làm tên", () => {
  const chunk = threadMessagesChunk(
    [
      {
        __typename: "UserMessage",
        message: { text: "xin chào" },
        timestamp_precise: "1700000001000",
        message_sender: {
          messaging_actor: { __typename: "User", id: "200002", name: "Đoạn chat" },
        },
      },
    ],
    null,
    false
  );
  const { name } = extractMessagesFromChunks([chunk], { selfId: SELF_ID });
  assert.equal(name, "");
});
