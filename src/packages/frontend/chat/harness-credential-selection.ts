/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Which Claude credential pays for a conversation, for the signed-in account.
// Stored on the server (see payment-selection-store), so every device sees the
// same choice. A conversation with no choice follows the account default.

import type { AcpHarnessCredential } from "@cocalc/util/ai/runtime";
import {
  harnessCredentialFromSelection,
  selectionFromHarnessCredential,
  type ClaudePaymentSelection,
} from "@cocalc/util/ai/agent-payment-selection";
import {
  PAYMENT_SELECTION_EVENT,
  readPaymentDefault,
  readPaymentSelection,
  setPaymentDefault,
  writePaymentSelection,
} from "./payment-selection-store";

export const HARNESS_CREDENTIAL_SELECTION_EVENT = PAYMENT_SELECTION_EVENT;

export function readHarnessCredentialSelection({
  accountId,
  projectId,
  threadKey,
  forNewAgent = false,
}: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
  forNewAgent?: boolean;
}): AcpHarnessCredential | undefined {
  if (!accountId) return;
  if (!projectId && !forNewAgent) return;
  const stored = projectId
    ? (readPaymentSelection({
        accountId,
        projectId,
        threadKey,
        provider: "claude-code",
      }) as ClaudePaymentSelection | undefined)
    : undefined;
  const fallback = readPaymentDefault({
    accountId,
    provider: "claude-code",
  }) as ClaudePaymentSelection | undefined;
  // A new agent with nothing chosen yet has no preselected credential.
  if (forNewAgent && !stored && !fallback) return;
  return harnessCredentialFromSelection(stored, fallback);
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
  const selection = selectionFromHarnessCredential(credential);
  const fallback = readPaymentDefault({ accountId, provider: "claude-code" });
  // The first credential chosen becomes the account default, so agents that
  // follow the default have one; later choices never change it implicitly.
  if (fallback == null) {
    void setPaymentDefault({
      accountId,
      provider: "claude-code",
      selection,
      onlyIfAbsent: true,
    });
    void writePaymentSelection({
      accountId,
      projectId,
      threadKey,
      provider: "claude-code",
      selection: null,
    });
    return;
  }
  // Choosing what the account default already is keeps following the
  // default, so changing the default later moves this agent too.
  const followsDefault =
    fallback != null && JSON.stringify(fallback) === JSON.stringify(selection);
  void writePaymentSelection({
    accountId,
    projectId,
    threadKey,
    provider: "claude-code",
    selection: followsDefault ? null : selection,
  });
}
