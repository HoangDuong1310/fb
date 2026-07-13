import { useEffect, useState } from "react";
import { ShieldAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { bg, type BgResponse } from "@/lib/bg";

/* -------------------------------------------------------------------------
   Auth.tsx — Cổng đăng nhập / đăng ký cho dashboard React.

   Trước đây LOGIC XÁC THỰC chỉ tồn tại ở popup (src/popup.js + popup.html),
   còn dashboard React render thẳng mọi view không kiểm tra đăng nhập -> ai mở
   dashboard cũng dùng được. Component này port đúng luồng của popup sang React,
   nối vào các message background đã có sẵn:
     - AUTH_LOGIN    { email, password }        -> { ok, user }
     - AUTH_REGISTER { email, password, displayName } -> { ok, user }
   App.tsx sẽ chỉ render dashboard khi đã đăng nhập; nếu chưa -> render <Auth/>.
   ------------------------------------------------------------------------- */

interface AuthResponse extends BgResponse {
  user?: { displayName?: string; id?: number | string } | null;
}

interface AuthProps {
  /** Gọi khi đăng nhập/đăng ký thành công để App chuyển sang dashboard. */
  onAuthed: (displayName: string) => void;
  /** Thông báo ban đầu (vd bị đá ra do phiên hết hạn / tài khoản bị khóa). */
  notice?: string;
}

type Mode = "login" | "register";

// Chỉ nhớ EMAIL (không bao giờ nhớ mật khẩu) — khớp hành vi popup.
const REMEMBER_KEY = "rememberedLogin";

function loadRememberedLogin(): Promise<{ remember: boolean; email: string }> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(REMEMBER_KEY, (r) => {
        void chrome.runtime.lastError;
        const saved = (r && (r[REMEMBER_KEY] as Record<string, unknown>)) || {};
        resolve({
          remember: !!saved.remember,
          email: typeof saved.email === "string" ? saved.email : "",
        });
      });
    } catch {
      resolve({ remember: false, email: "" });
    }
  });
}

function saveRememberedLogin(remember: boolean, email: string): void {
  try {
    if (remember && email) {
      chrome.storage.local.set(
        { [REMEMBER_KEY]: { remember: true, email } },
        () => void chrome.runtime.lastError,
      );
    } else {
      chrome.storage.local.remove(
        REMEMBER_KEY,
        () => void chrome.runtime.lastError,
      );
    }
  } catch {
    // Không nhớ được tài khoản không phải lỗi chặn đăng nhập.
  }
}

// Chuyển lỗi 401/khác thành thông báo tiếng Việt thân thiện (port từ popup).
function loginErrorMessage(raw: string | undefined): string {
  const s = String(raw || "");
  if (/\b401\b/.test(s) || /invalid credentials/i.test(s)) {
    return "Email hoặc mật khẩu không đúng.";
  }
  return "Không đăng nhập được, kiểm tra kết nối rồi thử lại.";
}

// Chuyển lỗi đăng ký (409/400/mật khẩu yếu...) thành thông báo tiếng Việt.
function registerErrorMessage(raw: string | undefined): string {
  const s = String(raw || "");
  if (/\b409\b/.test(s) || /already registered/i.test(s)) {
    return "Email này đã được đăng ký. Hãy đăng nhập.";
  }
  if (/password must be 6-72/i.test(s)) {
    return "Mật khẩu phải từ 6 đến 72 ký tự.";
  }
  if (/invalid email/i.test(s)) {
    return "Email không hợp lệ.";
  }
  if (/\b400\b/.test(s)) {
    return "Thông tin đăng ký không hợp lệ, vui lòng kiểm tra lại.";
  }
  return "Không đăng ký được, kiểm tra kết nối rồi thử lại.";
}

export function Auth({ onAuthed, notice }: AuthProps) {
  const [mode, setMode] = useState<Mode>("login");

  // Trường nhập chung — dùng lại giữa 2 form, reset khi đổi mode.
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [remember, setRemember] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Điền sẵn email đã nhớ + trạng thái ô tích lúc mở dashboard.
  useEffect(() => {
    void (async () => {
      const saved = await loadRememberedLogin();
      setRemember(saved.remember);
      if (saved.remember && saved.email) setEmail(saved.email);
    })();
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError("");
    setPassword("");
    if (next === "login") setDisplayName("");
  }

  async function doLogin() {
    const em = email.trim();
    // KHÔNG trim mật khẩu: khoảng trắng đầu/cuối có thể hợp lệ.
    if (!em || !password) {
      setError("Nhập email và mật khẩu");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await bg<AuthResponse>("AUTH_LOGIN", {
        email: em,
        password,
      });
      if (res && res.ok) {
        setPassword("");
        // Nhớ/quên email chỉ sau khi đăng nhập THÀNH CÔNG. KHÔNG lưu mật khẩu.
        saveRememberedLogin(remember, em);
        onAuthed((res.user && res.user.displayName) || "");
      } else {
        setError(loginErrorMessage(res && res.error));
      }
    } finally {
      setBusy(false);
    }
  }

  async function doRegister() {
    const em = email.trim();
    if (!em || !password) {
      setError("Nhập email và mật khẩu");
      return;
    }
    // Ràng buộc phía client khớp backend (6-72 ký tự).
    if (password.length < 6 || password.length > 72) {
      setError("Mật khẩu phải từ 6 đến 72 ký tự.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await bg<AuthResponse>("AUTH_REGISTER", {
        email: em,
        password,
        displayName: displayName.trim(),
      });
      if (res && res.ok) {
        setPassword("");
        onAuthed((res.user && res.user.displayName) || "");
      } else {
        setError(registerErrorMessage(res && res.error));
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (mode === "login") void doLogin();
    else void doRegister();
  }

  return (
    <div className="flex h-screen items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[400px]">
        {/* Thương hiệu */}
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-[42px] place-items-center rounded-lg bg-accent font-mono text-lg font-bold text-on-accent">
            GR
          </div>
          <div className="leading-tight">
            <div className="font-display text-base font-semibold text-ink">
              Group Radar
            </div>
            <div className="text-xs text-ink-faint">Trợ lý bán hàng nhóm</div>
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold text-ink">
            {mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}
          </h1>
          <p className="mt-1 text-sm text-ink-faint">
            {mode === "login"
              ? "Đăng nhập để dùng các tính năng đồng bộ với máy chủ."
              : "Đăng ký tài khoản mới. Có thể cần quản trị viên duyệt trước khi dùng."}
          </p>

          {/* Thông báo bị đá ra (phiên hết hạn / tài khoản bị khóa...) */}
          {notice ? (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-amber-soft bg-amber-soft/25 px-3 py-2.5">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber" />
              <p className="text-xs leading-snug text-ink-soft">{notice}</p>
            </div>
          ) : null}

          <form className="mt-4 flex flex-col gap-3" onSubmit={onSubmit}>
            {mode === "register" ? (
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
                Tên hiển thị
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                  placeholder="Tuỳ chọn"
                  className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent/60"
                />
              </label>
            ) : null}

            <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                placeholder="you@example.com"
                className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent/60"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs font-medium text-ink-soft">
              Mật khẩu
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "login" ? "current-password" : "new-password"
                }
                placeholder={mode === "register" ? "6–72 ký tự" : "••••••••"}
                className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-accent/60"
              />
            </label>

            {mode === "login" ? (
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-soft">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="size-4 rounded border-line accent-accent"
                />
                Ghi nhớ email
              </label>
            ) : null}

            {error ? (
              <div className="rounded-md border border-red-soft bg-red-soft/20 px-3 py-2 text-sm text-red">
                {error}
              </div>
            ) : null}

            <button
              type="submit"
              disabled={busy}
              className={cn(
                "mt-1 inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-on-accent transition-opacity",
                busy ? "opacity-60" : "hover:opacity-90",
              )}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {mode === "login" ? "Đăng nhập" : "Đăng ký"}
            </button>
          </form>

          <p className="mt-4 text-center text-sm text-ink-faint">
            {mode === "login" ? (
              <>
                Chưa có tài khoản?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("register")}
                  className="font-semibold text-accent hover:underline"
                >
                  Đăng ký
                </button>
              </>
            ) : (
              <>
                Đã có tài khoản?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="font-semibold text-accent hover:underline"
                >
                  Đăng nhập
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
