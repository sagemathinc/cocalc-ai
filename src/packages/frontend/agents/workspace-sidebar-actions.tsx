import type { ReactNode } from "react";
import { AgentsSidebarToggle } from "./workspace-sidebar-toggle";

export function WorkspaceSidebarActions({
  firstNavigationItem,
  children,
  footer,
  onHideSidebar,
}: {
  firstNavigationItem: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onHideSidebar?: () => void;
}) {
  return (
    <>
      <div
        role="region"
        aria-label="Agent navigation and list"
        tabIndex={0}
        style={{
          flex: "1 1 0",
          minHeight: 0,
          minWidth: 0,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 0 }}>{firstNavigationItem}</div>
            {onHideSidebar && (
              <AgentsSidebarToggle hidden={false} onToggle={onHideSidebar} />
            )}
          </div>
          {children}
        </div>
      </div>
      {footer && <div style={{ flex: "0 0 auto" }}>{footer}</div>}
    </>
  );
}
