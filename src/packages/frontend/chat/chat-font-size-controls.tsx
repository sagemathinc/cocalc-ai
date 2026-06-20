/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button } from "antd";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import { COLORS } from "@cocalc/util/theme";

interface ChatFontSizeControlsProps {
  fontSize: number;
  onDecreaseFontSize?: () => void;
  onIncreaseFontSize?: () => void;
  canDecreaseFontSize?: boolean;
  canIncreaseFontSize?: boolean;
  embedded?: boolean;
  label?: string;
  tooltipLabel?: string;
}

function ToolbarDivider(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        flexShrink: 0,
        width: 1,
        height: 16,
        background: COLORS.GRAY_LL,
      }}
    />
  );
}

export function ChatFontSizeControls({
  fontSize,
  onDecreaseFontSize,
  onIncreaseFontSize,
  canDecreaseFontSize = true,
  canIncreaseFontSize = true,
  embedded = false,
  label = "Chat text size",
  tooltipLabel = "Chat",
}: ChatFontSizeControlsProps): React.JSX.Element {
  return (
    <div
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        height: 28,
        ...(embedded
          ? undefined
          : {
              padding: "0 7px",
              marginRight: 8,
              border: `1px solid ${COLORS.GRAY_LL}`,
              borderRadius: 7,
              background: "white",
            }),
        whiteSpace: "nowrap",
      }}
    >
      <Tooltip title={`Decrease chat font size (${fontSize}px)`}>
        <Button
          size="small"
          type="text"
          disabled={!canDecreaseFontSize || onDecreaseFontSize == null}
          onClick={onDecreaseFontSize}
          style={{ minWidth: 24, height: 22, padding: "0 4px" }}
        >
          <Icon name="minus" />
        </Button>
      </Tooltip>
      <Tooltip title={`${tooltipLabel} font size: ${fontSize}px`}>
        <ToolbarDivider />
      </Tooltip>
      <Tooltip title={`Increase chat font size (${fontSize}px)`}>
        <Button
          size="small"
          type="text"
          disabled={!canIncreaseFontSize || onIncreaseFontSize == null}
          onClick={onIncreaseFontSize}
          style={{ minWidth: 24, height: 22, padding: "0 4px" }}
        >
          <Icon name="plus" />
        </Button>
      </Tooltip>
      {embedded ? <ToolbarDivider /> : null}
    </div>
  );
}
