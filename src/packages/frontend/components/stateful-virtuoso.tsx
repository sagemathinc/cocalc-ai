import LRUCache from "lru-cache";
import { ForwardedRef, forwardRef, useImperativeHandle, useRef } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import type { StateSnapshot } from "react-virtuoso";

interface CoreProps extends React.ComponentProps<typeof Virtuoso> {
  cacheId: string;
  initialIndex?: number;
}

const STORAGE_KEY = "cocalc-stateful-virtuoso-cache";
type SnapshotEnvelope = {
  snapshot: StateSnapshot;
  savedAt: number;
  viewportHeight?: number;
  scrollHeight?: number;
};

const cache = new LRUCache<string, SnapshotEnvelope>({ max: 500 });
const SAVE_THROTTLE_MS = 50;
const PERSIST_THROTTLE_MS = 1000;
const DEFAULT_VIEWPORT = 1000;
const MIN_SNAPSHOT_VIEWPORT_PX = 80;
const MIN_SNAPSHOT_SCROLL_HEIGHT_PX = 120;

const hasStorage =
  typeof window !== "undefined" &&
  typeof window.localStorage !== "undefined" &&
  (() => {
    try {
      const key = "__stateful_virtuoso_probe__";
      window.localStorage.setItem(key, "1");
      window.localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  })();

// Restore any previously saved scroll snapshots.
if (hasStorage) {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const entries: [string, StateSnapshot][] = JSON.parse(raw);
      if (Array.isArray(entries)) {
        for (const [k, v] of entries as any[]) {
          if (v && typeof v === "object" && "snapshot" in v && v.snapshot) {
            cache.set(k, {
              snapshot: v.snapshot as StateSnapshot,
              savedAt:
                typeof v.savedAt === "number" ? v.savedAt : Date.now(),
              viewportHeight:
                typeof v.viewportHeight === "number"
                  ? v.viewportHeight
                  : undefined,
              scrollHeight:
                typeof v.scrollHeight === "number" ? v.scrollHeight : undefined,
            });
            continue;
          }
          cache.set(k, {
            snapshot: v as StateSnapshot,
            savedAt: Date.now(),
          });
        }
      }
    }
  } catch {
    // ignore storage errors – persistence is best-effort
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
const schedulePersist = () => {
  if (!hasStorage) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const payload = Array.from(cache.entries());
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore persistence errors – keep runtime behavior intact
    }
  }, PERSIST_THROTTLE_MS);
};

function StatefulVirtuosoCore(
  { cacheId, initialTopMostItemIndex, initialScrollTop, ...rest }: CoreProps,
  ref: ForwardedRef<VirtuosoHandle>,
) {
  const virtRef = useRef<VirtuosoHandle | null>(null);
  const scrollerRef = useRef<any>(null);
  const snapshotRef = useRef<StateSnapshot | undefined>(undefined);
  const savingRef = useRef<boolean>(false);

  const canSaveState = () => {
    if (typeof document !== "undefined" && document.hidden) return false;
    const node = scrollerRef.current;
    if (!node) return true;
    const height = node.clientHeight ?? 0;
    const scrollHeight = node.scrollHeight ?? 0;
    if (height < MIN_SNAPSHOT_VIEWPORT_PX) return false;
    if (scrollHeight < MIN_SNAPSHOT_SCROLL_HEIGHT_PX) return false;
    if (scrollHeight <= height + 8) return false;
    return true;
  };

  const cached = cacheId ? cache.get(cacheId) : undefined;
  if (cached && snapshotRef.current == null) {
    snapshotRef.current = cached.snapshot;
  } else if (!cached && snapshotRef.current == null) {
    snapshotRef.current = undefined;
  }

  const saveState = () => {
    if (!canSaveState()) return;
    if (savingRef.current || !virtRef.current) return;
    savingRef.current = true;
    setTimeout(() => {
      virtRef.current?.getState((snapshot) => {
        snapshotRef.current = snapshot;
        if (cacheId) {
          const node = scrollerRef.current;
          cache.set(cacheId, {
            snapshot,
            savedAt: Date.now(),
            viewportHeight: node?.clientHeight ?? undefined,
            scrollHeight: node?.scrollHeight ?? undefined,
          });
          schedulePersist();
        }
        savingRef.current = false;
      });
    }, SAVE_THROTTLE_MS);
  };

  useImperativeHandle(ref, () => virtRef.current as VirtuosoHandle, []);

  // Respect user-provided refs/handlers.
  const {
    ref: restRef,
    scrollerRef: restScrollerRef,
    onScroll: userOnScroll,
    itemsRendered: userItemsRendered,
    ...restProps
  } = rest as React.ComponentProps<typeof Virtuoso>;

  const handleRef = (handle: VirtuosoHandle | null) => {
    virtRef.current = handle;
    if (typeof restRef === "function") {
      restRef(handle);
    } else if (restRef && typeof restRef === "object") {
      (restRef as React.RefObject<VirtuosoHandle | null>).current = handle;
    }
  };

  const handleScrollerRef = (ref: any) => {
    scrollerRef.current = ref;
    if (typeof restScrollerRef === "function") {
      restScrollerRef(ref);
    } else if (restScrollerRef && typeof restScrollerRef === "object") {
      (restScrollerRef as React.RefObject<any>).current = ref;
    }
  };

  return (
    <Virtuoso
      restoreStateFrom={snapshotRef.current}
      increaseViewportBy={DEFAULT_VIEWPORT}
      ref={handleRef}
      scrollerRef={handleScrollerRef}
      onScroll={(...args) => {
        saveState();
        userOnScroll?.(...args);
      }}
      itemsRendered={(items) => {
        if (items.length === 0) return;
        userItemsRendered?.(items as any);
      }}
      {...(snapshotRef.current == null && initialTopMostItemIndex != null
        ? { initialTopMostItemIndex }
        : {})}
      {...(snapshotRef.current == null && initialScrollTop != null
        ? { initialScrollTop }
        : {})}
      {...restProps}
    />
  );
}

const StatefulVirtuosoCoreWithRef = forwardRef<VirtuosoHandle, CoreProps>(
  StatefulVirtuosoCore,
);

// Public component that remounts the core when cacheId changes, so all refs
// and timers are fresh for a new identity.
function StatefulVirtuoso(props: CoreProps, ref: ForwardedRef<VirtuosoHandle>) {
  const { cacheId, ...rest } = props;
  if (!cacheId) {
    console.warn("StatefulVirtuoso requires a cacheId for state persistence.");
  }
  return (
    <StatefulVirtuosoCoreWithRef
      key={cacheId ?? "default"}
      cacheId={cacheId}
      {...rest}
      ref={ref}
    />
  );
}

export default forwardRef<VirtuosoHandle, CoreProps>(StatefulVirtuoso);
