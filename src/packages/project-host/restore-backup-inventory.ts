import rustic from "@cocalc/backend/sandbox/rustic";
import { isMissingRusticRepositoryError } from "./backup-index-errors";

type Backup = {
  id: string;
  time: Date;
  summary: { [key: string]: string | number };
};

function invalidInventory(): never {
  // Never include raw repository metadata or configuration in a client error.
  throw Error("invalid restore backup inventory");
}

export function parseRestoreBackupInventory(
  stdout: string,
  projectId: string,
): Backup[] {
  let groups: unknown;
  try {
    groups = JSON.parse(stdout);
  } catch {
    return invalidInventory();
  }
  if (!Array.isArray(groups)) return invalidInventory();
  const backups: Backup[] = [];
  for (const group of groups) {
    const snapshots = Array.isArray(group) ? group[1] : group?.snapshots;
    if (!Array.isArray(snapshots)) return invalidInventory();
    for (const snapshot of snapshots) {
      if (
        typeof snapshot?.hostname !== "string" ||
        typeof snapshot?.id !== "string" ||
        !/^[a-f0-9]{64}$/.test(snapshot.id) ||
        typeof snapshot?.time !== "string" ||
        !Number.isFinite(Date.parse(snapshot.time))
      )
        return invalidInventory();
      if (snapshot.hostname !== `project-${projectId}`) continue;
      // Restore needs identity and time only, not paths or the backup command.
      backups.push({
        id: snapshot.id,
        time: new Date(snapshot.time),
        summary: {},
      });
    }
  }
  return backups;
}

export async function listRestoreBackups({
  profilePath,
  projectId,
}: {
  profilePath: string;
  projectId: string;
}): Promise<Backup[]> {
  // Directory-repository development mode initializes missing repositories.
  // Project backup configuration resolves to TOML; never initialize it here.
  if (!profilePath.endsWith(".toml"))
    throw Error("restore inventory requires a repository profile");
  let output;
  try {
    output = await rustic(["snapshots", "--json"], {
      repo: profilePath,
      host: `project-${projectId}`,
      timeout: 60_000,
      maxSize: 100_000_000,
    });
  } catch {
    throw Error("restore backup inventory command failed");
  }
  if (output.truncated)
    throw Error("restore backup inventory exceeded its time or output limit");
  if (output.code !== 0) {
    if (isMissingRusticRepositoryError(output.stderr)) return [];
    throw Error("restore backup inventory command failed");
  }
  return parseRestoreBackupInventory(output.stdout, projectId);
}

/**
 * The ids and times of a project's backups, oldest first, for the host's own
 * bookkeeping: the backup limit, the parent of a new backup, and confirming a
 * recorded backup. This reads only snapshot files, with a timeout. The backup
 * browser's WebDAV helper first loads the whole repository index, and
 * repositories are shared by many projects: one stalled object-store read left
 * it unready for its whole 5-minute start timeout, which failed archive
 * backups on prod (2026-10-16). `browse` lists a directory repository
 * (development), which has no profile for the inventory.
 */
export async function listBackupIds({
  profilePath,
  projectId,
  browse,
}: {
  profilePath: string;
  projectId: string;
  browse: () => Promise<{ id: string; time: Date }[]>;
}): Promise<{ id: string; time: Date }[]> {
  const backups = profilePath.endsWith(".toml")
    ? await listRestoreBackups({ profilePath, projectId })
    : await browse();
  return backups
    .map(({ id, time }) => ({ id, time }))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}
