import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
  User,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { bg, type BgResponse } from "@/lib/bg";

/* -------------------------------------------------------------------------
   ChatAI — Trợ lý AI ngay trong tiện ích.

   Cổng dữ liệu là service worker (bg()), KHÔNG dùng SSE: message port của MV3
   không streaming được, nên view gọi endpoint /messages bản thường và tự POLL
   lại chi tiết khi còn tool async đang chạy (waitingAsync / status pending).
   Backend /api/chat đã có sẵn (lưu lịch sử + trí nhớ dài hạn ở BE), view này
   chỉ là lớp giao diện port từ dashboard web sang UI extension.
   ------------------------------------------------------------------------- */

/* ─── Kiểu dữ liệu (mirror server/web-ui/src/lib/types.ts) ─────────────── */

interface ChatConversation {
  id: number;
  title: string | null;
  model: string | null;
  createdAt?: string;
  updatedAt?: string;
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null;
  toolCalls: unknown;
  toolCallId: string | null;
  commandId: number | null;
  status: string | null;
  createdAt: string;
}

interface ChatConversationDetail {
  conversation: ChatConversation;
  messages: ChatMessage[];
}

/* ─── Phản hồi từ service worker ──────────────────────────────────────── */

interface ConversationsResp extends BgResponse {
  conversations?: ChatConversation[];
}
interface CreateResp extends BgResponse {
  conversation?: ChatConversation;
}
interface DetailResp extends BgResponse {
  conversation?: ChatConversation;
  messages?: ChatMessage[];
}
interface SendResp extends BgResponse {
  waitingAsync?: boolean;
  content?: string | null;
  messages?: ChatMessage[];
}
interface ModelsResp extends BgResponse {
  models?: string[];
}

/* ─── Nhãn tiếng Việt (đồng bộ TOOLS trong server/web/chat.js) ─────────── */

const TOOL_LABEL: Record<string, string> = {
  list_groups: "Liệt kê nhóm",
  search_products: "Tìm sản phẩm",
  search_posts: "Tìm bài viết",
  list_pending_advisories: "Tư vấn chờ duyệt",
  list_conversations: "Liệt kê hội thoại",
  get_overview: "Tổng quan",
  create_post: "Đăng bài",
  create_comment: "Bình luận",
  crawl_group: "Crawl nhóm",
  scan_groups: "Quét nhóm",
  approve_advisory: "Duyệt tư vấn",
  approve_conversation: "Duyệt hội thoại",
  delete_post: "Xoá bài",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Chờ xử lý",
  running: "Đang chạy",
  completed: "Hoàn thành",
  failed: "Lỗi",
  expired: "Hết hạn",
};

/** Màu badge trạng thái — dùng token màu của UI extension. */
const STATUS_STYLE: Record<string, string> = {
  pending: "border-amber-soft bg-amber-soft/20 text-amber",
  running: "border-blue-soft bg-blue-soft/20 text-blue",
  completed: "border-green-soft bg-green-soft/25 text-green",
  failed: "border-red-soft bg-red-soft/25 text-red",
  expired: "border-line bg-surface text-ink-faint",
};

/** Trạng thái tin còn "sống" → cần tiếp tục poll. */
const NON_TERMINAL = new Set(["pending", "running"]);

/** Sentinel cho lựa chọn "dùng model mặc định của tài khoản". */
const DEFAULT_MODEL = "__default__";

interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function toolCallName(tc: ToolCall): string {
  const name = tc?.function?.name || "";
  return TOOL_LABEL[name] || name || "tool";
}

/** Cắt tool_calls từ giá trị JSON (server đã parse sẵn, vẫn phòng thủ). */
function extractToolCalls(raw: unknown): ToolCall[] {
  if (Array.isArray(raw)) return raw as ToolCall[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ToolCall[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function fmtTime(value?: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function convTitle(c: ChatConversation): string {
  return c.title?.trim() || `Hội thoại #${c.id}`;
}

/* ─── Component chính ─────────────────────────────────────────────────── */

export function ChatAI() {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ChatConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState<ChatConversation | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<ChatConversation | null>(null);

  // Model picker.
  const [modelList, setModelList] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messages = detail?.messages ?? [];

  /** Có tin nhắn tool async nào đang chờ extension chạy xong không. */
  const hasPending = useMemo(
    () =>
      messages.some(
        (m) =>
          m.commandId != null && m.status != null && NON_TERMINAL.has(m.status),
      ),
    [messages],
  );

  const modelOverride = model === DEFAULT_MODEL ? undefined : model;

  /* ─── Tải dữ liệu ───────────────────────────────────────────────────── */

  const loadConversations = useCallback(async () => {
    setListLoading(true);
    const res = await bg<ConversationsResp>("GET_CHAT_CONVERSATIONS");
    setListLoading(false);
    if (!res.ok) {
      setError(res.error || "Không tải được danh sách hội thoại.");
      return;
    }
    const list = res.conversations ?? [];
    setConversations(list);
    // Tự chọn hội thoại đầu nếu chưa chọn gì.
    setActiveId((cur) => (cur == null && list.length > 0 ? list[0].id : cur));
  }, []);

  const loadDetail = useCallback(
    async (id: number, opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setDetailLoading(true);
      const res = await bg<DetailResp>("GET_CHAT_DETAIL", { id });
      if (!opts.silent) setDetailLoading(false);
      if (!res.ok || !res.conversation) {
        if (!opts.silent)
          setError(res.error || "Không tải được nội dung hội thoại.");
        return;
      }
      setDetail({
        conversation: res.conversation,
        messages: res.messages ?? [],
      });
    },
    [],
  );

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    const res = await bg<ModelsResp>("LIST_MODELS");
    setLoadingModels(false);
    if (res.ok && Array.isArray(res.models)) {
      setModelList(res.models);
    }
  }, []);

  // Nạp danh sách hội thoại + model khi mở view.
  useEffect(() => {
    void loadConversations();
    void loadModels();
  }, [loadConversations, loadModels]);

  // Đổi hội thoại → nạp chi tiết.
  useEffect(() => {
    if (activeId == null) {
      setDetail(null);
      return;
    }
    void loadDetail(activeId);
  }, [activeId, loadDetail]);

  // Đồng bộ model đang chọn theo model đã lưu của hội thoại.
  useEffect(() => {
    if (detail?.conversation) {
      setModel(detail.conversation.model || DEFAULT_MODEL);
    }
  }, [detail?.conversation]);

  // Cuộn xuống cuối khi có tin mới.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, detailLoading]);

  // Poll khi còn tool async đang chạy (kết quả về sau qua vòng feedback ở BE).
  useEffect(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
    if (activeId == null || !hasPending) return;
    pollRef.current = setTimeout(() => {
      void loadDetail(activeId, { silent: true });
    }, 3000);
    return () => {
      if (pollRef.current) {
        clearTimeout(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeId, hasPending, messages, loadDetail]);

  /* ─── Hành động ─────────────────────────────────────────────────────── */

  async function onNewConversation() {
    setError(null);
    const res = await bg<CreateResp>("CREATE_CHAT_CONVERSATION", {
      model: modelOverride ?? null,
    });
    if (!res.ok || !res.conversation) {
      setError(res.error || "Không tạo được hội thoại mới.");
      return;
    }
    const conv = res.conversation;
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setDetail({ conversation: conv, messages: [] });
  }

  /** Đảm bảo có một hội thoại đang mở, tạo mới nếu chưa có. Trả id hoặc null. */
  async function ensureConversation(): Promise<number | null> {
    if (activeId != null) return activeId;
    const res = await bg<CreateResp>("CREATE_CHAT_CONVERSATION", {
      model: modelOverride ?? null,
    });
    if (!res.ok || !res.conversation) {
      setError(res.error || "Không tạo được hội thoại mới.");
      return null;
    }
    const conv = res.conversation;
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    setDetail({ conversation: conv, messages: [] });
    return conv.id;
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    setSending(true);

    const id = await ensureConversation();
    if (id == null) {
      setSending(false);
      return;
    }

    // Optimistic: hiện ngay tin của người dùng.
    const optimistic: ChatMessage = {
      id: -Date.now(),
      role: "user",
      content: text,
      toolCalls: null,
      toolCallId: null,
      commandId: null,
      status: null,
      createdAt: new Date().toISOString(),
    };
    setDetail((prev) =>
      prev
        ? { ...prev, messages: [...prev.messages, optimistic] }
        : prev,
    );
    setInput("");

    const res = await bg<SendResp>("SEND_CHAT_MESSAGE", {
      id,
      text,
      model: modelOverride ?? null,
    });
    setSending(false);

    if (!res.ok) {
      setError(res.error || "Gửi tin nhắn thất bại.");
      // Nạp lại chi tiết để bỏ tin optimistic nếu server không lưu.
      void loadDetail(id, { silent: true });
      return;
    }

    // Server trả toàn bộ messages sau lượt này → thay thế luôn cho chuẩn.
    if (Array.isArray(res.messages)) {
      setDetail((prev) =>
        prev ? { ...prev, messages: res.messages as ChatMessage[] } : prev,
      );
    } else {
      void loadDetail(id, { silent: true });
    }
    // Cập nhật tiêu đề hội thoại trong sidebar (server có thể tự đặt title).
    void loadConversations();
  }

  function openRename(c: ChatConversation) {
    setRenaming(c);
    setRenameValue(c.title || "");
  }

  async function onRenameSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    const title = renameValue.trim();
    const target = renaming;
    setRenaming(null);
    const res = await bg("RENAME_CHAT_CONVERSATION", {
      id: target.id,
      title,
    });
    if (!res.ok) {
      setError(res.error || "Đổi tên thất bại.");
      return;
    }
    setConversations((prev) =>
      prev.map((c) => (c.id === target.id ? { ...c, title } : c)),
    );
    setDetail((prev) =>
      prev && prev.conversation.id === target.id
        ? { ...prev, conversation: { ...prev.conversation, title } }
        : prev,
    );
  }

  async function onDeleteConfirm() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    const res = await bg("DELETE_CHAT_CONVERSATION", { id: target.id });
    if (!res.ok) {
      setError(res.error || "Xoá hội thoại thất bại.");
      return;
    }
    setConversations((prev) => prev.filter((c) => c.id !== target.id));
    if (activeId === target.id) {
      setActiveId(null);
      setDetail(null);
    }
  }

  /* ─── Render ────────────────────────────────────────────────────────── */

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* ── Sidebar hội thoại ── */}
      <aside className="flex w-60 shrink-0 flex-col overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
          <span className="text-sm font-semibold text-ink">Hội thoại</span>
          <button
            type="button"
            onClick={onNewConversation}
            title="Tạo hội thoại mới"
            className="inline-flex items-center gap-1 rounded-md border border-line bg-bg px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:border-accent/50 hover:text-ink"
          >
            <MessageSquarePlus className="size-3.5" />
            Mới
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {listLoading ? (
            <div className="flex flex-col gap-1.5 p-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-11 animate-pulse rounded-md bg-line/60"
                />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-3 py-8 text-center text-xs text-ink-faint">
              Chưa có hội thoại. Bấm “Mới” để bắt đầu.
            </div>
          ) : (
            conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <div
                  key={c.id}
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-2 py-1.5 transition-colors",
                    active
                      ? "bg-accent-soft/40 text-ink"
                      : "text-ink-soft hover:bg-line/40",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(c.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm font-medium">
                      {convTitle(c)}
                    </div>
                    <div className="truncate text-[11px] text-ink-faint">
                      {c.model || "Model mặc định"}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      title="Đổi tên"
                      onClick={() => openRename(c)}
                      className="grid size-6 place-items-center rounded text-ink-faint hover:bg-line/60 hover:text-ink"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Xoá"
                      onClick={() => setDeleting(c)}
                      className="grid size-6 place-items-center rounded text-ink-faint hover:bg-red-soft/40 hover:text-red"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* ── Khung chat ── */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-line bg-surface">
        {/* Thanh model */}
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Bot className="size-4 text-accent" />
          <span className="text-xs font-medium text-ink-soft">Model:</span>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-xs text-ink outline-none focus:border-accent/60"
          >
            <option value={DEFAULT_MODEL}>Mặc định của tài khoản</option>
            {modelList.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            type="button"
            title="Tải lại danh sách model"
            onClick={loadModels}
            disabled={loadingModels}
            className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-bg text-ink-soft transition-colors hover:border-accent/50 hover:text-ink disabled:opacity-50"
          >
            <RefreshCw
              className={cn("size-3.5", loadingModels && "animate-spin")}
            />
          </button>
        </div>

        {error ? (
          <div className="flex items-start gap-2 border-b border-red-soft bg-red-soft/15 px-3 py-2 text-xs text-red">
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 text-red/70 hover:text-red"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}

        {/* Danh sách tin nhắn */}
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
        >
          {activeId == null ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-ink-faint">
              <Bot className="size-8 text-ink-faint/60" />
              <p>
                Chọn một hội thoại hoặc gõ tin nhắn để bắt đầu trò chuyện với
                Trợ lý AI.
              </p>
            </div>
          ) : detailLoading ? (
            <div className="flex h-full items-center justify-center text-ink-faint">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-ink-faint">
              <Bot className="size-8 text-ink-faint/60" />
              <p>
                Hỏi bất cứ điều gì — hoặc yêu cầu Trợ lý điều khiển công cụ
                (crawl nhóm, đăng bài, duyệt tư vấn…).
              </p>
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {(sending || hasPending) && (
                <div className="flex items-center gap-2 text-xs text-ink-faint">
                  <Loader2 className="size-3.5 animate-spin" />
                  {hasPending
                    ? "Đang chờ công cụ chạy xong…"
                    : "Trợ lý đang trả lời…"}
                </div>
              )}
            </>
          )}
        </div>

        {/* Ô nhập */}
        <form
          onSubmit={onSend}
          className="flex items-center gap-2 border-t border-line px-3 py-2.5"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Nhập tin nhắn cho Trợ lý AI…"
            className="min-w-0 flex-1 rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent/60"
          />
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Gửi
          </button>
        </form>
      </section>

      {/* ── Modal đổi tên ── */}
      {renaming ? (
        <Overlay onClose={() => setRenaming(null)}>
          <form onSubmit={onRenameSubmit} className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Đổi tên hội thoại</h3>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              placeholder="Tên hội thoại"
              className="rounded-md border border-line bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-accent/60"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRenaming(null)}
                className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
              >
                Huỷ
              </button>
              <button
                type="submit"
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent/90"
              >
                Lưu
              </button>
            </div>
          </form>
        </Overlay>
      ) : null}

      {/* ── Modal xoá ── */}
      {deleting ? (
        <Overlay onClose={() => setDeleting(null)}>
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-ink">Xoá hội thoại?</h3>
            <p className="text-sm text-ink-soft">
              “{convTitle(deleting)}” cùng toàn bộ tin nhắn sẽ bị xoá vĩnh viễn.
              Hành động này không thể hoàn tác.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleting(null)}
                className="rounded-md border border-line bg-bg px-3 py-1.5 text-sm text-ink-soft hover:text-ink"
              >
                Huỷ
              </button>
              <button
                type="button"
                onClick={onDeleteConfirm}
                className="rounded-md bg-red px-3 py-1.5 text-sm font-medium text-white hover:bg-red/90"
              >
                Xoá
              </button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}

/* ─── Modal nhẹ (không phụ thuộc thư viện ngoài) ──────────────────────── */

function Overlay({
  children,
  onClose,
}: {
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-modal grid place-items-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/* ─── Bong bóng tin nhắn ──────────────────────────────────────────────── */

function MessageBubble({ message }: { message: ChatMessage }) {
  const { role, content } = message;

  // Tin công cụ (role=tool): hiển thị gọn dạng kết quả.
  if (role === "tool") {
    return (
      <div className="flex items-start gap-2 text-xs text-ink-faint">
        <Wrench className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="font-medium">Kết quả công cụ</span>
          {message.status ? (
            <span
              className={cn(
                "ml-2 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium",
                STATUS_STYLE[message.status] || "border-line text-ink-faint",
              )}
            >
              {STATUS_LABEL[message.status] || message.status}
            </span>
          ) : null}
          {content ? (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 text-[11px]">
              {content}
            </pre>
          ) : null}
        </div>
      </div>
    );
  }

  const isUser = role === "user";
  const toolCalls = extractToolCalls(message.toolCalls);

  return (
    <div className={cn("flex gap-2", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-full",
          isUser ? "bg-accent text-on-accent" : "bg-line text-ink-soft",
        )}
      >
        {isUser ? <User className="size-4" /> : <Bot className="size-4" />}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-[80%] rounded-lg px-3 py-2 text-sm",
          isUser ? "bg-accent text-on-accent" : "bg-bg text-ink",
        )}
      >
        {content ? (
          <p className="whitespace-pre-wrap break-words">{content}</p>
        ) : null}

        {/* Badge cho các tool assistant vừa gọi */}
        {toolCalls.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {toolCalls.map((tc, i) => (
              <span
                key={tc.id || i}
                className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-soft"
              >
                <Wrench className="size-3" />
                {toolCallName(tc)}
              </span>
            ))}
          </div>
        ) : null}

        {/* Trạng thái action-tool async gắn với tin này */}
        {message.commandId != null && message.status ? (
          <span
            className={cn(
              "mt-2 inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium",
              STATUS_STYLE[message.status] || "border-line text-ink-faint",
            )}
          >
            {STATUS_LABEL[message.status] || message.status}
          </span>
        ) : null}

        <div
          className={cn(
            "mt-1 text-[10px]",
            isUser ? "text-on-accent/70" : "text-ink-faint",
          )}
        >
          {fmtTime(message.createdAt)}
        </div>
      </div>
    </div>
  );
}
