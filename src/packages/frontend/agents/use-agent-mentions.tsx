import { useEffect, useRef, useState } from "react";
import { Alert } from "antd";
import type { AgentEndpoint } from "@cocalc/conat/agents/rpc";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { openAccountSettings } from "@cocalc/frontend/account/settings-routing";
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
import { SessionApproval } from "./session-approval";
import type { SessionApprovalTarget } from "./session-approval";
import { hasUnboundAgentName } from "./unbound-mentions";
import { useAgentMessagingUI } from "./use-ui-preference";

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
  const enabled = useAgentMessagingUI();
  const { directory } = useNamedAgents(enabled && runnable);
  const [approval, setApproval] = useState<SessionApprovalTarget>();
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
  }, [accountId, projectId, path, threadId, enabled]);

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
    const sessions = await api.listAgentSessions({ limit: 100 });
    if (epoch !== generation.current) return false;
    if (sessions.controls.paused)
      throw new Error(
        "Your agent communication is paused. Resume it in Agents before sending.",
      );
    const active = sessions.sessions.some(
      (session) =>
        session.state === "active" &&
        session.members.some(
          (member) =>
            member.kind === "registered" &&
            sameEndpoint(member.endpoint, source),
        ) &&
        session.members.some(
          (member) =>
            member.kind === "registered" &&
            sameEndpoint(member.endpoint, reference.target),
        ),
    );
    const stateKey = reference.target.agent_id;
    if (active) {
      setStates((states) => ({ ...states, [stateKey]: "Session active" }));
      return true;
    }
    const inactive = sessions.sessions.some(
      (session) =>
        session.members.some(
          (member) =>
            member.kind === "registered" &&
            sameEndpoint(member.endpoint, source),
        ) &&
        session.members.some(
          (member) =>
            member.kind === "registered" &&
            sameEndpoint(member.endpoint, reference.target),
        ),
    );
    if (inactive)
      throw new Error(
        `The shared Agent Session with @${reference.name} is paused or closed. Review it in Agents; your draft has not been sent.`,
      );
    setStates((states) => ({ ...states, [stateKey]: "Needs session" }));
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
        sourceContext: {
          project_id: projectId,
          path,
          thread_id: threadId!,
          thread_title: threadTitle,
        },
        targetName,
        namingAccountId: reference.naming_account_id,
      });
    });
    if (!approved || epoch !== generation.current) return false;
    const refreshed = await api.listAgentSessions({ limit: 100 });
    const connected =
      !refreshed.controls.paused &&
      refreshed.sessions.some(
        (session) =>
          session.state === "active" &&
          session.members.some(
            (member) =>
              member.kind === "registered" &&
              sameEndpoint(member.endpoint, source),
          ) &&
          session.members.some(
            (member) =>
              member.kind === "registered" &&
              sameEndpoint(member.endpoint, reference.target),
          ),
      );
    if (!connected)
      throw new Error(
        "The Agent Session is not active. Your draft has not been sent.",
      );
    setStates((states) => ({ ...states, [stateKey]: "Session active" }));
    return true;
  }

  async function onSelect(reference: AgentMentionReference) {
    if (!enabled || !runnable || selectionLock.current || sendLock.current)
      return;
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
      !enabled ||
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
    agents: enabled && runnable ? (directory?.agents ?? []) : [],
    context: {
      allowAgentMentions: enabled && runnable,
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
    ui: enabled && (
      <>
        {error && (
          <div role="alert">
            <Alert
              type="warning"
              title="Agent mention needs attention"
              description={
                <>
                  {error}{" "}
                  <a
                    href="/settings/my-agents"
                    onClick={(event) => {
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      event.preventDefault();
                      openAccountSettings({ page: "my-agents" });
                    }}
                  >
                    Agents
                  </a>
                </>
              }
            />
          </div>
        )}
        {Object.entries(states).some(
          ([, state]) => state === "Needs session",
        ) && (
          <div role="status">
            Agent reference needs an Agent Session. Your draft is preserved;
            Send will check again.
          </div>
        )}
        {approval && (
          <SessionApproval value={approval} onClose={closeApproval} />
        )}
        <FreshAuthModal {...freshAuthModalProps} />
      </>
    ),
  };
}
