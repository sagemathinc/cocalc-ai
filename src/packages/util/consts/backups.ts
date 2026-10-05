import { human_readable_size } from "../misc";

export const BACKUPS = ".backups";

// Files whose apparent size exceeds the backup limit are not backed up, so
// they are also left out of moves, archives, and cross-host copies, which
// restore from backups. Sparse files make apparent size unrelated to disk use,
// and backing one up reads every hole. A dense file cannot exceed the disk
// quota, so the quota-based limit only affects sparse or compressed files.
// Restores are dense, so a larger file could not be restored within the quota
// anyway. The privileged backup helper enforces the same clamp on whatever it
// is sent.
export const BACKUP_MAX_FILE_QUOTA_MULTIPLE = 1;
export const BACKUP_MIN_MAX_FILE_BYTES = 1000 ** 3;
export const BACKUP_DEFAULT_MAX_FILE_BYTES = 100 * 1000 ** 3;
export const BACKUP_CEILING_MAX_FILE_BYTES = 1000 ** 4;

export function backupMaxFileBytes(diskQuotaBytes?: number | null): number {
  if (
    diskQuotaBytes == null ||
    !Number.isFinite(diskQuotaBytes) ||
    diskQuotaBytes <= 0
  ) {
    return BACKUP_DEFAULT_MAX_FILE_BYTES;
  }
  return Math.min(
    BACKUP_CEILING_MAX_FILE_BYTES,
    Math.max(
      BACKUP_MIN_MAX_FILE_BYTES,
      Math.floor(diskQuotaBytes * BACKUP_MAX_FILE_QUOTA_MULTIPLE),
    ),
  );
}

// Files a backup skipped because they exceed max_file_bytes. `files` holds at
// most a small sample; `count` is the total.
export interface OversizedFilesReport {
  max_file_bytes: number;
  count: number;
  files: { path: string; size: number }[];
}

// True for a report that lists at least one skipped file.
export function hasOversizedFiles(
  value: unknown,
): value is OversizedFilesReport {
  const report = value as OversizedFilesReport | null | undefined;
  return (
    typeof report?.max_file_bytes === "number" &&
    typeof report?.count === "number" &&
    report.count > 0 &&
    Array.isArray(report?.files)
  );
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

export function isBackupsPath(path?: string): boolean {
  if (path == null) return false;
  const normalized = stripLeadingSlash(path);
  return normalized === BACKUPS || normalized.startsWith(`${BACKUPS}/`);
}

// Message for an operation refused because it would leave out oversized files.
export function oversizedFilesMessage(
  action: string,
  report: OversizedFilesReport,
): string {
  const one = report.count === 1;
  const sample = report.files.map(({ path }) => path).join(", ");
  const more =
    report.count > report.files.length
      ? ` and ${report.count - report.files.length} more`
      : "";
  return `Unable to ${action}: ${report.count} ${one ? "file is" : "files are"} larger than this project's ${human_readable_size(report.max_file_bytes)} backup file size limit and would not be included (${sample}${more}). Delete or shrink ${one ? "it" : "them"}, or confirm that ${one ? "it" : "they"} may be skipped.`;
}
