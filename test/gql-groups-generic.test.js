import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeJoinedGroupsChunks } from "../src/gql-groups.js";

test("generic groups requires explicit joined-query authorization", () => {
  const chunks = [{
    data: {
      groups_tab_content: {
        groups: {
          edges: [{
            node: {
              __typename: "Group",
              id: "generic-joined",
              name: "Generic joined group",
              viewer_join_state: "MEMBER",
            },
          }],
          page_info: { has_next_page: false, end_cursor: "done" },
        },
      },
    },
  }];

  const unauthorized = analyzeJoinedGroupsChunks(chunks);
  assert.deepEqual(unauthorized.groups, []);
  assert.equal(unauthorized.authoritative, false);
  assert.equal(unauthorized.complete, false);

  const authorized = analyzeJoinedGroupsChunks(chunks, {
    allowGenericGroups: true,
  });
  assert.deepEqual(authorized.groups, [
    { groupId: "generic-joined", groupName: "Generic joined group" },
  ]);
  assert.equal(authorized.authoritative, true);
  assert.equal(authorized.complete, true);
});

test("generic groups rejects suggestion, recommendation, and discovery paths", () => {
  for (const pathKey of ["suggestions", "recommendations", "discover_groups"]) {
    const analysis = analyzeJoinedGroupsChunks([{
      data: {
        [pathKey]: {
          groups: {
            edges: [{
              node: {
                __typename: "Group",
                id: pathKey,
                name: pathKey,
                viewer_join_state: "MEMBER",
              },
            }],
            page_info: { has_next_page: false, end_cursor: "done" },
          },
        },
      },
    }], { allowGenericGroups: true });

    assert.deepEqual(analysis.groups, []);
    assert.equal(analysis.authoritative, false);
    assert.equal(analysis.complete, false);
  }
});
