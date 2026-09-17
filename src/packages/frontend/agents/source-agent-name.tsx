import { useId, useRef, useState } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import {
  personalAgentApi,
  refreshNamedAgents,
  sameEndpoint,
  useNamedAgents,
} from "./api";
import { AgentNameInput, agentNameProblem } from "./agent-name-input";
import { useBoundAgentAccount } from "./use-bound-account";
import { cachedAgentNameContext } from "./name-context";
import type { AgentNameContext } from "./name-context";
import { namedAgentLimitReached, NamedAgentLimitAlert } from "./agent-limit";

/** Name metadata is saved only inside the explicitly approved action, before its grant. */
export function useSourceAgentName(
  source: AgentEndpoint | undefined,
  fallback?: NamedAgent,
  busy = false,
  context?: AgentNameContext,
) {
  const id = useId();
  const account = useBoundAgentAccount();
  const { directory, loading, error } = useNamedAgents();
  const key = JSON.stringify(source);
  const [draft, setDraft] = useState({ key, name: "" });
  const saved = useRef<NamedAgent | undefined>(undefined);
  const name = draft.key === key ? draft.name : "";
  const known =
    source &&
    (directory?.agents.find((agent) => sameEndpoint(agent.endpoint, source)) ??
      (saved.current && sameEndpoint(saved.current.endpoint, source)
        ? saved.current
        : undefined) ??
      (fallback && sameEndpoint(fallback.endpoint, source)
        ? fallback
        : undefined));
  const problem = agentNameProblem(name, directory?.agents ?? [], source);
  const atLimit = namedAgentLimitReached(directory);
  const canApprove =
    !!known ||
    (!!source && !!directory && !loading && !error && !problem && !atLimit);
  return {
    known,
    canApprove,
    field:
      !source || known ? null : (
        <>
          <p>
            Name this source agent before approving communication. The name is
            in your account.
          </p>
          <NamedAgentLimitAlert directory={directory} />
          <AgentNameInput
            id={`${id}-source-name`}
            label="Source agent name"
            value={name}
            onChange={(name) => setDraft({ key, name })}
            problem={name.trim() ? problem : undefined}
            busy={busy}
          />
          {loading && <div role="status">Loading your agent names...</div>}
          {error && (
            <div role="alert">Unable to load your agent names: {error}</div>
          )}
        </>
      ),
    async ensureNamed(): Promise<NamedAgent> {
      account.assertCurrent();
      if (known) return known;
      if (!source || !canApprove)
        throw new Error(problem || "Load your agent names before approving.");
      // Native requests may be reviewed outside their project. Resolve identity
      // metadata only on this explicit save; never open a remote transcript.
      const locator = context ?? (await personalAgentApi().getIdentity(source));
      account.assertCurrent();
      if (locator.project_id !== source.project_id)
        throw new Error("The source agent changed. Review the request again.");
      const result = await personalAgentApi().nameAgent({
        endpoint: source,
        name: normalizeAgentName(name),
        ...cachedAgentNameContext(locator),
      });
      account.assertCurrent();
      saved.current = result;
      refreshNamedAgents();
      return result;
    },
  };
}
