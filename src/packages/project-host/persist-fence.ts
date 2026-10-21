/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Fences a project's persistent streams on this host's persist server while
its persist files are replaced, e.g., by restoring its home from a snapshot
or a backup (conat/persist/fence.ts).  Then nothing has those files open
while they change, and clients load the restored history afterwards instead
of resuming from seqs of the replaced files.
*/

import path from "node:path";
import getLogger from "@cocalc/backend/logger";
import { syncFiles } from "@cocalc/backend/data";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  PersistFenceUnavailableError,
  withPersistFence,
} from "@cocalc/conat/persist/fence";

const logger = getLogger("project-host:persist-fence");

let fenceClient: ConatClient | undefined;

export function setPersistFenceClient(client: ConatClient | undefined): void {
  fenceClient = client;
}

// Runs fn while the project's persistent streams are fenced.  Without a fence
// service (e.g., a persist daemon from before fences, still running after an
// upgrade), it goes ahead unfenced, as restores did before.
export async function withProjectPersistFenced<T>(
  { project_id, reason }: { project_id: string; reason: string },
  fn: () => Promise<T>,
): Promise<T> {
  const client = fenceClient;
  if (client == null) {
    logger.warn("persist fences are not set up; going ahead unfenced", {
      project_id,
      reason,
    });
    return await fn();
  }
  try {
    return await withPersistFence({ client, project_id }, fn);
  } catch (err) {
    if (err instanceof PersistFenceUnavailableError) {
      logger.warn("persist fence service unavailable; going ahead unfenced", {
        project_id,
        reason,
        err: `${err}`,
      });
      return await fn();
    }
    throw err;
  }
}

// The project's persist directory relative to its home, if it is inside the
// home (COCALC_SYNC_PROJECTS); "" if it is the home itself.
export function persistDirInHome(
  project_id: string,
  home: string,
  template: string = syncFiles.localProjects,
): string | undefined {
  if (!template) return;
  const dir = template.includes("[project_id]")
    ? template.split("[project_id]").join(project_id)
    : path.join(template, project_id);
  const rel = path.relative(home, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return;
  return rel;
}

// Whether restoring files into dest (relative to the project's home) can
// write its persist files.
export function restoreTouchesPersistFiles({
  project_id,
  home,
  dest,
  template,
}: {
  project_id: string;
  home: string;
  dest: string;
  template?: string;
}): boolean {
  const persist = persistDirInHome(project_id, home, template);
  if (persist == null) return false;
  const target = path.posix.normalize(dest || ".");
  if (target === "." || persist === "") return true;
  return (
    target === persist ||
    persist.startsWith(`${target}/`) ||
    target.startsWith(`${persist}/`)
  );
}
