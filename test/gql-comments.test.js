/**
 * gql-comments.test.js — Unit test cho bộ phân tích PURE src/gql-comments.js.
 *
 * MỤC ĐÍCH (honor "xác minh, không đoán mò"):
 *   Bình luận GraphQL nội bộ FB không có tài liệu => trước khi đấu nối LIVE ta
 *   chứng minh các giả định deep-search bằng FIXTURE TỔNG HỢP mô phỏng đúng kiểu
 *   node Comment của FB comet:
 *     - Comment { id (base64), legacy_fbid (số), author{id,name}, body{text},
 *       created_time, feedback{ replies_connection|replies_fields{edges[].node}}}
 *   Kiểm 3 hàm chính:
 *     - extractComments: gom comment + reply, gắn parentLegacyId theo LỒNG (không đoán text).
 *     - findCreatedComment: bắt đúng bình luận vừa đăng của ta (khớp text + author).
 *     - extractRepliesForParent: lọc reply đúng bình luận cha, cờ `mine` theo authorId.
 *
 *   Chạy: node --test test/gql-comments.test.js  (Node thuần, không cần chrome).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normText,
  deaccent,
  isCommentRequest,
  normComment,
  extractComments,
  findCreatedComment,
  extractRepliesForParent,
} from "../src/gql-comments.js";

/* --------------------------- Fixtures tổng hợp --------------------------- */

// id base64 kiểu FB: btoa("comment:<postid>_<commentid>") — hàm giải mã phải
// rút được <commentid> (cụm số dài cuối).
function b64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function comment(legacyId, authorId, authorName, text, createdSec, replies) {
  const node = {
    __typename: "Comment",
    id: b64("comment:111222333_" + legacyId),
    legacy_fbid: String(legacyId),
    author: { id: String(authorId), name: authorName, __typename: "User" },
    body: { text },
    created_time: createdSec,
  };
  if (replies && replies.length) {
    node.feedback = {
      replies_connection: {
        edges: replies.map((r) => ({ node: r })),
      },
    };
  }
  return node;
}

// Response "comment list" điển hình: data.node.comment_rendering_instance…
// .comments.edges[].node ; mỗi node có feedback.replies_connection.
function commentListChunk(rootComments) {
  return {
    data: {
      node: {
        __typename: "Group",
        comment_rendering_instance_for_feed_location: {
          comments: {
            edges: rootComments.map((c) => ({ node: c })),
            page_info: { end_cursor: "CURSOR_1", has_next_page: false },
          },
        },
      },
    },
  };
}

// Response mutation tạo bình luận: data.comment_create.feedback_comment_edge.node
function createChunk(createdNode) {
  return {
    data: {
      comment_create: {
        feedback_comment_edge: { node: createdNode },
        feedback: { id: "fb1" },
      },
    },
  };
}

/* ------------------------------- Tests ---------------------------------- */

test("normText bỏ dấu + gộp khoảng trắng + thường hoá", () => {
  assert.equal(normText("  Điện   Thoại ĐẸP "), "dien thoai dep");
  assert.equal(deaccent("Đặng"), "Dang");
});

test("isCommentRequest nhận diện theo friendly name", () => {
  assert.equal(isCommentRequest("CommentCreateMutation", ""), true);
  assert.equal(isCommentRequest("CommentsListComponentsPaginationQuery", ""), true);
  assert.equal(isCommentRequest("UFI2CommentsProviderQuery", ""), true);
  assert.equal(isCommentRequest("GroupsCometFeedRegularStoriesPaginationQuery", ""), false);
});

test("isCommentRequest fallback theo body khi friendly rỗng", () => {
  assert.equal(isCommentRequest("", "x=1&variables={\"feedbackId\":\"a\",\"create_comment\":1}"), true);
  assert.equal(isCommentRequest("", "just_a_feed_request"), false);
});

test("normComment rút legacyId số + author + text", () => {
  const n = comment("900900900", "555", "Nguyễn A", "Chào bạn", 1700000000);
  const c = normComment(n);
  assert.equal(c.legacyId, "900900900");
  assert.equal(c.authorId, "555");
  assert.equal(c.authorName, "Nguyễn A");
  assert.equal(c.text, "Chào bạn");
  assert.equal(c.createdTime, 1700000000 * 1000);
});

test("normComment giải legacyId từ id base64 khi thiếu legacy_fbid", () => {
  const node = {
    __typename: "Comment",
    id: b64("comment:111222333_777888999"),
    author: { id: "1", name: "X" },
    body: { text: "hi" },
  };
  const c = normComment(node);
  assert.equal(c.legacyId, "777888999");
});

test("extractComments gom root + reply và gắn parentLegacyId theo lồng", () => {
  const reply1 = comment("2001", "888", "Khách H", "Bao nhiêu tiền vậy shop?", 1700000100);
  const reply2 = comment("2002", "555", "Shop Me", "Dạ 5 triệu ạ", 1700000200);
  const root = comment("1001", "555", "Shop Me", "Máy còn bảo hành 12 tháng", 1700000000, [
    reply1,
    reply2,
  ]);
  const other = comment("1002", "999", "Người khác", "Bài hay", 1700000050);

  const list = extractComments([commentListChunk([root, other])]);
  const byId = new Map(list.map((c) => [c.legacyId, c]));

  assert.equal(byId.get("1001").parentLegacyId, null);
  assert.equal(byId.get("2001").parentLegacyId, "1001");
  assert.equal(byId.get("2002").parentLegacyId, "1001");
  assert.equal(byId.get("1002").parentLegacyId, null);
  // reply của người khác không bị gán nhầm cha 1001.
  assert.equal(byId.get("1002").text, "Bài hay");
});

test("extractComments dedup theo legacyId (node xuất hiện 2 lần)", () => {
  const root = comment("1001", "555", "Shop", "Nội dung", 1700000000);
  const list = extractComments([commentListChunk([root]), commentListChunk([root])]);
  const only = list.filter((c) => c.legacyId === "1001");
  assert.equal(only.length, 1);
});

test("findCreatedComment bắt đúng bình luận vừa đăng của ta (khớp text + author)", () => {
  const mine = comment("3003", "555", "Shop Me", "Inbox em tư vấn nhé", 1700001000);
  const chunk = createChunk(mine);
  const found = findCreatedComment([chunk], { text: "Inbox em tư vấn nhé", authorId: "555" });
  assert.ok(found);
  assert.equal(found.legacyId, "3003");
});

test("findCreatedComment không bắt bừa khi không có tín hiệu khớp", () => {
  const someoneElse = comment("4004", "111", "Ai đó", "Bình luận khác hẳn", 1700002000);
  const chunk = commentListChunk([someoneElse]);
  const found = findCreatedComment([chunk], { text: "Nội dung TA vừa gõ", authorId: "555" });
  assert.equal(found, null);
});

test("findCreatedComment ưu tiên khớp text tuyệt đối hơn khớp một phần", () => {
  const partial = comment("5005", "555", "Shop", "Chào bạn nhé bạn ơi", 1700003000);
  const exact = comment("5006", "555", "Shop", "Chào bạn", 1700003100);
  const chunk = commentListChunk([partial, exact]);
  const found = findCreatedComment([chunk], { text: "Chào bạn", authorId: "555" });
  assert.equal(found.legacyId, "5006");
});

test("extractRepliesForParent lọc đúng reply của cha + cờ mine theo authorId", () => {
  const reply1 = comment("2001", "888", "Khách H", "Bao nhiêu tiền vậy?", 1700000100);
  const reply2 = comment("2002", "555", "Shop Me", "Dạ 5 triệu ạ", 1700000200);
  const reply3 = comment("2003", "888", "Khách H", "Còn giảm không shop?", 1700000300);
  const root = comment("1001", "555", "Shop Me", "Máy còn bảo hành", 1700000000, [
    reply1,
    reply2,
    reply3,
  ]);
  // Một bình luận khác + reply của nó -> KHÔNG được lẫn vào.
  const otherReply = comment("2999", "111", "Z", "reply nhầm", 1700000400);
  const other = comment("1002", "222", "Y", "cmt khác", 1700000050, [otherReply]);

  const res = extractRepliesForParent([commentListChunk([root, other])], "1001", {
    authorId: "555",
    authorName: "Shop Me",
  });
  assert.equal(res.parentText, "Máy còn bảo hành");
  assert.equal(res.parentAuthor, "Shop Me");
  assert.equal(res.replies.length, 3);
  // thứ tự theo thời gian tăng dần
  assert.deepEqual(res.replies.map((r) => r.id), ["2001", "2002", "2003"]);
  // cờ mine: reply2 là của ta (authorId 555).
  const m = new Map(res.replies.map((r) => [r.id, r.mine]));
  assert.equal(m.get("2001"), false);
  assert.equal(m.get("2002"), true);
  assert.equal(m.get("2003"), false);
  // reply của bình luận khác không lọt vào.
  assert.ok(!res.replies.find((r) => r.id === "2999"));
});

test("extractRepliesForParent nhận mine theo authorName khi thiếu authorId", () => {
  const reply1 = comment("2001", "888", "Khách", "hỏi giá", 1700000100);
  const reply2 = comment("2002", "555", "Shop Me", "trả lời", 1700000200);
  const root = comment("1001", "555", "Shop Me", "gốc", 1700000000, [reply1, reply2]);
  const res = extractRepliesForParent([commentListChunk([root])], "1001", {
    authorName: "shop me",
  });
  const m = new Map(res.replies.map((r) => [r.id, r.mine]));
  assert.equal(m.get("2002"), true);
  assert.equal(m.get("2001"), false);
});
