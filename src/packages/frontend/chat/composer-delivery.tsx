import { Button, Dropdown } from "antd";
import { useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";

export type ComposerDelivery = "agent" | "post";

export function ComposerDeliverySelector({
  value,
  onChange,
}: {
  value: ComposerDelivery;
  onChange: (value: ComposerDelivery) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={["click"]}
      placement="topRight"
      autoFocus
      popupRender={(menu) => (
        <KeyboardBoundary
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          {menu}
        </KeyboardBoundary>
      )}
      menu={{
        style: {
          width: 300,
          maxWidth: "calc(100vw - 24px)",
          whiteSpace: "normal",
        },
        selectable: true,
        selectedKeys: [value],
        onClick: ({ key }) => {
          setOpen(false);
          triggerRef.current?.focus();
          onChange(key as ComposerDelivery);
        },
        items: [
          {
            key: "agent",
            icon: <Icon name="robot" />,
            label: (
              <div>
                <strong>To Agent</strong> <kbd>Shift+Enter</kbd>
                <div style={{ whiteSpace: "normal" }}>
                  Ask the agent, or steer its running turn.
                </div>
              </div>
            ),
          },
          {
            key: "post",
            icon: <Icon name="comment" />,
            label: (
              <div>
                <strong>Post</strong> <kbd>Ctrl+Enter</kbd>
                <div style={{ whiteSpace: "normal" }}>
                  Not sent to the agent
                </div>
              </div>
            ),
          },
        ],
      }}
    >
      <Button
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        type="text"
        size="small"
        aria-label={`Message delivery: ${value === "agent" ? "To Agent" : "Post"}`}
      >
        {value === "agent" ? "To Agent" : "Post"} <Icon name="caret-down" />
      </Button>
    </Dropdown>
  );
}
