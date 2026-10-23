/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// How a Claude Code agent is paid for, as in the web app: the account's own
// payment selection for the agent (provider "claude-code"), else the
// account's default for Claude agents. Admission applies it to each turn.
import {
  harnessCredentialFromSelection,
  type ClaudePaymentSelection,
} from "@cocalc/util/ai/agent-payment-selection";
import {
  ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY,
  CLAUDE_SUBSCRIPTION_KIND,
} from "@cocalc/util/ai/external-credential-profiles";

// As the web picker names them (claudeSubscriptionName): the label, else
// the plan and the provider account the subscription signed in with.
function credentialName(row: any): string | undefined {
  const label = `${row?.metadata?.label ?? ""}`.trim();
  if (label) return label;
  if (row?.kind !== CLAUDE_SUBSCRIPTION_KIND) return;
  const identity = row?.metadata?.[ACCOUNT_CREDENTIAL_IDENTITY_METADATA_KEY];
  if (typeof identity !== "string" || !identity) return;
  const plan = String(row.metadata?.plan || "Pro/Max")
    .replace(/^claude\s+/i, "")
    .replace(
      /^(pro|max)$/i,
      (value) => value[0].toUpperCase() + value.slice(1).toLowerCase(),
    );
  return `${plan} - ${identity}`;
}

export interface ClaudeCredential {
  id: string;
  kind: string;
  label?: string;
}

export interface ClaudePayment {
  credentials: ClaudeCredential[];
  /** This agent's own choice, if any. */
  selection?: ClaudePaymentSelection;
  /** The account's default for Claude agents, if any. */
  fallback?: ClaudePaymentSelection;
}

type HubApi = {
  system: {
    listExternalCredentials(opts: {
      provider: string;
      scope: string;
    }): Promise<any[]>;
  };
  agent: {
    getPaymentSelections(opts: {
      targets: { project_id: string; thread_id: string }[];
    }): Promise<{ selections?: any[]; defaults?: Record<string, any> }>;
  };
};

const claude = (value: any): ClaudePaymentSelection | undefined =>
  value?.provider === "claude-code" ? value : undefined;

export async function loadClaudePayment(
  hubApi: HubApi,
  project: string,
  thread: string,
): Promise<ClaudePayment> {
  const [rows, result] = await Promise.all([
    hubApi.system.listExternalCredentials({
      provider: "anthropic",
      scope: "account",
    }),
    hubApi.agent.getPaymentSelections({
      targets: [{ project_id: project, thread_id: thread }],
    }),
  ]);
  return {
    credentials: (rows ?? [])
      .filter(
        (row) =>
          !row?.revoked &&
          (row?.kind === "anthropic-api-key" ||
            row?.kind === CLAUDE_SUBSCRIPTION_KIND),
      )
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        label: credentialName(row),
      })),
    selection: claude(
      result?.selections?.find(
        (row) => row?.thread_id === thread && row?.provider === "claude-code",
      )?.selection,
    ),
    fallback: claude(result?.defaults?.["claude-code"]),
  };
}

export function credentialLabel(credential: ClaudeCredential): string {
  const kind =
    credential.kind === CLAUDE_SUBSCRIPTION_KIND
      ? "Claude subscription"
      : "Anthropic API key";
  return credential.label ? `${kind}: ${credential.label}` : kind;
}

// What admission uses, by the same rule: the agent's choice, else the
// account default, else the project's ANTHROPIC_API_KEY secret.
export function describeClaudePayment(payment: ClaudePayment): string {
  const effective = harnessCredentialFromSelection(
    payment.selection,
    payment.fallback,
  );
  if (effective.provider !== "anthropic" || effective.mode === "project-secret")
    return "Project ANTHROPIC_API_KEY";
  const credential = payment.credentials.find(
    (row) => row.id === effective.credentialId,
  );
  return credential ? credentialLabel(credential) : "Disconnected credential";
}
