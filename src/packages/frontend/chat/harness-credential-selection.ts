/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { isValidUUID } from "@cocalc/util/misc";
import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";

const PREFIX = "cocalc:acp-harness-credential:v1";
export const HARNESS_CREDENTIAL_SELECTION_EVENT =
  "cocalc:acp-harness-credential-selection";

function key(accountId: string, projectId: string, threadKey: string): string {
  return `${PREFIX}:${accountId}:${projectId}:${threadKey || "new"}`;
}

export function readHarnessCredentialSelection({
  accountId,
  projectId,
  threadKey,
}: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
}): AcpHarnessCredential | undefined {
  if (typeof localStorage === "undefined" || !accountId || !projectId) return;
  const value = localStorage.getItem(
    key(accountId, projectId, threadKey ?? ""),
  );
  if (!value || value === "project-secret") {
    return { version: 1, provider: "anthropic", mode: "project-secret" };
  }
  if (value.startsWith("account-api-key:")) {
    const credentialId = value.slice("account-api-key:".length);
    if (isValidUUID(credentialId)) {
      return {
        version: 1,
        provider: "anthropic",
        mode: "account-api-key",
        credentialId,
      };
    }
  }
  return { version: 1, provider: "anthropic", mode: "project-secret" };
}

export function writeHarnessCredentialSelection({
  accountId,
  projectId,
  threadKey,
  credential,
}: {
  accountId?: string;
  projectId: string;
  threadKey: string;
  credential: AcpHarnessCredential;
}): void {
  if (typeof localStorage === "undefined" || !accountId) return;
  const storageKey = key(accountId, projectId, threadKey);
  const value =
    credential.mode === "account-api-key"
      ? `account-api-key:${credential.credentialId}`
      : "project-secret";
  localStorage.setItem(storageKey, value);
  window.dispatchEvent(new Event(HARNESS_CREDENTIAL_SELECTION_EVENT));
}
