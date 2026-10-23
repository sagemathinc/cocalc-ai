/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

// How a Claude Code agent is paid for, as in the web app: the account's own
// payment selection for the agent (provider "claude-code"), else the
// account's default for Claude agents. Admission applies it to each turn.
import type { ClaudePaymentSelection } from "@cocalc/util/ai/agent-payment-selection";
import { CLAUDE_SUBSCRIPTION_KIND } from "@cocalc/util/ai/external-credential-profiles";

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
        label:
          typeof row.metadata?.label === "string"
            ? row.metadata.label
            : typeof row.metadata?.email === "string"
              ? row.metadata.email
              : undefined,
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

export function describeClaudePayment(payment: ClaudePayment): string {
  const effective =
    payment.selection?.mode === "default" || !payment.selection
      ? payment.fallback
      : payment.selection;
  if (!effective || effective.mode === "default") return "Not chosen";
  if (effective.mode === "project-secret") return "Project ANTHROPIC_API_KEY";
  const credential = payment.credentials.find(
    (row) => row.id === effective.credential_id,
  );
  return credential ? credentialLabel(credential) : "Disconnected credential";
}
