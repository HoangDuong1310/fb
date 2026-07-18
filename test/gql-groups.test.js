import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeJoinedGroupsChunks,
  extractJoinedGroupsFromChunks,
  isInitialJoinedGroupsRequest,
  isJoinedGroupsRequest,
} from "../src/gql-groups.js";

test("nhận diện request GraphQL danh sách nhóm đã tham gia", () => {
  assert.equal(
    isJoinedGroupsRequest(
      "GroupsCometGroupsTabContentQuery",
      { ordering: ["viewer_joined_groups"] },
      "/groups/joins/",
    ),
    true,
  );
  assert.equal(
    isJoinedGroupsRequest(
      "GroupsCometFeedRegularStoriesPaginationQuery",
      { id: "123", feedLocation: "GROUP" },
      "/groups/123/",
    ),
    false,
  );
});

test("loại query nền enforcement dù response có viewer và extensions", () => {
  assert.equal(
    isJoinedGroupsRequest(
      "FBYRPTimeLimitsEnforcementQuery",
      {},
      "/groups/joins/",
    ),
    false,
  );
});

test("loại query search/bootstrap/keyword dù response có viewer và extensions", () => {
  assert.equal(
    isJoinedGroupsRequest(
      "CometSearchBootstrapKeywordsDataSourceQuery",
      {},
      "/groups/joins/",
    ),
    false,
  );
});

test("loại query encrypted-backup/device dù response có viewer và extensions", () => {
  assert.equal(
    isJoinedGroupsRequest(
      "useMWEncryptedBackupsFetchBackupIdsV2Query",
      {},
      "/groups/joins/",
    ),
    false,
  );
});

test("loại query Messenger dù response có viewer và extensions", () => {
  assert.equal(
    isJoinedGroupsRequest(
      "MWChatTabInThreadBannerQuery",
      { thread_id: "123" },
      "/groups/joins/",
    ),
    false,
  );
});

test("trên trang joins vẫn phân tích query bị Facebook đổi friendly name", () => {
  assert.equal(
    isJoinedGroupsRequest(
      "GroupsCometYourGroupsContentQuery",
      { scale: 1, count: 12 },
      "/groups/joins/",
    ),
    true,
  );
  assert.equal(
    isJoinedGroupsRequest(
      "GroupsCometFeedRegularStoriesPaginationQuery",
      { id: "123", feedLocation: "GROUP" },
      "/groups/joins/",
    ),
    false,
  );
  assert.equal(
    isJoinedGroupsRequest(
      "GroupsCometSuggestedGroupsQuery",
      { count: 12 },
      "/groups/joins/",
    ),
    false,
  );
});

test("chỉ request không có cursor mới được làm baseline destructive", () => {
  assert.equal(isInitialJoinedGroupsRequest({ cursor: null }), true);
  assert.equal(isInitialJoinedGroupsRequest({ after: "" }), true);
  assert.equal(isInitialJoinedGroupsRequest({ input: { before: null } }), true);
  assert.equal(isInitialJoinedGroupsRequest({ cursor: "terminal-cursor" }), false);
  assert.equal(isInitialJoinedGroupsRequest({ input: { after: "page-2" } }), false);
});

test("lấy group trong joined connection và loại notification/suggestion/requested", () => {
  const chunks = [{
    data: {
      notification: { __typename: "Group", id: "bad-notification", name: "Đánh dấu là đã đọc, Chợ PC All in One: Nội dung bài viết…", viewer_join_state: "MEMBER" },
      viewer: { joined_groups: { edges: [
        { node: { __typename: "Group", id: "123456", name: "Chợ PC All in One", viewer_join_state: "MEMBER" } },
        { node: { __typename: "Group", id: "suggested", name: "Nhóm được đề xuất", viewer_join_state: "NOT_JOINED" } },
        { node: { __typename: "Group", id: "requested", name: "Nhóm đang xin tham gia", membership_status: "REQUESTED" } },
      ] } },
    },
  }];
  assert.deepEqual(extractJoinedGroupsFromChunks(chunks), [
    { groupId: "123456", groupName: "Chợ PC All in One" },
  ]);
});

test("gom nhiều chunk deferred, dedup và hỗ trợ numeric id/slug URL", () => {
  const chunks = [
    { data: { viewer: { viewer_joined_groups: { edges: [
      { node: { __typename: "Group", id: 77, name: "Nhóm số bảy bảy", viewer_membership_state: "JOINED" } },
    ] } } } },
    { incremental: [{ data: { viewer: { joined_groups: { edges: [
      { node: { __typename: "Group", id: "77", name: "Nhóm số bảy bảy", viewer_membership_state: "JOINED" } },
      { node: { __typename: "Group", id: "ignored", name: "Nhóm chưa tham gia", membership_status: "NOT_JOINED" } },
      { node: { __typename: "Group", name: "Nhóm qua slug", url: "https://www.facebook.com/groups/slug-group/", viewer_join_state: "MEMBER" } },
    ] } } } }] },
  ];
  assert.deepEqual(extractJoinedGroupsFromChunks(chunks), [
    { groupId: "77", groupName: "Nhóm số bảy bảy" },
    { groupId: "slug-group", groupName: "Nhóm qua slug" },
  ]);
});

test("không lấy Group ngoài joined connection", () => {
  const chunks = [{ data: { group: { __typename: "Group", id: "outside", name: "Group ngoài scope", viewer_join_state: "MEMBER" } } }];
  assert.deepEqual(extractJoinedGroupsFromChunks(chunks), []);
});


test("chỉ đánh dấu complete khi page_info mới nhất xác nhận hết trang", () => {
  const firstPage = { data: { viewer: { joined_groups: { edges: [{ node: { __typename: "Group", id: "page-1", name: "Trang một", viewer_join_state: "MEMBER" } }], page_info: { has_next_page: true, end_cursor: "cursor-1" } } } } };
  const finalPage = { data: { viewer: { joined_groups: { edges: [{ node: { __typename: "Group", id: "page-2", name: "Trang hai", viewer_join_state: "MEMBER" } }], page_info: { has_next_page: false, end_cursor: "cursor-2" } } } } };
  const firstAnalysis = analyzeJoinedGroupsChunks([firstPage]);
  assert.deepEqual(firstAnalysis.groups, [{ groupId: "page-1", groupName: "Trang một" }]);
  assert.equal(firstAnalysis.hasPageInfo, true);
  assert.equal(firstAnalysis.hasNextPage, true);
  assert.equal(firstAnalysis.endCursor, "cursor-1");
  assert.equal(firstAnalysis.complete, false);
  assert.equal(firstAnalysis.authoritative, true);
  assert.equal(firstAnalysis.hasNonAuthoritativeIds, false);
  assert.equal(firstAnalysis.diagnostics.chunkCount, 1);
  assert.equal(firstAnalysis.diagnostics.connectionCount, 1);

  const finalAnalysis = analyzeJoinedGroupsChunks([firstPage, finalPage]);
  assert.deepEqual(finalAnalysis.groups, [{ groupId: "page-1", groupName: "Trang một" }, { groupId: "page-2", groupName: "Trang hai" }]);
  assert.equal(finalAnalysis.hasPageInfo, true);
  assert.equal(finalAnalysis.hasNextPage, false);
  assert.equal(finalAnalysis.endCursor, "cursor-2");
  assert.equal(finalAnalysis.complete, true);
  assert.equal(finalAnalysis.authoritative, true);
  assert.equal(finalAnalysis.hasNonAuthoritativeIds, false);
  assert.equal(analyzeJoinedGroupsChunks([{ data: { viewer: { joined_groups: { edges: [] } } } }]).complete, false);
});


test('reads only direct edges of selected joined connection', () => {
  const chunks = [{ data: { viewer: { joined_groups: {
    edges: [{ node: { __typename: 'Group', id: 'joined', name: 'Joined group', viewer_join_state: 'MEMBER' } }],
    recommendations: { edges: [{ node: { __typename: 'Group', id: 'nested', name: 'Nested suggestion', viewer_join_state: 'MEMBER' } }] },
    page_info: { has_next_page: false, end_cursor: 'done' },
  } } } }];
  const analysis = analyzeJoinedGroupsChunks(chunks);
  assert.deepEqual(analysis.groups, [
    { groupId: 'joined', groupName: 'Joined group' },
  ]);
  assert.equal(analysis.hasPageInfo, true);
  assert.equal(analysis.hasNextPage, false);
  assert.equal(analysis.endCursor, 'done');
  assert.equal(analysis.complete, true);
  assert.equal(analysis.authoritative, true);
  assert.equal(analysis.hasNonAuthoritativeIds, false);
  assert.equal(analysis.diagnostics.chunkCount, 1);
  assert.equal(analysis.diagnostics.connectionCount, 1);
  assert.equal(analysis.diagnostics.selectedKey, 'joined_groups');
  assert.equal(analysis.diagnostics.selectedPath, 'viewer.joined_groups');
});

test('does not mix page info from another matching connection', () => {
  const chunks = [{ data: { viewer: {
    joined_groups: {
      edges: [{ node: { __typename: 'Group', id: 'joined-1', name: 'Joined one', viewer_join_state: 'MEMBER' } }],
      page_info: { has_next_page: true, end_cursor: 'cursor-1' },
    },
    member_groups: {
      edges: [{ node: { __typename: 'Group', id: 'member-1', name: 'Other member group', viewer_join_state: 'MEMBER' } }],
      page_info: { has_next_page: false, end_cursor: 'wrong-done' },
    },
  } } }];
  const analysis = analyzeJoinedGroupsChunks(chunks);
  assert.equal(analysis.complete, false);
  assert.equal(analysis.endCursor, 'cursor-1');
});


test('keeps identical field names isolated by response path', () => {
  const chunks = [{ data: { viewer: { joined_groups: { edges: [{ node: { __typename: 'Group', id: 'real', name: 'Real joined', viewer_join_state: 'MEMBER' } }], page_info: { has_next_page: true, end_cursor: 'real-next' } } }, sidebar: { joined_groups: { edges: [{ node: { __typename: 'Group', id: 'side', name: 'Sidebar joined', viewer_join_state: 'MEMBER' } }], page_info: { has_next_page: false, end_cursor: 'side-done' } } } } }];
  const analysis = analyzeJoinedGroupsChunks(chunks);
  assert.deepEqual(analysis.groups, [{ groupId: 'real', groupName: 'Real joined' }]);
  assert.equal(analysis.complete, false);
  assert.equal(analysis.endCursor, 'real-next');
});

test('prefers exact joined_groups field over joined preview fields', () => {
  const chunks = [{ data: { viewer: { joined_groups_preview: { edges: [{ node: { __typename: 'Group', id: 'preview', name: 'Preview', viewer_join_state: 'MEMBER' } }], page_info: { has_next_page: false, end_cursor: 'preview-done' } }, joined_groups: { edges: [{ node: { __typename: 'Group', id: 'real', name: 'Real joined', viewer_join_state: 'MEMBER' } }], page_info: { has_next_page: true, end_cursor: 'real-next' } } } } }];
  const analysis = analyzeJoinedGroupsChunks(chunks);
  assert.deepEqual(analysis.groups, [{ groupId: 'real', groupName: 'Real joined' }]);
  assert.equal(analysis.complete, false);
  assert.equal(analysis.endCursor, 'real-next');
});


test('does not treat preview or generic member connections as authoritative', () => {
  for (const key of ['joined_groups_preview', 'member_groups', 'membership_groups']) {
    const analysis = analyzeJoinedGroupsChunks([{ data: { viewer: { [key]: {
      edges: [{ node: { __typename: 'Group', id: key, name: key, viewer_join_state: 'MEMBER' } }],
      page_info: { has_next_page: false, end_cursor: 'done' },
    } } } }]);
    assert.equal(analysis.complete, true);
    assert.equal(analysis.authoritative, false);
  }
});

test('marks URL-derived group identifiers as non-authoritative for replacement', () => {
  const analysis = analyzeJoinedGroupsChunks([{ data: { viewer: { joined_groups: {
    edges: [{ node: { __typename: 'Group', name: 'Slug only', url: 'https://www.facebook.com/groups/slug-only/', viewer_join_state: 'MEMBER' } }],
    page_info: { has_next_page: false, end_cursor: 'done' },
  } } } }]);
  assert.equal(analysis.complete, true);
  assert.equal(analysis.authoritative, true);
  assert.equal(analysis.hasNonAuthoritativeIds, true);
});
