export function combinedComposerTargetStorageKey(
  projectId: string,
  path: string,
): string {
  return `chat-composer-target:${projectId}:${path}:0`;
}

export function readStoredCombinedComposerTargetKey(
  value: string | object | null,
): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key.length > 0 ? key : null;
}

export function resolveCombinedComposerTargetKey(
  composerTargetKey: string | null,
  storedComposerTargetKey: string | null,
  threads: Array<{ key: string }>,
  isCombinedFeedSelected: boolean,
): string | null {
  if (threads.length === 0) return null;
  if (!isCombinedFeedSelected) return composerTargetKey;
  const preferredKey = composerTargetKey ?? storedComposerTargetKey;
  if (preferredKey == null) return threads[0].key;
  const exists = threads.some((thread) => thread.key === preferredKey);
  return exists ? preferredKey : threads[0].key;
}
