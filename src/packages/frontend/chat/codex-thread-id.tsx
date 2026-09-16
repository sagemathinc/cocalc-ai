import { Form, Input } from "antd";
import CopyButton from "@cocalc/frontend/components/copy-button";

export function CodexThreadId({ threadId }: { threadId?: string }) {
  const value = threadId?.trim();
  if (!value) return null;
  return (
    <Form.Item
      label="Thread ID"
      tooltip="The stable chat thread ID for project chat send. This is different from the Codex Session ID."
      style={{ marginTop: 12, marginBottom: 0 }}
    >
      <div style={{ display: "flex", gap: 4 }}>
        <Input
          aria-label="Thread ID"
          readOnly
          value={value}
          onFocus={(event) => event.target.select()}
          style={{ fontFamily: "monospace", minWidth: 0 }}
        />
        <CopyButton value={value} noText ariaLabel="Copy thread ID" />
      </div>
    </Form.Item>
  );
}
