import { Button } from "antd";
import { useState } from "react";

export function MarkEverythingRead({
  disabled,
  onMarkRead,
}: {
  disabled: boolean;
  onMarkRead: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      disabled={disabled}
      loading={pending}
      onClick={async () => {
        setPending(true);
        try {
          await onMarkRead();
        } finally {
          setPending(false);
        }
      }}
    >
      Mark Everything Read
    </Button>
  );
}
