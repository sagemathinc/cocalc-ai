/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { Drawer } from "antd";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import {
  APP_DOCS_DRAWER_OPEN_EVENT,
  type AppDocsDrawerOpenDetail,
} from "./navigation";

const DocsPanel = lazy(() =>
  import("@cocalc/frontend/project/page/flyouts/docs").then((module) => ({
    default: module.ProjectDocsPanel,
  })),
);
// Keep the existing agent drawer preference when sharing its shell elsewhere.
const WIDTH_STORAGE_KEY = "cocalc-agents-docs-drawer-width-v1";

function clampWidth(width: number): number {
  const maximum =
    typeof window === "undefined" ? 960 : Math.max(320, window.innerWidth - 32);
  return Math.min(maximum, Math.max(Math.min(360, maximum), width));
}

function initialWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    return clampWidth(Number.isFinite(stored) && stored > 0 ? stored : 720);
  } catch {
    return clampWidth(720);
  }
}

export function DocsDrawer({
  children,
  open,
  onClose,
  returnFocus,
}: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  returnFocus?: HTMLElement;
}) {
  const [width, setWidth] = useState(initialWidth);
  useEffect(() => {
    const resize = () => setWidth((value) => clampWidth(value));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return (
    <Drawer
      destroyOnHidden={false}
      open={open}
      placement="right"
      title="Documentation"
      size={width}
      resizable={{
        onResize: (next) => {
          setWidth(clampWidth(next));
          try {
            window.localStorage.setItem(
              WIDTH_STORAGE_KEY,
              `${clampWidth(next)}`,
            );
          } catch {
            // Resizing still works without localStorage.
          }
        },
      }}
      onClose={onClose}
      afterOpenChange={(visible) => {
        if (!visible && returnFocus) {
          // The drawer also restores its captured focus during this callback.
          // Restore the current opener after that, especially on later opens.
          requestAnimationFrame(() => {
            if (returnFocus.isConnected) returnFocus.focus();
          });
        }
      }}
      styles={{ body: { overflow: "auto", padding: "12px 0 0 14px" } }}
    >
      <KeyboardBoundary boundary="documentation">{children}</KeyboardBoundary>
    </Drawer>
  );
}

/** One persistent host for help opened from account pages and navigation. */
export function AppDocsDrawer() {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<{ slug?: string }>();
  const returnFocus = useRef<HTMLElement | undefined>(undefined);
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<AppDocsDrawerOpenDetail>).detail;
      returnFocus.current =
        detail.returnFocus ??
        (document.activeElement instanceof HTMLElement
          ? document.activeElement
          : undefined);
      setRequest({ slug: detail.slug });
      setOpen(true);
    };
    window.addEventListener(APP_DOCS_DRAWER_OPEN_EVENT, handleOpen);
    return () =>
      window.removeEventListener(APP_DOCS_DRAWER_OPEN_EVENT, handleOpen);
  }, []);
  return (
    <DocsDrawer
      open={open}
      onClose={() => setOpen(false)}
      returnFocus={returnFocus.current}
    >
      {request && (
        <Suspense fallback={<div role="status">Loading documentation…</div>}>
          <DocsPanel layout="flyout" request={request} />
        </Suspense>
      )}
    </DocsDrawer>
  );
}
