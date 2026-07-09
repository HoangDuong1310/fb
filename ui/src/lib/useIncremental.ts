import { useCallback, useEffect, useRef, useState } from "react";

/**
 * useIncremental — render a large list in chunks instead of all at once.
 *
 * Renders only the first `pageSize` items, then reveals more as a sentinel
 * element scrolls into view (or via loadMore()). This keeps the DOM small so
 * the first paint is fast and scrolling stays smooth even with thousands of
 * source rows. Purely client-side windowing — no backend/API changes needed.
 *
 * The window resets to the first page whenever the source array identity
 * changes (e.g. after a refetch or when filters recompute the list).
 */
export function useIncremental<T, E extends HTMLElement = HTMLDivElement>(
  items: T[],
  opts: { pageSize?: number } = {},
) {
  const pageSize = opts.pageSize ?? 12;
  const [count, setCount] = useState(pageSize);
  const sentinelRef = useRef<E | null>(null);

  // Reset to first page when the source list changes (refetch / filter change).
  useEffect(() => {
    setCount(pageSize);
  }, [items, pageSize]);

  const total = items.length;
  const shown = Math.min(count, total);
  const hasMore = shown < total;

  const loadMore = useCallback(() => {
    setCount((c) => c + pageSize);
  }, [pageSize]);

  // Auto-reveal the next chunk as the sentinel nears the viewport.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  return {
    visible: items.slice(0, shown),
    sentinelRef,
    hasMore,
    loadMore,
    shown,
    total,
  };
}
