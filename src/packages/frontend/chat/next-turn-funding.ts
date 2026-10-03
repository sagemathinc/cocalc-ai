/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// After a human send is acknowledged, record server-side how this account paid
// for it, so turns started by agent messages pay the same way instead of
// depending on this browser's local selection.

import type { AgentTurnFunding } from "@cocalc/util/ai/agent-turn-funding";
import type {
  AcpHarnessCredential,
  AcpHarnessRuntime,
} from "@cocalc/util/ai/runtime";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export function nextTurnFundingForSend({
  runtime,
  harnessCredential,
  credentialId,
}: {
  runtime?: AcpHarnessRuntime;
  harnessCredential?: AcpHarnessCredential;
  credentialId?: string;
}): AgentTurnFunding | undefined {
  if (runtime) {
    const profile = runtime.profile;
    // Other harnesses are project-managed and need no per-account record.
    if (profile.version !== 2 || profile.id !== "claude-code") return;
    return {
      version: 1,
      kind: "harness",
      profile_id: "claude-code",
      // No explicit choice means the project secret, as at admission.
      harness_credential: harnessCredential ?? {
        version: 1,
        provider: "anthropic",
        mode: "project-secret",
      },
    };
  }
  return credentialId
    ? { version: 1, kind: "codex", credential_id: credentialId }
    : { version: 1, kind: "codex" };
}

type FundingApi = {
  setNextTurnFunding(opts: {
    project_id: string;
    path: string;
    thread_id: string;
    funding: AgentTurnFunding;
  }): Promise<{ recorded: boolean }>;
};

export async function recordNextTurnFunding({
  project_id,
  path,
  thread_id,
  funding,
  api,
}: {
  project_id: string;
  path: string;
  thread_id: string;
  funding?: AgentTurnFunding;
  api?: FundingApi;
}): Promise<void> {
  if (!funding || !path.endsWith(".chat")) return;
  // Not cached: the same account may change the choice in another browser,
  // and the latest human send must win.
  try {
    // Resolved here, not as a default parameter: this runs fire-and-forget,
    // so nothing may throw outside the try.
    const target: FundingApi | undefined =
      api ?? webapp_client.conat_client?.hub?.agent;
    if (!target?.setNextTurnFunding) return;
    await target.setNextTurnFunding({ project_id, path, thread_id, funding });
  } catch (err) {
    // The turn itself already succeeded; an older hub may lack this API.
    console.warn("could not record agent next-turn funding", err);
  }
}
