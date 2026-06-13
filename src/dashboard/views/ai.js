/**
 * views/ai.js — Cấu hình AI + khám phá/xem/xóa selector.
 */
import { $, bg, esc, toast } from "../core.js";

/* ============================= CẤU HÌNH AI ============================= */
// Danh sách model mặc định (phòng khi chưa tải được từ endpoint).
const FALLBACK_MODELS = [
  "gpt-5.5",
  "gpt-5.5-high",
  "gpt-5.4",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
];

// Đổ danh sách model vào <select>, giữ nguyên model đang chọn nếu còn trong list.
// Nếu model đã lưu không có trong list -> thêm vào để không mất lựa chọn cũ.
export function populateModelSelect(models, selected) {
  const sel = $("aiModel");
  if (!sel) return;
  const list = Array.isArray(models) && models.length ? models.slice() : FALLBACK_MODELS.slice();
  if (selected && !list.includes(selected)) list.unshift(selected);
  sel.innerHTML = list
    .map((m) => `<option value="${esc(m)}"${m === selected ? " selected" : ""}>${esc(m)}</option>`)
    .join("");
}

export function loadAIConfig() {
  chrome.storage.local.get(["aiConfig", "aiModelList"], (r) => {
    const cfg = (r && r.aiConfig) || {};
    const cached = (r && Array.isArray(r.aiModelList) && r.aiModelList) || [];
    $("aiApiBase").value = cfg.apiBase || "https://danglamgiau.com/v1";
    $("aiApiKey").value = cfg.apiKey || "";
    const model = cfg.model || "gpt-5.5";
    populateModelSelect(cached, model);
    if ($("aiModelCustom")) $("aiModelCustom").value = "";
    // Nếu chưa có cache model -> tự tải nền (im lặng) khi đã có API key.
    if (!cached.length && cfg.apiKey) reloadModels(true);
  });
}

// Lưu cấu hình AI. opts.silent = true: tự lưu nền (không toast, không đồng bộ
// lại dropdown) để dùng cho auto-save khi người dùng gõ/đổi rồi rời ô — tránh
// làm gián đoạn thao tác gõ. Khi bấm nút "Lưu cấu hình" thì gọi không silent.
export function saveAIConfig(opts = {}) {
  const silent = !!opts.silent;
  // Ưu tiên ô nhập thủ công nếu người dùng gõ, ngược lại lấy từ dropdown.
  const custom = ($("aiModelCustom") && $("aiModelCustom").value || "").trim();
  const picked = ($("aiModel") && $("aiModel").value || "").trim();
  const cfg = {
    apiBase: ($("aiApiBase").value || "").trim() || "https://danglamgiau.com/v1",
    apiKey: ($("aiApiKey").value || "").trim(),
    model: custom || picked || "gpt-5.5",
  };
  chrome.storage.local.set({ aiConfig: cfg }, () => {
    void chrome.runtime.lastError;
    if (silent) return;
    toast("Đã lưu cấu hình AI.", "ok");
    // Đồng bộ lại dropdown nếu nhập model thủ công.
    if (custom) {
      chrome.storage.local.get("aiModelList", (r) => {
        populateModelSelect((r && r.aiModelList) || [], cfg.model);
        if ($("aiModelCustom")) $("aiModelCustom").value = "";
      });
    }
  });
}

// Tải danh sách model từ endpoint qua background. silent=true thì không báo lỗi ồn ào.
export async function reloadModels(silent) {
  const btn = $("btnReloadModels");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Đang tải...";
  }
  let res;
  try {
    res = await bg("LIST_MODELS");
  } catch (e) {
    res = { ok: false, error: String(e) };
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Tải lại";
    }
  }
  if (!res || !res.ok) {
    if (!silent) toast((res && res.error) || "Không tải được danh sách model.", "err", 5000);
    return;
  }
  chrome.storage.local.set({ aiModelList: res.models });
  const current = ($("aiModel") && $("aiModel").value || "").trim();
  populateModelSelect(res.models, current);
  if (!silent) toast(`Đã tải ${res.models.length} model.`, "ok");
}
export async function discoverSelectors() {
  toast("Đang lấy HTML mẫu và gọi AI...", "info", 4000);
  const res = await bg("DISCOVER_SELECTORS");
  if (!res || !res.ok) {
    toast((res && res.error) || "Khám phá thất bại.", "err", 5000);
    if (res && res.error) $("selectorBox").textContent = res.error;
    return;
  }
  $("selectorBox").textContent = JSON.stringify(res.selectors, null, 2);
  toast("Đã khám phá selector và lưu lại.", "ok");
}
export async function viewSelectors() {
  const res = await bg("GET_SELECTORS");
  $("selectorBox").textContent = res && res.selectors ? JSON.stringify(res.selectors, null, 2) : "Chưa có selector.";
}
export async function clearSelectors() {
  await bg("CLEAR_SELECTORS");
  $("selectorBox").textContent = "Đã xóa selector.";
  toast("Đã xóa selector.", "ok");
}
