/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { useRef, useState } from "react";
import type { RefObject } from "react";
import { Button, Dropdown } from "antd";
import type { MenuProps } from "antd";
import { Icon } from "@cocalc/frontend/components/icon";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export function MessageActionsMenu({
  items,
  triggerRef,
}: {
  items: MenuProps["items"];
  triggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  return (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      open={open}
      autoFocus
      onOpenChange={setOpen}
      menu={{
        items,
        onClick: () => {
          setOpen(false);
          trigger.current?.focus();
        },
      }}
      popupRender={(menu) => (
        <KeyboardBoundary
          boundary="message-actions"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") event.preventDefault();
            if (event.key === "Escape") {
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          {menu}
        </KeyboardBoundary>
      )}
    >
      <Button
        ref={trigger}
        type="text"
        size="small"
        aria-label="More message actions"
        aria-haspopup="menu"
        aria-expanded={open}
        icon={<Icon name="ellipsis" />}
      />
    </Dropdown>
  );
}
