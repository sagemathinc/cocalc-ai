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
import {
  currentFenceHolder,
  fenceCapableServerRunning,
  persistServerHasFeature,
} from "@cocalc/backend/conat/persist-fence";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  PersistFenceUnavailableError,
  withPersistFence,
} from "@cocalc/conat/persist/fence";
import { setTimeout as delay } from "node:timers/promises";
import {
  checkProjectHostConatPersistReady,
  isProjectHostExternalConatPersistEnabled,
  persistFenceDir,
} from "./conat-persist";

const logger = getLogger("project-host:persist-fence");

// How long a restore waits for the fence service of a persist server that
// has one (e.g., while it restarts or resubscribes) before it fails.
const UNAVAILABLE_WAIT_MS = 60_000;

let fenceClient: ConatClient | undefined;

export function setPersistFenceClient(client: ConatClient | undefined): void {
  fenceClient = client;
}

// What to do when no fence service answers.
async function whenUnavailable(
  client: ConatClient,
): Promise<"wait" | "unfenced"> {
  // A persist server that has fences (in this process, or a daemon whose
  // capability file names a running process): its service is only briefly
  // unreachable.
  if (
    !isProjectHostExternalConatPersistEnabled() ||
    fenceCapableServerRunning(persistFenceDir())
  ) {
    return "wait";
  }
  // A persist daemon that answers without a capability file is from before
  // fences (one writes its file before it serves); none answering means it
  // is restarting.
  return (await checkProjectHostConatPersistReady({ client }))
    ? "unfenced"
    : "wait";
}

// Runs fn while the project's persistent streams are fenced.  Only with a
// persist daemon from before fences (e.g., kept running across an upgrade)
// does it go ahead unfenced, as restores did before; if a server with fences
// can't be reached, it waits a while and then fails without running fn.
//
// With requires (e.g., "persist-volume": fn changes the history's volume), the
// persist server must have that feature (its capability file says so, see
// conat-persist.ts), and it never goes ahead unfenced: a daemon from before
// would keep using the history where it was, and its writes would be lost.
export async function withProjectPersistFenced<T>(
  {
    project_id,
    reason,
    requires,
  }: { project_id: string; reason: string; requires?: string },
  fn: () => Promise<T>,
  { waitMs = UNAVAILABLE_WAIT_MS }: { waitMs?: number } = {},
): Promise<T> {
  const client = fenceClient;
  if (client == null) {
    throw new Error("persist fences are not set up (no file server)");
  }
  if (
    requires != null &&
    isProjectHostExternalConatPersistEnabled() &&
    !persistServerHasFeature(persistFenceDir(), requires)
  ) {
    throw new Error(
      `the persist daemon on this host is from an older version (no ${requires}), so the project's history can't be replaced now; try again after it is upgraded`,
    );
  }
  const deadline = Date.now() + waitMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await withPersistFence(
        {
          client,
          project_id,
          holder: currentFenceHolder(),
          // checked by the server that grants the fence
          ...(requires != null ? { requires: [requires] } : {}),
        },
        fn,
      );
    } catch (err) {
      if (!(err instanceof PersistFenceUnavailableError)) throw err;
      if (requires == null && (await whenUnavailable(client)) == "unfenced") {
        logger.warn("the persist daemon has no fences; going ahead unfenced", {
          project_id,
          reason,
        });
        return await fn();
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `the persist fence service is unavailable, so the project's history can't be replaced safely now; try again (${err})`,
        );
      }
      await delay(Math.min(5000, 500 * 2 ** Math.min(attempt, 4)));
    }
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
