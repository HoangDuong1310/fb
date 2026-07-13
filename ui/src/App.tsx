import { useEffect, useState } from "react";
import {
  MessagesSquare,
  Newspaper,
  MessageCircleReply,
  Megaphone,
  Tag,
  KeyRound,
  FileSignature,
  Wrench,
  Bot,
  Sparkles,
  ShieldAlert,
  LogOut,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { bg, type BgResponse } from "@/lib/bg";
import { Auth } from "@/views/Auth";
import { Messenger } from "@/views/Messenger";
import { Feed } from "@/views/Feed";
import { Comments } from "@/views/Comments";
import { Compose } from "@/views/Compose";
import { Prices } from "@/views/Prices";
import { Keywords } from "@/views/Keywords";
import { Profiles } from "@/views/Profiles";
import { Tools } from "@/views/Tools";
import { ChatAI } from "@/views/ChatAI";

/* -------------------------------------------------------------------------
   App shell — Facebook-like information architecture.
   The user drives everything from the extension: Messenger (private DMs),
   Feed (group posts + inline comment), Comments (reply-watch queue). Tools
   holds crawl / market / config. AI is an optional assist layer per view,
   never the driver. Views are stubbed here and built out per-todo.

   XÁC THỰC: dashboard chỉ render khi ĐÃ đăng nhập. Lúc mở, App hỏi background
   AUTH_STATE; nếu chưa đăng nhập -> render <Auth/>. App cũng nghe broadcast
   AUTH_REQUIRED (do background phát khi token hết hạn / tài khoản bị khóa...)
   để đá người dùng về màn hình đăng nhập kèm thông báo lý do.
   ------------------------------------------------------------------------- */

type ViewId =
  | "messenger"
  | "feed"
  | "comments"
  | "compose"
  | "prices"
  | "keywords"
  | "profiles"
  | "tools"
  | "chat";

interface NavItem {
  id: ViewId;
  label: string;
  hint: string;
  icon: typeof MessagesSquare;
}

interface AuthStateResponse extends BgResponse {
  loggedIn?: boolean;
  display_name?: string;
}

// Trạng thái cổng xác thực: đang kiểm tra / đã vào / chưa đăng nhập.
type AuthGate = "checking" | "in" | "out";

// reason từ background -> thông báo tiếng Việt (khớp popup.js).
function authRequiredNote(reason: unknown): string {
  switch (reason) {
    case "locked":
      return "Tài khoản của bạn đã bị khóa. Vui lòng liên hệ quản trị viên để được hỗ trợ.";
    case "pending":
      return "Tài khoản của bạn đang chờ được duyệt. Vui lòng thử lại sau khi được phê duyệt.";
    case "inactive":
      return "Tài khoản của bạn hiện không hoạt động. Vui lòng liên hệ quản trị viên.";
    default:
      return "Phiên đăng nhập hết hạn, vui lòng đăng nhập lại.";
  }
}

const NAV: NavItem[] = [
  {
    id: "messenger",
    label: "Tin nhắn",
    hint: "Nhắn tin riêng — tự viết hoặc để AI gợi ý",
    icon: MessagesSquare,
  },
  {
    id: "feed",
    label: "Bảng tin",
    hint: "Bài viết nhóm — bình luận ngay tại chỗ",
    icon: Newspaper,
  },
  {
    id: "comments",
    label: "Bình luận",
    hint: "Hàng đợi trả lời hội thoại",
    icon: MessageCircleReply,
  },
  {
    id: "compose",
    label: "Đăng bài",
    hint: "Đăng bài lên nhiều nhóm — tự viết hoặc để AI viết",
    icon: Megaphone,
  },
  {
    id: "prices",
    label: "Giá",
    hint: "Giá Group, sản phẩm cửa hàng và kho của bạn",
    icon: Tag,
  },
  {
    id: "keywords",
    label: "Từ khóa",
    hint: "Bộ lọc lead tự học — duyệt từ khóa AI đề xuất",
    icon: KeyRound,
  },
  {
    id: "profiles",
    label: "Hồ sơ ngành",
    hint: "Prompt AI theo ngành — phân loại, soạn tin, trích giá",
    icon: FileSignature,
  },
  {
    id: "tools",
    label: "Công cụ",
    hint: "Thu thập, giá thị trường, cấu hình",
    icon: Wrench,
  },
  {
    id: "chat",
    label: "Trợ lý AI",
    hint: "Chat với AI — điều khiển tool, lưu lịch sử trên server",
    icon: Bot,
  },
];

const VIEW_TITLE: Record<ViewId, { title: string; sub: string }> = {
  messenger: {
    title: "Tin nhắn",
    sub: "Gửi tin nhắn riêng ngay từ tiện ích. AI chỉ hỗ trợ soạn thảo.",
  },
  feed: {
    title: "Bảng tin",
    sub: "Xem bài viết nhóm và bình luận trực tiếp — không cần mở Facebook.",
  },
  comments: {
    title: "Bình luận",
    sub: "Theo dõi phản hồi và duyệt trả lời trước khi gửi.",
  },
  compose: {
    title: "Đăng bài",
    sub: "Soạn một lần, đăng lên nhiều nhóm. Mọi việc chờ bạn duyệt trước khi lên Facebook.",
  },
  prices: {
    title: "Giá & Sản phẩm",
    sub: "Giá sàn từ nhóm, so giá sản phẩm cửa hàng và kho hàng của bạn.",
  },
  keywords: {
    title: "Từ khóa & Đề xuất",
    sub: "Bộ lọc lead tự học theo thời gian. Duyệt từ khóa do AI đề xuất để lần sau lọc chuẩn hơn.",
  },
  profiles: {
    title: "Hồ sơ ngành",
    sub: "Tạo và kích hoạt bộ prompt AI theo ngành — phân loại lead, soạn tin, trích giá từ bài rao.",
  },
  tools: {
    title: "Công cụ",
    sub: "Thu thập dữ liệu, so giá thị trường và cấu hình hệ thống.",
  },
  chat: {
    title: "Trợ lý AI",
    sub: "Trò chuyện với AI, chọn model, lưu hội thoại — điều khiển công cụ qua chat.",
  },
};

export function App() {
  const [view, setView] = useState<ViewId>("messenger");
  const head = VIEW_TITLE[view];

  // ---- Cổng xác thực ----
  const [gate, setGate] = useState<AuthGate>("checking");
  const [displayName, setDisplayName] = useState("");
  const [notice, setNotice] = useState("");

  // Hỏi background xem đã đăng nhập chưa (lúc mở dashboard).
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await bg<AuthStateResponse>("AUTH_STATE");
        if (!alive) return;
        if (res && res.ok && res.loggedIn) {
          setDisplayName(res.display_name || "");
          setGate("in");
        } else {
          setGate("out");
        }
      } catch {
        if (alive) setGate("out");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Nghe broadcast AUTH_REQUIRED để đá về màn hình đăng nhập kèm lý do.
  useEffect(() => {
    interface AuthRequiredMsg {
      type?: string;
      reason?: string;
    }
    const handler = (msg: AuthRequiredMsg) => {
      if (msg && msg.type === "AUTH_REQUIRED") {
        setNotice(authRequiredNote(msg.reason));
        setDisplayName("");
        setGate("out");
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => {
      chrome.runtime.onMessage.removeListener(handler);
    };
  }, []);

  function onAuthed(name: string) {
    setDisplayName(name);
    setNotice("");
    setView("messenger");
    setGate("in");
  }

  async function doLogout() {
    try {
      await bg("AUTH_LOGOUT");
    } finally {
      setDisplayName("");
      setNotice("");
      setGate("out");
    }
  }

  // Trạng thái đang kiểm tra phiên: tránh nháy dashboard trước khi biết.
  if (gate === "checking") {
    return (
      <div className="flex h-screen items-center justify-center bg-bg">
        <Loader2 className="size-6 animate-spin text-ink-faint" />
      </div>
    );
  }

  // Chưa đăng nhập -> chặn toàn bộ dashboard, chỉ hiển thị cổng đăng nhập.
  if (gate === "out") {
    return <Auth onAuthed={onAuthed} notice={notice} />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* ---- Sidebar: deepest instrument shelf ---- */}
      <aside className="flex h-screen w-[248px] shrink-0 flex-col border-r border-sb-line bg-sb">
        <div className="flex items-center gap-3 px-4 py-4">
          <div className="grid size-[38px] place-items-center rounded-lg bg-accent font-mono text-lg font-bold text-on-accent">
            GR
          </div>
          <div className="leading-tight">
            <div className="font-display text-sm font-semibold text-ink">
              Group Radar
            </div>
            <div className="text-xs text-sb-text-dim">Trợ lý bán hàng nhóm</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-0.5 px-2 py-2">
          {NAV.map((item) => {
            const active = view === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setView(item.id)}
                title={item.hint}
                className={cn(
                  "group flex items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors duration-150",
                  active
                    ? "bg-sb-2 text-ink"
                    : "text-sb-text hover:bg-sb-2/60 hover:text-ink",
                )}
              >
                <Icon
                  className={cn(
                    "size-[18px] shrink-0",
                    active ? "text-accent" : "text-sb-text-dim",
                  )}
                  strokeWidth={active ? 2.25 : 1.75}
                />
                <span
                  className={cn(
                    "text-sm",
                    active ? "font-semibold" : "font-medium",
                  )}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* ---- Tài khoản + đăng xuất ---- */}
        <div className="border-t border-sb-line px-3 py-3">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <span className="min-w-0 truncate text-xs text-sb-text-dim">
              {displayName || "Đã đăng nhập"}
            </span>
            <button
              type="button"
              onClick={() => void doLogout()}
              title="Đăng xuất"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium text-sb-text transition-colors hover:bg-sb-2/60 hover:text-ink"
            >
              <LogOut className="size-3.5" />
              Đăng xuất
            </button>
          </div>
          <div className="flex items-start gap-2 rounded-md border border-amber-soft bg-amber-soft/25 px-3 py-2.5">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber" />
            <p className="text-xs leading-snug text-ink-soft">
              Mọi hành động đều chờ bạn duyệt trước khi gửi.
            </p>
          </div>
        </div>
      </aside>

      {/* ---- Main ---- */}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="z-sticky flex shrink-0 items-center justify-between border-b border-line bg-bg/85 px-6 py-4 backdrop-blur">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">{head.title}</h1>
            <p className="mt-0.5 truncate text-sm text-ink-faint">{head.sub}</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
          >
            <Sparkles className="size-4 text-accent" />
            AI gợi ý
          </button>
        </header>

        <section
          className={cn(
            "min-h-0 flex-1",
            view === "messenger" || view === "chat"
              ? "overflow-hidden p-4"
              : "overflow-y-auto p-6",
          )}
        >
          {view === "messenger" ? (
            <Messenger />
          ) : view === "feed" ? (
            <Feed />
          ) : view === "comments" ? (
            <Comments />
          ) : view === "compose" ? (
            <Compose />
          ) : view === "prices" ? (
            <Prices />
          ) : view === "keywords" ? (
            <Keywords />
          ) : view === "profiles" ? (
            <Profiles />
          ) : view === "chat" ? (
            <ChatAI />
          ) : (
            <Tools />
          )}
        </section>
      </main>
    </div>
  );
}
