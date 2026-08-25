/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Button, Dropdown, type MenuProps } from "antd";
import { useState, type CSSProperties } from "react";

import { Icon } from "@cocalc/frontend/components/icon";

interface MoreElementActionsDropdownProps {
  buttonStyle?: CSSProperties;
  items: MenuProps["items"];
}

export function MoreElementActionsDropdown({
  buttonStyle,
  items,
}: MoreElementActionsDropdownProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dropdown
      menu={{ items }}
      trigger={["click"]}
      open={open}
      onOpenChange={setOpen}
    >
      <Button
        aria-label="More element actions"
        aria-expanded={open}
        style={buttonStyle}
      >
        <Icon name="ellipsis-vertical" />
      </Button>
    </Dropdown>
  );
}
