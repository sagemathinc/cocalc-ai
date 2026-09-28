/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useEffect, useRef, useState } from "react";
import type { ComponentRef, ReactNode } from "react";
import { Alert, Button, Popover } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { VirtualCollectionContext } from "@cocalc/frontend/components/virtual-collection";
import type { DirectoryPage } from "./use-directory";

export function DirectoryResultOptions<T>({
  result,
  inline = false,
}: {
  result: DirectoryPage<T>;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<ComponentRef<typeof Button>>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  if (inline)
    return (
      <>
        <Button
          type="text"
          icon={<Icon name="refresh" />}
          onClick={result.refresh}
        >
          Refresh
        </Button>
        {result.page && result.page.coverage !== "complete" && (
          <details>
            <summary>About these results</summary>
            <p>
              {result.page.coverage_message ||
                "Only currently verified directory entries are shown. Older conversations may not have been discovered yet."}
            </p>
          </details>
        )}
      </>
    );
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      content={
        <KeyboardBoundary>
          <div
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-label="Results options"
            style={{ maxWidth: "min(320px, calc(100vw - 64px))" }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
          >
            <Button
              type="text"
              icon={<Icon name="refresh" />}
              onClick={() => {
                close();
                result.refresh();
              }}
            >
              Refresh
            </Button>
            {result.page?.coverage !== "complete" && result.page && (
              <>
                <h3 style={{ fontSize: 14 }}>About these results</h3>
                <p>
                  {result.page.coverage_message ||
                    "Only currently verified directory entries are shown. Older conversations may not have been discovered yet."}
                </p>
              </>
            )}
          </div>
        </KeyboardBoundary>
      }
    >
      <Button
        ref={trigger}
        type="text"
        aria-label="Results options"
        aria-haspopup="dialog"
        aria-expanded={open}
        icon={<Icon name="ellipsis" />}
      />
    </Popover>
  );
}

export function DirectoryResults<T>({
  result,
  label,
  children,
  empty = "No matches. Try another search or clear a filter.",
  onRestart,
  hideOptions = false,
  autoLoad = true,
  heading,
}: {
  result: DirectoryPage<T>;
  label: string;
  children: (items: T[]) => ReactNode;
  empty?: ReactNode;
  onRestart?: () => void;
  hideOptions?: boolean;
  autoLoad?: boolean;
  heading?: ReactNode;
}) {
  const { page, loading, loadingMore, error } = result;
  const root = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const requestedBy = useRef<HTMLElement | undefined>(undefined);
  const [scrollParent, setScrollParent] = useState<HTMLElement>();
  const next = useRef(result.next);
  next.current = result.next;
  useEffect(() => {
    if (loadingMore || !requestedBy.current) return;
    if (
      document.activeElement === document.body ||
      document.activeElement === requestedBy.current
    ) {
      // An explicit keyboard load reaching the final page must not lose focus
      // when its button disappears. Automatic scrolling never moves focus.
      if (!page?.next) (sentinel.current ?? root.current)?.focus();
    }
    requestedBy.current = undefined;
  }, [loadingMore, page, error]);
  useEffect(() => {
    let parent = root.current?.parentElement;
    while (parent && !/(auto|scroll)/.test(getComputedStyle(parent).overflowY))
      parent = parent.parentElement;
    setScrollParent(parent ?? undefined);
  }, []);
  useEffect(() => {
    if (
      !autoLoad ||
      !page?.next ||
      loading ||
      loadingMore ||
      !sentinel.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) next.current();
      },
      { root: scrollParent ?? null, rootMargin: "200px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [autoLoad, page?.next, loading, loadingMore, scrollParent]);
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={label}
      aria-busy={loading || loadingMore}
    >
      {(heading || !hideOptions) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
          }}
        >
          {heading && <div style={{ flex: 1, minWidth: 0 }}>{heading}</div>}
          {!hideOptions && <DirectoryResultOptions result={result} />}
        </div>
      )}
      {loading && !page && (
        <p role="status">Loading {label.toLowerCase()}...</p>
      )}
      {error && (
        <Alert
          role="alert"
          type="error"
          title={`Unable to load ${label.toLowerCase()}`}
          description={error}
          action={
            <>
              <Button onClick={result.refresh}>Retry</Button>
              {onRestart && (
                <Button onClick={onRestart}>Restart results</Button>
              )}
            </>
          }
        />
      )}
      {page && (
        <VirtualCollectionContext.Provider
          value={{ scrollParent, loadMore: result.next }}
        >
          {page.items.length ? (
            children(page.items)
          ) : (
            <p role="status">{empty}</p>
          )}
          {!page.items.length && page.coverage === "indexing" && (
            <p role="status">
              Some results could not yet be verified. Refresh or check Results
              options for details.
            </p>
          )}
          <div
            ref={sentinel}
            role="group"
            tabIndex={-1}
            aria-label="End of results"
            className={page.next ? "collaborators-load-more" : undefined}
          >
            {page.next && (
              <Button
                type="text"
                aria-disabled={loadingMore}
                onClick={(event) => {
                  if (loadingMore) return;
                  requestedBy.current = event.currentTarget;
                  result.next();
                }}
              >
                {loadingMore ? (
                  <span role="status">Loading more...</span>
                ) : (
                  "Load more"
                )}
              </Button>
            )}
          </div>
        </VirtualCollectionContext.Provider>
      )}
    </section>
  );
}
