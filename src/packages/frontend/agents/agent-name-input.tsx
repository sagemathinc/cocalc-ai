import { useState } from "react";
import { InfoCircleOutlined } from "@ant-design/icons";
import { Button, Input } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { UI_COLORS } from "@cocalc/util/appearance-palette";

export function agentNameProblem(
  value: string,
  agents: NamedAgent[],
  current?:
    | AgentEndpoint
    | { project_id: string; path: string; thread_id: string },
): string | undefined {
  let name: string;
  try {
    name = normalizeAgentName(value);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const taken = agents.find((agent) => agent.name === name);
  if (!taken) return;
  const same =
    current &&
    taken.endpoint.project_id === current.project_id &&
    ("agent_id" in current
      ? taken.endpoint.agent_id === current.agent_id
      : taken.path === current.path && taken.thread_id === current.thread_id);
  if (!same)
    return `@${name} is already used by another agent in your account.`;
}

export function isAgentNameRename(
  value: string,
  currentName: string | undefined,
): boolean {
  if (!currentName) return false;
  try {
    return normalizeAgentName(value) !== normalizeAgentName(currentName);
  } catch {
    return false;
  }
}

export function AgentNameInput({
  id,
  value,
  onChange,
  problem,
  busy,
  onEnter,
  autoFocus = true,
  label = "Agent name",
  showRetirementWarning = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  problem?: string;
  busy?: boolean;
  onEnter?: () => void;
  autoFocus?: boolean;
  label?: string;
  showRetirementWarning?: boolean;
}) {
  const [showRequirements, setShowRequirements] = useState(false);
  const requirementsId = `${id}-requirements`;
  const retirementId = `${id}-retirement`;
  const problemId = `${id}-problem`;
  const describedBy = [
    showRequirements ? requirementsId : undefined,
    showRetirementWarning ? retirementId : undefined,
    problem ? problemId : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <div
        style={{
          alignItems: "baseline",
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "space-between",
        }}
      >
        <label htmlFor={id}>{label}</label>
        <Button
          type="link"
          size="small"
          htmlType="button"
          icon={<InfoCircleOutlined />}
          aria-label="Agent name requirements"
          aria-expanded={showRequirements}
          aria-controls={requirementsId}
          title="Name requirements"
          onClick={() => setShowRequirements((value) => !value)}
          style={{ height: "auto", padding: 0 }}
        />
      </div>
      <Input
        id={id}
        autoFocus={autoFocus}
        value={value}
        maxLength={32}
        disabled={busy}
        aria-invalid={!!problem}
        aria-describedby={describedBy || undefined}
        onChange={(event) => onChange(event.target.value)}
        onPressEnter={onEnter}
      />
      <div id={requirementsId} hidden={!showRequirements}>
        Use 1-32 letters, digits, or internal hyphens, beginning with a letter.
        Availability is checked again when saved.
      </div>
      {showRetirementWarning && (
        <div id={retirementId} role="status" aria-live="polite">
          The old name will be retired when you save this rename.
        </div>
      )}
      {problem && (
        <div
          id={problemId}
          role="status"
          aria-live="polite"
          style={{ color: UI_COLORS.danger }}
        >
          {problem}
        </div>
      )}
    </>
  );
}
