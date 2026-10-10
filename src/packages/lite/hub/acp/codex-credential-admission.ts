/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpJobRequest, AcpRequest } from "@cocalc/conat/ai/acp/types";
import { agentRecipientSetupError } from "@cocalc/conat/agents/rpc";
import { hubApi } from "../api";
import { reportAgentRuntimeOnce } from "./agent-runtime-report";
import {
  type AcpHarnessProfile,
  parseAcpHarnessProfile,
} from "@cocalc/util/ai/runtime";
import { prepareHarnessRequest } from "./harness-runtime";
import { decodeAcpJobRequest, latestHumanHarnessJob } from "../sqlite/acp-jobs";
import {
  codexCredentialFromSelection,
  harnessCredentialFromSelection,
  type AgentPaymentProvider,
  type ClaudePaymentSelection,
  type CodexPaymentSelection,
} from "@cocalc/util/ai/agent-payment-selection";

type CodexCredentialAdmissionResolver = (opts: {
  account_id: string;
  project_id?: string;
  preference: "auto" | "subscription";
  credential_id?: string;
}) => Promise<{
  source: string;
  credentialId?: string;
  unavailableReason?: string;
  credentialPinRequired?: boolean;
}>;

const defaultResolver: CodexCredentialAdmissionResolver = async (opts) =>
  await hubApi.system.getCodexPaymentSource(opts);

let resolver = defaultResolver;

type PaymentSelectionResolver = (opts: {
  account_id: string;
  project_id: string;
  thread_id: string;
  provider: AgentPaymentProvider;
}) => Promise<{ selection?: unknown; default?: unknown }>;

const defaultPaymentSelectionResolver: PaymentSelectionResolver = async (
  opts,
) => await hubApi.agent.resolvePaymentSelection(opts);

let paymentSelectionResolver = defaultPaymentSelectionResolver;

export function setPaymentSelectionResolver(
  next?: PaymentSelectionResolver,
): void {
  paymentSelectionResolver = next ?? defaultPaymentSelectionResolver;
}

// The account's stored choice for this conversation (shared by all of its
// devices), for turns that arrive without one: agent messages, CLI sends,
// automations. Undefined when nothing is stored or the hub cannot answer.
async function storedPaymentSelection<T>(
  request: AcpJobRequest,
  provider: AgentPaymentProvider,
): Promise<{ selection?: T; default?: T } | undefined> {
  const thread_id = request.chat?.thread_id;
  if (!thread_id) return;
  try {
    const resolved = await paymentSelectionResolver({
      account_id: request.account_id,
      project_id: request.chat?.project_id ?? request.project_id,
      thread_id,
      provider,
    });
    const pick = (value: any) =>
      value?.provider === provider ? (value as T) : undefined;
    const selection = pick(resolved?.selection);
    const fallback = pick(resolved?.default);
    if (!selection && !fallback) return;
    return {
      ...(selection ? { selection } : {}),
      ...(fallback ? { default: fallback } : {}),
    };
  } catch {
    // Older hubs lack this API; keep the previous behavior.
    return;
  }
}

export function setCodexCredentialAdmissionResolver(
  next?: CodexCredentialAdmissionResolver,
): void {
  resolver = next ?? defaultResolver;
}

export async function pinCodexCredentialAtAdmission<T extends AcpJobRequest>(
  request: T,
): Promise<T> {
  if (request.request_kind === "command") return request;
  reportAgentRuntimeOnce(request);
  if (request.runtime !== undefined) {
    const claudeCode =
      request.runtime.profile.version === 2 &&
      request.runtime.profile.id === "claude-code";
    let harness_credential = request.harness_credential;
    if (claudeCode && !harness_credential) {
      const stored = await storedPaymentSelection<ClaudePaymentSelection>(
        request,
        "claude-code",
      );
      if (stored)
        harness_credential = harnessCredentialFromSelection(
          stored.selection,
          stored.default,
        );
    }
    if (
      claudeCode &&
      (request.chat?.agent_rpc_execution || request.chat?.sensor_wake) &&
      !harness_credential
    ) {
      // Nothing stored yet: fall back to this account's last human turn.
      const previous = latestHumanHarnessJob({
        project_id: request.project_id,
        account_id: request.account_id,
        path: request.chat.path,
        thread_id: request.chat.thread_id!,
      });
      const admitted = previous && decodeAcpJobRequest(previous);
      if (!admitted || admitted.request_kind === "command" || !admitted.runtime)
        throw agentRecipientSetupError(
          "human-turn",
          "The recipient agent has no payment method recorded for this account. Open it and send one message with its selected payment method before using Agent Networks.",
        );
      // Compare the profiles as they run now: a job admitted before a
      // harness version bump names the superseded pin, which parsing upgrades.
      const normalized = (value: AcpHarnessProfile) => {
        try {
          return parseAcpHarnessProfile(value);
        } catch {
          return value; // Unknown profiles are compared as recorded.
        }
      };
      const { cwd: _oldCwd, ...oldProfile } = normalized(
        admitted.runtime.profile,
      );
      const { cwd: _newCwd, ...newProfile } = normalized(
        request.runtime.profile,
      );
      if (JSON.stringify(oldProfile) !== JSON.stringify(newProfile))
        throw agentRecipientSetupError(
          "human-turn",
          "Recipient runtime changed; send a message in the recipient agent to confirm its payment method.",
        );
      harness_credential = admitted.harness_credential;
    }
    return prepareHarnessRequest({
      ...request,
      ...(harness_credential ? { harness_credential } : {}),
    } as AcpRequest) as T;
  }
  const preference = request.config?.paymentSource ?? "auto";
  if (
    preference !== "auto" &&
    preference !== "subscription" &&
    preference !== "subscription-credential"
  ) {
    return request;
  }
  let storedCredentialId: string | undefined;
  if (preference === "subscription" && !request.config?.credentialId) {
    const stored = await storedPaymentSelection<CodexPaymentSelection>(
      request,
      "codex",
    );
    // This agent's subscription, else the account's chosen default; with
    // neither, the hub uses the designated default subscription.
    storedCredentialId =
      codexCredentialFromSelection(stored?.selection) ??
      codexCredentialFromSelection(stored?.default);
  }
  const requestedCredentialId = `${
    request.config?.credentialId ?? storedCredentialId ?? ""
  }`.trim();
  if (preference === "subscription-credential" && !requestedCredentialId) {
    throw new Error("An explicit ChatGPT subscription is required.");
  }
  const resolved = await resolver({
    account_id: request.account_id,
    project_id: request.chat?.project_id ?? request.project_id,
    preference:
      preference === "subscription-credential" ? "subscription" : preference,
    credential_id: requestedCredentialId || undefined,
  });
  const agentMessage = !!(
    request.chat?.agent_rpc_execution || request.chat?.sensor_wake
  );
  if (resolved.source !== "subscription") {
    if (preference !== "auto") {
      const reason =
        resolved.unavailableReason ||
        "The selected ChatGPT subscription is unavailable.";
      throw agentMessage
        ? agentRecipientSetupError("codex-connection", reason)
        : new Error(reason);
    }
    if (agentMessage && resolved.source === "none") {
      // Nothing can pay for this turn. Refuse it now so the sender learns
      // why, rather than admitting a turn that fails in the recipient thread.
      throw agentRecipientSetupError("codex-connection");
    }
    return request;
  }
  const credentialId = `${resolved.credentialId ?? ""}`.trim();
  if (!credentialId) {
    if (resolved.credentialPinRequired && agentMessage) {
      throw agentRecipientSetupError(
        "codex-connection",
        "The recipient agent has no payment method recorded for this account. Open it and send one message with its selected ChatGPT subscription before using Agent Networks.",
      );
    }
    if (resolved.credentialPinRequired || requestedCredentialId) {
      throw new Error("The selected ChatGPT subscription is unavailable.");
    }
    return request;
  }
  return {
    ...request,
    config: {
      ...request.config,
      paymentSource: "subscription-credential",
      credentialId,
    },
  };
}
