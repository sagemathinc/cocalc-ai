import type { ReactNode } from "react";
import { useState } from "react";
import { APP_ICON } from "@cocalc/frontend/art";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { AgentsSidebarToggle } from "./workspace-sidebar-toggle";

export function WorkspaceSidebarActions({
  firstNavigationItem,
  children,
  footer,
  headerActions,
  onHideSidebar,
  fillHeight = false,
}: {
  firstNavigationItem: ReactNode;
  // The children divide the height between themselves and scroll on their
  // own (collapsible sidebar sections) instead of scrolling as one list.
  fillHeight?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  // Shown beside the hide-sidebar control (e.g. notifications).
  headerActions?: ReactNode;
  onHideSidebar?: () => void;
}) {
  const [brandFocused, setBrandFocused] = useState(false);
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flex: "0 0 auto",
          padding: "8px 4px 8px 12px",
          gap: 8,
        }}
      >
        <a
          href={appBasePath || "/"}
          aria-label="CoCalc home"
          onFocus={() => setBrandFocused(true)}
          onBlur={() => setBrandFocused(false)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flex: 1,
            minWidth: 0,
            color: UI_COLORS.text,
            fontSize: 22,
            fontWeight: 600,
            textDecoration: "none",
            borderRadius: 4,
            outline: brandFocused ? `2px solid ${UI_COLORS.focus}` : undefined,
            outlineOffset: 2,
          }}
        >
          {/* Shares its page-transition name with the landing page's logo. */}
          <img
            className="cocalc-vt-logo"
            src={APP_ICON}
            alt=""
            width={32}
            height={32}
          />
          CoCalc
        </a>
        {headerActions}
        {onHideSidebar && (
          <AgentsSidebarToggle hidden={false} onToggle={onHideSidebar} />
        )}
      </div>
      <div
        role="region"
        aria-label="Agent navigation and list"
        tabIndex={0}
        style={{
          flex: "1 1 0",
          minHeight: 0,
          minWidth: 0,
          overflowY: fillHeight ? "hidden" : "auto",
          overflowX: "hidden",
          ...(fillHeight ? { display: "flex", flexDirection: "column" } : {}),
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            ...(fillHeight ? { flex: "1 1 0", minHeight: 0 } : {}),
          }}
        >
          {firstNavigationItem}
          {children}
        </div>
      </div>
      {footer && <div style={{ flex: "0 0 auto" }}>{footer}</div>}
    </>
  );
}
