/**
 * PURE parser for Facebook joined-groups GraphQL responses.
 * It intentionally reads Group nodes only from connections whose field name
 * explicitly identifies joined/member groups, preventing notification and
 * recommendation objects elsewhere in the response from leaking into results.
 */

const JOINED_CONNECTION_RE =
  /(?:^|_)(?:viewer_)?(?:joined|member(?:ship)?)(?:_|$).*group|group.*(?:^|_)(?:joined|member(?:ship)?)(?:_|$)/i;

const JOINED_STATES = new Set(["MEMBER", "JOINED", "ACTIVE", "APPROVED"]);
const REJECTED_STATES = new Set([
  "NOT_JOINED",
  "NOT_MEMBER",
  "REQUESTED",
  "PENDING",
  "INVITED",
  "LEFT",
  "REMOVED",
  "DECLINED",
  "REJECTED",
  "BANNED",
]);

function stringify(value) {
  try {
    return JSON.stringify(value || {}).toLowerCase();
  } catch (e) {
    return "";
  }
}

function hasPaginationCursor(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasPaginationCursor(item, seen));

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase();
    if (["cursor", "after", "before"].includes(normalizedKey)) {
      if (child !== null && child !== undefined && String(child) !== "") return true;
    }
    if (hasPaginationCursor(child, seen)) return true;
  }
  return false;
}

/** Return true only when variables represent the first page of a joined query. */
export function isInitialJoinedGroupsRequest(variables) {
  return !hasPaginationCursor(variables);
}

/** Return true only for a likely /groups/joins GraphQL operation. */
export function isJoinedGroupsRequest(friendly, variables, pagePath = "") {
  const f = String(friendly || "").toLowerCase();
  const vars = stringify(variables);
  const path = String(pagePath || "").toLowerCase();

  if (
    /feed|stories|post|comment|notification|suggest|discover|search|keyword|bootstrap|messenger|chat|thread|inbox|message|promotion|eligible|timelimit|time.?limit|enforcement|regulatory|youth|safety|policy|config|settings|eligibility|backup|device|encrypted|encryption|eb_/.test(f)
  ) {
    return false;
  }

  const hasJoinedSignal =
    /joined.?groups|groups?.?(?:joined|membership)|groupscometgroupstabcontent/.test(f) ||
    /viewer_joined_groups|joined_groups|membership.*groups|groups.*membership/.test(vars);

  if (hasJoinedSignal) return true;

  // Facebook can rename the persisted query without retaining a stable joined-
  // groups token. On the dedicated /groups/joins document, inspect otherwise
  // unclassified GraphQL responses and let the response-connection analysis
  // decide authority. Known feed/notification/suggestion families were rejected
  // above, and destructive replacement still requires a complete authoritative
  // joined connection with immutable Group IDs.
  return path.includes("/groups/joins");
}
function walk(value, callback, depth = 0, seen = new Set(), path = []) {
  if (depth > 18 || !value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      walk(value[index], callback, depth + 1, seen, [...path, String(index)]);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    callback(child, key, value, childPath);
    walk(child, callback, depth + 1, seen, childPath);
  }
}

function canonicalConnectionKey(key) {
  return String(key || "").toLowerCase().replace(/^viewer_/, "");
}

function connectionPriority(key, path = "", allowGenericGroups = false) {
  const canonical = canonicalConnectionKey(key);
  const semanticPath = String(path || "").toLowerCase();
  if (canonical === "joined_groups") return 5;
  if (/(?:^|_)joined(?:_|$)/.test(canonical)) return 4;
  if (canonical === "joined_groups_preview") return 2;
  if (/(?:^|_)membership(?:_|$)/.test(canonical)) return 2;
  if (/(?:^|_)member(?:_|$)/.test(canonical)) return 1;
  if (
    allowGenericGroups &&
    canonical === "groups" &&
    !/(?:suggest|recommend|discover|invite|pending|request)/.test(semanticPath)
  ) {
    // Some Facebook versions expose the joined list as a generic `groups`
    // connection. It is accepted only when the caller has already authenticated
    // the operation as the /groups/joins query.
    return /(?:tab|content|joined|membership)/.test(semanticPath) ? 3 : 2;
  }
  return 0;
}

function collectJoinedConnections(chunk, allowGenericGroups = false) {
  const out = [];

  walk(chunk, (value, key, parent, path) => {
    if (
      typeof key !== "string" ||
      !value ||
      typeof value !== "object" ||
      !Array.isArray(value.edges)
    ) {
      return;
    }

    const canonicalKey = canonicalConnectionKey(key);
    const isNamedJoinedConnection = JOINED_CONNECTION_RE.test(key);
    const isAllowedGenericConnection =
      allowGenericGroups && canonicalKey === "groups";

    if (!isNamedJoinedConnection && !isAllowedGenericConnection) return;

    const semanticPath = path
      .slice(0, -1)
      .filter((part) =>
        !/^\d+$/.test(part) &&
        !["data", "incremental", "payload"].includes(String(part).toLowerCase())
      );

    semanticPath.push(canonicalKey);
    const joinedPath = semanticPath.join(".");
    const priority = connectionPriority(
      key,
      joinedPath,
      allowGenericGroups,
    );

    // A generic `groups` field is ignored unless its semantic path survives the
    // recommendation/discovery/request deny-list in connectionPriority().
    if (priority <= 0) return;

    out.push({
      key: canonicalKey,
      path: joinedPath,
      priority,
      value,
    });
  });

  return out;
}

function collectEdgeNodes(connection) {
  const edges = connection && Array.isArray(connection.edges)
    ? connection.edges
    : [];
  const out = [];
  for (const edge of edges) {
    const node = edge && typeof edge === "object" && edge.node ? edge.node : edge;
    if (node && typeof node === "object") out.push(node);
  }
  return out;
}

function membershipState(node) {
  for (const key of [
    "viewer_join_state",
    "viewer_membership_state",
    "membership_status",
    "viewer_membership_status",
  ]) {
    const value = node && node[key];
    if (typeof value === "string" && value.trim()) return value.trim().toUpperCase();
  }
  return "";
}

function groupIdFromUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  try {
    const url = new URL(rawUrl, "https://www.facebook.com/");
    const match = url.pathname.match(/^\/groups\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  } catch (e) {
    const match = rawUrl.match(/\/groups\/([^/?#]+)/i);
    return match ? match[1] : "";
  }
}

function normalizeGroup(node) {
  if (!node || typeof node !== "object") return null;
  if (node.__typename && String(node.__typename).toLowerCase() !== "group") return null;

  const state = membershipState(node);
  if (state && (REJECTED_STATES.has(state) || !JOINED_STATES.has(state))) return null;

  const groupName = typeof node.name === "string" ? node.name.trim().replace(/\s+/g, " ") : "";
  const rawId = node.id ?? node.group_id ?? node.groupID ?? "";
  const authoritativeId = String(rawId || "").trim();
  const groupId = authoritativeId || groupIdFromUrl(node.url || node.profile_url || "").trim();

  if (!groupId || !groupName) return null;
  return {
    group: { groupId, groupName: groupName.slice(0, 300) },
    authoritativeId: !!authoritativeId,
  };
}

function collectStructuralDiagnostics(chunks) {
  const topLevelKeys = new Set();
  const objectPaths = new Set();

  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) continue;
    for (const key of Object.keys(chunk).slice(0, 12)) topLevelKeys.add(key);

    walk(chunk, (value, key, parent, path) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if (typeof key !== "string" || !path.length || objectPaths.size >= 24) return;

      const meaningfulPath = path
        .filter((part) => !/^\d+$/.test(String(part)))
        .slice(-6)
        .join(".");
      if (meaningfulPath) objectPaths.add(meaningfulPath);
    });
  }

  return {
    topLevelKeys: [...topLevelKeys].slice(0, 12),
    objectPaths: [...objectPaths].slice(0, 24),
  };
}

function collectJoinedGroupAnalysis(chunks, options = {}) {
  const allowGenericGroups = options.allowGenericGroups === true;
  const allConnections = [];
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    allConnections.push(...collectJoinedConnections(chunk, allowGenericGroups));
  }

  let selectedKey = "";
  let selectedPath = "";
  let selectedPriority = -1;
  for (const connection of allConnections) {
    if (
      connection.priority > selectedPriority ||
      (connection.priority === selectedPriority &&
        connection.key === "joined_groups" &&
        selectedKey !== "joined_groups")
    ) {
      selectedKey = connection.key;
      selectedPath = connection.path;
      selectedPriority = connection.priority;
    }
  }

  const byId = new Map();
  let hasNonAuthoritativeIds = false;
  let hasPageInfo = false;
  let hasNextPage = null;
  let endCursor = null;

  for (const connection of allConnections) {
    if (
      !selectedKey ||
      connection.key !== selectedKey ||
      connection.path !== selectedPath
    ) continue;

    for (const node of collectEdgeNodes(connection.value)) {
      const normalized = normalizeGroup(node);
      if (!normalized) continue;
      if (!normalized.authoritativeId) hasNonAuthoritativeIds = true;
      if (!byId.has(normalized.group.groupId)) {
        byId.set(normalized.group.groupId, normalized.group);
      }
    }

    const pageInfo = connection.value.page_info || connection.value.pageInfo;
    if (!pageInfo || typeof pageInfo !== "object") continue;
    if (typeof pageInfo.has_next_page !== "boolean" && typeof pageInfo.hasNextPage !== "boolean") continue;

    hasPageInfo = true;
    hasNextPage = typeof pageInfo.has_next_page === "boolean"
      ? pageInfo.has_next_page
      : pageInfo.hasNextPage;
    endCursor = pageInfo.end_cursor ?? pageInfo.endCursor ?? null;
  }

  return {
    groups: [...byId.values()],
    hasPageInfo,
    hasNextPage,
    endCursor,
    complete: hasPageInfo && hasNextPage === false,
    authoritative:
      selectedKey === "joined_groups" ||
      (allowGenericGroups && selectedKey === "groups"),
    hasNonAuthoritativeIds,
    diagnostics: {
      chunkCount: Array.isArray(chunks) ? chunks.length : 0,
      connectionCount: allConnections.length,
      selectedKey,
      selectedPath,
      ...collectStructuralDiagnostics(chunks),
      connections: allConnections.map((connection) => ({
        key: connection.key,
        path: connection.path,
        priority: connection.priority,
        edgeCount: Array.isArray(connection.value?.edges)
          ? connection.value.edges.length
          : 0,
        hasPageInfo: !!(
          connection.value?.page_info || connection.value?.pageInfo
        ),
      })),
    },
  };
}

/** Extract and deduplicate joined groups across normal and deferred chunks. */
export function extractJoinedGroupsFromChunks(chunks, options = {}) {
  return collectJoinedGroupAnalysis(chunks, options).groups;
}

/** Analyze groups and prove pagination completion from the latest page_info. */
export function analyzeJoinedGroupsChunks(chunks, options = {}) {
  return collectJoinedGroupAnalysis(chunks, options);
}
