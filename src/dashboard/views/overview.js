/**
 * views/overview.js — Tab Tổng quan: thống kê bài/nhóm/job + biểu đồ cột.
 */
import { $, bg, esc, emptyState } from "../core.js";

export async function renderOverview() {
  const [statsRes, groupsRes, jobsRes] = await Promise.all([
    bg("GET_STATS"),
    bg("GET_GROUPS"),
    bg("GET_JOBS"),
  ]);
  const stats = (statsRes && statsRes.stats) || { total: 0, groups: [] };
  const groups = (groupsRes && groupsRes.groups) || [];
  const jobs = (jobsRes && jobsRes.jobs) || [];

  $("statPosts").textContent = stats.total;
  $("statGroups").textContent = groups.length;
  $("statPending").textContent = jobs.filter((j) => j.status === "pending" || j.status === "running").length;
  $("statDone").textContent = jobs.filter((j) => j.status === "done").length;

  const sorted = [...stats.groups].sort((a, b) => b.count - a.count).slice(0, 8);
  const max = sorted.length ? sorted[0].count : 1;
  const wrap = $("overviewGroups");
  if (!sorted.length) {
    wrap.innerHTML = emptyState("Chưa có dữ liệu", "Hãy crawl một nhóm để xem thống kê tại đây.");
    return;
  }
  wrap.innerHTML = sorted
    .map(
      (g) => `
      <div class="bar-row">
        <div class="bar-name" title="${esc(g.groupName)}">${esc(g.groupName)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, (g.count / max) * 100)}%"></div></div>
        <div class="bar-val">${g.count}</div>
      </div>`
    )
    .join("");
}
