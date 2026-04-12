import { lite } from "@cocalc/frontend/lite";

export type BrowserTimeTravelProviders = {
  patchflow: boolean;
  snapshots: boolean;
  backups: boolean;
  git: boolean;
};

export function getBrowserTimeTravelProviders(): BrowserTimeTravelProviders {
  return {
    patchflow: true,
    snapshots: true,
    // Lite does not implement project backup archives.
    backups: !lite,
    git: true,
  };
}
