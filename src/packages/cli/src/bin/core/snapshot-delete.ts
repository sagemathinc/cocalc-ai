// Decide which project snapshots `project snapshot delete` removes.
// Exactly one selector: explicit names, or every snapshot except a kept set.

export function selectSnapshotsToDelete({
  existing,
  names = [],
  allExcept = [],
}: {
  existing: string[];
  names?: string[];
  allExcept?: string[];
}): string[] {
  const clean = (v: string[]) => v.map((x) => `${x}`.trim()).filter(Boolean);
  const wanted = clean(names);
  const keep = clean(allExcept);
  if (wanted.length > 0 && keep.length > 0) {
    throw new Error("use either --name or --all-except, not both");
  }
  if (wanted.length === 0 && keep.length === 0) {
    throw new Error("specify --name <snapshot> or --all-except <snapshot>");
  }
  const present = new Set(existing);
  if (wanted.length > 0) {
    const missing = wanted.filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(`no such snapshot: ${missing.join(", ")}`);
    }
    return [...new Set(wanted)];
  }
  const missingKeep = keep.filter((name) => !present.has(name));
  if (missingKeep.length > 0) {
    // Refuse rather than delete everything because of a typo in the kept name.
    throw new Error(
      `snapshot to keep does not exist: ${missingKeep.join(", ")}`,
    );
  }
  const kept = new Set(keep);
  return existing.filter((name) => !kept.has(name));
}
