export interface WarmingDiagnosticEntry {
  id: number;
  type: string;
  status: string;
  createdAt?: number | null;
  data?: unknown;
}

const WARMING_ACTIVITY_STATUSES = new Set([
  "done",
  "success",
  "error",
  "blocked",
  "stopped",
  "no_op",
  "unverified",
  "skipped",
  "deferred",
]);

const WARMING_ACTIVITY_TYPES = new Set([
  "session",
  "scrollFeed",
  "watchVideo",
  "openNotifications",
  "scrollGroups",
  "scrollReels",
  "reactPost",
  "reactReels",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function normalizeWarmingActivityEntries(
  value: unknown,
): WarmingDiagnosticEntry[] {
  if (!Array.isArray(value)) return [];
  const rows: WarmingDiagnosticEntry[] = [];
  const seenIds = new Set<number>();
  for (const item of value) {
    const row = asRecord(item);
    if (!row) continue;
    const rawId = row.id;
    const canonicalId =
      typeof rawId === "number"
        ? Number.isSafeInteger(rawId) && rawId > 0
        : typeof rawId === "string" && /^[1-9]\d*$/.test(rawId);
    if (!canonicalId) continue;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0 || seenIds.has(id)) continue;
    seenIds.add(id);
    const rawStatus = String(row.status ?? "");
    const rawType = typeof row.type === "string" ? row.type : "";
    const createdAt = Number(row.createdAt);
    rows.push({
      id,
      type: WARMING_ACTIVITY_TYPES.has(rawType) ? rawType : "unknown",
      status: WARMING_ACTIVITY_STATUSES.has(rawStatus) ? rawStatus : "error",
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
      data: row.data,
    });
  }
  return rows;
}

export function sanitizeWarmingDiagnostic(
  value: unknown,
  maxLength = 180,
): string {
  return String(value ?? "")
    .replace(
      /\b(authorization|cookie)\s*(:)\s*[^\r\n]+(?:\r?\n[\t ][^\r\n]*)*/gi,
      "$1$2 [redacted]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|password)\s*([:=])\s*([^,;\s]+)/gi,
      (_match, key: string, separator: string) =>
        `${key}${separator}${separator === ":" ? " " : ""}[redacted]`,
    )
    .replace(/\b(c_user|xs|fr|datr|sb)=([^;\s]+)/gi, "$1=[redacted]")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function warmingSkippedWritesText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    const skipped = asRecord(item);
    if (!skipped) continue;
    const action = sanitizeWarmingDiagnostic(skipped.action);
    const code = sanitizeWarmingDiagnostic(skipped.code);
    const reason = sanitizeWarmingDiagnostic(skipped.reason);
    if (!action && !code && !reason) continue;
    const identity = [action, code].filter(Boolean).join(": ");
    parts.push(
      `Bỏ qua${identity ? ` ${identity}` : ""}${reason ? ` — ${reason}` : ""}`,
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function warmingDiagnosticText(entry: unknown): string | null {
  const record = asRecord(entry);
  if (!record) return null;
  const data = asRecord(record.data);
  if (!data) return null;
  const navigation = asRecord(data.navigation);
  const verificationSignals = asRecord(data.verificationSignals);
  const reelsSignals = verificationSignals || data;
  const parts: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return;
    const clean = sanitizeWarmingDiagnostic(value);
    if (clean) parts.push(`${label}: ${clean}`);
  };

  if (
    record.type === "session" &&
    Array.isArray(data.plan) &&
    data.plan.length === 0 &&
    Number(data.attempted) === 0
  ) {
    parts.push("Kế hoạch: không có hành động");
  }
  const skippedWrites = warmingSkippedWritesText(data.skippedWrites);
  if (skippedWrites) parts.push(skippedWrites);
  push("Bước", data.stage);
  push("Mã", data.note);
  if (record.type === "reactReels") {
    push("Trước", reelsSignals.pressedBefore);
    push("Sau", reelsSignals.pressedAfter);
    if (reelsSignals.nodeReplaced === true) parts.push("DOM: nút đã được thay");
  }
  push("Lỗi", data.error);
  if (!data.stage && navigation) {
    push("Điều hướng", navigation.note);
    if (navigation.completed === false) {
      parts.push("Tải trang: hết thời gian chờ");
    }
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
