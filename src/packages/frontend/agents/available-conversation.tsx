import { Alert, Button } from "antd";
import type { ReactNode } from "react";

export function AvailableConversation({
  available,
  retry,
  children,
}: {
  available: boolean;
  retry: () => void;
  children: ReactNode;
}) {
  if (available) return <>{children}</>;
  return (
    <Alert
      showIcon
      type="warning"
      title="Agent conversation unavailable"
      description="The project or agent is no longer accessible, or its server is temporarily unavailable. You can retry, create another agent, or remove this agent using its menu."
      action={<Button onClick={retry}>Retry connection</Button>}
    />
  );
}
