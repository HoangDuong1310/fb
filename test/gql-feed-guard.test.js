/**
 * gql-feed-guard.test.js — Chặn BÀI RÁC ở nhánh crawl API (GraphQL).
 *
 * TRIỆU CHỨNG THẬT ĐÃ QUAN SÁT: đang crawl bằng chế độ "api", người dùng mở tab
 * khác lướt Facebook => tab crawl cào về một đống bài rác (tác giả là tên NHÓM,
 * nội dung là metadata kiểu "Có 3,4K người theo dõi · 40K thành viên", postId
 * dạng "fp:", permalink null => UI hiện "thiếu link gốc nên chưa bình luận được").
 *
 * HAI KHIẾM KHUYẾT ĐỘC LẬP cùng gây ra, test này khoá cả hai:
 *
 * BUG A — isGroupFeedRequest quá lỏng.
 *   Hook GraphQL chạy trên MỌI tab facebook.com. Khi người dùng lướt FB ở tab
 *   khác, mọi request FB tự bắn đều đi qua hook. Điều kiện cũ
 *   (JSON.stringify(variables) chứa "group" VÀ ("feed" HOẶC "stories")) khớp cả
 *   gói BÌNH LUẬN (CometUFICommentsProviderQuery, feedback_source:"group_feed")
 *   lẫn gói XEM-MỘT-BÀI (CometSinglePostContentQuery, có groupID). Hai gói này
 *   GHI ĐÈ khuôn feed đang tốt — cả trong RAM lẫn chrome.storage.local. Trang kế
 *   replay bằng doc_id của truy vấn bình luận => response là cây comment.
 *
 * BUG B — mapEdgeToPost nhận mọi node có "tên" là bài.
 *   Response feed nhóm còn chứa thẻ nhóm gợi ý / rail "Khám phá". Các node đó có
 *   name + url nên looksLikeUser khớp, và extractTextFromNode nhặt được chuỗi mô
 *   tả dài. Chúng vượt cửa "có tác giả" rồi thành bài fp: rác.
 *
 * Chạy: node --test test/gql-feed-guard.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";
import { isGroupFeedRequest, mapEdgeToPost, extractPostsFromChunks } from "../src/gql-parse.js";

const CTX = {
  groupId: "865205505876088",
  groupName: "Chợ PC Cũ",
  origin: "https://www.facebook.com",
};

/* =================== BUG A: isGroupFeedRequest ========================== */

test("NHẬN đúng các truy vấn feed nhóm thật", () => {
  assert.equal(isGroupFeedRequest("GroupsCometFeedRegularStoriesPaginationQuery", {}), true);
  assert.equal(isGroupFeedRequest("GroupsCometNewsFeedPaginationQuery", {}), true);
  assert.equal(isGroupFeedRequest("GroupsFeedQuery", { groupID: "1" }), true);
});

test("TỪ CHỐI gói BÌNH LUẬN dù variables nhắc tới group_feed", () => {
  // Đây là gói FB bắn khi người dùng mở phần bình luận của MỘT bài bất kỳ —
  // kể cả ở tab khác. Trước khi sửa, nó ghi đè khuôn feed.
  assert.equal(
    isGroupFeedRequest("CometUFICommentsProviderQuery", { feedback_source: "group_feed" }),
    false
  );
  assert.equal(
    isGroupFeedRequest("CometUFICommentsListQuery", { feedLocation: "GROUP", groupID: "1" }),
    false
  );
});

test("TỪ CHỐI gói XEM-MỘT-BÀI dù có groupID", () => {
  assert.equal(
    isGroupFeedRequest("CometSinglePostContentQuery", {
      feedLocation: "PERMALINK",
      groupID: "865205505876088",
    }),
    false
  );
  assert.equal(
    isGroupFeedRequest("GroupsCometDiscussionRootSuccessQuery", { groupID: "1" }),
    false
  );
  assert.equal(isGroupFeedRequest("CometGroupPermalinkQuery", { groupID: "1" }), false);
});

test("TỪ CHỐI feed trang cá nhân / news feed / messenger", () => {
  assert.equal(isGroupFeedRequest("ProfileCometTimelineFeedRefetchQuery", {}), false);
  assert.equal(isGroupFeedRequest("CometNewsFeedPaginationQuery", {}), false);
  assert.equal(isGroupFeedRequest("MessengerThreadListQuery", { folder: "inbox" }), false);
});

test("friendly name có mặt thì KHÔNG được cứu bằng variables", () => {
  // Chốt chặn quan trọng: một truy vấn đã tự khai tên là comment thì dù
  // variables trông giống feed đến đâu cũng không được nhận.
  assert.equal(
    isGroupFeedRequest("CometUFICommentsProviderQuery", {
      groupID: "1",
      count: 10,
      cursor: "abc",
      feedType: "stories",
    }),
    false
  );
});

test("không có friendly name: chỉ nhận khi có groupID + dấu hiệu feed", () => {
  assert.equal(isGroupFeedRequest("", { groupID: "1", count: 3, cursor: "x" }), true);
  assert.equal(isGroupFeedRequest("", { groupID: "1", feedType: "stories" }), true);
  // Thiếu dấu hiệu feed => không đủ căn cứ, từ chối (thà bỏ sót còn hơn hỏng khuôn).
  assert.equal(isGroupFeedRequest("", { groupID: "1" }), false);
  // Chỉ nhắc group qua feedback_source => KHÔNG phải feed (đây là lỗ hổng cũ).
  assert.equal(isGroupFeedRequest("", { feedback_source: "group_feed" }), false);
  assert.equal(isGroupFeedRequest("", {}), false);
  assert.equal(isGroupFeedRequest("", null), false);
});

/* ==================== BUG B: mapEdgeToPost ============================== */

/** Thẻ NHÓM GỢI Ý mà FB nhét vào giữa feed. Có name + url nhưng KHÔNG phải bài. */
function groupSuggestionCard() {
  return {
    __typename: "GroupSuggestion",
    group: {
      __typename: "Group",
      id: "555000111",
      name: "Hội mua bán PC cũ Hà Nội",
      url: "https://www.facebook.com/groups/555000111",
    },
    subtitle_text: {
      text: "Có 3,4K người theo dõi · 40K thành viên · 10+ bài viết/ngày",
    },
  };
}

/** Bài viết THẬT trong nhóm (story comet đầy đủ). */
function realStory() {
  return {
    __typename: "Story",
    comet_sections: {
      content: {
        story: {
          actors: [
            {
              __typename: "User",
              name: "Nguyễn Văn A",
              id: "u1",
              url: "https://www.facebook.com/nguyenvana",
            },
          ],
          message: { text: "Bán case i5 12400F + RTX 3060, giá 9 triệu, bao test." },
          creation_time: 1730000000,
          wwwURL: "https://www.facebook.com/groups/865205505876088/posts/1122334455667788/",
        },
      },
    },
  };
}

test("thẻ nhóm gợi ý KHÔNG được biến thành bài", () => {
  const post = mapEdgeToPost(groupSuggestionCard(), CTX);
  assert.equal(
    post,
    null,
    'đây chính là bài rác "tác giả = tên nhóm, nội dung = 40K thành viên"'
  );
});

test("bài viết THẬT vẫn được giữ nguyên (không chặn nhầm)", () => {
  const post = mapEdgeToPost(realStory(), CTX);
  assert.ok(post, "bài thật phải qua được cửa chặn");
  assert.equal(post.postId, "1122334455667788");
  assert.equal(post.authorName, "Nguyễn Văn A");
  assert.ok(post.permalink, "bài thật phải có link gốc để còn bình luận được");
  assert.match(post.text, /i5 12400F/);
});

test("bài trong nhóm có __typename Group kèm story vẫn được giữ", () => {
  // Không được chặn nhầm: node mang thông tin nhóm NHƯNG đồng thời là bài thật.
  const node = realStory();
  node.comet_sections.content.story.target_group = {
    __typename: "Group",
    id: "865205505876088",
    name: "Chợ PC Cũ",
  };
  const post = mapEdgeToPost(node, CTX);
  assert.ok(post, "bài đăng TRONG nhóm không phải là thẻ quảng bá nhóm");
  assert.equal(post.postId, "1122334455667788");
});

test("node có creation_time nhưng thiếu id + tác giả vẫn bị loại", () => {
  // Qua được looksLikePostNode (có creation_time) nhưng không đủ định danh.
  const node = { __typename: "Story", creation_time: 1730000000 };
  assert.equal(mapEdgeToPost(node, CTX), null);
});

test("trang feed lẫn thẻ gợi ý: chỉ lấy bài thật, vẫn đọc được cursor", () => {
  const chunk = {
    data: {
      node: {
        __typename: "Group",
        group_feed: {
          edges: [
            { node: groupSuggestionCard() },
            { node: realStory() },
            { node: groupSuggestionCard() },
          ],
          page_info: { end_cursor: "CURSOR_Z", has_next_page: true },
        },
      },
    },
  };
  const { posts, pageInfo } = extractPostsFromChunks([chunk], CTX);
  assert.equal(posts.length, 1, "hai thẻ gợi ý phải bị loại, giữ đúng 1 bài thật");
  assert.equal(posts[0].postId, "1122334455667788");
  // Chặn rác KHÔNG được làm đứt phân trang.
  assert.equal(pageInfo.endCursor, "CURSOR_Z");
  assert.equal(pageInfo.hasNext, true);
});

test("không bài nào có permalink null lọt ra khi node là thẻ gợi ý", () => {
  const chunk = {
    data: {
      feed: {
        edges: Array.from({ length: 5 }, () => ({ node: groupSuggestionCard() })),
        page_info: { end_cursor: "C", has_next_page: false },
      },
    },
  };
  const { posts } = extractPostsFromChunks([chunk], CTX);
  assert.equal(posts.length, 0);
});
