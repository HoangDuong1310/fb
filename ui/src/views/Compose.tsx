import { useEffect, useMemo, useRef, useState } from "react";
import {
  Users,
  UserCircle2,
  Sparkles,
  ImagePlus,
  X,
  Search,
  CheckSquare,
  Square,
  Loader2,
  Send,
  AlertCircle,
  Package,
  CalendarClock,
  ChevronDown,
  Eye,
  PenLine,
  Wand2,
  Signature,
  Save,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { cn } from "@/lib/utils";
import { useIncremental } from "@/lib/useIncremental";
import { compressAndUploadImages } from "@/lib/upload";
import {
  SIGNATURE_SETTING_KEY,
  DEFAULT_SIGNATURE,
  normalizeSignature,
  isSignatureActive,
  appendSignature,
  type SignatureConfig,
} from "@/lib/signature";

/* -------------------------------------------------------------------------
   Compose — Đăng bài lên nhiều nhóm (và/hoặc trang cá nhân).

   Luồng: chọn mục tiêu → soạn nội dung (tự viết hoặc để AI viết từ "yêu cầu",
   có thể lấy sản phẩm từ kho) → đính kèm ảnh + lên lịch giãn cách → xem trước
   từng biến thể (AI xào nấu để tránh trùng nội dung) → tạo MỘT việc cho mỗi mục
   tiêu ở trạng thái "Chờ duyệt". Không có gì tự đăng: mọi việc chờ bạn duyệt ở
   tab Hàng đợi (Công cụ). AI chỉ là lớp hỗ trợ tùy chọn.
   ------------------------------------------------------------------------- */

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;

interface Group {
  groupId: string;
  groupName?: string;
}

interface Product {
  name?: string;
  price?: number | string;
  category?: string;
  brand?: string;
  warranty?: string;
  store?: string;
  inStock?: boolean;
  owned?: boolean;
  source?: string;
}

interface GroupsResponse extends BgResponse {
  groups?: Group[];
}
interface ProductsResponse extends BgResponse {
  products?: Product[];
}
interface AiVariantsResponse extends BgResponse {
  variants?: string[];
  source?: string;
  note?: string;
}
interface CreateJobsResponse extends BgResponse {
  jobs?: unknown[];
}
interface SettingResponse extends BgResponse {
  value?: unknown;
}

interface Target {
  type: "profile" | "group";
  groupId: string | null;
  name: string;
}

interface PreviewItem {
  target: Target;
  text: string;
  isOrig: boolean;
}

const TONES: { id: string; label: string }[] = [
  { id: "than-thien", label: "Thân thiện" },
  { id: "chuyen-nghiep", label: "Chuyên nghiệp" },
  { id: "nang-dong", label: "Năng động" },
  { id: "khan-truong", label: "Chốt đơn" },
];

const SPACING_PRESETS = [0, 5, 10, 15, 30, 60];

function fmtPrice(v?: number | string): string {
  if (v == null || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return "";
  return n.toLocaleString("vi-VN") + "₫";
}

// Nén ảnh rồi TẢI LÊN storage, trả về URL "/uploads/..." (xem ui/src/lib/upload.ts).
// Không còn nhúng base64 vào job.images -> cột jobs.data không phình.
function readFiles(fileList: FileList): Promise<string[]> {
  return compressAndUploadImages(fileList);
}

export function Compose() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Mục tiêu
  const [toProfile, setToProfile] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [groupQuery, setGroupQuery] = useState("");

  // Nội dung
  const [mode, setMode] = useState<"write" | "generate">("write");
  const [content, setContent] = useState("");
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("than-thien");
  const [spin, setSpin] = useState(true);

  // Kho sản phẩm để dựng brief chào hàng
  const [products, setProducts] = useState<Product[]>([]);
  const [pickedProduct, setPickedProduct] = useState<string>("");
  const [productQuery, setProductQuery] = useState("");
  const [productOpen, setProductOpen] = useState(false);
  const [productHi, setProductHi] = useState(0);

  // Ảnh + lịch
  const [images, setImages] = useState<string[]>([]);
  const [imgBusy, setImgBusy] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [spacing, setSpacing] = useState(0);

  // Chữ ký cuối bài — lưu ở settings theo user, dán SAU khi AI viết/xào nấu.
  const [sig, setSig] = useState<SignatureConfig>(DEFAULT_SIGNATURE);
  const [sigSaving, setSigSaving] = useState(false);
  const [sigDirty, setSigDirty] = useState(false);

  // Trạng thái AI / tạo việc
  const [aiBusy, setAiBusy] = useState(false);
  const [creating, setCreating] = useState(false);

  // Xem trước
  const [preview, setPreview] = useState<PreviewItem[] | null>(null);
  const [previewNote, setPreviewNote] = useState<{ kind: "warn" | "err"; text: string } | null>(
    null,
  );

  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const productBoxRef = useRef<HTMLDivElement | null>(null);
  const productSearchRef = useRef<HTMLInputElement | null>(null);
  const productListRef = useRef<HTMLUListElement | null>(null);

  function flash(kind: NonNullable<Toast>["kind"], text: string, ms = 3600) {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
  }, []);

  async function load() {
    setLoading(true);
    setLoadError(null);
    const res = await bg<GroupsResponse>("GET_GROUPS");
    if (!res || !res.ok) {
      setLoadError(res?.error || "Không tải được danh sách nhóm.");
      setGroups([]);
    } else {
      setGroups(Array.isArray(res.groups) ? res.groups.filter((g) => g && g.groupId) : []);
    }
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  // Nạp chữ ký đã lưu. GET_SETTING không bao giờ throw (getSetting tự fallback
  // về default) nên lỗi mạng chỉ khiến chữ ký rỗng, không chặn composer.
  useEffect(() => {
    void (async () => {
      const res = await bg<SettingResponse>("GET_SETTING", {
        key: SIGNATURE_SETTING_KEY,
      });
      if (res && res.ok) setSig(normalizeSignature(res.value));
    })();
  }, []);

  async function saveSignature() {
    setSigSaving(true);
    const next = normalizeSignature(sig);
    const res = await bg<SettingResponse>("SET_SETTING", {
      key: SIGNATURE_SETTING_KEY,
      value: next,
    });
    setSigSaving(false);
    if (!res || !res.ok) {
      flash("err", res?.error || "Không lưu được chữ ký.");
      return;
    }
    setSig(next);
    setSigDirty(false);
    flash("ok", "Đã lưu chữ ký. Mọi bài tạo sau sẽ tự có chữ ký ở cuối.");
  }

  function patchSig(patch: Partial<SignatureConfig>) {
    setSig((s) => ({ ...s, ...patch }));
    setSigDirty(true);
  }

  // Nạp kho sản phẩm khi lần đầu chuyển sang chế độ AI viết.
  useEffect(() => {
    if (mode !== "generate" || products.length) return;
    void (async () => {
      const res = await bg<ProductsResponse>("GET_PRODUCTS");
      const all = (res && res.products) || [];
      setProducts(all.filter((p) => p.owned || p.source === "mystore"));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const filteredGroups = useMemo(() => {
    const q = groupQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => (g.groupName || g.groupId).toLowerCase().includes(q));
  }, [groups, groupQuery]);

  const {
    visible: windowedGroups,
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  } = useIncremental(filteredGroups, { pageSize: 40 });

  const selectedGroups = useMemo(
    () => groups.filter((g) => selected[g.groupId]),
    [groups, selected],
  );
  const targetCount = selectedGroups.length + (toProfile ? 1 : 0);

  function toggleGroup(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }

  function selectAllVisible(on: boolean) {
    setSelected((s) => {
      const next = { ...s };
      for (const g of filteredGroups) next[g.groupId] = on;
      return next;
    });
  }

  const allVisibleSelected =
    filteredGroups.length > 0 && filteredGroups.every((g) => selected[g.groupId]);

  // Danh sách sản phẩm sau khi lọc — giữ nguyên index gốc để fillBriefFromProduct vẫn đúng.
  const filteredProducts = useMemo(() => {
    const indexed = products.map((p, idx) => ({ p, idx }));
    const q = productQuery.trim().toLowerCase();
    if (!q) return indexed;
    const terms = q.split(/\s+/).filter(Boolean);
    return indexed.filter(({ p }) => {
      const hay = [p.name, p.category, p.brand, p.store, p.warranty, String(p.price ?? "")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [products, productQuery]);

  const pickedProductLabel = useMemo(() => {
    if (pickedProduct === "") return "";
    const p = products[Number(pickedProduct)];
    if (!p) return "";
    const price = fmtPrice(p.price);
    return (p.name || "SP") + (price ? " · " + price : "");
  }, [products, pickedProduct]);

  // Đóng dropdown khi bấm ra ngoài.
  useEffect(() => {
    if (!productOpen) return;
    function onDocDown(e: MouseEvent) {
      if (!productBoxRef.current?.contains(e.target as Node)) setProductOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, [productOpen]);

  // Tự focus ô tìm kiếm và cuộn tới dòng đang trỏ.
  useEffect(() => {
    if (productOpen) productSearchRef.current?.focus();
  }, [productOpen]);

  useEffect(() => {
    if (!productOpen) return;
    const el = productListRef.current?.querySelector<HTMLElement>('[data-hi="1"]');
    el?.scrollIntoView({ block: "nearest" });
  }, [productHi, productOpen]);

  function openProductPicker() {
    setProductOpen(true);
    setProductHi(0);
  }

  function pickProduct(idx: number) {
    fillBriefFromProduct(String(idx));
    setProductOpen(false);
    setProductQuery("");
  }

  function clearProduct() {
    setPickedProduct("");
    setProductQuery("");
    setProductOpen(false);
  }

  function onProductKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setProductHi((h) => Math.min(h + 1, Math.max(0, filteredProducts.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setProductHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = filteredProducts[productHi];
      if (hit) pickProduct(hit.idx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setProductOpen(false);
    }
  }

  function fillBriefFromProduct(idx: string) {
    setPickedProduct(idx);
    const p = products[Number(idx)];
    if (!p) return;
    const lines = ["Viết bài chào hàng cho sản phẩm sau:"];
    lines.push("- Tên: " + (p.name || ""));
    const price = fmtPrice(p.price);
    if (price) lines.push("- Giá: " + price);
    if (p.category) lines.push("- Loại: " + p.category);
    if (p.brand) lines.push("- Hãng: " + p.brand);
    if (p.warranty) lines.push("- Bảo hành: " + p.warranty);
    if (p.store) lines.push("- Cửa hàng: " + p.store);
    lines.push(
      p.inStock === false
        ? "- Tình trạng: tạm hết hàng (nhận đặt trước)"
        : "- Tình trạng: còn hàng",
    );
    setBrief(lines.join("\n"));
    flash("ok", "Đã điền yêu cầu từ kho. Bổ sung ưu đãi/liên hệ rồi bấm “AI viết bài”.");
  }

  async function generate() {
    const b = brief.trim();
    if (!b) {
      flash("err", "Hãy nhập yêu cầu để AI viết nội dung.");
      return;
    }
    const count = Math.max(1, targetCount);
    setAiBusy(true);
    const res = await bg<AiVariantsResponse>("AI_GENERATE_CONTENT", {
      payload: { brief: b, tone, count },
    });
    setAiBusy(false);
    if (!res || !res.ok || !Array.isArray(res.variants) || !res.variants.length) {
      flash("err", res?.error || "AI chưa viết được nội dung.");
      return;
    }
    setContent(res.variants[0]);
    flash(
      "ok",
      res.variants.length > 1
        ? `AI đã viết ${res.variants.length} biến thể — bản đầu đã điền vào ô nội dung.`
        : "AI đã viết xong nội dung. Kiểm tra rồi tạo hàng đợi.",
    );
  }

  async function buildPreview() {
    const text = content.trim();
    if (!text) {
      flash("err", "Hãy nhập nội dung bài.");
      return;
    }
    const targets: Target[] = [];
    if (toProfile)
      targets.push({ type: "profile", groupId: null, name: "Trang cá nhân của tôi" });
    for (const g of selectedGroups)
      targets.push({ type: "group", groupId: g.groupId, name: g.groupName || g.groupId });

    if (!targets.length) {
      flash("err", "Hãy chọn ít nhất một nhóm hoặc bật đăng lên trang cá nhân.");
      return;
    }

    let variants: string[];
    let note: { kind: "warn" | "err"; text: string } | null = null;

    if (spin && targets.length > 1) {
      setAiBusy(true);
      // tone phải đi kèm: trước đây spin không nhận tone nên bài xào ra lệch giọng
      // so với bài AI tự viết ở cùng màn hình này.
      const res = await bg<AiVariantsResponse>("AI_SPIN_CONTENT", {
        payload: { content: text, count: targets.length, tone },
      });
      setAiBusy(false);
      if (res && res.ok && Array.isArray(res.variants) && res.variants.length) {
        variants = res.variants;
        // "fallback"/"partial-ai" = có bài vẫn là bản gốc y hệt nhau → đăng lên là
        // trùng nội dung. Đây là LỖI cần sửa tay, không phải cảnh báo nhẹ.
        if (res.source === "fallback" || res.source === "partial-ai") {
          note = {
            kind: "err",
            text:
              (res.note ||
                "Một phần nội dung chưa xào nấu được bằng AI và đang dùng nguyên văn bản gốc.") +
              " Sửa tay các bài trùng hoặc bấm Xem trước lại trước khi tạo hàng đợi.",
          };
        }
      } else {
        variants = targets.map(() => text);
        note = {
          kind: "err",
          text:
            (res?.error || "AI lỗi nên chưa xào được nội dung.") +
            " Mọi mục tiêu đang dùng chung bài gốc — đăng nguyên trạng sẽ bị Facebook gắn cờ trùng nội dung.",
        };
      }
    } else {
      variants = targets.map(() => text);
    }

    // Chữ ký dán SAU CÙNG, sau khi AI đã xào nấu: số điện thoại/link trong chữ ký
    // phải nguyên văn ở mọi mục tiêu. isOrig vẫn so trên THÂN BÀI (trước khi dán
    // chữ ký) để nhãn "Nguyên gốc / AI xào nấu" không bị chữ ký làm lệch.
    setPreview(
      targets.map((t, i) => {
        const v = variants[i] ?? text;
        return {
          target: t,
          text: appendSignature(v, sig),
          isOrig: v.trim() === text.trim(),
        };
      }),
    );
    setPreviewNote(note);
  }

  function editPreviewItem(idx: number, text: string) {
    setPreview((prev) => {
      if (!prev) return prev;
      const next = prev.slice();
      next[idx] = { ...next[idx], text };
      return next;
    });
  }

  async function createJobs() {
    if (!preview || !preview.length) return;
    const baseTime = scheduleAt ? new Date(scheduleAt).getTime() : Date.now();
    const batchId = "batch_" + Date.now();
    const jobs = preview
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => item.text.trim())
      .map(({ item, i }) => ({
        type: "post",
        status: "paused",
        targetType: item.target.type,
        groupId: item.target.groupId,
        content: item.text.trim(),
        images,
        batchId,
        batchName: item.target.name,
        scheduledAt: baseTime + i * spacing * 60000,
      }));

    if (!jobs.length) {
      flash("err", "Không có nội dung hợp lệ để tạo việc.");
      return;
    }

    setCreating(true);
    const res = await bg<CreateJobsResponse>("CREATE_JOBS", { jobs });
    setCreating(false);

    if (!res || !res.ok) {
      flash(
        "err",
        res?.error ||
          "Không lưu được hàng đợi (có thể do quá nhiều ảnh vượt dung lượng). Hãy bớt ảnh hoặc bớt nhóm rồi thử lại.",
      );
      return;
    }
    const created = Array.isArray(res.jobs) ? res.jobs.length : jobs.length;
    flash(
      "ok",
      `Đã tạo ${created} việc (đang CHỜ DUYỆT). Sang tab Công cụ → Hàng đợi để duyệt và đăng.`,
    );
    // Reset composer
    setPreview(null);
    setPreviewNote(null);
    setContent("");
    setBrief("");
    setPickedProduct("");
    setImages([]);
    setScheduleAt("");
    setSelected({});
    setToProfile(false);
  }

  async function onPickImages(list: FileList | null) {
    if (!list || !list.length || imgBusy) return;
    setImgBusy(true);
    try {
      const arr = await readFiles(list);
      setImages((imgs) => [...imgs, ...arr]);
    } catch (e) {
      flash(
        "err",
        e instanceof Error ? e.message : "Không tải được ảnh lên. Thử lại.",
      );
    } finally {
      setImgBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function removeImage(i: number) {
    setImages((imgs) => imgs.filter((_, idx) => idx !== i));
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "sticky top-2 z-sticky flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm font-medium shadow-sm",
            toast.kind === "ok" && "border-green-soft bg-green-soft/30 text-green",
            toast.kind === "err" && "border-red-soft bg-red-soft/30 text-red",
            toast.kind === "info" && "border-blue-soft bg-blue-soft/20 text-blue",
          )}
        >
          {toast.text}
        </div>
      )}

      {/* Cảnh báo an toàn */}
      <div className="flex items-start gap-2 rounded-md border border-amber-soft bg-amber-soft/20 px-4 py-2.5">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber" />
        <p className="text-xs leading-snug text-ink-soft">
          Mỗi mục tiêu sẽ tạo một việc ở trạng thái <strong>Chờ duyệt</strong>. Không gì tự đăng —
          bạn duyệt ở <strong>Công cụ → Hàng đợi</strong> trước khi bài lên Facebook.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* ---- Cột chọn mục tiêu ---- */}
        <section className="flex min-h-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Users className="size-4 text-accent" />
              Chọn mục tiêu
            </h2>
            <span className="rounded-full bg-accent-soft/40 px-2 py-0.5 text-xs font-semibold text-accent-ink">
              {targetCount}
            </span>
          </div>

          {/* Trang cá nhân */}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm text-ink-soft transition-colors hover:border-accent/40">
            <input
              type="checkbox"
              checked={toProfile}
              onChange={(e) => setToProfile(e.target.checked)}
              className="size-4 accent-accent"
            />
            <UserCircle2 className="size-4 text-ink-faint" />
            <span className="font-medium">Trang cá nhân của tôi</span>
          </label>

          {/* Tìm nhóm */}
          <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5">
            <Search className="size-4 shrink-0 text-ink-faint" />
            <input
              value={groupQuery}
              onChange={(e) => setGroupQuery(e.target.value)}
              placeholder="Tìm nhóm…"
              className="w-full bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-faint"
            />
          </div>

          <button
            type="button"
            onClick={() => selectAllVisible(!allVisibleSelected)}
            disabled={filteredGroups.length === 0}
            className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-accent hover:underline disabled:opacity-50"
          >
            {allVisibleSelected ? (
              <Square className="size-3.5" />
            ) : (
              <CheckSquare className="size-3.5" />
            )}
            {allVisibleSelected ? "Bỏ chọn tất cả" : "Chọn tất cả"}
            {groupQuery ? " (đang lọc)" : ""}
          </button>

          {/* Danh sách nhóm */}
          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-line-soft">
            {loading ? (
              <div className="grid place-items-center py-10 text-ink-faint">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : loadError ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-red">
                <AlertCircle className="size-4 shrink-0" />
                {loadError}
              </div>
            ) : filteredGroups.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-ink-faint">
                {groups.length === 0
                  ? "Chưa có nhóm nào. Quét nhóm ở Công cụ → Thu thập trước."
                  : "Không có nhóm khớp tìm kiếm."}
              </p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {windowedGroups.map((g) => (
                  <li key={g.groupId}>
                    <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm transition-colors hover:bg-surface-2">
                      <input
                        type="checkbox"
                        checked={!!selected[g.groupId]}
                        onChange={() => toggleGroup(g.groupId)}
                        className="size-4 shrink-0 accent-accent"
                      />
                      <span className="truncate text-ink-soft">
                        {g.groupName || g.groupId}
                      </span>
                    </label>
                  </li>
                ))}
                {hasMore && (
                  <li>
                    <div ref={sentinelRef} className="px-3 py-2">
                      <button
                        onClick={loadMore}
                        className="w-full rounded-sm border border-line bg-surface-2 py-1.5 text-xs font-medium text-ink-faint hover:text-ink"
                      >
                        Xem thêm ({shown}/{total})
                      </button>
                    </div>
                  </li>
                )}
              </ul>
            )}
          </div>
        </section>

        {/* ---- Cột soạn nội dung ---- */}
        <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          {/* Chọn chế độ soạn */}
          <div className="inline-flex self-start rounded-md border border-line bg-surface-2 p-0.5">
            {(
              [
                { id: "write", label: "Tự viết", icon: PenLine },
                { id: "generate", label: "AI viết", icon: Sparkles },
              ] as const
            ).map((m) => {
              const active = mode === m.id;
              const Icon = m.icon;
              return (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                    active ? "bg-accent text-on-accent" : "text-ink-faint hover:text-ink",
                  )}
                >
                  <Icon className="size-3.5" />
                  {m.label}
                </button>
              );
            })}
          </div>

          {/* Chế độ AI viết: brief + kho + tone */}
          {mode === "generate" && (
            <div className="flex flex-col gap-2.5 rounded-md border border-line-soft bg-surface-2/50 p-3">
              <div className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                <span className="flex items-center gap-1.5">
                  <Package className="size-3.5 text-accent" />
                  Lấy sản phẩm từ kho (tùy chọn)
                </span>

                <div className="relative" ref={productBoxRef}>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => (productOpen ? setProductOpen(false) : openProductPicker())}
                      aria-haspopup="listbox"
                      aria-expanded={productOpen}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-sm border bg-surface px-2.5 py-2 text-left text-sm outline-none transition-colors",
                        productOpen ? "border-accent" : "border-line hover:border-accent/50",
                        pickedProductLabel ? "text-ink" : "text-ink-faint",
                      )}
                    >
                      <span className="truncate">
                        {pickedProductLabel || "— Chọn sản phẩm để tạo yêu cầu —"}
                      </span>
                      <ChevronDown
                        className={cn(
                          "size-4 shrink-0 text-ink-faint transition-transform",
                          productOpen && "rotate-180",
                        )}
                      />
                    </button>
                    {pickedProductLabel && (
                      <button
                        type="button"
                        onClick={clearProduct}
                        title="Bỏ chọn sản phẩm"
                        aria-label="Bỏ chọn sản phẩm"
                        className="grid size-8 shrink-0 place-items-center rounded-sm border border-line bg-surface text-ink-faint hover:text-ink"
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>

                  {productOpen && (
                    <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-line bg-surface shadow-lg">
                      <div className="flex items-center gap-2 border-b border-line-soft px-2.5">
                        <Search className="size-4 shrink-0 text-ink-faint" />
                        <input
                          ref={productSearchRef}
                          value={productQuery}
                          onChange={(e) => {
                            setProductQuery(e.target.value);
                            setProductHi(0);
                          }}
                          onKeyDown={onProductKeyDown}
                          placeholder="Tìm theo tên, hãng, loại, cửa hàng…"
                          className="w-full bg-transparent py-2 text-sm font-normal text-ink outline-none placeholder:text-ink-faint"
                        />
                        {productQuery && (
                          <button
                            type="button"
                            onClick={() => {
                              setProductQuery("");
                              setProductHi(0);
                              productSearchRef.current?.focus();
                            }}
                            title="Xoá từ khoá"
                            aria-label="Xoá từ khoá"
                            className="shrink-0 text-ink-faint hover:text-ink"
                          >
                            <X className="size-3.5" />
                          </button>
                        )}
                      </div>

                      {filteredProducts.length === 0 ? (
                        <p className="px-3 py-5 text-center text-xs font-normal text-ink-faint">
                          {products.length === 0
                            ? "Kho chưa có sản phẩm của bạn. Thêm ở Bảng giá → Kho của tôi."
                            : "Không có sản phẩm khớp từ khoá."}
                        </p>
                      ) : (
                        <ul
                          ref={productListRef}
                          role="listbox"
                          className="max-h-56 overflow-y-auto divide-y divide-line-soft"
                        >
                          {filteredProducts.map(({ p, idx }, i) => {
                            const price = fmtPrice(p.price);
                            const meta = [p.brand, p.category, p.store].filter(Boolean).join(" · ");
                            return (
                              <li key={idx}>
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={String(idx) === pickedProduct}
                                  data-hi={i === productHi ? "1" : undefined}
                                  onMouseEnter={() => setProductHi(i)}
                                  onClick={() => pickProduct(idx)}
                                  className={cn(
                                    "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition-colors",
                                    i === productHi ? "bg-surface-2" : "hover:bg-surface-2",
                                  )}
                                >
                                  <span className="flex w-full items-center justify-between gap-2">
                                    <span className="truncate text-sm font-medium text-ink">
                                      {p.name || "SP"}
                                    </span>
                                    {price && (
                                      <span className="shrink-0 text-xs font-semibold text-accent-ink">
                                        {price}
                                      </span>
                                    )}
                                  </span>
                                  {(meta || p.inStock === false) && (
                                    <span className="truncate text-xs font-normal text-ink-faint">
                                      {meta}
                                      {p.inStock === false ? (meta ? " · " : "") + "tạm hết" : ""}
                                    </span>
                                  )}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      {products.length > 0 && (
                        <div className="border-t border-line-soft px-3 py-1.5 text-xs font-normal text-ink-faint">
                          {filteredProducts.length}/{products.length} sản phẩm
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                Yêu cầu nội dung (AI sẽ viết bài từ đây)
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={4}
                  placeholder="Ví dụ: Bán iPhone 15 Pro 256GB, giá 22 triệu, bảo hành 12 tháng, giao toàn quốc, liên hệ 0900..."
                  className="resize-y rounded-sm border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                />
              </label>

              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                  Giọng văn
                  <select
                    value={tone}
                    onChange={(e) => setTone(e.target.value)}
                    className="rounded-sm border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
                  >
                    {TONES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={generate}
                  disabled={aiBusy || !brief.trim()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
                >
                  {aiBusy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  AI viết bài
                </button>
                {targetCount > 1 && (
                  <span className="text-xs text-ink-faint">
                    AI sẽ viết {targetCount} biến thể cho {targetCount} mục tiêu.
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Nội dung bài */}
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
            Nội dung bài đăng
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={8}
              placeholder="Nhập nội dung bài đăng… (hoặc dùng AI viết ở trên rồi chỉnh lại)"
              className="resize-y rounded-sm border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed text-ink outline-none focus:border-accent"
            />
          </label>

          {/* Chữ ký cuối bài — dán sau khi AI viết/xào nấu nên số điện thoại,
              link trong chữ ký luôn nguyên văn ở mọi mục tiêu. */}
          <div className="flex flex-col gap-2.5 rounded-md border border-line-soft bg-surface-2/50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={sig.enabled}
                  onChange={(e) => patchSig({ enabled: e.target.checked })}
                  className="size-4 accent-accent"
                />
                <Signature className="size-4 text-accent" />
                <span>Tự thêm chữ ký xuống dưới mỗi bài</span>
              </label>
              <button
                onClick={saveSignature}
                disabled={sigSaving}
                className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface px-2.5 py-1 text-xs font-medium text-ink-soft hover:border-accent/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sigSaving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                {sigDirty ? "Lưu chữ ký *" : "Lưu chữ ký"}
              </button>
            </div>

            <textarea
              value={sig.text}
              onChange={(e) => patchSig({ text: e.target.value })}
              rows={3}
              placeholder={"— Liên hệ: 09xx xxx xxx\nĐịa chỉ: …\nFanpage: …"}
              className="resize-y rounded-sm border border-line bg-surface px-3 py-2.5 text-sm leading-relaxed text-ink outline-none focus:border-accent"
            />

            <p className="text-xs text-ink-faint">
              {isSignatureActive(sig)
                ? "Chữ ký được dán nguyên văn ở cuối bài, sau khi AI viết/xào nấu — số điện thoại và link không bị AI đổi."
                : "Bật và nhập chữ ký để mọi bài (tự viết hoặc AI viết) tự có phần liên hệ ở cuối."}
            </p>
          </div>

          {/* Ảnh đính kèm */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-soft">
                Ảnh đính kèm {images.length > 0 && `(${images.length})`}
              </span>
              <button
                onClick={() => fileInput.current?.click()}
                disabled={imgBusy}
                className="inline-flex items-center gap-1.5 rounded-sm border border-line bg-surface-2 px-2.5 py-1 text-xs font-medium text-ink-soft hover:border-accent/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
              >
                {imgBusy ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Đang tải…
                  </>
                ) : (
                  <>
                    <ImagePlus className="size-3.5" />
                    Thêm ảnh
                  </>
                )}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => onPickImages(e.target.files)}
              />
            </div>
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {images.map((src, i) => (
                  <div
                    key={i}
                    className="group relative size-16 overflow-hidden rounded-md border border-line"
                  >
                    <img src={src} alt="" className="size-full object-cover" />
                    <button
                      onClick={() => removeImage(i)}
                      title="Bỏ ảnh"
                      className="absolute right-0.5 top-0.5 grid size-5 place-items-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {images.length > 0 && (
              <p className="text-xs text-ink-faint">
                Ảnh sẽ được đính kèm cho tất cả mục tiêu.
              </p>
            )}
          </div>

          {/* Lịch + xào nấu */}
          <div className="flex flex-col gap-2.5 rounded-md border border-line-soft bg-surface-2/50 p-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
              <span className="flex items-center gap-1.5">
                <CalendarClock className="size-3.5 text-accent" />
                Thời điểm bắt đầu (để trống = ngay khi duyệt)
              </span>
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="rounded-sm border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
              Giãn cách giữa các bài (phút)
              <select
                value={spacing}
                onChange={(e) => setSpacing(Number(e.target.value))}
                className="w-40 rounded-sm border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
              >
                {SPACING_PRESETS.map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Không giãn cách" : `${n} phút`}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={spin}
                onChange={(e) => setSpin(e.target.checked)}
                className="size-4 accent-accent"
              />
              <Wand2 className="size-4 text-ink-faint" />
              <span>AI xào nấu mỗi nhóm một biến thể (tránh trùng nội dung)</span>
            </label>
          </div>

          {/* Nút xem trước */}
          <button
            onClick={buildPreview}
            disabled={aiBusy || !content.trim() || targetCount === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
          >
            {aiBusy ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />}
            Xem trước {targetCount > 0 ? `${targetCount} bài` : ""}
          </button>
        </section>
      </div>

      {/* ---- Xem trước (inline panel) ---- */}
      {preview && (
        <section className="flex flex-col gap-3 rounded-lg border border-accent/40 bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Eye className="size-4 text-accent" />
              Xem trước {preview.length} bài đăng
            </h2>
            <button
              onClick={() => {
                setPreview(null);
                setPreviewNote(null);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink"
            >
              <X className="size-3.5" />
              Đóng
            </button>
          </div>

          {previewNote && (
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-xs",
                previewNote.kind === "err"
                  ? "border-red-soft bg-red-soft/20 text-red"
                  : "border-amber-soft bg-amber-soft/20 text-amber",
              )}
            >
              {previewNote.text}
            </div>
          )}

          <p className="text-xs text-ink-faint">Bạn có thể sửa từng biến thể trước khi tạo việc.</p>

          <div className="flex flex-col gap-3">
            {preview.map((item, i) => (
              <div key={i} className="rounded-md border border-line bg-surface-2/40 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium text-ink">
                    {item.target.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      item.isOrig
                        ? "bg-line text-ink-faint"
                        : "bg-accent-soft/40 text-accent-ink",
                    )}
                  >
                    {item.isOrig ? "Nguyên gốc" : "AI xào nấu"}
                  </span>
                </div>
                <textarea
                  value={item.text}
                  onChange={(e) => editPreviewItem(i, e.target.value)}
                  rows={5}
                  className="w-full resize-y rounded-sm border border-line bg-surface px-3 py-2 text-sm leading-relaxed text-ink outline-none focus:border-accent"
                />
              </div>
            ))}
          </div>

          {images.length > 0 && (
            <p className="text-xs text-ink-faint">
              {images.length} ảnh sẽ được đính kèm cho tất cả mục tiêu.
            </p>
          )}

          <button
            onClick={createJobs}
            disabled={creating}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-bright disabled:opacity-50"
          >
            {creating ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Tạo {preview.length} việc (chờ duyệt)
          </button>
        </section>
      )}
    </div>
  );
}
