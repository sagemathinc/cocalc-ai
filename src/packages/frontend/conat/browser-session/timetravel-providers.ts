import { lite } from "@cocalc/frontend/lite";

export type BrowserTimeTravelProviders = {
  patchflow: boolean;
  snapshots: boolean;
  backups: boolean;
  git: boolean;
};

export function getBrowserTimeTravelProviders(
  projectsApi: Record<string, unknown> | undefined,
): BrowserTimeTravelProviders {
  return {
    patchflow: true,
    snapshots: typeof projectsApi?.getSnapshotFileText === "function",
    // Lite does not implement project backup APIs even though the generic hub
    // proxy exposes callable stubs for every declared method.
    backups:
      !lite &&
      typeof projectsApi?.findBackupFiles === "function" &&
      typeof projectsApi?.getBackupFileText === "function",
    git: true,
  };
}
