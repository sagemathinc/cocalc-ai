export function isMissingRusticRepositoryError(err: unknown): boolean {
  const text = `${err ?? ""}`;
  return (
    text.includes("No repository config file found") ||
    (text.includes("path=config") &&
      text.includes("stat failed NotFound") &&
      text.includes("rustic_core") &&
      text.includes("the configuration"))
  );
}

// The repository's bucket is gone (deleted or reassigned): the cached backup
// profile is stale and should be refreshed.
export function looksLikeMissingBackupBucketError(err: unknown): boolean {
  const s = `${err ?? ""}`.toLowerCase();
  return (
    s.includes("nosuchbucket") ||
    s.includes("specified bucket does not exist") ||
    s.includes("path `config` does not exist")
  );
}
