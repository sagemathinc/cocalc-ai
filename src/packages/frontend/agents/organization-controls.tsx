import type { ReactNode } from "react";
import { useId, useRef, useState } from "react";
import { Button, Segmented, Space, Switch, Typography } from "antd";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function AgentOrganizationControls({
  mode,
  groupByProject,
  onMode,
  onGroupByProject,
  onNewAgent,
  filterInput,
  open: openProp,
  onOpenChange,
}: {
  mode: "recent" | "custom";
  groupByProject: boolean;
  onMode: (mode: "recent" | "custom") => void;
  onGroupByProject: (value: boolean) => void;
  onNewAgent: () => void;
  // A sticky filter, shown (and applied) only while the panel is open.
  filterInput?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean | ((value: boolean) => boolean)) => {
    const value = typeof next === "function" ? next(open) : next;
    setOpenState(value);
    onOpenChange?.(value);
  };
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
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: 8,
        }}
      >
        <Typography.Text type="secondary">Agents</Typography.Text>
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
      <Button
        block
        type="text"
        icon={<Icon name="plus" />}
        onClick={onNewAgent}
        style={{ justifyContent: "flex-start", marginTop: 8 }}
      >
        New Agent
      </Button>
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
        {filterInput && <div style={{ marginTop: 8 }}>{filterInput}</div>}
      </div>
    </KeyboardBoundary>
  );
}
