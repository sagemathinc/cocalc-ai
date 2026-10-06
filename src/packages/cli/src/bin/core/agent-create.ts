/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// `cocalc agent create NAME --from AGENT`: the CLI version of "Copy agent".
// The new agent's thread is a fork of the source agent's thread (same
// project and .chat file, independent copy of the agent session), it gets a
// name, and an optional message is left unsent in its composer for the user
// to edit and send.

import {
  CHAT_DRAFT_STORE,
  CHAT_DRAFT_TTL_MS,
  chatComposerDraftKey,
  chatComposerDraftPayload,
  stableDraftKeyFromThreadKey,
} from "@cocalc/chat";
import { normalizeAgentName } from "@cocalc/conat/agents/personal";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import {
  harnessCredentialFromSelection,
  type ClaudePaymentSelection,
} from "@cocalc/util/ai/agent-payment-selection";
import type {
  AcpHarnessCredential,
  AcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";

export interface AgentCreateDeps {
  hub: { agent: any };
  accountId: string;
  /** projectChatThreadForkData bound to the command context. */
  forkThread: (opts: {
    projectIdentifier: string;
    path: string;
    sourceThreadId: string;
    title: string;
    sourceTitle?: string;
    resolveHarnessCredential?: (
      runtime: AcpHarnessRuntime,
    ) => Promise<AcpHarnessCredential | undefined>;
  }) => Promise<{
    project_id: string;
    path: string;
    thread_id: string;
    session: string;
    copy_payment_selection: boolean;
    harness_credential?: AcpHarnessCredential;
  }>;
  /** Write one account-scoped draft (AKV set with TTL). */
  setDraft: (key: string, value: unknown, ttlMs: number) => Promise<void>;
}

export function findNamedAgent(
  agents: readonly NamedAgent[],
  nameOrId: string,
): NamedAgent | undefined {
  const wanted = `${nameOrId ?? ""}`.trim().replace(/^@/, "").toLowerCase();
  return agents.find(
    (agent) =>
      agent.name.toLowerCase() === wanted ||
      agent.endpoint.agent_id.toLowerCase() === wanted,
  );
}

export async function createAgentFromCopy(
  deps: AgentCreateDeps,
  opts: {
    name: string;
    from: string;
    description?: string;
    draft?: string;
  },
): Promise<Record<string, unknown>> {
  const name = normalizeAgentName(`${opts.name ?? ""}`.replace(/^@/, ""));
  const directory = await deps.hub.agent.listNamedAgents({});
  const agents: NamedAgent[] = directory?.agents ?? [];
  if (findNamedAgent(agents, name)) {
    throw new Error(`you already have an agent named @${name}`);
  }
  const source = findNamedAgent(agents, opts.from);
  if (!source) {
    throw new Error(
      `no agent named ${opts.from}; run "cocalc agent names" to see your agents`,
    );
  }
  const sourceTarget = {
    project_id: source.endpoint.project_id,
    thread_id: source.thread_id,
    path: source.path,
  };

  const forked = await deps.forkThread({
    projectIdentifier: source.endpoint.project_id,
    path: source.path,
    sourceThreadId: source.thread_id,
    title: name,
    sourceTitle: source.thread_title || source.name,
    resolveHarnessCredential: async (runtime) => {
      if (runtime.profile.id !== "claude-code") return undefined;
      const result = await deps.hub.agent.getPaymentSelections({
        targets: [sourceTarget],
      });
      const stored = (result?.selections ?? []).find(
        (row) =>
          row.provider === "claude-code" &&
          row.project_id === sourceTarget.project_id &&
          row.thread_id === sourceTarget.thread_id,
      )?.selection as ClaudePaymentSelection | undefined;
      const fallback = result?.defaults?.["claude-code"] as
        | ClaudePaymentSelection
        | undefined;
      if (!stored && !fallback) return undefined;
      return harnessCredentialFromSelection(stored, fallback);
    },
  });
  const target = {
    project_id: forked.project_id,
    thread_id: forked.thread_id,
    path: forked.path,
  };

  // Keep this account's payment choice (ChatGPT plan or Claude credential).
  const warnings: string[] = [];
  if (forked.copy_payment_selection || forked.harness_credential) {
    try {
      await deps.hub.agent.copyPaymentSelection({
        from: sourceTarget,
        to: target,
      });
    } catch (err) {
      warnings.push(`payment selection was not copied: ${err}`);
    }
  }

  let identity = await deps.hub.agent.resolveIdentity(target);
  if (!identity) identity = await deps.hub.agent.registerIdentity(target);
  if (!identity?.agent_id) throw new Error("unable to register the new agent");
  await deps.hub.agent.nameAgent({
    endpoint: { project_id: target.project_id, agent_id: identity.agent_id },
    name,
    description: opts.description ?? "",
    project_title: source.project_title,
    thread_title: name,
  });

  const draft = `${opts.draft ?? ""}`.trim();
  if (draft) {
    await deps.setDraft(
      chatComposerDraftKey({
        project_id: target.project_id,
        path: target.path,
        composerDraftKey: stableDraftKeyFromThreadKey(target.thread_id),
      }),
      chatComposerDraftPayload(draft),
      CHAT_DRAFT_TTL_MS,
    );
  }

  return {
    agent_id: identity.agent_id,
    name,
    project_id: target.project_id,
    path: target.path,
    thread_id: target.thread_id,
    copied_from: source.name,
    session: forked.session,
    draft: draft ? "unsent draft left in the composer" : null,
    draft_verified: draft ? true : undefined,
    draft_store: draft ? CHAT_DRAFT_STORE : undefined,
    ...(warnings.length ? { warnings } : {}),
  };
}

/** Your named agents, as shown in the Agents sidebar. */
export async function listNamedAgentsSummary(hub: {
  agent: any;
}): Promise<Record<string, unknown>[]> {
  const directory = await hub.agent.listNamedAgents({});
  return (directory?.agents ?? []).map((agent: NamedAgent) => ({
    name: agent.name,
    agent_id: agent.endpoint.agent_id,
    project_id: agent.endpoint.project_id,
    project_title: agent.project_title,
    path: agent.path,
    thread_id: agent.thread_id,
    thread_title: agent.thread_title,
    runtime: agent.runtime,
    available: agent.available,
  }));
}

/** Remove a named agent from Agents; its conversation is preserved. */
export async function removeNamedAgent(
  hub: { agent: any },
  nameOrId: string,
): Promise<Record<string, unknown>> {
  const directory = await hub.agent.listNamedAgents({});
  const agent = findNamedAgent(directory?.agents ?? [], nameOrId);
  if (!agent) throw new Error(`no agent named ${nameOrId}`);
  await hub.agent.retireNamedAgent({ endpoint: agent.endpoint });
  return {
    removed: agent.name,
    agent_id: agent.endpoint.agent_id,
    note: "The conversation and artifacts are preserved.",
  };
}
