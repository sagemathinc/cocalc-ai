import { Button, Dropdown } from "antd";
import { useRef, useState } from "react";
import { Icon } from "@cocalc/frontend/components";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export type ComposerDelivery = "agent" | "queue" | "post";

const DELIVERY_LABELS: Record<ComposerDelivery, string> = {
  agent: "To Agent",
  queue: "Queue",
  post: "Post",
};

export function ComposerDeliverySelector({
  value,
  onChange,
  canQueue = false,
  canPost = true,
}: {
  value: ComposerDelivery;
  onChange: (value: ComposerDelivery) => void;
  canQueue?: boolean;
  canPost?: boolean;
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
            key: "queue",
            icon: <Icon name="clock" />,
            label: (
              <div>
                <strong>Queue</strong> <kbd>Alt+Enter</kbd>
                <div style={{ whiteSpace: "normal" }}>
                  Send after the running turn finishes, without interrupting it.
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
                  Not sent now. You can send this post to the agent later.
                </div>
              </div>
            ),
          },
        ].filter(({ key }) =>
          key === "queue" ? canQueue : key === "post" ? canPost : true,
        ),
      }}
    >
      <Button
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        type="text"
        size="small"
        style={{ color: UI_COLORS.secondary }}
        aria-label={`Message delivery: ${DELIVERY_LABELS[value]}`}
      >
        {DELIVERY_LABELS[value]} <Icon name="caret-down" />
      </Button>
    </Dropdown>
  );
}
