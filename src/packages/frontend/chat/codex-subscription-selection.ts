const PREFIX = "cocalc:codex-subscription:v1";
export const CODEX_SUBSCRIPTION_SELECTION_EVENT =
  "cocalc:codex-subscription-selection";

function key(accountId: string, projectId: string, threadKey: string): string {
  return `${PREFIX}:${accountId}:${projectId}:${threadKey || "new"}`;
}

export function readCodexSubscriptionSelection({
  accountId,
  projectId,
  threadKey,
}: {
  accountId?: string;
  projectId?: string;
  threadKey?: string;
}): string | undefined {
  if (typeof localStorage === "undefined" || !accountId || !projectId) return;
  return (
    localStorage.getItem(key(accountId, projectId, threadKey ?? "")) ??
    undefined
  );
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
  const storageKey = key(accountId, projectId, threadKey ?? "");
  if (credentialId) localStorage.setItem(storageKey, credentialId);
  else localStorage.removeItem(storageKey);
  window.dispatchEvent(new Event(CODEX_SUBSCRIPTION_SELECTION_EVENT));
}
