/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Where a project-host keeps each project's persist databases.

They used to live in the project's home: host bootstrap sets
COCALC_SYNC_PROJECTS=/mnt/cocalc/project-[project_id]/.local/share/cocalc/persist.
The project owns that directory, so it could change the databases at any time.
Now each project has its own btrfs subvolume next to its home,
/mnt/cocalc/project-[project_id]-persist, which is never mounted into the
project. The old directory is only read once, to import a project's history
(see project-host/persist-volume.ts). Backups still carry the databases at the
old path, so backups, moves and restores work across versions.

COCALC_PERSIST_PROJECT_VOLUME=0 keeps the databases in the home.
*/

export const PERSIST_VOLUME_SUFFIX = "-persist";

const IN_HOME = /^(.*\/project-)\[project_id\]\/+([^/].*?)\/*$/;

export interface ProjectPersistTemplates {
  // where the persist server keeps a project's databases
  template: string;
  // the old location in the project's home, when the databases moved from it:
  // home is the template of the home directory, relative the directory in it
  legacy?: { home: string; relative: string };
}

export function projectPersistTemplates(
  env: NodeJS.ProcessEnv = process.env,
): ProjectPersistTemplates {
  const configured = env.COCALC_SYNC_PROJECTS ?? "";
  const match = configured.match(IN_HOME);
  if (match == null || env.COCALC_PERSIST_PROJECT_VOLUME === "0") {
    return { template: configured };
  }
  const relative = match[2];
  if (relative.split("/").some((part) => part === ".." || part === ".")) {
    return { template: configured };
  }
  return {
    template: `${match[1]}[project_id]${PERSIST_VOLUME_SUFFIX}`,
    legacy: { home: `${match[1]}[project_id]`, relative },
  };
}
