import { Button } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import type { ReactNode } from "react";
import { AgentsSidebarToggle } from "./workspace-sidebar-toggle";

export function WorkspaceSidebarActions({
  onProjects,
  onNewAgent,
  children,
  footer,
  onHideSidebar,
}: {
  onProjects?: () => void;
  onNewAgent: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  onHideSidebar?: () => void;
}) {
  return (
    <>
      <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center" }}>
        <Button
          type="text"
          icon={<Icon name="plus" />}
          onClick={onNewAgent}
          style={{ justifyContent: "flex-start", flex: 1 }}
        >
          New Agent
        </Button>
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
          overflowY: "auto",
          overflowX: "hidden",
          marginTop: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          {onProjects && (
            <Button
              type="text"
              block
              icon={<Icon name="folder-open" />}
              onClick={onProjects}
              style={{ justifyContent: "flex-start" }}
            >
              Projects
            </Button>
          )}
          {children}
        </div>
      </div>
      {footer && <div style={{ flex: "0 0 auto" }}>{footer}</div>}
    </>
  );
}
