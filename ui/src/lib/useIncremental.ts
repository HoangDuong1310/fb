import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function didIncrementalItemsChange<T>(previous: T[], current: T[]): boolean {
  return (
    previous.length !== current.length ||
    previous.some((item, index) => !Object.is(item, current[index]))
  );
}

/**
 * useIncremental — render a large list in chunks instead of all at once.
 *
 * Renders only the first `pageSize` items, then reveals more as a sentinel
 * element scrolls into view (or via loadMore()). This keeps the DOM small so
 * the first paint is fast and scrolling stays smooth even with thousands of
 * source rows. Purely client-side windowing — no backend/API changes needed.
 *
 * The window resets only when the list's CONTENT changes. Many callers derive
 * arrays with filter()/sort() during render, so array identity alone is not a
 * valid reset signal: resetting on every new reference makes loadMore() jump
 * immediately back to the first page.
 */
export function useIncremental<T, E extends HTMLElement = HTMLDivElement>(
  items: T[],
  opts: { pageSize?: number } = {},
) {
  const pageSize = opts.pageSize ?? 12;
  const [count, setCount] = useState(pageSize);
  const sentinelRef = useRef<E | null>(null);
  const previousItemsRef = useRef(items);

  // Reset only when item content/order changed, not merely because filter()/sort()
  // returned a fresh array reference containing the same item objects.
  useLayoutEffect(() => {
    const previous = previousItemsRef.current;
    previousItemsRef.current = items;
    if (didIncrementalItemsChange(previous, items)) setCount(pageSize);
  }, [items, pageSize]);

  const total = items.length;
  const shown = Math.min(count, total);
  const hasMore = shown < total;

  const loadMore = useCallback(() => {
    setCount((c) => Math.min(items.length, c + pageSize));
  }, [items.length, pageSize]);

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
