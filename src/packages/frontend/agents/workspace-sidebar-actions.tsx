import { Button } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import type { ReactNode } from "react";

export function WorkspaceSidebarActions({
  onProjects,
  onNewAgent,
  children,
}: {
  onProjects?: () => void;
  onNewAgent: () => void;
  children?: ReactNode;
}) {
  return (
    <>
      <div style={{ flex: "0 0 auto" }}>
        <Button
          type="text"
          block
          icon={<Icon name="plus" />}
          onClick={onNewAgent}
          style={{ justifyContent: "flex-start" }}
        >
          New Agent
        </Button>
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
            minHeight: "100%",
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
    </>
  );
}
