/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Once this host keeps projects' edit history in persist volumes
(persist-volume.ts), project-host software from before them would use the
old directories in the homes again, and the history would seem gone.  So:

- a persist server that keeps histories in volumes records that, for good,
  in the host's data directory before it serves, so before any history
  moves (commitToPersistVolumes);
- from then on this host never activates or starts a project-host bundle
  without persist volumes (assertBundleKeepsPersistVolumes), nor runs a
  persist server that keeps histories in the homes (assertPersistVolumesStayOn).

The record and the current bundle are each written before the other is
checked: a persist server records, then checks the current bundle; an
activation switches the bundle, then checks the record and undoes the
switch.  Of two that race, at least one sees the other.

COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE=1 in the host's environment allows a
downgrade anyway, by hand (e.g., in an emergency).
*/

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import getLogger from "@cocalc/backend/logger";
import { resolveHostAgentDataDir } from "./host-agent-state";

const logger = getLogger("project-host:persist-layout-guard");

const RECORD = "persist-volume-layout";

export class PersistLayoutDowngradeError extends Error {}

interface Where {
  // the host's data directory (resolveHostAgentDataDir)
  dataDir?: string;
  env?: NodeJS.ProcessEnv | Record<string, string>;
}

function recordPath(dataDir?: string): string {
  return join(resolveHostAgentDataDir(dataDir), RECORD);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function overridden(env: Where["env"] = process.env): boolean {
  return env?.COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE === "1";
}

// Where the current project-host bundle is linked (as the daemon starts it).
export function projectHostCurrentLink(
  env: Where["env"] = process.env,
): string {
  const explicit = `${env?.COCALC_PROJECT_HOST_CURRENT ?? ""}`.trim();
  if (explicit) return explicit;
  const bundleRoot = `${env?.COCALC_PROJECT_HOST_BUNDLE_ROOT ?? ""}`.trim();
  if (bundleRoot) return join(bundleRoot, "current");
  return "/opt/cocalc/project-host/current";
}

// Whether the project-host bundle at `root` keeps histories in persist
// volumes (it has the module for them).
export function bundleHasPersistVolumes(root: string): boolean {
  return existsSync(join(root, "dist", "persist-volume.js"));
}

// Whether this host committed to persist volumes: only a missing record
// means it did not.
export function hostCommittedToPersistVolumes(dataDir?: string): boolean {
  try {
    lstatSync(recordPath(dataDir));
    return true;
  } catch (err) {
    const code = errorCode(err);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

// Throws PersistLayoutDowngradeError unless this host may run the
// project-host bundle at `root`.
export function assertBundleKeepsPersistVolumes(
  root: string,
  { dataDir, env = process.env }: Where = {},
): void {
  if (bundleHasPersistVolumes(root)) return;
  if (!hostCommittedToPersistVolumes(dataDir)) return;
  if (overridden(env)) {
    logger.warn(
      "running project-host software from before persist volumes (COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE=1)",
      { root },
    );
    return;
  }
  throw new PersistLayoutDowngradeError(
    `refusing project-host ${basename(root)}: this host keeps projects' edit history in persist volumes, which that version predates (it would not see the history); COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE=1 allows it`,
  );
}

// In a persist server that keeps histories in volumes, before it serves.
export function commitToPersistVolumes({
  dataDir,
  env = process.env,
}: Where = {}): void {
  if (!hostCommittedToPersistVolumes(dataDir)) {
    const path = recordPath(dataDir);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ time: new Date() })}\n`);
    syncPath(tmp);
    renameSync(tmp, path);
    syncPath(dirname(path));
    logger.info("this host keeps projects' edit history in persist volumes");
  }
  // An activation of an older bundle may have raced this one: then no
  // history moves.  (No current bundle, e.g., in development: nothing to
  // check.)
  let current: string;
  try {
    current = realpathSync(projectHostCurrentLink(env));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return;
    throw err;
  }
  assertBundleKeepsPersistVolumes(current, { dataDir, env });
}

// In a persist server that keeps histories in the homes.
export function assertPersistVolumesStayOn({
  dataDir,
  env = process.env,
}: Where = {}): void {
  if (!hostCommittedToPersistVolumes(dataDir) || overridden(env)) return;
  throw new PersistLayoutDowngradeError(
    "this host keeps projects' edit history in persist volumes, so its persist server can't use the old directories in the homes (e.g., COCALC_PERSIST_PROJECT_VOLUME=0); COCALC_ALLOW_PERSIST_LAYOUT_DOWNGRADE=1 allows it",
  );
}

function syncPath(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
