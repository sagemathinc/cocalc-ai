import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import { refreshNamedAgents } from "./api";

export function AgentDirectoryContent({
  hasDirectory,
  error,
  children,
}: {
  hasDirectory: boolean;
  error?: string;
  children: ReactNode;
}) {
  return (
    <>
      {error && (
        <Alert
          type="error"
          showIcon
          title="Unable to load agents"
          description={error}
          action={<Button onClick={refreshNamedAgents}>Retry directory</Button>}
        />
      )}
      {hasDirectory && children}
    </>
  );
}
