import { Button } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";

export function WorkspaceSidebarActions({
  onNewAgent,
}: {
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
    </div>
  );
}
