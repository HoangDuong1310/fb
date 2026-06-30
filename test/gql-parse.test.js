/**
 * gql-parse.test.js — Unit test cho bộ phân tích PURE src/gql-parse.js.
 *
 * MỤC ĐÍCH (honor "xác minh, không đoán mò"):
 *   GraphQL nội bộ FB không có tài liệu => trước khi đấu nối LIVE, ta chứng minh
 *   các giả định deep-search bằng FIXTURE TỔNG HỢP mô phỏng đúng kiểu lồng của
 *   FB comet: data.node.group_feed.edges[].node.comet_sections.{content,context_layout}
 *   với message.text, actors[], creation_time, photo image uri, permalink url
 *   chứa /posts/<pfbid>, reaction_count, comment_count, và page_info.end_cursor.
 *
 *   Chạy: node --test test/gql-parse.test.js  (Node thuần, không cần chrome).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hashStr,
  fingerprintId,
  buildPermalink,
  parseGqlRequestBody,
  isGroupFeedRequest,
  findFeedEdges,
  findPageInfo,
  mapEdgeToPost,
  extractPostsFromChunks,
} from "../src/gql-parse.js";

const GROUP_ID = "950437708832783";
const ORIGIN = "https://www.facebook.com";

/* --------------------------- Fixtures tổng hợp --------------------------- */

// Một story "đầy đủ" theo kiểu comet lồng sâu. postId lấy được từ url permalink.
function storyFull(pfbid, msg, authorName, authorUrl, photoUri, creationSec, reacts, comments) {
  return {
    node: {
      __typename: "Story",
      comet_sections: {
        content: {
          story: {
            comet_sections: {
              message: {
                story: {
                  message: { text: msg },
                },
              },
              actor_photo: {
                story: {
                  actors: [
                    {
                      __typename: "User",
                      id: "100001",
                      name: authorName,
                      url: authorUrl,
                    },
                  ],
                },
              },
            },
            attachments: [
              {
                styles: {
                  attachment: {
                    media: {
                      __typename: "Photo",
                      photo_image: { uri: photoUri, width: 720, height: 720 },
                    },
                  },
                },
              },
            ],
          },
        },
        context_layout: {
          story: {
            comet_sections: {
              metadata: [
                {
                  story: {
                    creation_time: creationSec,
                    url: ORIGIN + "/groups/" + GROUP_ID + "/posts/" + pfbid + "/",
                  },
                },
              ],
            },
          },
        },
        feedback: {
          story: {
            feedback_context: {
              feedback_target_with_context: {
                comet_ufi_summary_and_actions_renderer: {
                  feedback: {
                    reaction_count: { count: reacts },
                    comment_count: { total_count: comments },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

// Một story KHÔNG có permalink/post_id => buộc parser rơi về fingerprintId.
function storyNoId(msg, authorName, photoUri, creationSec) {
  return {
    node: {
      __typename: "Story",
      comet_sections: {
        content: {
          story: {
            comet_sections: {
              message: { story: { message: { text: msg } } },
              actor_photo: {
                story: { actors: [{ __typename: "User", name: authorName }] },
              },
            },
            attachments: [
              {
                styles: {
                  attachment: {
                    media: { __typename: "Photo", photo_image: { uri: photoUri } },
                  },
                },
              },
            ],
          },
        },
        context_layout: {
          story: { comet_sections: { metadata: [{ story: { creation_time: creationSec } }] } },
        },
      },
    },
  };
}

// Response GraphQL hợp lệ: data.node.group_feed.edges[] + page_info.
function feedResponse(edges, endCursor, hasNext) {
  return {
    data: {
      node: {
        __typename: "Group",
        id: GROUP_ID,
        group_feed: {
          edges,
          page_info: {
            end_cursor: endCursor,
            has_next_page: hasNext,
          },
        },
      },
    },
  };
}

/* ----------------------------- helpers thuần ----------------------------- */

test("hashStr: ổn định, base36, cùng input cùng output", () => {
  const a = hashStr("xin chào nhóm");
  const b = hashStr("xin chào nhóm");
  assert.equal(a, b);
  assert.match(a, /^[0-9a-z]+$/);
  assert.notEqual(hashStr("a"), hashStr("b"));
});

test("fingerprintId: dạng fp:<group>:<hash>, null khi rỗng", () => {
  const fp = fingerprintId(GROUP_ID, "Nguyễn A", "bán iphone 15", ["https://x/y.jpg?abc"]);
  assert.ok(fp.startsWith("fp:" + GROUP_ID + ":"));
  // ổn định: bỏ query string của ảnh + chuẩn hoá text
  const fp2 = fingerprintId(GROUP_ID, "Nguyễn A", "bán iphone 15", ["https://x/y.jpg?zzz"]);
  assert.equal(fp, fp2);
  assert.equal(fingerprintId(GROUP_ID, "Ai đó", "", []), null);
});

test("buildPermalink: ghép đúng origin/group/posts", () => {
  assert.equal(
    buildPermalink(ORIGIN, GROUP_ID, "pfbid123"),
    ORIGIN + "/groups/" + GROUP_ID + "/posts/pfbid123/"
  );
  // origin mặc định
  assert.ok(buildPermalink(null, GROUP_ID, "9").startsWith("https://www.facebook.com/groups/"));
});

/* ---------------------- parseGqlRequestBody / detect --------------------- */

test("parseGqlRequestBody: bóc fb_dtsg/doc_id/friendly/variables", () => {
  const vars = { id: GROUP_ID, count: 3, cursor: "CUR_1" };
  const body =
    "fb_dtsg=AbCdEf&doc_id=987654321&fb_api_req_friendly_name=GroupsCometFeedRegularStoriesPaginationQuery" +
    "&variables=" +
    encodeURIComponent(JSON.stringify(vars));
  const out = parseGqlRequestBody(body);
  assert.equal(out.fb_dtsg, "AbCdEf");
  assert.equal(out.doc_id, "987654321");
  assert.equal(out.friendly, "GroupsCometFeedRegularStoriesPaginationQuery");
  assert.deepEqual(out.variables, vars);
});

test("parseGqlRequestBody: body rác không ném lỗi", () => {
  const out = parseGqlRequestBody("###not a body###");
  assert.equal(out.variables, null);
});

test("isGroupFeedRequest: nhận diện qua friendly name", () => {
  assert.equal(
    isGroupFeedRequest("GroupsCometFeedRegularStoriesPaginationQuery", {}),
    true
  );
  assert.equal(isGroupFeedRequest("SomeProfileQuery", {}), false);
});

test("isGroupFeedRequest: nhận diện qua variables khi friendly trống", () => {
  assert.equal(isGroupFeedRequest("", { groupID: GROUP_ID, feedType: "stories" }), true);
});

/* ----------------------- findFeedEdges / findPageInfo -------------------- */

test("findFeedEdges: tìm đúng cụm edges lồng sâu", () => {
  const resp = feedResponse(
    [storyFull("pfbidAAA", "bài 1", "An", ORIGIN + "/an", "https://img/1.jpg", 1700000000, 3, 1)],
    "CURSOR_END",
    true
  );
  const edgesObj = findFeedEdges(resp);
  assert.ok(edgesObj);
  assert.equal(edgesObj.edges.length, 1);
});

test("findFeedEdges: chọn cụm edges LỚN NHẤT khi có nhiều", () => {
  const big = feedResponse(
    [
      storyFull("pfbid1", "a", "X", ORIGIN + "/x", "https://i/1.jpg", 1700000001, 0, 0),
      storyFull("pfbid2", "b", "Y", ORIGIN + "/y", "https://i/2.jpg", 1700000002, 0, 0),
    ],
    "C2",
    false
  );
  // nhét thêm 1 cụm edges nhỏ (gợi ý) ở nhánh khác
  big.data.node.sidebar = { suggestions: { edges: [{ node: { __typename: "Group" } }] } };
  const edgesObj = findFeedEdges(big);
  assert.equal(edgesObj.edges.length, 2);
});

test("findPageInfo: lấy end_cursor + has_next_page", () => {
  const resp = feedResponse([], "NEXT_CURSOR", true);
  const pi = findPageInfo(resp);
  assert.equal(pi.endCursor, "NEXT_CURSOR");
  assert.equal(pi.hasNext, true);
});

test("findPageInfo: không có -> {null,false}", () => {
  const pi = findPageInfo({ data: { foo: 1 } });
  assert.equal(pi.endCursor, null);
  assert.equal(pi.hasNext, false);
});

/* ------------------------------ mapEdgeToPost ---------------------------- */

test("mapEdgeToPost: bóc đầy đủ field từ story comet", () => {
  const story = storyFull(
    "pfbid0XYZ",
    "Bán laptop Dell cũ giá 5 triệu, fix nhẹ.",
    "Trần Văn B",
    ORIGIN + "/tranvanb",
    "https://scontent/img.jpg?_nc=1",
    1700000123,
    12,
    4
  );
  const post = mapEdgeToPost(story.node, {
    groupId: GROUP_ID,
    groupName: "Chợ Đồ Cũ",
    origin: ORIGIN,
  });

  assert.ok(post, "phải trả về post");
  assert.equal(post.postId, "pfbid0XYZ");
  assert.equal(post.groupId, GROUP_ID);
  assert.equal(post.groupName, "Chợ Đồ Cũ");
  assert.equal(post.permalink, ORIGIN + "/groups/" + GROUP_ID + "/posts/pfbid0XYZ/");
  assert.equal(post.authorName, "Trần Văn B");
  assert.equal(post.authorProfile, ORIGIN + "/tranvanb");
  assert.match(post.text, /Bán laptop Dell/);
  assert.ok(post.images.includes("https://scontent/img.jpg?_nc=1"));
  assert.equal(post.reactions, 12);
  assert.equal(post.comments, 4);
  assert.equal(post.timestamp, 1700000123 * 1000);
  assert.equal(post.source, "api");
  // shape khớp extractPost: có đủ key kỳ vọng
  for (const k of [
    "postId", "groupId", "groupName", "permalink", "authorName", "authorProfile",
    "timestamp", "timeText", "text", "images", "videos", "links",
    "reactions", "comments", "crawledAt", "source",
  ]) {
    assert.ok(k in post, "thiếu key: " + k);
  }
});

test("mapEdgeToPost: rơi về fingerprint khi không có postId", () => {
  const story = storyNoId("Cần mua xe đạp cũ", "Lê C", "https://i/bike.jpg", 1700000200);
  const post = mapEdgeToPost(story.node, { groupId: GROUP_ID, origin: ORIGIN });
  assert.ok(post);
  assert.ok(post.postId.startsWith("fp:" + GROUP_ID + ":"), "phải là fingerprint");
  assert.equal(post.permalink, null, "bài fingerprint không có permalink");
  assert.equal(post.authorName, "Lê C");
});

test("mapEdgeToPost: trả null khi không đủ định danh (không text, không ảnh, không id)", () => {
  const empty = { node: { __typename: "Story", comet_sections: {} } };
  const post = mapEdgeToPost(empty.node, { groupId: GROUP_ID, origin: ORIGIN });
  assert.equal(post, null);
});

// REGRESSION: response THẬT của FB để số comment ở key `total_comment_count`
// (một number nằm cạnh reaction_count), KHÔNG phải comment_count.total_count.
// Trước khi fix, parser luôn trả comments=0 cho dữ liệu thật.
test("mapEdgeToPost: đọc comment qua total_comment_count (cấu trúc FB thật)", () => {
  const node = {
    __typename: "Story",
    post_id: "pfbidREAL1",
    comet_sections: {
      content: {
        story: {
          comet_sections: {
            message: { story: { message: { text: "Bán iPhone 13 còn bảo hành" } } },
          },
        },
      },
      feedback: {
        story: {
          feedback_context: {
            feedback_target_with_context: {
              comet_ufi_summary_and_actions_renderer: {
                feedback: {
                  reaction_count: { count: 7 },
                  total_comment_count: 23,
                },
              },
            },
          },
        },
      },
    },
  };
  const post = mapEdgeToPost(node, { groupId: GROUP_ID, origin: ORIGIN });
  assert.ok(post, "phải trả về post");
  assert.equal(post.reactions, 7);
  assert.equal(post.comments, 23, "comments phải đọc từ total_comment_count");
});

/* --------------------------- extractPostsFromChunks ---------------------- */

test("extractPostsFromChunks: gộp nhiều chunk + dedup + pageInfo", () => {
  const chunkA = feedResponse(
    [
      storyFull("pfbidDUP", "trùng", "Z", ORIGIN + "/z", "https://i/d.jpg", 1700000300, 0, 0),
      storyFull("pfbidB2", "bài 2", "W", ORIGIN + "/w", "https://i/2.jpg", 1700000301, 1, 0),
    ],
    null,
    false
  );
  // chunk thứ 2 (do @defer) chứa lại pfbidDUP + page_info có cursor
  const chunkB = feedResponse(
    [storyFull("pfbidDUP", "trùng", "Z", ORIGIN + "/z", "https://i/d.jpg", 1700000300, 0, 0)],
    "FINAL_CURSOR",
    true
  );

  const { posts, pageInfo } = extractPostsFromChunks([chunkA, chunkB], {
    groupId: GROUP_ID,
    groupName: "G",
    origin: ORIGIN,
  });

  const ids = posts.map((p) => p.postId);
  assert.equal(ids.length, 2, "phải dedup pfbidDUP");
  assert.ok(ids.includes("pfbidDUP"));
  assert.ok(ids.includes("pfbidB2"));
  assert.equal(pageInfo.endCursor, "FINAL_CURSOR");
  assert.equal(pageInfo.hasNext, true);
});

test("extractPostsFromChunks: chunk rỗng -> mảng rỗng, không ném", () => {
  const { posts, pageInfo } = extractPostsFromChunks([{}, { data: null }], {
    groupId: GROUP_ID,
    origin: ORIGIN,
  });
  assert.equal(posts.length, 0);
  assert.equal(pageInfo.endCursor, null);
});
