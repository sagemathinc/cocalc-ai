import { useState } from "react";
import { Alert, Modal, Space, Typography } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { AgentNameInput, agentNameProblem } from "./agent-name-input";

// Keep typing local so it does not rerender the workspace and mounted chats.
export function CopyAgentModal({
  agent,
  agents,
  initialName,
  busy,
  error,
  onCopy,
  onCancel,
}: {
  agent: NamedAgent;
  agents: NamedAgent[];
  initialName: string;
  busy: boolean;
  error: string;
  onCopy: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const problem = agentNameProblem(name, agents);
  const submit = () => {
    if (!busy && !problem) onCopy(name);
  };
  return (
    <Modal
      title={`Copy @${agent.name}`}
      open
      okText="Copy agent"
      okButtonProps={{ loading: busy, disabled: busy || !!problem }}
      cancelButtonProps={{ disabled: busy }}
      onOk={submit}
      onCancel={() => !busy && onCancel()}
    >
      <Space orientation="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text>
          Copy the Codex context into a new named agent linked to this
          conversation. Project, working directory, model, reasoning, and
          payment source are preserved. The description starts blank.
        </Typography.Text>
        <AgentNameInput
          id="copy-agent-name"
          value={name}
          onChange={setName}
          problem={name.trim() ? problem : undefined}
          busy={busy}
          onEnter={submit}
        />
        {error && <Alert role="alert" type="error" showIcon title={error} />}
      </Space>
    </Modal>
  );
}
