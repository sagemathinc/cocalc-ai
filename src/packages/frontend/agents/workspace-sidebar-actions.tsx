import { Button } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";

export function WorkspaceSidebarActions({
  onProjects,
  onNewAgent,
}: {
  onProjects?: () => void;
  onNewAgent: () => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Button
        type="text"
        block
        icon={<Icon name="plus" />}
        onClick={onNewAgent}
        style={{ justifyContent: "flex-start" }}
      >
        New Agent
      </Button>
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
    </div>
  );
}
