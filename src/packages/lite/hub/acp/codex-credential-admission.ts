/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AcpJobRequest } from "@cocalc/conat/ai/acp/types";
import { hubApi } from "../api";

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
  const preference = request.config?.paymentSource ?? "auto";
  if (
    preference !== "auto" &&
    preference !== "subscription" &&
    preference !== "subscription-credential"
  ) {
    return request;
  }
  const requestedCredentialId = `${request.config?.credentialId ?? ""}`.trim();
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
