/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/**
 * Right-hand controls of the compact kernel header while a notebook frame is
 * in studio mode: layout width Segmented, Reading switch, help popover, and the
 * switch back to the classic notebook view.
 */

import { Segmented, Switch } from "antd";

import { Icon, Tooltip } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { SwitchToClassicButton } from "./frame-type-toggle";
import StudioNotebookHelp from "./studio-help";
import type { StudioLayout } from "./types";

const READING_MODE_LABEL = "Reading";

interface StudioControlsProps {
  studioLayout?: StudioLayout;
  availableLayouts?: readonly StudioLayout[];
  onLayoutChange: (layout: StudioLayout) => void;
  readingMode?: boolean;
  onReadingModeChange?: (reading: boolean) => void;
  /** Very narrow frame: keep the icons, drop the text labels. */
  iconsOnly?: boolean;
}

function Divider() {
  return (
    <div
      style={{
        borderLeft: `1px solid ${UI_COLORS.muted}`,
        height: "18px",
      }}
    />
  );
}

export function StudioControls({
  studioLayout,
  availableLayouts,
  onLayoutChange,
  readingMode,
  onReadingModeChange,
  iconsOnly,
}: StudioControlsProps) {
  return (
    <>
      <Divider />
      <Segmented
        size="small"
        className="studio-status-segmented"
        value={studioLayout ?? "comfortable"}
        onChange={(v) => onLayoutChange(v as StudioLayout)}
        options={[
          {
            value: "wide",
            label: (
              <Tooltip title="Full width">
                <Icon name="column-width" />
              </Tooltip>
            ),
          },
          {
            value: "comfortable",
            disabled: !availableLayouts?.includes("comfortable"),
            label: (
              <Tooltip title="Comfortable width">
                <Icon name="pic-centered" rotate="90" />
              </Tooltip>
            ),
          },
          {
            value: "narrow",
            disabled: !availableLayouts?.includes("narrow"),
            label: (
              <Tooltip title="Narrow, centered">
                <Icon name="vertical-align-middle" rotate="90" />
              </Tooltip>
            ),
          },
        ].filter((o) => availableLayouts?.includes(o.value as any) ?? true)}
      />
      {onReadingModeChange && (
        <Tooltip title={readingMode ? "Show code cells" : "Hide code cells"}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              cursor: "pointer",
            }}
            onClick={() => onReadingModeChange(!readingMode)}
          >
            {/* The visible label is a sibling of the switch, so name the
                control explicitly rather than relying on proximity. */}
            {/* The wrapper owns the toggle so the label is clickable too;
                keyboard activation of the switch bubbles up to it. */}
            <Switch
              size="small"
              aria-label={READING_MODE_LABEL}
              checked={readingMode}
            />
            {!iconsOnly && (
              <span aria-hidden style={{ userSelect: "none" }}>
                {READING_MODE_LABEL}
              </span>
            )}
          </span>
        </Tooltip>
      )}
      <Divider />
      <StudioNotebookHelp iconsOnly={iconsOnly} />
      {/* direct flex child: blockified, so no baseline descender space; the
          header's own padding provides the gap to the frame edge */}
      <SwitchToClassicButton iconsOnly={iconsOnly} />
    </>
  );
}
