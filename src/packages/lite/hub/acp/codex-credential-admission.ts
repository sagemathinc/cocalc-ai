/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpJobRequest, AcpRequest } from "@cocalc/conat/ai/acp/types";
import { hubApi } from "../api";
import { prepareHarnessRequest } from "./harness-runtime";
import { decodeAcpJobRequest, latestHumanHarnessJob } from "../sqlite/acp-jobs";

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

export function setCodexCredentialAdmissionResolver(
  next?: CodexCredentialAdmissionResolver,
): void {
  resolver = next ?? defaultResolver;
}

export async function pinCodexCredentialAtAdmission<T extends AcpJobRequest>(
  request: T,
): Promise<T> {
  if (request.request_kind === "command") return request;
  if (request.runtime !== undefined) {
    if (
      request.runtime.profile.version === 2 &&
      request.runtime.profile.id === "claude-code" &&
      request.chat?.agent_rpc_execution &&
      !request.harness_credential
    ) {
      const previous = latestHumanHarnessJob({
        project_id: request.project_id,
        account_id: request.account_id,
        path: request.chat.path,
        thread_id: request.chat.thread_id!,
      });
      const admitted = previous && decodeAcpJobRequest(previous);
      if (!admitted || admitted.request_kind === "command" || !admitted.runtime)
        throw Error(
          "The recipient agent has no payment method recorded for this account. Open it and send one message with its selected payment method before using Agent Networks.",
        );
      const { cwd: _oldCwd, ...oldProfile } = admitted.runtime.profile;
      const { cwd: _newCwd, ...newProfile } = request.runtime.profile;
      if (JSON.stringify(oldProfile) !== JSON.stringify(newProfile))
        throw Error(
          "Recipient runtime changed; send a message in the recipient agent to confirm its payment method.",
        );
      request = { ...request, harness_credential: admitted.harness_credential };
    }
    return prepareHarnessRequest(request as AcpRequest) as T;
  }
  const preference = request.config?.paymentSource ?? "auto";
  if (
    preference !== "auto" &&
    preference !== "subscription" &&
    preference !== "subscription-credential"
  ) {
    return request;
  }
  const requestedCredentialId = `${request.config?.credentialId ?? ""}`.trim();
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
  if (resolved.source !== "subscription") {
    if (preference !== "auto") {
      throw new Error(
        resolved.unavailableReason ||
          "The selected ChatGPT subscription is unavailable.",
      );
    }
    return request;
  }
  const credentialId = `${resolved.credentialId ?? ""}`.trim();
  if (!credentialId) {
    if (resolved.credentialPinRequired && request.chat?.agent_rpc_execution) {
      throw new Error(
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
