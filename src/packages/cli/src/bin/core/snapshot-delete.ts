// Decide which project snapshots `project snapshot delete` (or backups,
// `project backup delete`) removes.
// Exactly one selector: explicit names, or every one except a kept set.

export function selectSnapshotsToDelete({
  existing,
  names = [],
  allExcept = [],
  noun = "snapshot",
  nameFlag = "--name",
}: {
  existing: string[];
  names?: string[];
  allExcept?: string[];
  noun?: string;
  nameFlag?: string;
}): string[] {
  const clean = (v: string[]) => v.map((x) => `${x}`.trim()).filter(Boolean);
  const wanted = clean(names);
  const keep = clean(allExcept);
  if (wanted.length > 0 && keep.length > 0) {
    throw new Error(`use either ${nameFlag} or --all-except, not both`);
  }
  if (wanted.length === 0 && keep.length === 0) {
    throw new Error(`specify ${nameFlag} <${noun}> or --all-except <${noun}>`);
  }
  const present = new Set(existing);
  if (wanted.length > 0) {
    const missing = wanted.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(`no such ${noun}: ${missing.join(", ")}`);
    }
    return [...new Set(wanted)];
  }
  const missingKeep = keep.filter((name) => !present.has(name));
  if (missingKeep.length > 0) {
    // Refuse rather than delete everything because of a typo in the kept name.
    throw new Error(
      `${noun} to keep does not exist: ${missingKeep.join(", ")}`,
    );
  }
  const kept = new Set(keep);
  return existing.filter((name) => !kept.has(name));
}
