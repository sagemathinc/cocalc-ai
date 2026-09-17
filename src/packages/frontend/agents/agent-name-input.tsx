import { Input } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";

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

export function AgentNameInput({
  id,
  value,
  onChange,
  problem,
  busy,
  onEnter,
  label = "Agent name",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  problem?: string;
  busy?: boolean;
  onEnter?: () => void;
  label?: string;
}) {
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        autoFocus
        value={value}
        maxLength={32}
        disabled={busy}
        aria-invalid={!!problem}
        aria-describedby={`${id}-help ${id}-availability`}
        onChange={(event) => onChange(event.target.value)}
        onPressEnter={onEnter}
      />
      <div id={`${id}-help`}>
        1-32 letters, digits or internal hyphens, beginning with a letter. Old
        names are retired after renaming.
      </div>
      <div id={`${id}-availability`} role="status" aria-live="polite">
        {value.trim()
          ? (problem ??
            "No conflict in your loaded agent names. Availability is checked again when saved.")
          : "Choose a name for this agent in your account."}
      </div>
    </>
  );
}
