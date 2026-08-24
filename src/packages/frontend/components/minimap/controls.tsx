/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The small control stack every minimap carries in its bottom-right corner:

    [ ⋮ ]   opens the minimap menu upwards
    [ 👁 ]  hides the minimap

Bottom-right keeps the controls out of the way of the document's beginning,
which is where the eye lands first.  The stack swallows its pointer events so
pressing a button never starts a drag on the rail underneath.
*/

import { Button, Dropdown } from "antd";
import React from "react";

import { Icon } from "@cocalc/frontend/components/icon";
import { MinimapHideButton } from "./hide-button";
import type { MinimapSettingsApi } from "./settings";
import { useMinimapMenuItems, type MinimapLabels } from "./settings-ui";

export const MINIMAP_BUTTON_STYLE: React.CSSProperties = {
  width: 20,
  minWidth: 20,
  height: 20,
  padding: 0,
};

interface Props {
  api: MinimapSettingsApi;
  labels?: MinimapLabels;
  onOpenSettings?: () => void;
}

export const MinimapControls: React.FC<Props> = ({
  api,
  labels,
  onOpenSettings,
}) => {
  const items = useMinimapMenuItems({ api, labels, onOpenSettings });
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <div
      data-cocalc-minimap-controls="1"
      style={{
        position: "absolute",
        right: 3,
        bottom: 3,
        zIndex: 5,
        display: "flex",
        flexDirection: "column",
        gap: "6px",
      }}
      onMouseDown={stop}
      onPointerDown={stop}
      onClick={stop}
    >
      <Dropdown menu={{ items }} trigger={["click"]} placement="topRight">
        <Button
          aria-label="Minimap options"
          title="Minimap options"
          size="small"
          icon={<Icon name="ellipsis" rotate="90" />}
          style={MINIMAP_BUTTON_STYLE}
        />
      </Dropdown>
      <MinimapHideButton onConfirm={() => api.setEnabled(false)} />
    </div>
  );
};
