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
 * chosen default. Undefined when neither names one (the hub then uses the
 * designated default subscription) or the hub predates the API.
 */
export async function storedCodexCredential(
  agent: AgentApi | undefined,
  project: string,
  thread: string,
): Promise<string | undefined> {
  if (typeof agent?.getPaymentSelections !== "function") return;
  try {
    const result = await agent.getPaymentSelections({
      targets: [{ project_id: project, thread_id: thread }],
    });
    const selection = codex(
      result?.selections?.find(
        (row) => row?.thread_id === thread && row?.provider === "codex",
      )?.selection,
    );
    return (
      codexCredentialFromSelection(selection) ??
      codexCredentialFromSelection(codex(result?.defaults?.codex))
    );
  } catch {
    // An older hub: fall back to the thread's saved choice.
    return;
  }
}
