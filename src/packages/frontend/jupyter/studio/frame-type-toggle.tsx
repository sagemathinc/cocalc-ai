import { Button, Popconfirm } from "antd";
import { useRef, useState } from "react";
import { KeyboardBoundary } from "@cocalc/frontend/keyboard/boundary";
import { useFrameContext } from "@cocalc/frontend/frame-editors/frame-tree/frame-context";

export function SwitchToClassicButton(_props: { iconsOnly?: boolean } = {}) {
  const { actions, id } = useFrameContext();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <KeyboardBoundary
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancel();
        }
      }}
    >
      <Popconfirm
        title="Studio is experimental"
        okText="Return to classic"
        cancelText="Stay in Studio"
        open={open}
        onOpenChange={setOpen}
        onCancel={cancel}
        onConfirm={() => {
          setOpen(false);
          actions.set_frame_type(id, "jupyter_cell_notebook");
        }}
      >
        <Button ref={trigger} type="text" size="small" aria-expanded={open}>
          Studio
        </Button>
      </Popconfirm>
    </KeyboardBoundary>
  );
}
