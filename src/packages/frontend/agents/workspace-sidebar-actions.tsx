import { Button } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { Tooltip } from "@cocalc/frontend/components/tip";

export function WorkspaceSidebarActions({
  onProjects,
  onNewAgent,
}: {
  onProjects?: () => void;
  onNewAgent: () => void;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {onProjects && (
        <Tooltip title="Your projects, courses, and files.">
          <Button icon={<Icon name="edit" />} onClick={onProjects}>
            Projects
          </Button>
        </Tooltip>
      )}
      <Button
        type="primary"
        icon={<Icon name="plus" />}
        onClick={onNewAgent}
        style={{ flex: 1 }}
      >
        New Agent
      </Button>
    </div>
  );
}
