/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const PREFIX = "cocalc:codex-subscription:v1";

function key(accountId: string, projectId: string, threadId: string): string {
  return `${PREFIX}:${accountId}:${projectId}:${threadId || "new"}`;
}

export function readAgentSubscriptionSelection({
  accountId,
  projectId,
  threadId,
}: {
  accountId?: string;
  projectId?: string;
  threadId?: string;
}): string | undefined {
  if (typeof localStorage === "undefined" || !accountId || !projectId) return;
  return (
    localStorage.getItem(key(accountId, projectId, threadId ?? "")) ?? undefined
  );
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
  if (typeof localStorage === "undefined" || !accountId) return;
  const storageKey = key(accountId, projectId, threadId);
  if (credentialId) localStorage.setItem(storageKey, credentialId);
  else localStorage.removeItem(storageKey);
}
