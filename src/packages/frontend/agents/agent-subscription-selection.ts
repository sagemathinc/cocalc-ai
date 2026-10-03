/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Agents page view of the per-account ChatGPT subscription choice, which is
// stored on the server and shared by all devices.

import {
  readCodexSubscriptionSelection,
  writeCodexSubscriptionSelection,
} from "@cocalc/frontend/chat/codex-subscription-selection";

export function readAgentSubscriptionSelection({
  accountId,
  projectId,
  threadId,
}: {
  accountId?: string;
  projectId?: string;
  threadId?: string;
}): string | undefined {
  return readCodexSubscriptionSelection({
    accountId,
    projectId,
    threadKey: threadId,
  });
}

export function writeAgentSubscriptionSelection({
  accountId,
  projectId,
  threadId,
  credentialId,
}: {
  accountId?: string;
  projectId: string;
  threadId: string;
  credentialId?: string;
}): void {
  if (!accountId) return;
  void writeCodexSubscriptionSelection({
    accountId,
    projectId,
    threadKey: threadId,
    credentialId,
  });
}
