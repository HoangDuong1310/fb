import { useState } from "react";
import {
  MessagesSquare,
  Newspaper,
  MessageCircleReply,
  Megaphone,
  Tag,
  Wrench,
  Sparkles,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Messenger } from "@/views/Messenger";
import { Feed } from "@/views/Feed";
import { Comments } from "@/views/Comments";
import { Compose } from "@/views/Compose";
import { Prices } from "@/views/Prices";
import { Tools } from "@/views/Tools";

/* -------------------------------------------------------------------------
   App shell — Facebook-like information architecture.
   The user drives everything from the extension: Messenger (private DMs),
   Feed (group posts + inline comment), Comments (reply-watch queue). Tools
   holds crawl / market / config. AI is an optional assist layer per view,
   never the driver. Views are stubbed here and built out per-todo.
   ------------------------------------------------------------------------- */

type ViewId = "messenger" | "feed" | "comments" | "compose" | "prices" | "tools";

interface NavItem {
  id: ViewId;
  label: string;
  hint: string;
  icon: typeof MessagesSquare;
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
    id: "tools",
    label: "Công cụ",
    hint: "Thu thập, giá thị trường, cấu hình",
    icon: Wrench,
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
  tools: {
    title: "Công cụ",
    sub: "Thu thập dữ liệu, so giá thị trường và cấu hình hệ thống.",
  },
};

export function App() {
  const [view, setView] = useState<ViewId>("messenger");
  const head = VIEW_TITLE[view];

  return (
    <div className="grid min-h-screen grid-cols-[248px_1fr]">
      {/* ---- Sidebar: deepest instrument shelf ---- */}
      <aside className="sticky top-0 flex h-screen flex-col border-r border-sb-line bg-sb">
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

        <div className="px-3 py-3">
          <div className="flex items-start gap-2 rounded-md border border-amber-soft bg-amber-soft/25 px-3 py-2.5">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber" />
            <p className="text-xs leading-snug text-ink-soft">
              Mọi hành động đều chờ bạn duyệt trước khi gửi.
            </p>
          </div>
        </div>
      </aside>

      {/* ---- Main ---- */}
      <main className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-sticky flex items-center justify-between border-b border-line bg-bg/85 px-6 py-4 backdrop-blur">
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
            view === "messenger"
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
          ) : (
            <Tools />
          )}
        </section>
      </main>
    </div>
  );
}
