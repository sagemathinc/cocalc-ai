/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Popconfirm } from "antd";

import { Icon } from "@cocalc/frontend/components/icon";
import { MINIMAP_BUTTON_STYLE } from "./controls";

interface Props {
  onConfirm: () => void;
}

export function MinimapHideButton({ onConfirm }: Props) {
  return (
    <Popconfirm
      placement="leftBottom"
      title="Hide minimap?"
      description="You can show it again from the View menu."
      okText="Hide"
      cancelText="Cancel"
      onConfirm={onConfirm}
    >
      <Button
        aria-label="Hide minimap"
        title="Hide minimap"
        size="small"
        icon={<Icon name="eye-slash" />}
        style={MINIMAP_BUTTON_STYLE}
      />
    </Popconfirm>
  );
}
