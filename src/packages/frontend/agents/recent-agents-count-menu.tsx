/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The sidebar's "Recent" heading: a menu choosing how many recent agents it
// shows (J6). Keyboard: Enter or Space opens it, the arrow keys move, Enter
// chooses, Escape closes; focus returns to the heading either way (not
// when a click on another control closed it).

import { useEffect, useId, useRef, useState } from "react";
import { Button, Dropdown } from "antd";
import { Icon } from "@cocalc/frontend/components";
import { UI_COLORS } from "@cocalc/util/appearance-palette";
import { SIDEBAR_RECENT_AGENTS_CHOICES } from "./sidebar-recent";

export function RecentAgentsCountMenu({
  title,
  count,
  onChange,
}: {
  title: string;
  count: number;
  onChange: (count: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = `recent-agents-count-${useId().replace(/:/g, "")}`;
  // Keyboard users land in the menu (arrow keys move, Enter chooses), not
  // on the page behind it.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => document.getElementById(menuId)?.focus(), 0);
    return () => clearTimeout(timer);
  }, [open, menuId]);
  const close = () => {
    setOpen(false);
    // Back to the heading, whether a count was chosen or not; but a click
    // on another control outside the menu keeps the focus it gave that one.
    setTimeout(() => {
      const active = document.activeElement;
      if (
        active == null ||
        active === document.body ||
        document.getElementById(menuId)?.contains(active)
      ) {
        button.current?.focus();
      }
    }, 0);
  };
  return (
    <Dropdown
      trigger={["click"]}
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      menu={{
        selectable: true,
        selectedKeys: [`${count}`],
        id: menuId,
        "aria-label": "How many recent agents to show",
        items: SIDEBAR_RECENT_AGENTS_CHOICES.map((n) => ({
          key: `${n}`,
          label: `Show ${n} recent agents`,
        })),
        onClick: ({ key }) => {
          onChange(Number(key));
          close();
        },
      }}
    >
      <Button
        ref={button}
        type="text"
        size="small"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Recent agents: showing ${count}. Change how many`}
        style={{ color: UI_COLORS.secondary, padding: "0 6px" }}
      >
        {title} <Icon name="caret-down" />
      </Button>
    </Dropdown>
  );
}
