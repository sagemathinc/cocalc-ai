import type { CSSProperties } from "react";
import { Button, Popconfirm } from "antd";

import { Tooltip } from "@cocalc/frontend/components";

export const SELECTED = "#337ab7";

export const WHITEBOARD_COMPACT_BUTTON_STYLE: CSSProperties = {
  minWidth: 0,
  height: "auto",
  padding: 0,
  lineHeight: 1,
  border: "none",
  boxShadow: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

export function ResetButton({ onClick }) {
  return (
    <Tooltip title="Reset to defaults" mouseEnterDelay={0.9} placement="bottom">
      <Popconfirm
        title="Reset the presets to their default settings?"
        onConfirm={onClick}
      >
        <Button
          type="text"
          style={{
            ...WHITEBOARD_COMPACT_BUTTON_STYLE,
            color: "#666",
            margin: "auto",
            padding: 0,
            fontSize: "12px",
          }}
        >
          Reset
        </Button>
      </Popconfirm>
    </Tooltip>
  );
}
