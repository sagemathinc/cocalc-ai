import { useEffect, useRef, useState } from "react";
import { Alert } from "antd";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  FreshAuthModal,
  useFreshAuthAction,
} from "@cocalc/frontend/auth/fresh-auth";
import {
  agentMentionReferenceMap,
  extractAgentMentions,
} from "@cocalc/util/agent-mentions";
import type { AgentMentionReference } from "@cocalc/util/agent-mentions";
import { personalAgentApi, sameEndpoint, useNamedAgents } from "./api";
import { ConnectionApproval } from "./connection-approval";
import type { ApprovalTarget } from "./connection-approval";
import { hasUnboundAgentName } from "./unbound-mentions";

export function useAgentMentions({
  projectId,
  path,
  threadId,
  threadTitle,
  runnable,
  restoreFocus,
}: {
  projectId: string;
  path: string;
  threadId?: string;
  threadTitle?: string;
  runnable: boolean;
  restoreFocus: () => void;
}) {
  const accountId = useTypedRedux("account", "account_id");
  const { directory } = useNamedAgents();
  const [approval, setApproval] = useState<ApprovalTarget>();
  const [error, setError] = useState("");
  const [states, setStates] = useState<Record<string, string>>({});
  const pending = useRef<((approved: boolean) => void) | undefined>(undefined);
  const selectionLock = useRef(false);
  const sendLock = useRef(false);
  const generation = useRef(0);
  const { runFreshAuthAction, freshAuthModalProps } = useFreshAuthAction();
  useEffect(() => {
    generation.current += 1;
    setApproval(undefined);
    setError("");
    setStates({});
    return () => {
      generation.current += 1;
      pending.current?.(false);
      pending.current = undefined;
    };
  }, [accountId, projectId, path, threadId]);

  function closeApproval(approved: boolean) {
    setApproval(undefined);
    const resolve = pending.current;
    pending.current = undefined;
    resolve?.(approved);
    // Restore the existing editor selection rather than writing a new draft.
    setTimeout(restoreFocus, 0);
  }

  async function sourceEndpoint(
    epoch: number,
  ): Promise<AgentEndpoint | undefined> {
    if (!threadId)
      throw new Error(
        "Create an agent thread before connecting a named agent. Your draft has not been sent.",
      );
    const api = personalAgentApi();
    let identity = await api.resolveIdentity({
      project_id: projectId,
      path,
      thread_id: threadId,
    });
    if (!identity) {
      const completed = await runFreshAuthAction(async () => {
        if (epoch !== generation.current) return;
        identity = await api.registerIdentity({
          project_id: projectId,
          path,
          thread_id: threadId,
        });
      });
      if (!completed) return;
    }
    if (!identity || epoch !== generation.current) return;
    return { project_id: projectId, agent_id: identity.agent_id };
  }

  async function check(
    reference: AgentMentionReference,
    epoch: number,
  ): Promise<boolean> {
    const source = await sourceEndpoint(epoch);
    if (!source) return false;
    const api = personalAgentApi();
    const target = await api.getIdentity(reference.target);
    if (
      target.disabled_at ||
      target.agent_id !== reference.target.agent_id ||
      target.project_id !== reference.target.project_id
    )
      throw new Error(
        `@${reference.name} is unavailable. Remove or replace its reference before sending.`,
      );
    const connections = await api.listPersonalConnections({});
    if (epoch !== generation.current) return false;
    if (!connections.enabled)
      throw new Error("Personal agent messaging is not enabled on this site.");
    if (connections.controls?.paused)
      throw new Error(
        "Your agent communication is paused. Resume it in My Agents before sending.",
      );
    const links = connections.connections.filter(
      (connection) =>
        sameEndpoint(connection.source, source) &&
        sameEndpoint(connection.target, reference.target),
    );
    const active = links.some(
      (link) =>
        link.status === "active" &&
        !link.paused &&
        !link.revoked_at &&
        (!link.expires_at || Date.parse(link.expires_at) > Date.now()),
    );
    const stateKey = reference.target.agent_id;
    if (active) {
      setStates((states) => ({ ...states, [stateKey]: "Connected" }));
      return true;
    }
    if (
      links.some(
        (link) => link.status === "paused" || link.status === "revoked",
      )
    )
      throw new Error(
        `Communication with @${reference.name} was paused or revoked. Explicitly re-enable it in My Agents; your draft has not been sent.`,
      );
    setStates((states) => ({ ...states, [stateKey]: "Needs approval" }));
    if (pending.current) return false;
    const approved = await new Promise<boolean>((resolve) => {
      pending.current = resolve;
      const sourceName = directory?.agents.find((agent) =>
        sameEndpoint(agent.endpoint, source),
      );
      const targetName = directory?.agents.find((agent) =>
        sameEndpoint(agent.endpoint, reference.target),
      );
      setApproval({
        source,
        target: reference.target,
        sourceLabel: sourceName
          ? `@${sourceName.name}`
          : (threadTitle ?? "This agent"),
        targetLabel: `@${reference.name}`,
        sourceName,
        targetName,
        namingAccountId: reference.naming_account_id,
      });
    });
    if (!approved || epoch !== generation.current) return false;
    // Approval does not snapshot permission. Confirm the resulting state before sending.
    const refreshed = await api.listPersonalConnections({});
    const connected =
      !refreshed.controls?.paused &&
      refreshed.connections.some(
        (link) =>
          sameEndpoint(link.source, source) &&
          sameEndpoint(link.target, reference.target) &&
          link.status === "active" &&
          !link.paused &&
          !link.revoked_at &&
          (!link.expires_at || Date.parse(link.expires_at) > Date.now()),
      );
    if (!connected)
      throw new Error(
        "The connection is not active. Your draft has not been sent.",
      );
    setStates((states) => ({ ...states, [stateKey]: "Connected" }));
    return true;
  }

  async function onSelect(reference: AgentMentionReference) {
    if (!runnable || selectionLock.current || sendLock.current) return;
    selectionLock.current = true;
    setError("");
    try {
      await check(reference, generation.current);
    } catch (err) {
      setError(`${err}`);
    } finally {
      selectionLock.current = false;
    }
  }

  async function preflight(value: string, send: () => void | Promise<void>) {
    // Do not change the synchronous normal-chat send path when no agent
    // reference needs preflight. The lock belongs to the approval flow only.
    if (
      !runnable ||
      (!extractAgentMentions(value).length &&
        !directory?.agents.some((agent) =>
          hasUnboundAgentName(value, agent.name),
        ))
    ) {
      await send();
      return;
    }
    if (sendLock.current || selectionLock.current) return;
    sendLock.current = true;
    setError("");
    const epoch = generation.current;
    try {
      if (runnable) {
        const unresolved = directory?.agents.find((agent) =>
          hasUnboundAgentName(value, agent.name),
        );
        if (unresolved)
          throw new Error(
            `Resolve @${unresolved.name} using the named-agent suggestion below the composer, or select it from the @ picker before sending.`,
          );
        const references = extractAgentMentions(value);
        agentMentionReferenceMap(references);
        for (const reference of references) {
          if (!(await check(reference, epoch))) return;
        }
      }
      if (epoch === generation.current) await send();
    } catch (err) {
      setError(`${err}`);
    } finally {
      sendLock.current = false;
    }
  }

  return {
    accountId,
    agents: directory?.agents ?? [],
    context: {
      onSelect: (reference: AgentMentionReference) => {
        void onSelect(reference);
      },
      states,
    },
    preflight,
    namedAgent: directory?.agents.find(
      (agent) =>
        agent.endpoint.project_id === projectId &&
        agent.path === path &&
        agent.thread_id === threadId,
    ),
    ui: (
      <>
        {error && (
          <div role="alert">
            <Alert
              type="warning"
              title="Agent mention needs attention"
              description={
                <>
                  {error} <a href="/settings/my-agents">My Agents</a>
                </>
              }
            />
          </div>
        )}
        {Object.entries(states).some(
          ([, state]) => state === "Needs approval",
        ) && (
          <div role="status">
            Agent reference needs approval. Your draft is preserved; Send will
            check again.
          </div>
        )}
        {approval && (
          <ConnectionApproval value={approval} onClose={closeApproval} />
        )}
        <FreshAuthModal {...freshAuthModalProps} />
      </>
    ),
  };
}
