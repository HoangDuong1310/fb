/**
 * remote-commands.js — View "Lệnh từ Web": hiển thị danh sách lệnh điều khiển
 * từ web server, trạng thái, kết quả và lỗi.
 *
 * Dữ liệu lấy qua bg() → background.js → apiFetch("/api/remote-commands").
 *
 * Đường dữ liệu:
 *   bg("GET_REMOTE_COMMANDS", { status?, page?, limit? })
 *     → { ok, commands: [{id, type, payload, status, result, error,
 *        createdAt, startedAt, completedAt}], total, page, limit }
 */
import { $, bg, toast, timeAgo, esc } from "../core.js";

const PAGE_SIZE = 20;

const STATUS_LABEL = {
  pending: "Chờ xử lý",
  running: "Đang chạy",
  completed: "Hoàn thành",
  failed: "Lỗi",
  expired: "Hết hạn",
};

const TYPE_LABEL = {
  create_post: "Đăng bài",
  create_comment: "Bình luận",
  crawl_group: "Crawl nhóm",
  scan_groups: "Quét nhóm",
  approve_advisory: "Duyệt tư vấn",
  approve_conversation: "Duyệt hội thoại",
  delete_post: "Xoá bài",
};

let currentPage = 1;
let currentStatus = "";
let totalCount = 0;

function statusBadge(status) {
  const colors = {
    pending: ["#f59e0b", "#78350f"],
    running: ["#3b82f6", "#1e3a5f"],
    completed: ["#10b981", "#064e3b"],
    failed: ["#ef4444", "#7f1d1d"],
    expired: ["#6b7280", "#374151"],
  };
  const [bg2, fg] = colors[status] || colors.pending;
  const label = STATUS_LABEL[status] || status;
  return `<span class="badge" style="background:${bg2};color:${fg};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${esc(label)}</span>`;
}

function typeLabel(type) {
  return `<span style="color:var(--accent,#3b82f6);font-weight:500;">${esc(TYPE_LABEL[type] || type)}</span>`;
}

function renderPayload(payload) {
  if (!payload) return '<span style="opacity:0.4">—</span>';
  // Show compact summary based on type
  const parts = [];
  if (payload.content) {
    const preview = String(payload.content).slice(0, 80);
    parts.push(esc(preview) + (String(payload.content).length > 80 ? "…" : ""));
  }
  if (payload.url) parts.push(`<a href="${esc(payload.url)}" target="_blank" rel="noopener" style="color:var(--accent,#3b82f6);word-break:break-all;font-size:12px;">${esc(payload.url)}</a>`);
  if (payload.groupId) parts.push(`<span style="opacity:0.6">Nhóm:</span> ${esc(String(payload.groupId))}`);
  if (payload.images && payload.images.length) parts.push(`<span style="opacity:0.6">Ảnh:</span> ${payload.images.length}`);
  if (parts.length === 0) {
    // Generic: show first 2 keys
    const keys = Object.keys(payload).slice(0, 3);
    for (const k of keys) {
      const v = typeof payload[k] === "object" ? JSON.stringify(payload[k]) : String(payload[k]);
      parts.push(`<span style="opacity:0.6">${esc(k)}:</span> ${esc(v.slice(0, 60))}${v.length > 60 ? "…" : ""}`);
    }
  }
  return parts.length ? parts.join("<br>") : '<span style="opacity:0.4">—</span>';
}

function renderResult(result) {
  if (!result) return '<span style="opacity:0.4">—</span>';
  if (result.postUrl) {
    return `<a href="${esc(result.postUrl)}" target="_blank" rel="noopener" style="color:var(--accent,#3b82f6);font-size:12px;word-break:break-all;">${esc(result.postUrl)}</a>`;
  }
  if (result.summary) return `<span style="font-size:12px;">${esc(result.summary)}</span>`;
  // Generic
  const text = JSON.stringify(result).slice(0, 100);
  return `<span style="font-size:12px;opacity:0.7;">${esc(text)}${JSON.stringify(result).length > 100 ? "…" : ""}</span>`;
}

function renderError(error) {
  if (!error) return "";
  return `<span style="color:#ef4444;font-size:12px;" title="${esc(error)}">⚠ ${esc(String(error).slice(0, 80))}${String(error).length > 80 ? "…" : ""}</span>`;
}

function renderTime(ts) {
  if (!ts) return '<span style="opacity:0.4">—</span>';
  return `<span title="${esc(ts)}" style="font-size:12px;">${esc(timeAgo(ts))}</span>`;
}

function renderRow(cmd) {
  return `
    <tr style="border-bottom:1px solid var(--border,#333);">
      <td style="padding:10px 12px;font-size:12px;opacity:0.6;white-space:nowrap;">#${cmd.id}</td>
      <td style="padding:10px 12px;">${typeLabel(cmd.type)}</td>
      <td style="padding:10px 12px;">${statusBadge(cmd.status)}</td>
      <td style="padding:10px 12px;max-width:300px;">${renderPayload(cmd.payload)}</td>
      <td style="padding:10px 12px;max-width:200px;">${renderResult(cmd.result)}</td>
      <td style="padding:10px 12px;max-width:200px;">${renderError(cmd.error)}</td>
      <td style="padding:10px 12px;white-space:nowrap;">${renderTime(cmd.createdAt)}</td>
      <td style="padding:10px 12px;white-space:nowrap;">${renderTime(cmd.completedAt)}</td>
    </tr>`;
}

function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (totalPages <= 1) return "";

  const prevDisabled = currentPage <= 1 ? "disabled" : "";
  const nextDisabled = currentPage >= totalPages ? "disabled" : "";

  return `
    <div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:16px 0;">
      <button class="btn ghost" id="rcPrevPage" ${prevDisabled} style="opacity:${prevDisabled ? 0.4 : 1};">← Trước</button>
      <span style="font-size:13px;opacity:0.7;">Trang ${currentPage} / ${totalPages}  (${totalCount} lệnh)</span>
      <button class="btn ghost" id="rcNextPage" ${nextDisabled} style="opacity:${nextDisabled ? 0.4 : 1};">Sau →</button>
    </div>`;
}

function renderCommandList(commands) {
  const container = $("remoteCmdList");
  if (!container) return;

  if (!commands || commands.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:40px 16px;opacity:0.5;">
        <p style="font-size:15px;margin:0;">Không có lệnh nào.</p>
        <p style="font-size:13px;margin:8px 0 0;">Lệnh từ web server sẽ xuất hiện ở đây khi được gửi.</p>
      </div>`;
    return;
  }

  const rows = commands.map(renderRow).join("");

  container.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:2px solid var(--border,#333);text-align:left;">
            <th style="padding:8px 12px;font-weight:600;opacity:0.6;">ID</th>
            <th style="padding:8px 12px;font-weight:600;">Loại</th>
            <th style="padding:8px 12px;font-weight:600;">Trạng thái</th>
            <th style="padding:8px 12px;font-weight:600;">Nội dung</th>
            <th style="padding:8px 12px;font-weight:600;">Kết quả</th>
            <th style="padding:8px 12px;font-weight:600;">Lỗi</th>
            <th style="padding:8px 12px;font-weight:600;">Tạo lúc</th>
            <th style="padding:8px 12px;font-weight:600;">Xong lúc</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${renderPagination()}`;

  // Bind pagination
  const prev = $("rcPrevPage");
  const next = $("rcNextPage");
  if (prev) prev.onclick = () => { if (currentPage > 1) { currentPage--; loadRemoteCommandsView(); } };
  if (next) next.onclick = () => { if (currentPage < Math.ceil(totalCount / PAGE_SIZE)) { currentPage++; loadRemoteCommandsView(); } };
}

export async function loadRemoteCommandsView() {
  // Update status tabs
  document.querySelectorAll("#rcStatusTabs .seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.status === currentStatus);
  });

  // Show which user the extension is authenticated as (diagnostic for wrong-user bug)
  const hint = $("rcAuthHint");
  const authRes = await bg("AUTH_STATE");
  if (hint) {
    hint.hidden = false;
    if (authRes && authRes.ok && authRes.loggedIn) {
      hint.innerHTML =
        `<span style="color:var(--green,#4caf50)">✓ Extension đang đăng nhập: <strong>${esc(authRes.display_name || "")}</strong></span>` +
        ` &nbsp;<button id="btnPollNow" class="btn ghost" style="font-size:12px;padding:2px 8px;">Poll ngay</button>`;
    } else {
      hint.innerHTML =
        `<span style="color:var(--warn,#e57373)">✗ Extension chưa đăng nhập tài khoản web.</span>` +
        ` &nbsp;<button id="btnPollNow" class="btn ghost" style="font-size:12px;padding:2px 8px;" disabled>Poll ngay</button>`;
    }
    const btnPoll = document.getElementById("btnPollNow");
    if (btnPoll) {
      btnPoll.onclick = async () => {
        btnPoll.disabled = true;
        btnPoll.textContent = "Đang poll…";
        const r = await bg("POLL_REMOTE_COMMANDS");
        toast(r && r.ok ? "Đã poll lệnh mới!" : "Poll thất bại: " + (r && r.error || "unknown"));
        btnPoll.textContent = "Poll ngay";
        btnPoll.disabled = false;
        loadRemoteCommandsView();
      };
    }
  }

  const res = await bg("GET_REMOTE_COMMANDS", {
    status: currentStatus || undefined,
    page: currentPage,
    limit: PAGE_SIZE,
  });

  if (!res || !res.ok) {
    if (hint) {
      const errSpan = document.createElement("span");
      errSpan.style.cssText = "color:var(--warn,#e57373);margin-left:8px;";
      errSpan.textContent = " — " + ((res && res.error) || "Lỗi tải danh sách lệnh.");
      hint.appendChild(errSpan);
    }
    renderCommandList([]);
    return;
  }

  totalCount = res.total || 0;
  renderCommandList(res.commands || []);
}

export function switchRcTab(status) {
  currentStatus = status;
  currentPage = 1;
  loadRemoteCommandsView();
}
