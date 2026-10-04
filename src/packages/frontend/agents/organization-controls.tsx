import { useId, useRef, useState } from "react";
import { Button, Segmented, Space, Switch, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function AgentOrganizationControls({
  showLabel = true,
  mode,
  groupByProject,
  onMode,
  onGroupByProject,
  onNewAgent,
}: {
  mode: "recent" | "custom";
  groupByProject: boolean;
  onMode: (mode: "recent" | "custom") => void;
  onGroupByProject: (value: boolean) => void;
  onNewAgent: () => void;
  // Hidden when a sidebar section header already says "Agents".
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <KeyboardBoundary
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      {showLabel && (
        <Typography.Text
          type="secondary"
          style={{ display: "block", marginTop: 8 }}
        >
          Agents
        </Typography.Text>
      )}
      {/* One row: the create action, with organizing tucked beside it. */}
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <Button
          type="text"
          icon={<Icon name="plus" />}
          onClick={onNewAgent}
          style={{ flex: "1 1 auto", justifyContent: "flex-start" }}
        >
          New agent
        </Button>
        <Button
          ref={trigger}
          type="text"
          size="small"
          aria-label="Organize agents"
          aria-expanded={open}
          aria-controls={id}
          icon={<Icon name="sliders" />}
          onClick={() => setOpen((value) => !value)}
        />
      </div>
      <div id={id} hidden={!open}>
        <Segmented
          block
          aria-label="Agent ordering"
          options={[
            { label: "Recent", value: "recent" },
            { label: "Custom", value: "custom" },
          ]}
          value={mode}
          onChange={(value) => onMode(value as "recent" | "custom")}
        />
        <Space style={{ marginTop: 8 }}>
          <Switch
            size="small"
            aria-label="Group agents by project"
            checked={groupByProject}
            onChange={(value) => onGroupByProject(value)}
          />
          <span>Group by project</span>
        </Space>
      </div>
    </KeyboardBoundary>
  );
}
