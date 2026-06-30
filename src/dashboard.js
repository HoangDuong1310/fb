/**
 * dashboard.js — Điểm vào (entry) của trang dashboard, dạng ES module.
 *
 * File này KHÔNG còn chứa logic nghiệp vụ: toàn bộ đã được tách theo domain vào
 * thư mục src/dashboard/ (core, prefs, nav) và src/dashboard/views/* (overview,
 * groups, posts, jobs, ai, products, mystore, build, advisory).
 *
 * Nhiệm vụ của entry:
 *   1) bindEvents(): gắn toàn bộ event listener cho UI (event delegation qua
 *      data-act/data-* — KHÔNG dùng inline onclick, nên các hàm view nằm ở module
 *      scope vẫn an toàn).
 *   2) Lắng nghe message realtime từ service worker (CRAWL_PROGRESS, CRAWL_DONE,
 *      SYNC_PROGRESS, BUILD_PROGRESS, JOB_UPDATE).
 *   3) init(): khôi phục tùy chọn đã lưu, nạp nhóm, mở view Tổng quan.
 */

import { $, store, toast, modal, syncToasts } from "./dashboard/core.js";
import { switchView } from "./dashboard/nav.js";
import {
  CRAWL_FIELDS,
  saveCrawlSettings,
  loadCrawlSettings,
  loadUIPrefs,
} from "./dashboard/prefs.js";
import { bg } from "./dashboard/core.js";
import { renderOverview } from "./dashboard/views/overview.js";
import {
  loadGroups,
  renderGroups,
  scanGroups,
  addGroupManual,
  crawlGroup,
  crawlGroupApi,
  testApiAuto,
  setCrawlStatus,
  saveAutoCrawl,
  loadAutoCrawl,
  updateSelCount,
  toggleSelectAll,
  updateBatchStatus,
  startBatchCrawl,
  onWorkerDone,
  stopBatchCrawl,
} from "./dashboard/views/groups.js";
import {
  loadPosts,
  renderPosts,
  exportPosts,
  clearGroupPosts,
  analyzePostUI,
  applyLeadMode,
  suggestKeywordsUI,
  toggleMineOnly,
  loadPostComments,
} from "./dashboard/views/posts.js";
import { loadLeadKeywords } from "./dashboard/leadfilter.js";
import {
  loadJobs,
  preparePost,
  createCommentJob,
  addPostImages,
  addCmtImages,
  updatePostGroupCount,
  togglePostSelectAll,
  filterPostGroups,
} from "./dashboard/views/jobs.js";
import {
  saveAIConfig,
  reloadModels,
  discoverSelectors,
  viewSelectors,
  clearSelectors,
} from "./dashboard/views/ai.js";
import {
  productStore,
  syncAllSources,
  applyProductFilter,
  clearAllProducts,
  onSourceAction,
  saveAutoSync,
  renderProducts,
} from "./dashboard/views/products.js";
import {
  myStore,
  loadSheetTabs,
  importSheet,
  clearMyStore,
  applyMyStoreFilter,
  compareMine,
} from "./dashboard/views/mystore.js";
import {
  buildAI,
  syncBuildBudget,
  runBuildConfig,
} from "./dashboard/views/build.js";
import {
  advisoryStore,
  syncAdvTabs,
  reloadAdvisories,
  genAdvisories,
  clearAdvisoriesUI,
  approveAdvisoryUI,
  editAdvisory,
  rejectAdvisoryUI,
  deleteAdvisoryUI,
} from "./dashboard/views/advisory.js";
import {
  conversationStore,
  syncConvTabs,
  reloadConversations,
  loadConversationsView,
  saveWatchConfig,
  watchNow,
  trackConversationUI,
  draftConvReplyUI,
  approveConvReplyUI,
  toggleConvClose,
  deleteConvUI,
} from "./dashboard/views/conversations.js";
import {
  exportAllPosts,
  clearAllPosts,
  clearAllAdvisories,
  clearAllPrices,
  clearMyStoreData,
} from "./dashboard/views/settings.js";
import {
  reloadGroupPrices,
  applyGroupPriceFilter,
  setGroupPriceMine,
  runExtraction,
  explainShareIcon,
} from "./dashboard/views/groupprices.js";
import {
  reloadKeywords,
  addKeywordUI,
  toggleKeyword,
  deleteKeyword,
  switchKeywordType,
} from "./dashboard/views/keywords.js";
import { loadSharingView, saveSharePref } from "./dashboard/views/sharing.js";
import { loadProfilesView, onProfileAction } from "./dashboard/views/profiles.js";
import { switchRcTab } from "./dashboard/views/remote-commands.js";

/* ============================ SỰ KIỆN UI ============================== */
function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((b) =>
    b.addEventListener("click", () => switchView(b.dataset.view))
  );
  $("btnGlobalRefresh").addEventListener("click", () => {
    const active = document.querySelector(".nav-item.active");
    loadGroups().then(() => switchView(active ? active.dataset.view : "overview"));
    toast("Đã làm mới.", "info", 1500);
  });

  // Nhóm
  $("btnScanGroups").addEventListener("click", scanGroups);
  $("btnAddGroup").addEventListener("click", addGroupManual);
  if ($("btnTestApiAuto"))
    $("btnTestApiAuto").addEventListener("click", testApiAuto);
  $("groupSearch").addEventListener("input", renderGroups);
  // Cấu hình crawl: tự lưu mỗi khi thay đổi (giữ nguyên sau F5)
  CRAWL_FIELDS.forEach((id) => {
    if ($(id)) $(id).addEventListener("change", saveCrawlSettings);
  });
  if ($("crawlSafe")) $("crawlSafe").addEventListener("change", saveCrawlSettings);
  // Tự động crawl nền theo chu kỳ
  if ($("autoCrawlEnabled"))
    $("autoCrawlEnabled").addEventListener("change", saveAutoCrawl);
  if ($("autoCrawlInterval"))
    $("autoCrawlInterval").addEventListener("change", saveAutoCrawl);
  // Crawl hàng loạt
  $("chkSelectAll").addEventListener("change", toggleSelectAll);
  $("btnCrawlSelected").addEventListener("click", startBatchCrawl);
  $("btnStopBatch").addEventListener("click", stopBatchCrawl);
  $("groupsWrap").addEventListener("click", (e) => {
    const card = e.target.closest(".group-card");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest("[data-sel]")) {
      if (store.selected.has(id)) store.selected.delete(id);
      else store.selected.add(id);
      card.classList.toggle("selected", store.selected.has(id));
      updateSelCount();
      return;
    }
    const act = e.target.closest("[data-act]") && e.target.closest("[data-act]").dataset.act;
    if (act === "crawl") crawlGroup(id);
    else if (act === "open") window.open("https://www.facebook.com/groups/" + id + "/", "_blank");
    else if (act === "del") {
      modal({
        title: "Xóa nhóm",
        bodyHTML: `<p>Xóa nhóm khỏi danh sách theo dõi? (Bài đã crawl vẫn được giữ.)</p>`,
        confirmText: "Xóa",
        danger: true,
        onConfirm: async () => {
          await bg("DELETE_GROUP", { groupId: id });
          await loadGroups();
          renderGroups();
          toast("Đã xóa nhóm.", "ok");
        },
      });
    }
  });

  // Bài viết
  $("postsGroupFilter").addEventListener("change", loadPosts);
  $("postSearch").addEventListener("input", renderPosts);
  if ($("postsLeadToggle"))
    $("postsLeadToggle").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-lead]");
      if (btn) applyLeadMode(btn.dataset.lead);
    });
  if ($("btnSuggestKeywords"))
    $("btnSuggestKeywords").addEventListener("click", suggestKeywordsUI);
  if ($("btnMineOnly"))
    $("btnMineOnly").addEventListener("click", toggleMineOnly);
  $("btnExportJson").addEventListener("click", () => exportPosts("json"));
  $("btnExportCsv").addEventListener("click", () => exportPosts("csv"));
  $("btnClearPosts").addEventListener("click", clearGroupPosts);
  $("postsWrap").addEventListener("click", (e) => {
    const tog = e.target.closest("[data-toggle]");
    if (tog) {
      const card = tog.closest(".post-card");
      const body = card && card.querySelector(".pc-text");
      if (body) {
        const expanded = body.classList.toggle("expanded");
        body.classList.toggle("clamp", !expanded);
        tog.textContent = expanded ? "Xem bớt" : "Xem thêm";
      }
      return;
    }
    const showCmt = e.target.closest("[data-show-comments]");
    if (showCmt) {
      const id = showCmt.dataset.showComments;
      const container = document.getElementById("cmtHist_" + id);
      loadPostComments(id, container);
      return;
    }
    const ana = e.target.closest("[data-analyze]");
    if (ana) {
      analyzePostUI(ana.dataset.analyze, ana);
      return;
    }
    const btn = e.target.closest("[data-cmt]");
    if (btn) createCommentJob(btn.dataset.cmt);
  });

  // Đăng bài (đa nhóm + trang cá nhân, AI xào nấu, ảnh đính kèm)
  if ($("btnPreparePost")) $("btnPreparePost").addEventListener("click", preparePost);
  if ($("btnPostAddImg"))
    $("btnPostAddImg").addEventListener("click", () => $("postImages").click());
  if ($("postImages"))
    $("postImages").addEventListener("change", (e) => {
      addPostImages(e.target.files);
      e.target.value = "";
    });
  if ($("postGroupSearch"))
    $("postGroupSearch").addEventListener("input", (e) => filterPostGroups(e.target.value));
  if ($("btnPostSelectAll"))
    $("btnPostSelectAll").addEventListener("click", () => togglePostSelectAll(true));
  if ($("btnPostSelectNone"))
    $("btnPostSelectNone").addEventListener("click", () => togglePostSelectAll(false));
  if ($("postGroupList"))
    $("postGroupList").addEventListener("change", (e) => {
      if (e.target.closest("input.gcl-check")) updatePostGroupCount();
    });
  $("btnClearPostJobs").addEventListener("click", async () => {
    await bg("CLEAR_FINISHED_JOBS");
    loadJobs("post");
  });
  $("postJobs").addEventListener("click", (e) => onJobAction(e, "post"));

  // Bình luận
  $("btnCreateCmtJob").addEventListener("click", () => createCommentJob());
  if ($("btnCmtAddImg"))
    $("btnCmtAddImg").addEventListener("click", () => $("cmtImages").click());
  if ($("cmtImages"))
    $("cmtImages").addEventListener("change", (e) => {
      addCmtImages(e.target.files);
      e.target.value = "";
    });
  $("btnClearCmtJobs").addEventListener("click", async () => {
    await bg("CLEAR_FINISHED_JOBS");
    loadJobs("comment");
  });
  $("cmtJobs").addEventListener("click", (e) => onJobAction(e, "comment"));

  // AI
  $("btnSaveAI").addEventListener("click", () => saveAIConfig());
  // Tự lưu cấu hình AI khi đổi giá trị (giống các mục khác). Dùng silent để
  // không bắn toast/đồng bộ dropdown làm gián đoạn lúc đang gõ.
  ["aiApiBase", "aiApiKey", "aiModelCustom"].forEach((id) => {
    if ($(id)) $(id).addEventListener("change", () => saveAIConfig({ silent: true }));
  });
  if ($("aiModel"))
    $("aiModel").addEventListener("change", () => saveAIConfig({ silent: true }));
  if ($("btnReloadModels")) $("btnReloadModels").addEventListener("click", () => reloadModels(false));
  $("btnDiscover").addEventListener("click", discoverSelectors);
  $("btnViewSelectors").addEventListener("click", viewSelectors);
  $("btnClearSelectors").addEventListener("click", clearSelectors);

  // Sản phẩm / Giá
  if ($("btnSyncAllSources"))
    $("btnSyncAllSources").addEventListener("click", syncAllSources);
  // Tìm kiếm lọc ngay trên dữ liệu đã nạp (productStore.all), không nạp lại kho.
  if ($("btnSearchProducts"))
    $("btnSearchProducts").addEventListener("click", () => applyProductFilter());
  if ($("productSearch"))
    $("productSearch").addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyProductFilter();
    });
  if ($("btnClearProducts"))
    $("btnClearProducts").addEventListener("click", clearAllProducts);
  if ($("sourceList"))
    $("sourceList").addEventListener("click", onSourceAction);
  if ($("autoSyncEnabled"))
    $("autoSyncEnabled").addEventListener("change", saveAutoSync);
  if ($("autoSyncInterval"))
    $("autoSyncInterval").addEventListener("change", saveAutoSync);
  // Phân trang danh sách sản phẩm: bắt nút Trước/Sau (chỉ đổi trang, không nạp lại kho).
  if ($("productList"))
    $("productList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pg]");
      if (!btn || btn.disabled) return;
      if (btn.dataset.pg === "prev") productStore.page -= 1;
      else if (btn.dataset.pg === "next") productStore.page += 1;
      renderProducts();
      const wrap = $("productList");
      if (wrap) wrap.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  // Chuyển chế độ hiển thị: so sánh cửa hàng / danh sách phẳng.
  if ($("prodModeToggle"))
    $("prodModeToggle").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mode]");
      if (!btn) return;
      productStore.mode = btn.dataset.mode;
      productStore.page = 1; // đổi chế độ -> về trang đầu
      $("prodModeToggle")
        .querySelectorAll("[data-mode]")
        .forEach((b) => b.classList.toggle("active", b === btn));
      renderProducts();
    });

  // Kho của tôi
  if ($("btnLoadSheet")) $("btnLoadSheet").addEventListener("click", loadSheetTabs);
  if ($("sheetUrl"))
    $("sheetUrl").addEventListener("keydown", (e) => {
      if (e.key === "Enter") loadSheetTabs();
    });
  if ($("btnImportSheet")) $("btnImportSheet").addEventListener("click", importSheet);
  if ($("btnClearMystore")) $("btnClearMystore").addEventListener("click", clearMyStore);
  if ($("mystoreSearch"))
    $("mystoreSearch").addEventListener("input", applyMyStoreFilter);
  if ($("mystoreCatFilter"))
    $("mystoreCatFilter").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat]");
      if (!btn) return;
      myStore.cat = btn.dataset.cat;
      $("mystoreCatFilter")
        .querySelectorAll("[data-cat]")
        .forEach((b) => b.classList.toggle("active", b === btn));
      applyMyStoreFilter();
    });
  if ($("mystoreList"))
    $("mystoreList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cmp]");
      if (btn) compareMine(btn.dataset.cmp);
    });

  // Build cấu hình bằng AI
  if ($("buildBudget"))
    $("buildBudget").addEventListener("input", () => syncBuildBudget(false));
  if ($("buildBudgetRange"))
    $("buildBudgetRange").addEventListener("input", () => syncBuildBudget(true));
  if ($("buildNeeds"))
    $("buildNeeds").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-need]");
      if (!btn) return;
      const key = btn.dataset.need;
      if (buildAI.needs.has(key)) buildAI.needs.delete(key);
      else buildAI.needs.add(key);
      btn.classList.toggle("active", buildAI.needs.has(key));
    });
  // Dùng sự kiện "change" của checkbox: chỉ bắn 1 lần với trạng thái cuối cùng,
  // tránh double-toggle khi click trúng label (label tự lật checkbox bên trong).
  if ($("buildCats"))
    $("buildCats").addEventListener("change", (e) => {
      const cb = e.target.closest("input[type=checkbox]");
      if (!cb) return;
      const label = cb.closest("label[data-cat]");
      if (!label) return;
      const cat = label.dataset.cat;
      if (cb.checked) buildAI.selected.add(cat);
      else buildAI.selected.delete(cat);
      label.classList.toggle("on", cb.checked);
    });
  if ($("btnBuildConfig"))
    $("btnBuildConfig").addEventListener("click", runBuildConfig);

  // Tư vấn AI
  if ($("btnGenAdvisories"))
    $("btnGenAdvisories").addEventListener("click", genAdvisories);
  if ($("btnClearAdvisories"))
    $("btnClearAdvisories").addEventListener("click", clearAdvisoriesUI);
  if ($("advStatusTabs"))
    $("advStatusTabs").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-status]");
      if (!btn) return;
      advisoryStore.status = btn.dataset.status;
      syncAdvTabs();
      reloadAdvisories();
    });
  if ($("advisoryList"))
    $("advisoryList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-adv-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.advAct;
      if (act === "approve") approveAdvisoryUI(id);
      else if (act === "edit") editAdvisory(id);
      else if (act === "reject") rejectAdvisoryUI(id);
      else if (act === "del") deleteAdvisoryUI(id);
    });

  // Hội thoại (theo dõi reply + AI soạn nháp)
  if ($("convStatusTabs"))
    $("convStatusTabs").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-status]");
      if (!btn) return;
      conversationStore.status = btn.dataset.status;
      syncConvTabs();
      reloadConversations();
    });

  // Lệnh từ Web (remote commands)
  if ($("rcStatusTabs"))
    $("rcStatusTabs").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-status]");
      if (btn) switchRcTab(btn.dataset.status || "");
    });

  if ($("watchEnabled")) $("watchEnabled").addEventListener("change", saveWatchConfig);
  if ($("watchInterval")) $("watchInterval").addEventListener("change", saveWatchConfig);
  if ($("btnWatchNow")) $("btnWatchNow").addEventListener("click", watchNow);
  if ($("btnTrackConv")) $("btnTrackConv").addEventListener("click", trackConversationUI);
  if ($("conversationList"))
    $("conversationList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cv-act]");
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.cvAct;
      if (act === "draft") draftConvReplyUI(id, btn.dataset.targetReply);
      else if (act === "approve") approveConvReplyUI(id);
      else if (act === "close") toggleConvClose(id);
      else if (act === "del") deleteConvUI(id);
    });

  // Cài đặt — quản lý dữ liệu
  if ($("setExportPostsJson"))
    $("setExportPostsJson").addEventListener("click", () => exportAllPosts("json"));
  if ($("setExportPostsCsv"))
    $("setExportPostsCsv").addEventListener("click", () => exportAllPosts("csv"));
  if ($("setClearPosts"))
    $("setClearPosts").addEventListener("click", clearAllPosts);
  if ($("setClearProducts"))
    $("setClearProducts").addEventListener("click", clearAllPrices);
  if ($("setClearMystore"))
    $("setClearMystore").addEventListener("click", clearMyStoreData);
  if ($("setClearAdvisories"))
    $("setClearAdvisories").addEventListener("click", clearAllAdvisories);

  // Giá Group: trích xuất, lọc, toggle "Chỉ của tôi", icon chia sẻ (read-only).
  if ($("btnExtractPrices"))
    $("btnExtractPrices").addEventListener("click", runExtraction);
  if ($("gpGroupFilter"))
    $("gpGroupFilter").addEventListener("change", applyGroupPriceFilter);
  if ($("gpCatFilter"))
    $("gpCatFilter").addEventListener("input", applyGroupPriceFilter);
  if ($("gpCondFilter"))
    $("gpCondFilter").addEventListener("change", applyGroupPriceFilter);
  if ($("gpPriceMin"))
    $("gpPriceMin").addEventListener("input", applyGroupPriceFilter);
  if ($("gpPriceMax"))
    $("gpPriceMax").addEventListener("input", applyGroupPriceFilter);
  if ($("gpMineToggle"))
    $("gpMineToggle").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-mine]");
      if (!btn) return;
      setGroupPriceMine(btn.dataset.mine === "1");
    });
  if ($("groupPriceList"))
    $("groupPriceList").addEventListener("click", (e) => {
      // Icon 🌐/🔒 chỉ hiển thị trạng thái — bấm thì nhắc chỗ chỉnh chia sẻ.
      if (e.target.closest("[data-share-info]")) explainShareIcon();
    });

  // Từ khóa học: thêm thủ công + bật/tắt + xóa (event delegation trên bảng).
  if ($("btnAddKeyword"))
    $("btnAddKeyword").addEventListener("click", addKeywordUI);
  if ($("kwNewWord"))
    $("kwNewWord").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addKeywordUI();
    });
  if ($("keywordList")) {
    $("keywordList").addEventListener("change", (e) => {
      const tog = e.target.closest("[data-kw-toggle]");
      if (!tog) return;
      const tr = tog.closest("tr[data-id]");
      if (tr) toggleKeyword(tr.dataset.id, tog.checked);
    });
    $("keywordList").addEventListener("click", (e) => {
      const del = e.target.closest("[data-kw-del]");
      if (!del) return;
      const tr = del.closest("tr[data-id]");
      if (tr) deleteKeyword(tr.dataset.id);
    });
  }
  // Chuyển tab nhóm từ khóa (Bán / Cần mua / Cần hỗ trợ).
  if ($("kwTypeTabs"))
    $("kwTypeTabs").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-kwtype]");
      if (btn) switchKeywordType(btn.dataset.kwtype);
    });

  // Cài đặt chia sẻ: mỗi công tắc lưu riêng khi đổi.
  ["shareCrawled", "shareCommented", "shareGroupPrices"].forEach((id) => {
    if ($(id)) $(id).addEventListener("change", () => saveSharePref(id));
  });

  // Hồ sơ ngành: 1 delegation cho cả section (nút dùng data-act).
  const profilesView = document.querySelector('.view[data-view="profiles"]');
  if (profilesView) profilesView.addEventListener("click", onProfileAction);
}

async function onJobAction(e, type) {
  const actEl = e.target.closest("[data-act]");
  const act = actEl && actEl.dataset.act;
  // "Duyệt tất cả" nằm ở thanh phía trên, KHÔNG thuộc job-card nào.
  if (act === "approve-all") {
    toast("Đang duyệt các việc...", "info", 3000);
    const res = await bg("APPROVE_ALL_JOBS", { jobType: type });
    const n = (res && res.approved) || 0;
    toast(
      n ? `Đã duyệt ${n} việc. Sẽ đăng theo lịch.` : "Không có việc nào để duyệt.",
      n ? "ok" : "info"
    );
    loadJobs(type);
    return;
  }
  // "Xóa tất cả" — xoá toàn bộ việc trong hàng đợi.
  if (act === "clear-all") {
    const count = (store.jobs || []).length;
    if (!count) { toast("Hàng đợi trống.", "info"); return; }
    modal({
      title: "Xóa tất cả việc trong hàng đợi",
      bodyHTML: `<p>Bạn muốn xóa <b>${count} việc</b> khỏi hàng đợi?</p><p style="color:var(--red)">Thao tác này không thể hoàn tác.</p>`,
      confirmText: "Xóa tất cả",
      danger: true,
      onConfirm: async () => {
        toast("Đang xóa tất cả việc...", "info", 3000);
        const res = await bg("CLEAR_ALL_JOBS");
        const n = (res && res.deleted) || 0;
        toast(n ? `Đã xóa ${n} việc.` : "Không có việc nào để xóa.", n ? "ok" : "info");
        loadJobs(type);
      },
    });
    return;
  }
  const card = e.target.closest(".job-card");
  if (!card) return;
  const id = Number(card.dataset.id);
  if (act === "del") {
    const job = (store.jobs || []).find((j) => j.id === id);
    const postUrl = job && job.result && job.result.postUrl;
    // Với việc ĐĂNG BÀI: luôn hiện hộp xác nhận để người dùng chủ động chọn,
    // không bao giờ xoá im lặng. Nếu đã bắt được link bài thì cho phép xoá
    // luôn trên Facebook; nếu chưa có link thì nói rõ lý do.
    if (type === "post") {
      if (postUrl) {
        modal({
          title: "Xóa việc đăng bài",
          bodyHTML:
            `<p>Bạn muốn xóa việc này khỏi ứng dụng, hay xóa luôn cả bài viết trên Facebook?</p>` +
            `<p style="color:var(--red)">Xóa trên Facebook là thao tác không thể hoàn tác.</p>`,
          confirmText: "Xóa cả bài trên Facebook",
          danger: true,
          onConfirm: async () => {
            toast("Đang xóa bài trên Facebook...", "info", 4000);
            const res = await bg("DELETE_JOB", { id, deleteRemote: true, postUrl });
            if (res && res.remote && !res.remote.ok) {
              toast("Đã xóa khỏi app, nhưng xóa trên FB lỗi: " + (res.remote.error || ""), "err", 6000);
            } else {
              toast("Đã xóa việc và bài trên Facebook.", "ok");
            }
            loadJobs(type);
          },
          extraText: "Chỉ xóa trong app",
          onExtra: async () => {
            await bg("DELETE_JOB", { id });
            toast("Đã xóa việc khỏi app (bài trên FB vẫn còn).", "ok");
            loadJobs(type);
          },
        });
      } else {
        // Chưa có link bài (job cũ đăng trước khi có tính năng bắt link, hoặc
        // lúc đăng không bắt được permalink). Không thể tự mở đúng bài để xoá.
        modal({
          title: "Xóa việc đăng bài",
          bodyHTML:
            `<p>Việc này chưa lưu được link bài trên Facebook nên app không thể tự xóa bài thật.</p>` +
            `<p>Hãy xóa thủ công trên Facebook. Bài đăng mới từ giờ sẽ tự lưu link để xóa được trực tiếp.</p>`,
          confirmText: "Xóa việc khỏi app",
          danger: true,
          onConfirm: async () => {
            await bg("DELETE_JOB", { id });
            toast("Đã xóa việc khỏi app.", "ok");
            loadJobs(type);
          },
        });
      }
      return;
    }
    await bg("DELETE_JOB", { id });
    loadJobs(type);
  } else if (act === "approve") {
    // Duyệt 1 việc: chuyển paused -> pending để guồng lịch tự đăng theo giờ.
    const res = await bg("APPROVE_JOB", { id });
    if (res && res.ok) toast("Đã duyệt việc. Sẽ đăng theo lịch.", "ok");
    else toast((res && res.error) || "Không duyệt được việc.", "err", 5000);
    loadJobs(type);
  } else if (act === "run") {
    toast("Đang chạy việc...", "info", 3000);
    const res = await bg("RUN_JOB_NOW", { id });
    if (res && res.ok) toast("Việc đã chạy xong.", "ok");
    else toast((res && res.error) || "Việc thất bại.", "err", 5000);
    loadJobs(type);
  }
}

/* =========================== REALTIME LISTENER ========================= */
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "CRAWL_PROGRESS" && msg.progress) {
    const p = msg.progress;
    const name = p.groupName || p.groupId || "";
    if (p.status === "started") {
      setCrawlStatus(`Bắt đầu crawl "${name}"...`, true);
    } else if (p.status === "crawling") {
      const last = p.lastAuthor ? ` · mới nhất: ${p.lastAuthor}` : "";
      setCrawlStatus(
        `Đang crawl "${name}": +${p.newCount || 0} bài mới · đã cuộn ${p.scrolls || 0} lần${last}`,
        true
      );
    } else if (p.status === "stopped_known") {
      setCrawlStatus(`"${name}": đã gặp đủ bài cũ liên tiếp, đang kết thúc...`, true);
    }
  }
  if (msg.type === "CRAWL_DONE" && msg.result) {
    // Đang crawl hàng loạt (pool song song): nhả slot rồi lấp nhóm kế tiếp
    if (store.batch) {
      updateBatchStatus(`vừa xong +${msg.result.newCount} bài mới`);
      onWorkerDone();
      return;
    }
    setCrawlStatus(`Xong: +${msg.result.newCount} bài mới. ${msg.result.reason || ""}`, false);
    toast(`Crawl xong: +${msg.result.newCount} bài. ${msg.result.reason || ""}`, "ok", 4500);
    // Nếu testApiAuto() đang chờ, tự chuyển sang view "posts" và lọc theo
    // groupId đã đánh dấu để người dùng thấy ngay các bài vừa lấy được.
    const pendingGroupId = store.pendingPostsView;
    if (pendingGroupId) {
      store.pendingPostsView = null;
      // QUAN TRỌNG: nạp lại nhóm TRƯỚC, vì loadGroups()->fillGroupSelects()
      // dựng lại innerHTML của #postsGroupFilter (xoá mọi option + value đã set).
      // Sau khi select đã được dựng lại mới gán value, rồi mới switchView để
      // loadPosts() đọc đúng groupId vừa crawl (nếu set trước sẽ bị xoá mất).
      loadGroups().then(() => {
        const sel = $("postsGroupFilter");
        if (sel) {
          // Đảm bảo option cho groupId này tồn tại (kể cả khi chưa có trong store.groups).
          let opt = Array.from(sel.options).find((o) => o.value === pendingGroupId);
          if (!opt) {
            opt = document.createElement("option");
            opt.value = pendingGroupId;
            opt.textContent = pendingGroupId + " (test)";
            sel.appendChild(opt);
          }
          sel.value = pendingGroupId;
        }
        switchView("posts");
        toast(`Đã mở view Bài viết, lọc theo nhóm test ${pendingGroupId}.`, "info", 3500);
      });
      return;
    }
    loadGroups().then(() => {
      const active = document.querySelector(".nav-item.active");
      if (active && ["posts", "overview", "groups"].includes(active.dataset.view)) {
        switchView(active.dataset.view);
      }
    });
  }
  if (msg.type === "SYNC_PROGRESS") {
    const handle = syncToasts[msg.id];
    if (handle) {
      const totalTxt = msg.total != null ? `/${msg.total}` : "";
      handle.update(
        `Đang đồng bộ "${msg.name || msg.id}": trang ${msg.page} · đã lấy ${msg.fetched}${totalTxt} SP...`,
        "info"
      );
    }
  }
  if (msg.type === "BUILD_PROGRESS") {
    // Cập nhật dòng chữ tiến trình trong khung loading (nếu đang build).
    if (buildAI.running) {
      const el = $("buildProgressText");
      if (el && msg.text) el.textContent = msg.text;
    }
  }
  if (msg.type === "JOB_UPDATE") {
    const active = document.querySelector(".nav-item.active");
    if (active && active.dataset.view === "autopost") loadJobs("post");
    if (active && active.dataset.view === "autocomment") loadJobs("comment");
    if (active && active.dataset.view === "overview") renderOverview();
  }
  if (msg.type === "CONVERSATION_UPDATE") {
    const active = document.querySelector(".nav-item.active");
    if (active && active.dataset.view === "conversations") reloadConversations();
  }
  // Service worker báo 401 (hết phiên / chưa đăng nhập): nạp lại view web hiện
  // hành để hiện trạng thái "Cần đăng nhập" thay vì dữ liệu trống gây hiểu nhầm.
  if (msg.type === "AUTH_REQUIRED") {
    const active = document.querySelector(".nav-item.active");
    const view = active && active.dataset.view;
    if (view === "groupprices") reloadGroupPrices();
    else if (view === "keywords") reloadKeywords();
    else if (view === "sharing") loadSharingView();
    else if (view === "profiles") loadProfilesView();
  }
});

/* =============================== KHỞI ĐỘNG ============================= */
(async function init() {
  bindEvents();
  await loadUIPrefs();
  await loadLeadKeywords();
  await loadCrawlSettings();
  await loadAutoCrawl();
  await loadGroups();
  switchView("overview");
})();
