export function resolveCombinedComposerTargetKey(
  composerTargetKey: string | null,
  threads: Array<{ key: string }>,
  isCombinedFeedSelected: boolean,
): string | null {
  if (threads.length === 0) return null;
  if (!isCombinedFeedSelected) return composerTargetKey;
  if (composerTargetKey == null) return threads[0].key;
  const exists = threads.some((thread) => thread.key === composerTargetKey);
  return exists ? composerTargetKey : threads[0].key;
}
