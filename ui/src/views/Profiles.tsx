import { useEffect, useRef, useState } from "react";
import {
  FileSignature,
  Plus,
  Copy,
  Trash2,
  Check,
  Star,
  Save,
  X,
  Sparkles,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------
   Profiles view — HỒ SƠ NGÀNH (prompt/business profiles).

   Đây là bản chuyển từ dashboard cũ sang UI React mới. Mọi hồ sơ được lưu
   100% ở backend (bảng prompt_profiles) nên chia sẻ được giữa thiết bị.
   View này chỉ gọi các handler background đã có sẵn:
     - GET_PROMPT_PROFILES      -> { ok, profiles: Profile[] }
     - SAVE_PROMPT_PROFILE      -> { ok }         (payload: { profile })
     - ACTIVATE_PROMPT_PROFILE  -> { ok }         (payload: { id })
     - DELETE_PROMPT_PROFILE    -> { ok }         (payload: { id })

   Mỗi Profile đã được db.js dẹp phẳng: config được trải ra cùng cấp với
   id/name/isActive. Các trường ĐẶC THÙ NGÀNH mà người dùng chỉnh:
     name, description, categories[], + 4 trường text (classify/draft/extract/build).

   Chỉ MỘT hồ sơ được kích hoạt tại một thời điểm — đó là hồ sơ AI dùng.
   ------------------------------------------------------------------------- */

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;
type FlashFn = (
  kind: NonNullable<Toast>["kind"],
  text: string,
  ms?: number,
) => void;

/** Một hồ sơ ngành đã dẹp phẳng (khớp shape db.js getPromptProfiles trả về). */
interface Profile {
  id: string;
  name?: string;
  description?: string;
  categories?: string[];
  classifyIntro?: string;
  draftPersona?: string;
  extractIntro?: string;
  buildPersona?: string;
  isActive?: boolean;
  updatedAt?: number | string;
  [key: string]: unknown;
}

interface ProfilesResponse extends BgResponse {
  profiles?: Profile[];
}

/** Kết quả AI sinh hồ sơ (khớp shape generateProfileFull trả về). */
interface GenProfileFields {
  name?: string;
  description?: string;
  categories?: string[];
  classifyIntro?: string;
  draftPersona?: string;
  extractIntro?: string;
  buildPersona?: string;
}
interface GenProfileResponse extends BgResponse {
  fields?: GenProfileFields;
}

/* Các trường text người dùng chỉnh — mirror từ src/prompts.js PROFILE_TEXT_FIELDS. */
const TEXT_FIELDS: {
  key: "classifyIntro" | "draftPersona" | "extractIntro" | "buildPersona";
  label: string;
  rows: number;
  hint: string;
}[] = [
  {
    key: "classifyIntro",
    label: "Phân loại ý định (mua / hỏi / bỏ qua)",
    rows: 9,
    hint: "Mô tả 3 nhãn buy/question/ignore theo đặc thù ngành của bạn. Phần cấu trúc JSON bắt buộc hệ thống tự nối, bạn không cần ghi.",
  },
  {
    key: "draftPersona",
    label: "Vai trò & quy tắc khi soạn trả lời khách",
    rows: 16,
    hint: "Vai trò người bán, giọng văn, quy tắc về giá/sản phẩm. Đây là phần AI dựa vào để soạn bình luận & tin nhắn.",
  },
  {
    key: "extractIntro",
    label: "Trích giá từ bài rao bán trong nhóm",
    rows: 7,
    hint: "Hướng dẫn AI đọc bài rao bán và trích giá. Đổi ngành thì mô tả loại sản phẩm & cách nhận biết giá.",
  },
  {
    key: "buildPersona",
    label: "Ghép bộ theo ngân sách (tuỳ ngành, có thể bỏ trống)",
    rows: 10,
    hint: "Chỉ dùng cho ngành có 'ghép bộ theo ngân sách' (vd build PC). Ngành khác có thể để trống.",
  },
];

/** Draft đang chỉnh trong form. categories giữ dạng chuỗi để nhập cho tiện. */
interface Draft {
  id: string;
  name: string;
  description: string;
  categoriesText: string;
  classifyIntro: string;
  draftPersona: string;
  extractIntro: string;
  buildPersona: string;
  isActive: boolean;
  isNew: boolean;
}

/** Tạo slug id an toàn từ tên (chỉ chữ thường, số, gạch ngang). */
function slugify(s: string): string {
  const base = String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "ho-so";
}

function profileToDraft(p: Profile): Draft {
  return {
    id: p.id,
    name: p.name ?? p.id,
    description: p.description ?? "",
    categoriesText: Array.isArray(p.categories) ? p.categories.join(", ") : "",
    classifyIntro: p.classifyIntro ?? "",
    draftPersona: p.draftPersona ?? "",
    extractIntro: p.extractIntro ?? "",
    buildPersona: p.buildPersona ?? "",
    isActive: !!p.isActive,
    isNew: false,
  };
}

function blankDraft(): Draft {
  return {
    id: "",
    name: "",
    description: "",
    categoriesText: "",
    classifyIntro: "",
    draftPersona: "",
    extractIntro: "",
    buildPersona: "",
    isActive: false,
    isNew: true,
  };
}

function cloneDraft(p: Profile): Draft {
  const d = profileToDraft(p);
  return {
    ...d,
    id: "",
    name: (p.name ?? p.id) + " (bản sao)",
    isActive: false,
    isNew: true,
  };
}

export function Profiles() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);
  // Ô mô tả + trạng thái khi nhờ AI sinh toàn bộ hồ sơ từ một yêu cầu bằng lời.
  const [aiRequest, setAiRequest] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const flash: FlashFn = (kind, text, ms = 3200) => {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  async function load() {
    setLoading(true);
    setLoadError(null);
    const res = await bg<ProfilesResponse>("GET_PROMPT_PROFILES", {});
    if (!res.ok) {
      setLoadError(
        res.error ||
          "Đăng nhập tài khoản web ở popup tiện ích để quản lý hồ sơ ngành.",
      );
      setProfiles([]);
      setLoading(false);
      return;
    }
    const list = Array.isArray(res.profiles) ? res.profiles : [];
    setProfiles(list);
    setLoading(false);
  }

  useEffect(() => {
    load();
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function startNew() {
    setDraft(blankDraft());
    setAiRequest("");
    setConfirmDeleteId(null);
  }

  function startEdit(p: Profile) {
    setDraft(profileToDraft(p));
    setAiRequest("");
    setConfirmDeleteId(null);
  }

  function startClone(p: Profile) {
    setDraft(cloneDraft(p));
    setAiRequest("");
    setConfirmDeleteId(null);
    flash("info", "Đã tạo bản sao — sửa rồi lưu để tạo hồ sơ mới.", 2600);
  }

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  /**
   * generateWithAi — Gọi AI sinh TOÀN BỘ hồ sơ ngành từ mô tả bằng lời của
   * người dùng (+ ngữ cảnh đang có trong form nếu có), rồi điền kết quả vào
   * draft để người dùng xem lại & lưu. Backend: handler GEN_PROFILE_FULL ->
   * POST /api/ai/generate-profile. Không tự lưu — chỉ điền form.
   */
  async function generateWithAi() {
    if (!draft || aiBusy) return;
    const request = aiRequest.trim();
    const categories = draft.categoriesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (
      !request &&
      !draft.name.trim() &&
      !draft.description.trim() &&
      !categories.length
    ) {
      flash("err", "Mô tả ngành hàng + yêu cầu để AI có ngữ cảnh sinh hồ sơ.", 3200);
      return;
    }
    setAiBusy(true);
    const res = await bg<GenProfileResponse>("GEN_PROFILE_FULL", {
      payload: {
        request,
        profile: {
          name: draft.name.trim(),
          description: draft.description.trim(),
          categories,
        },
      },
    });
    setAiBusy(false);
    if (!res.ok || !res.fields) {
      flash("err", res.error || "AI chưa sinh được hồ sơ, hãy thử lại.", 5000);
      return;
    }
    const f = res.fields;
    // Chỉ ghi đè trường AI có trả về (không đạp lên nội dung người dùng đã nhập).
    setDraft((d) => {
      if (!d) return d;
      const next = { ...d };
      if (f.name) next.name = f.name;
      if (f.description) next.description = f.description;
      if (Array.isArray(f.categories) && f.categories.length)
        next.categoriesText = f.categories.join(", ");
      if (f.classifyIntro) next.classifyIntro = f.classifyIntro;
      if (f.draftPersona) next.draftPersona = f.draftPersona;
      if (f.extractIntro) next.extractIntro = f.extractIntro;
      if (f.buildPersona) next.buildPersona = f.buildPersona;
      return next;
    });
    flash("ok", "AI đã điền hồ sơ — xem lại rồi bấm Lưu.", 3200);
  }

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      flash("err", "Nhập tên hồ sơ trước đã.", 2600);
      return;
    }
    // id: hồ sơ cũ giữ nguyên; hồ sơ mới lấy id người dùng nhập hoặc slug từ tên.
    let id = draft.id.trim();
    if (draft.isNew && !id) id = slugify(name) + "-" + Date.now().toString(36);
    if (!id) {
      flash("err", "Thiếu mã hồ sơ (id).", 2600);
      return;
    }
    // Chặn trùng id khi tạo mới.
    if (draft.isNew && profiles.some((p) => p.id === id)) {
      flash("err", `Mã hồ sơ "${id}" đã tồn tại. Chọn mã khác.`, 4000);
      return;
    }

    const categories = draft.categoriesText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const profile: Profile = {
      id,
      name,
      description: draft.description.trim(),
      categories,
      classifyIntro: draft.classifyIntro,
      draftPersona: draft.draftPersona,
      extractIntro: draft.extractIntro,
      buildPersona: draft.buildPersona,
      isActive: draft.isActive,
    };

    setSaving(true);
    const res = await bg("SAVE_PROMPT_PROFILE", { profile });
    setSaving(false);
    if (!res.ok) {
      flash("err", res.error || "Lưu hồ sơ thất bại.", 5000);
      return;
    }
    flash("ok", "Đã lưu hồ sơ ngành.", 2200);
    setDraft(null);
    load();
  }

  async function activate(p: Profile) {
    if (p.isActive) return;
    setBusyId(p.id);
    const res = await bg("ACTIVATE_PROMPT_PROFILE", { id: p.id });
    setBusyId(null);
    if (!res.ok) {
      flash("err", res.error || "Kích hoạt thất bại.", 5000);
      return;
    }
    flash("ok", `Đã kích hoạt "${p.name ?? p.id}".`, 2200);
    // Cập nhật cục bộ cờ active (chỉ một hồ sơ active).
    setProfiles((list) =>
      list.map((r) => ({ ...r, isActive: r.id === p.id })),
    );
    // Nếu đang mở hồ sơ này trong form thì đồng bộ cờ.
    setDraft((d) => (d && d.id === p.id ? { ...d, isActive: true } : d));
  }

  async function remove(id: string) {
    setBusyId(id);
    const res = await bg("DELETE_PROMPT_PROFILE", { id });
    setBusyId(null);
    setConfirmDeleteId(null);
    if (!res.ok) {
      flash("err", res.error || "Xóa thất bại.", 5000);
      return;
    }
    flash("ok", "Đã xóa hồ sơ.", 2000);
    setProfiles((list) => list.filter((r) => r.id !== id));
    setDraft((d) => (d && d.id === id ? null : d));
  }

  return (
    <div className="relative mx-auto flex w-full max-w-[1080px] flex-col gap-4">
      {/* Header actions */}
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-[640px] text-sm leading-snug text-ink-faint">
          Hồ sơ ngành quyết định cách AI phân loại, tư vấn và trích giá cho
          NGÀNH của bạn. Chỉ một hồ sơ được kích hoạt tại một thời điểm. Nhân
          bản hồ sơ mẫu rồi sửa lời thoại để dùng cho ngành khác.
        </p>
        <button
          type="button"
          onClick={startNew}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90"
        >
          <Plus className="size-4" strokeWidth={2.25} />
          Hồ sơ mới
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        {/* ---- Danh sách hồ sơ ---- */}
        <div className="flex flex-col gap-2">
          {loading ? (
            <ListSkeleton />
          ) : loadError ? (
            <EmptyState title="Cần đăng nhập" desc={loadError} />
          ) : profiles.length === 0 ? (
            <EmptyState
              title="Chưa có hồ sơ ngành"
              desc='Bấm "Hồ sơ mới" để tạo hồ sơ đầu tiên cho ngành của bạn.'
            />
          ) : (
            profiles.map((p) => {
              const active = !!p.isActive;
              const selected = draft?.id === p.id && !draft?.isNew;
              const confirming = confirmDeleteId === p.id;
              const busy = busyId === p.id;
              return (
                <article
                  key={p.id}
                  className={cn(
                    "flex flex-col gap-2 rounded-lg border bg-surface px-3 py-2.5 transition-colors",
                    selected
                      ? "border-accent/60 ring-1 ring-accent/30"
                      : "border-line hover:border-accent/40",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink">
                          {p.name ?? p.id}
                        </span>
                        {active && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-green-soft bg-green-soft/30 px-2 py-0.5 text-xs font-medium text-green">
                            <Check className="size-3" strokeWidth={2.5} />
                            đang dùng
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate font-mono text-xs text-ink-faint">
                        {p.id}
                      </div>
                      {p.description ? (
                        <p className="mt-1 line-clamp-2 text-xs leading-snug text-ink-faint">
                          {p.description}
                        </p>
                      ) : null}
                    </button>
                  </div>

                  {confirming ? (
                    <div className="flex items-center gap-2 rounded-md border border-red-soft bg-red-soft/20 px-2.5 py-2">
                      <span className="flex-1 text-xs text-red">
                        Xóa hồ sơ này?
                      </span>
                      <button
                        type="button"
                        onClick={() => remove(p.id)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded-md bg-red px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-red/90 disabled:opacity-60"
                      >
                        <Trash2 className="size-3" />
                        Xóa
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="rounded-md border border-line px-2 py-1 text-xs text-ink-soft hover:bg-surface-2"
                      >
                        Hủy
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => activate(p)}
                        disabled={active || busy}
                        title={active ? "Đang là hồ sơ dùng" : "Kích hoạt"}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                          active
                            ? "cursor-default text-ink-faint"
                            : "border border-line text-ink-soft hover:border-accent/50 hover:text-ink disabled:opacity-60",
                        )}
                      >
                        <Star
                          className={cn(
                            "size-3.5",
                            active ? "fill-green text-green" : "",
                          )}
                        />
                        {active ? "Đang dùng" : "Dùng hồ sơ này"}
                      </button>
                      <button
                        type="button"
                        onClick={() => startClone(p)}
                        title="Nhân bản"
                        className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
                      >
                        <Copy className="size-3.5" />
                        Nhân bản
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(p.id)}
                        title="Xóa"
                        className="ml-auto inline-flex items-center rounded-md border border-line px-2 py-1 text-xs text-ink-faint transition-colors hover:border-red-soft hover:text-red"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>

        {/* ---- Editor ---- */}
        <div className="min-w-0">
          {draft ? (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <FileSignature className="size-4 text-accent" />
                  {draft.isNew ? "Tạo hồ sơ mới" : "Chỉnh sửa hồ sơ"}
                </h2>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-ink-soft transition-colors hover:bg-surface-2"
                >
                  <X className="size-3.5" />
                  Đóng
                </button>
              </div>

              {draft.isNew ? (
                <div className="flex flex-col gap-2 rounded-md border border-accent/30 bg-accent/5 p-3">
                  <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                    <span className="flex items-center gap-1.5 text-accent">
                      <Sparkles className="size-3.5" />
                      Tạo nhanh bằng AI
                    </span>
                    <textarea
                      value={aiRequest}
                      onChange={(e) => setAiRequest(e.target.value)}
                      rows={2}
                      placeholder="Mô tả ngành hàng / yêu cầu, vd: Tôi bán mỹ phẩm chính hãng cho nữ 25-40 tuổi..."
                      className="resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm font-normal text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
                    />
                  </label>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-ink-faint">
                      AI sẽ điền toàn bộ hồ sơ bên dưới để bạn xem lại rồi Lưu.
                    </span>
                    <button
                      type="button"
                      onClick={generateWithAi}
                      disabled={aiBusy}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-xs font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-60"
                    >
                      <Sparkles className="size-3.5" />
                      {aiBusy ? "Đang tạo..." : "Tạo bằng AI"}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                  Tên hồ sơ
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setField("name", e.target.value)}
                    placeholder="vd: Bán điện thoại"
                    className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-normal text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                  Mã hồ sơ (id)
                  <input
                    type="text"
                    value={draft.id}
                    onChange={(e) => setField("id", e.target.value)}
                    disabled={!draft.isNew}
                    placeholder="tự tạo từ tên nếu bỏ trống"
                    className={cn(
                      "rounded-md border border-line bg-surface px-3 py-2 font-mono text-sm font-normal text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none",
                      !draft.isNew && "cursor-not-allowed opacity-60",
                    )}
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                Mô tả ngắn
                <input
                  type="text"
                  value={draft.description}
                  onChange={(e) => setField("description", e.target.value)}
                  placeholder="Mô tả ngắn về ngành / mục đích hồ sơ"
                  className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-normal text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                Danh mục sản phẩm
                <input
                  type="text"
                  value={draft.categoriesText}
                  onChange={(e) => setField("categoriesText", e.target.value)}
                  placeholder="cpu, vga, ram, laptop, màn hình…"
                  className="rounded-md border border-line bg-surface px-3 py-2 text-sm font-normal text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
                />
                <span className="font-normal text-ink-faint">
                  Ngăn cách bằng dấu phẩy. AI dùng làm gợi ý khi phân loại &
                  ghép bộ.
                </span>
              </label>

              {TEXT_FIELDS.map((f) => (
                <label
                  key={f.key}
                  className="flex flex-col gap-1 text-xs font-medium text-ink-soft"
                >
                  {f.label}
                  <textarea
                    rows={f.rows}
                    value={draft[f.key]}
                    onChange={(e) => setField(f.key, e.target.value)}
                    className="resize-y rounded-md border border-line bg-surface px-3 py-2 text-sm font-normal leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent/60 focus:outline-none"
                  />
                  <span className="font-normal text-ink-faint">{f.hint}</span>
                </label>
              ))}

              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(e) => setField("isActive", e.target.checked)}
                  className="size-4 rounded border-line accent-accent"
                />
                Kích hoạt hồ sơ này ngay sau khi lưu (đặt làm hồ sơ AI dùng)
              </label>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-60"
                >
                  <Save className="size-4" strokeWidth={2.25} />
                  {saving ? "Đang lưu…" : "Lưu hồ sơ"}
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="rounded-md border border-line px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-surface-2"
                >
                  Hủy
                </button>
              </div>
            </div>
          ) : (
            <div className="grid h-full min-h-[240px] place-items-center rounded-lg border border-dashed border-line bg-surface-2/40 p-8 text-center">
              <div className="max-w-[360px]">
                <FileSignature className="mx-auto size-8 text-ink-faint" />
                <p className="mt-3 text-sm font-medium text-ink-soft">
                  Chọn một hồ sơ để chỉnh sửa
                </p>
                <p className="mt-1 text-xs leading-snug text-ink-faint">
                  Bấm vào một hồ sơ bên trái để xem & sửa, hoặc "Hồ sơ mới" để
                  tạo hồ sơ cho ngành của bạn.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 z-toast -translate-x-1/2 rounded-md border px-4 py-2.5 text-sm shadow-md",
            toast.kind === "ok" &&
              "border-green-soft bg-green-soft/30 text-green",
            toast.kind === "err" && "border-red-soft bg-red-soft/30 text-red",
            toast.kind === "info" && "border-line bg-surface-2 text-ink-soft",
          )}
        >
          {toast.text}
        </div>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-[92px] animate-pulse rounded-lg border border-line bg-surface-2/50"
        />
      ))}
    </div>
  );
}

function EmptyState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-line bg-surface-2/40 p-8 text-center">
      <div className="max-w-[320px]">
        <p className="text-sm font-medium text-ink-soft">{title}</p>
        <p className="mt-1 text-xs leading-snug text-ink-faint">{desc}</p>
      </div>
    </div>
  );
}
