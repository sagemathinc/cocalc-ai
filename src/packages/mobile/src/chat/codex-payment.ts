/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import {
  codexCredentialFromSelection,
  type CodexPaymentSelection,
} from "@cocalc/util/ai/agent-payment-selection";

type AgentApi = {
  getPaymentSelections?: (opts: {
    targets: { project_id: string; thread_id: string }[];
  }) => Promise<{ selections?: any[]; defaults?: Record<string, any> }>;
};

const codex = (value: any): CodexPaymentSelection | undefined =>
  value?.provider === "codex" ? value : undefined;

/**
 * The ChatGPT subscription this account pays for the agent with, as
 * admission resolves it: the agent's own selection, else the account's
 * chosen default. `resolved` with no credentialId means neither names one,
 * so the hub uses the designated default subscription; a credential saved
 * in shared thread config must not be used then. Only when the hub cannot
 * answer (`resolved: false`) is that saved credential the best guess.
 * `defaultCredentialId` is the account's chosen default subscription.
 */
export async function storedCodexCredential(
  agent: AgentApi | undefined,
  project: string,
  thread: string,
): Promise<{
  resolved: boolean;
  credentialId?: string;
  defaultCredentialId?: string;
}> {
  if (typeof agent?.getPaymentSelections !== "function")
    return { resolved: false };
  try {
    const result = await agent.getPaymentSelections({
      targets: [{ project_id: project, thread_id: thread }],
    });
    const selection = codex(
      result?.selections?.find(
        (row) => row?.thread_id === thread && row?.provider === "codex",
      )?.selection,
    );
    const defaultCredentialId = codexCredentialFromSelection(
      codex(result?.defaults?.codex),
    );
    const credentialId =
      codexCredentialFromSelection(selection) ?? defaultCredentialId;
    return {
      resolved: true,
      ...(credentialId ? { credentialId } : {}),
      ...(defaultCredentialId ? { defaultCredentialId } : {}),
    };
  } catch {
    return { resolved: false };
  }
}

/** The credential_id to check a Codex agent's payment with, as admission would. */
export async function codexPaymentCredential(
  agent: AgentApi | undefined,
  project: string,
  thread: string | undefined,
  config?: { paymentSource?: string; credentialId?: string },
): Promise<string | undefined> {
  if (config?.paymentSource !== "subscription") return;
  const stored = thread
    ? await storedCodexCredential(agent, project, thread)
    : { resolved: false };
  return stored.resolved ? stored.credentialId : config.credentialId;
}
