/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Once a project on this host keeps its edit history in a persist volume of
its own (persist-volume.ts), project-host software from before persist
volumes would use the old directories in the homes again: the history would
seem gone, and what it wrote there would only be set aside once this software
runs again (setAsideReappearedLegacy).  So this host never activates a
project-host bundle without persist volumes, nor runs its persist server
from one.

COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE=1 in the host's environment allows it
anyway, e.g., by hand in an emergency.
*/

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import {
  PERSIST_VOLUME_READY_MARKER,
  PERSIST_VOLUME_SUFFIX,
  projectPersistTemplates,
} from "@cocalc/backend/conat/persist-volume-template";

const logger = getLogger("project-host:persist-layout-guard");

export class PersistLayoutDowngradeError extends Error {}

// Whether the project-host bundle at `root` keeps histories in persist
// volumes (it has the module for them).
export function bundleHasPersistVolumes(root: string): boolean {
  return existsSync(join(root, "dist", "persist-volume.js"));
}

const VOLUME = new RegExp(
  `^project-[0-9a-f-]{36}${PERSIST_VOLUME_SUFFIX}$`,
  "i",
);

// Whether a project on this host has its history in a persist volume.
export function hostHasPersistVolumes(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const { legacy } = projectPersistTemplates(env);
  if (legacy == null) return false;
  const mount = dirname(legacy.home);
  let names: string[];
  try {
    names = readdirSync(mount);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw err;
  }
  for (const name of names) {
    if (
      VOLUME.test(name) &&
      existsSync(join(mount, name, PERSIST_VOLUME_READY_MARKER))
    ) {
      return true;
    }
  }
  return false;
}

// Throws PersistLayoutDowngradeError unless this host may run the
// project-host bundle at `root`.
export function assertBundleKeepsPersistVolumes(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (bundleHasPersistVolumes(root)) return;
  if (!hostHasPersistVolumes(env)) return;
  if (env.COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE === "1") {
    logger.warn(
      "running project-host software from before persist volumes (COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE=1)",
      { root },
    );
    return;
  }
  throw new PersistLayoutDowngradeError(
    `refusing project-host ${basename(root)}: projects on this host keep their edit history in persist volumes, which that version predates (it would not see the history); COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE=1 allows it`,
  );
}
