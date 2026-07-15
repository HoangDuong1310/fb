import { useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Link2,
  Link2Off,
  RefreshCw,
  Loader2,
  UserCheck,
  ExternalLink,
} from "lucide-react";
import { bg, type BgResponse } from "@/lib/bg";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------
   Kết nối tài khoản Facebook — chống dùng nhầm tài khoản.

   Một người có thể dùng nhiều tài khoản Group Radar, mỗi tài khoản gắn với
   MỘT trang cá nhân Facebook. Màn này cho phép:
     - Xem Facebook đang đăng nhập trên trình duyệt (đọc cookie c_user, không
       cần mở tab Facebook, không đụng gì tới tài khoản FB).
     - Gắn (bind) tài khoản Group Radar hiện tại với FB đó.
     - Cảnh báo khi FB đang đăng nhập KHÁC với FB đã gắn (tránh bất đồng bộ /
       đăng nhầm chỗ) hoặc khi KHÔNG phát hiện FB nào.

   Toàn bộ dữ liệu đi qua background qua bg(type, payload). Lưu ý bg() trải
   { type, ...payload } nên KHÔNG bao giờ đặt khóa "type" trong payload.
   ------------------------------------------------------------------------- */

type Toast = { kind: "ok" | "err" | "info"; text: string } | null;
type FlashFn = (kind: NonNullable<Toast>["kind"], text: string, ms?: number) => void;

// 4 mã khớp trả về từ backend (khớp src/fb-identity.js).
type MatchCode = "OK" | "UNBOUND" | "FB_ABSENT" | "MISMATCH";

interface ActiveIdResponse extends BgResponse {
  fbId?: string | null;
}
interface BindingResponse extends BgResponse {
  binding?: { fbId?: string | null; fbName?: string | null } | null;
}
interface BindActiveResponse extends BgResponse {
  code?: string;
  fbId?: string | null;
  fbName?: string | null;
}
interface CheckMatchResponse extends BgResponse {
  code?: MatchCode;
  bound?: string | null;
  current?: string | null;
  boundName?: string | null;
}

// Broadcast từ background (khớp util.broadcast).
interface FbBroadcastMsg {
  type?: string;
  fbId?: string | null;
  fbName?: string | null;
}

// Mô tả trạng thái khớp -> màu + icon + lời giải thích tiếng Việt.
const MATCH_META: Record<
  MatchCode,
  {
    tone: "ok" | "warn" | "err" | "idle";
    icon: typeof ShieldCheck;
    title: string;
    desc: string;
  }
> = {
  OK: {
    tone: "ok",
    icon: ShieldCheck,
    title: "Đúng tài khoản",
    desc: "Facebook đang đăng nhập khớp với tài khoản đã gắn. An toàn để thao tác.",
  },
  UNBOUND: {
    tone: "idle",
    icon: ShieldQuestion,
    title: "Chưa gắn tài khoản",
    desc: "Tài khoản này chưa gắn với trang Facebook nào. Hãy gắn để bật cảnh báo dùng nhầm.",
  },
  FB_ABSENT: {
    tone: "warn",
    icon: ShieldAlert,
    title: "Không thấy Facebook đăng nhập",
    desc: "Trình duyệt chưa đăng nhập Facebook (hoặc cookie đã bị xoá). Đăng nhập FB rồi thử lại.",
  },
  MISMATCH: {
    tone: "err",
    icon: ShieldAlert,
    title: "Sai tài khoản Facebook",
    desc: "Facebook đang đăng nhập KHÁC với tài khoản đã gắn. Dừng thao tác để tránh đăng nhầm chỗ.",
  },
};

function fbProfileUrl(id: string): string {
  return "https://www.facebook.com/profile.php?id=" + encodeURIComponent(id);
}

export function AccountBinding() {
  const [toast, setToast] = useState<Toast>(null);
  const toastTimer = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "bind" | "unbind" | "refresh">(null);

  // FB đang đăng nhập trên trình duyệt (đọc từ cookie).
  const [activeFbId, setActiveFbId] = useState<string | null>(null);
  // Tài khoản FB đã gắn với account Group Radar hiện tại.
  const [boundFbId, setBoundFbId] = useState<string | null>(null);
  const [boundFbName, setBoundFbName] = useState<string | null>(null);
  // Kết quả khớp.
  const [matchCode, setMatchCode] = useState<MatchCode>("UNBOUND");

  // Tên tuỳ chọn người dùng nhập khi gắn (để dễ nhận biết).
  const [nameInput, setNameInput] = useState("");
  const [confirmUnbind, setConfirmUnbind] = useState(false);

  const flash: FlashFn = (kind, text, ms = 3200) => {
    setToast({ kind, text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  };

  // Đọc toàn bộ trạng thái: FB đang đăng nhập, binding, và kết quả khớp.
  async function loadAll(opts: { silent?: boolean } = {}) {
    if (!opts.silent) setLoading(true);
    setLoadError(null);
    try {
      const [active, binding, match] = await Promise.all([
        bg<ActiveIdResponse>("FB_ACTIVE_ID"),
        bg<BindingResponse>("FB_GET_BINDING"),
        bg<CheckMatchResponse>("FB_CHECK_MATCH"),
      ]);

      if (active && active.ok) {
        setActiveFbId(active.fbId ?? null);
      }
      if (binding && binding.ok) {
        setBoundFbId(binding.binding?.fbId ?? null);
        setBoundFbName(binding.binding?.fbName ?? null);
      }
      if (match && match.ok && match.code) {
        setMatchCode(match.code);
        // FB_CHECK_MATCH trả cả bound/current — dùng để đồng bộ hiển thị.
        if (match.bound !== undefined) setBoundFbId(match.bound ?? null);
        if (match.current !== undefined) setActiveFbId(match.current ?? null);
        if (match.boundName !== undefined) setBoundFbName(match.boundName ?? null);
      } else if (match && !match.ok && match.code) {
        // FB_ABSENT / MISMATCH trả ok:false nhưng vẫn có code hợp lệ.
        setMatchCode(match.code);
        if (match.bound !== undefined) setBoundFbId(match.bound ?? null);
        if (match.current !== undefined) setActiveFbId(match.current ?? null);
        if (match.boundName !== undefined) setBoundFbName(match.boundName ?? null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nghe broadcast từ background: binding đổi ở nơi khác, hoặc job bị chặn do sai FB.
  useEffect(() => {
    const handler = (msg: FbBroadcastMsg) => {
      if (!msg || !msg.type) return;
      if (msg.type === "FB_BINDING_UPDATE") {
        void loadAll({ silent: true });
      } else if (msg.type === "FB_MISMATCH") {
        setMatchCode("MISMATCH");
        void loadAll({ silent: true });
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Gắn tài khoản FB đang đăng nhập vào account Group Radar hiện tại.
  async function doBind() {
    if (!activeFbId) {
      flash("err", "Chưa phát hiện Facebook đăng nhập để gắn.");
      return;
    }
    setBusy("bind");
    try {
      const res = await bg<BindActiveResponse>("FB_BIND_ACTIVE", {
        fbId: activeFbId,
        fbName: nameInput.trim() || null,
      });
      if (res && res.ok) {
        setBoundFbId(res.fbId ?? activeFbId);
        setBoundFbName(res.fbName ?? (nameInput.trim() || null));
        setNameInput("");
        flash("ok", "Đã gắn tài khoản Facebook.");
        await loadAll({ silent: true });
      } else {
        flash("err", res?.error || "Không gắn được tài khoản.");
      }
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Gỡ gắn kết.
  async function doUnbind() {
    setBusy("unbind");
    try {
      const res = await bg<BgResponse>("FB_UNBIND");
      if (res && res.ok) {
        setBoundFbId(null);
        setBoundFbName(null);
        setConfirmUnbind(false);
        flash("info", "Đã gỡ gắn kết tài khoản.");
        await loadAll({ silent: true });
      } else {
        flash("err", res?.error || "Không gỡ được gắn kết.");
      }
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doRefresh() {
    setBusy("refresh");
    try {
      await loadAll({ silent: true });
      flash("info", "Đã làm mới trạng thái.");
    } finally {
      setBusy(null);
    }
  }

  const meta = MATCH_META[matchCode];
  const StatusIcon = meta.icon;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      {loadError && (
        <div className="flex items-start gap-2 rounded-md border border-red-soft bg-red-soft/25 px-4 py-3 text-sm text-red">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>Không tải được trạng thái: {loadError}</span>
        </div>
      )}

      {/* ---- Thẻ trạng thái khớp ---- */}
      <div
        className={cn(
          "flex items-start gap-3 rounded-lg border px-4 py-4",
          meta.tone === "ok" && "border-green-soft bg-green-soft/20",
          meta.tone === "err" && "border-red-soft bg-red-soft/20",
          meta.tone === "warn" && "border-amber-soft bg-amber-soft/25",
          meta.tone === "idle" && "border-line bg-surface-2",
        )}
      >
        <StatusIcon
          className={cn(
            "mt-0.5 size-6 shrink-0",
            meta.tone === "ok" && "text-green",
            meta.tone === "err" && "text-red",
            meta.tone === "warn" && "text-amber",
            meta.tone === "idle" && "text-ink-faint",
          )}
        />
        <div className="min-w-0">
          <div
            className={cn(
              "text-sm font-semibold",
              meta.tone === "ok" && "text-green",
              meta.tone === "err" && "text-red",
              meta.tone === "warn" && "text-amber",
              meta.tone === "idle" && "text-ink",
            )}
          >
            {meta.title}
          </div>
          <p className="mt-0.5 text-sm leading-snug text-ink-soft">{meta.desc}</p>
        </div>
      </div>

      {/* ---- Facebook đang đăng nhập ---- */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Facebook đang đăng nhập</h2>
          <button
            type="button"
            onClick={() => void doRefresh()}
            disabled={busy !== null}
            title="Làm mới"
            className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            {busy === "refresh" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Làm mới
          </button>
        </div>

        {activeFbId ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs text-ink-faint">ID trang cá nhân</div>
              <div className="truncate font-mono text-sm text-ink">{activeFbId}</div>
            </div>
            <a
              href={fbProfileUrl(activeFbId)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium text-accent transition-colors hover:underline"
            >
              <ExternalLink className="size-3.5" />
              Mở
            </a>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-line px-3 py-4 text-center text-sm text-ink-faint">
            Chưa phát hiện Facebook đăng nhập trên trình duyệt.
          </div>
        )}
      </div>

      {/* ---- Tài khoản đã gắn ---- */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink">Tài khoản đã gắn</h2>

        {boundFbId ? (
          <>
            <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <UserCheck className="size-4 shrink-0 text-accent" />
                <div className="min-w-0">
                  {boundFbName && (
                    <div className="truncate text-sm font-medium text-ink">
                      {boundFbName}
                    </div>
                  )}
                  <div className="truncate font-mono text-xs text-ink-faint">
                    {boundFbId}
                  </div>
                </div>
              </div>
              <a
                href={fbProfileUrl(boundFbId)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium text-accent transition-colors hover:underline"
              >
                <ExternalLink className="size-3.5" />
                Mở
              </a>
            </div>

            {confirmUnbind ? (
              <div className="flex items-center justify-between gap-2 rounded-md border border-red-soft bg-red-soft/15 px-3 py-2">
                <span className="text-sm text-ink-soft">Gỡ gắn kết tài khoản này?</span>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmUnbind(false)}
                    disabled={busy !== null}
                    className="rounded-sm px-2.5 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    Huỷ
                  </button>
                  <button
                    type="button"
                    onClick={() => void doUnbind()}
                    disabled={busy !== null}
                    className="inline-flex items-center gap-1.5 rounded-sm bg-red px-2.5 py-1 text-xs font-semibold text-white transition-colors hover:bg-red/90 disabled:opacity-50"
                  >
                    {busy === "unbind" ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Link2Off className="size-3.5" />
                    )}
                    Gỡ
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmUnbind(true)}
                disabled={busy !== null}
                className="inline-flex w-fit items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink-soft transition-colors hover:border-red-soft hover:text-red disabled:opacity-50"
              >
                <Link2Off className="size-4" />
                Gỡ gắn kết
              </button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-ink-soft">
              Tài khoản này chưa gắn với trang Facebook nào. Gắn tài khoản đang đăng
              nhập để bật cảnh báo khi dùng nhầm chỗ.
            </p>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
              Tên gợi nhớ (tuỳ chọn)
              <input
                type="text"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="VD: Shop A — Nguyễn Văn X"
                className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent"
              />
            </label>
            <button
              type="button"
              onClick={() => void doBind()}
              disabled={busy !== null || !activeFbId}
              title={!activeFbId ? "Chưa phát hiện Facebook đăng nhập" : undefined}
              className="inline-flex w-fit items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {busy === "bind" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Link2 className="size-4" />
              )}
              Gắn tài khoản đang đăng nhập
            </button>
          </>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 left-1/2 z-toast -translate-x-1/2 rounded-md border px-4 py-2.5 text-sm shadow-md",
            toast.kind === "ok" && "border-green-soft bg-green-soft/30 text-green",
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
