/**
 * api-post-guard.test.js — Test hồi quy cho bug "bài Không rõ" phía bộ bóc tách API.
 *
 * BỐI CẢNH (XÁC MINH bằng DB thật, không phỏng đoán):
 *   Soi 2840 bài trong DB thấy 54 bài không có tác giả. 19 bài MỚI NHẤT (crawl lúc
 *   10:23–10:24 ngày 26/07) có ĐÚNG một chữ ký:
 *       postId  = "fp:<groupId>:<hash>"   (vân tay, không phải id thật)
 *       link    = null                    -> Feed hiện "thiếu link gốc"
 *       author  = ""                      -> Feed hiện "Không rõ"
 *       text    = ""            (textLen 0)
 *       ts      = null
 *       images  = ĐÚNG 1 ảnh, luôn dạng t15.5256-10 (thumbnail video/reel)
 *
 *   Đây là các story video/reel mà FB trả về KHÔNG kèm actor lẫn message.
 *
 * HAI KHIẾM KHUYẾT ĐÃ SỬA, test này khoá lại cả hai:
 *   A1. mapEdgeToPost thiếu điều kiện định danh tối thiểu (phía DOM đã có từ trước:
 *       `if (!postId && !finalAuthor) return null;` trong src/content.js).
 *   A2. fingerprintId nhận author="" + text="" + 1 ảnh => basis thoái hoá thành ĐÚNG
 *       url ảnh, nên (a) sinh id cho rác, và (b) cùng thumbnail ở 2 nhóm khác nhau
 *       cho CÙNG hash. Đã quan sát sgyc24, y8howe, ov0a4n lặp ở 2 groupId.
 *
 *   Chạy: node --test test/api-post-guard.test.js
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintId, mapEdgeToPost, extractPostsFromChunks } from "../src/gql-parse.js";

const CTX = {
  groupId: "865205505876088",
  groupName: "Chợ PC Cũ",
  origin: "https://www.facebook.com",
};

// URL thumbnail video/reel THẬT (dạng t15.5256-10) lấy từ dữ liệu rác trong DB.
const REEL_THUMB =
  "https://scontent.fhan2-3.fna.fbcdn.net/v/t15.5256-10/500000000_1234567890_n.jpg?_nc_cat=1&oh=abc";

/** Story video/reel: chỉ có thumbnail, KHÔNG actor, KHÔNG message, KHÔNG permalink. */
function reelStoryNode() {
  return {
    __typename: "Story",
    comet_sections: {
      content: {
        story: {
          attachments: [
            {
              styles: {
                attachment: {
                  media: {
                    __typename: "Video",
                    image: { uri: REEL_THUMB },
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

// ---- A2: fingerprintId phải từ chối "chỉ có ảnh" -------------------------

test("fingerprintId: không tác giả + không text + chỉ 1 ảnh => null (không sinh id cho rác)", () => {
  assert.equal(fingerprintId(CTX.groupId, "", "", [REEL_THUMB]), null);
});

test("fingerprintId: khoảng trắng cũng coi là không có tác giả/text", () => {
  assert.equal(fingerprintId(CTX.groupId, "   ", "  \n\t ", [REEL_THUMB]), null);
});

test("fingerprintId: cùng thumbnail ở 2 nhóm KHÔNG còn cho cùng hash vì cả hai bị từ chối", () => {
  const a = fingerprintId("865205505876088", "", "", [REEL_THUMB]);
  const b = fingerprintId("761814895940998", "", "", [REEL_THUMB]);
  assert.equal(a, null);
  assert.equal(b, null);
});

test("fingerprintId: CÓ tác giả + chỉ ảnh (bài ảnh không caption) vẫn được định danh", () => {
  const id = fingerprintId(CTX.groupId, "Nguyễn Văn A", "", [REEL_THUMB]);
  assert.ok(id, "bài ảnh của một tác giả có thật vẫn phải lưu được");
  assert.match(id, /^fp:865205505876088:/);
});

test("fingerprintId: CÓ text nhưng không tác giả vẫn được định danh", () => {
  const id = fingerprintId(CTX.groupId, "", "Bán case i5 12400F giá 5 triệu", []);
  assert.ok(id);
});

test("fingerprintId: giữ NGUYÊN công thức basis => id của bài đã lưu không đổi (dedup còn đúng)", () => {
  // Hash LITERAL, chốt cứng: basis = authorName + "|" + text + "|" + img0 (djb2 -> base36).
  // Nếu ai đó sửa công thức basis, các id "fp:" đã lưu trong DB sẽ lệch và dedup giữa
  // các phiên crawl vỡ (bài cũ được lưu lại thành bài mới) => test này phải đỏ.
  assert.equal(fingerprintId("g1", "An", "xin chao", []), "fp:g1:1umeavq");
  // tác giả khác => hash khác (vân tay còn tính phân biệt)
  assert.equal(fingerprintId("g1", "Binh", "xin chao", []), "fp:g1:1vffjyg");
  // groupId nằm ngoài hash: cùng nội dung ở nhóm khác vẫn là bài khác nhờ tiền tố nhóm
  assert.equal(fingerprintId("g2", "An", "xin chao", []), "fp:g2:1umeavq");
});

// ---- A1: mapEdgeToPost phải bỏ node không đủ định danh --------------------

test("mapEdgeToPost: story video/reel không actor + không message + không permalink => null", () => {
  const post = mapEdgeToPost(reelStoryNode(), CTX);
  assert.equal(post, null, 'đây chính là bài hiện "Không rõ" + "thiếu link gốc" trên Feed');
});

test("mapEdgeToPost: không bao giờ trả bài vừa thiếu tác giả vừa thiếu permalink", () => {
  const post = mapEdgeToPost(reelStoryNode(), CTX);
  if (post) {
    const bad = !String(post.authorName || "").trim() && !post.permalink;
    assert.equal(bad, false, "bài không tác giả VÀ không link gốc là rác, không được lưu");
  }
});

test("mapEdgeToPost: story có permalink thật nhưng thiếu actor vẫn được giữ (còn bình luận được)", () => {
  const node = reelStoryNode();
  node.comet_sections.content.story.wwwURL =
    "https://www.facebook.com/groups/865205505876088/posts/1122334455667788/";
  const post = mapEdgeToPost(node, CTX);
  assert.ok(post, "có link gốc thì vẫn dùng được dù FB không trả tên tác giả");
  assert.equal(post.postId, "1122334455667788");
  assert.ok(post.permalink);
});

// ---- Mức luồng: cả trang feed toàn reel không được sinh bài nào ----------

test("extractPostsFromChunks: trang feed gồm toàn story reel rác => 0 bài", () => {
  const chunk = {
    data: {
      node: {
        __typename: "Group",
        group_feed: {
          edges: [{ node: reelStoryNode() }, { node: reelStoryNode() }, { node: reelStoryNode() }],
          page_info: { end_cursor: "CURSOR_X", has_next_page: true },
        },
      },
    },
  };
  const { posts, pageInfo } = extractPostsFromChunks([chunk], CTX);
  assert.equal(posts.length, 0, "không được lưu bài rác nào");
  // Vẫn phải đọc được con trỏ trang để crawl tiếp — chặn rác không được làm đứt phân trang.
  assert.equal(pageInfo.endCursor, "CURSOR_X");
  assert.equal(pageInfo.hasNext, true);
});
