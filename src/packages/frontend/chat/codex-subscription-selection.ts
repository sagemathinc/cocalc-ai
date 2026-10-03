/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Which ChatGPT subscription pays for a conversation, for the signed-in
// account. Stored on the server (see payment-selection-store), so every
// device sees the same choice. Undefined means the account's default.

import { isValidUUID } from "@cocalc/util/misc";
import {
  PAYMENT_SELECTION_EVENT,
  readPaymentSelection,
  writePaymentSelection,
} from "./payment-selection-store";

export const CODEX_SUBSCRIPTION_SELECTION_EVENT = PAYMENT_SELECTION_EVENT;

export function readCodexSubscriptionSelection({
  accountId,
  projectId,
  threadKey,
}: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
}): string | undefined {
  const selection = readPaymentSelection({
    accountId,
    projectId,
    threadKey,
    provider: "codex",
  });
  return selection?.mode === "credential" ? selection.credential_id : undefined;
}

export function writeCodexSubscriptionSelection({
  accountId,
  projectId,
  threadKey,
  credentialId,
}: {
  accountId: string;
  projectId: string;
  threadKey?: string;
  credentialId?: string;
}): void {
  void writePaymentSelection({
    accountId,
    projectId,
    threadKey,
    provider: "codex",
    selection:
      credentialId && isValidUUID(credentialId)
        ? {
            version: 1,
            provider: "codex",
            mode: "credential",
            credential_id: credentialId,
          }
        : null,
  });
}
