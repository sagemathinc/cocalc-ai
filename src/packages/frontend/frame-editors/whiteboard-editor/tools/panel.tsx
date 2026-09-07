import { UI_COLORS } from "@cocalc/util/appearance-palette";
/*

Floating panel from which you can select a tool.

*/
import { Button, Divider, Typography } from "antd";
import { ReactNode, useEffect } from "react";

import { CSS } from "@cocalc/frontend/app-framework";
import { Tooltip } from "@cocalc/frontend/components";
import { Icon } from "@cocalc/frontend/components/icon";
import { r_join } from "@cocalc/frontend/components/r_join";
import { useFrameContext } from "../hooks";
import { MAX_ELEMENTS } from "../math";
import { SELECTED, SELECTED_FG } from "./common";
import { Tool, TOOLS } from "./desc";
export const PANEL_STYLE: CSS = {
  zIndex: MAX_ELEMENTS + 1,
  position: "absolute",
  fontSize: "18px",
  boxShadow: `0 0 5px ${UI_COLORS.shadow}`,
  borderRadius: "3px",
  margin: "10px",
  background: UI_COLORS.elevated,
  color: UI_COLORS.text,
} as const;

interface Props {
  selectedTool: Tool;
  readOnly?: boolean;
  minimizedTools?: boolean;
  setMinimizedTools?: (boolean) => void;
}

export default function Panel({
  selectedTool,
  readOnly,
  minimizedTools,
  setMinimizedTools,
}: Props) {
  const { actions, id } = useFrameContext();
  useEffect(() => {
    // ensure that in readonly mode the only possibly selected tool is select or hand.
    // this could happen if switch from non-read only to read only, or switch entire frame
    // from whiteboard to timetravel
    if (readOnly && selectedTool != "select" && selectedTool != "hand") {
      actions.setSelectedTool(id, "hand");
    }
  }, [readOnly]);
  const v: ReactNode[] = [
    <Tooltip title="Toggle toolbar" key="toggle">
      <Button
        type="text"
        size="small"
        style={{
          color: UI_COLORS.secondary,
          background: minimizedTools ? undefined : UI_COLORS.inset,
        }}
        onClick={() => {
          setMinimizedTools?.(!minimizedTools);
        }}
      >
        <Icon name="tool" />
      </Button>
    </Tooltip>,
  ];
  if (!minimizedTools) {
    for (const tool in TOOLS) {
      if (TOOLS[tool].hideFromToolbar) continue;
      if (readOnly && !TOOLS[tool].readOnly) continue;
      v.push(
        <ToolButton key={tool} tool={tool} isSelected={tool == selectedTool} />,
      );
    }
    v.push(<SnapToggleButton key="snap-toggle" />);
  }
  return (
    <div
      style={{
        ...PANEL_STYLE,
        width: "46px",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {v}
    </div>
  );
}

function ToolButton({ tool, isSelected }) {
  const { actions, id } = useFrameContext();
  const { icon, tip, key, onClick } = TOOLS[tool];
  return (
    <Tooltip
      placement="right"
      title={
        key == null ? (
          tip
        ) : (
          <>
            {tip} <Key keys={key} />
          </>
        )
      }
    >
      <Button
        type="text"
        onClick={() => {
          if (onClick) {
            onClick(actions, id);
          } else {
            actions.setSelectedTool(id, tool);
          }
        }}
        style={isSelected ? { color: "#fff", background: SELECTED } : undefined}
      >
        <Icon
          name={icon}
          style={{
            fontSize: "16px",
          }}
        />
      </Button>
    </Tooltip>
  );
}

export function SnapToggleButton() {
  const { actions, id, desc } = useFrameContext();
  const snapEnabled = desc.get("snapToAlignment") !== false;
  return (
    <>
      <Divider style={{ margin: "2px 4px", minWidth: "auto", width: "auto" }} />
      <Tooltip
        placement="right"
        title={
          snapEnabled
            ? "Snap to alignment enabled (hold Shift to move freely)"
            : "Snap to alignment disabled"
        }
      >
        <Button
          type="text"
          aria-label="Snap to alignment"
          aria-pressed={snapEnabled}
          onClick={() => {
            actions.set_frame_tree({
              id,
              snapToAlignment: !snapEnabled,
            });
          }}
          style={
            snapEnabled
              ? { color: SELECTED_FG, background: SELECTED }
              : { opacity: 0.5 }
          }
        >
          <Icon name="aim" style={{ fontSize: "16px" }} />
        </Button>
      </Tooltip>
    </>
  );
}

export function Key({ keys }: { keys: string | string[] }) {
  if (typeof keys == "string") {
    return <Typography.Text keyboard>{keys.toUpperCase()}</Typography.Text>;
  } else {
    return r_join(keys.map((k: string) => <Key key={k} keys={k} />));
  }
}
