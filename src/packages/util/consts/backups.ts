export const BACKUPS = ".backups";

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

export function isBackupsPath(path?: string): boolean {
  if (path == null) return false;
  const normalized = stripLeadingSlash(path);
  return normalized === BACKUPS || normalized.startsWith(`${BACKUPS}/`);
}
