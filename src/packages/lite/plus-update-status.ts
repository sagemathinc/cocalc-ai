/*
 * Is a newer CoCalc Plus release installed than the one this Lite runs?
 *
 * CoCalc Plus installs updates in the background but never restarts Lite
 * (that would lose notebook and terminal state); the UI shows a "restart to
 * update" notice instead. This reads the installed `active` pointer and the
 * local manifests; it only describes, and changes nothing.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Read when this module loads: Lite's project setup later deletes every
// inherited COCALC_* variable from process.env.
const INSTALLED = {
  root: process.env.COCALC_PLUS_DIST_ROOT,
  active: process.env.COCALC_PLUS_ACTIVE,
};

export interface PlusUpdateStatus {
  restartToApply: boolean;
  running?: { release: number; version: string };
  installed?: { release: number; version: string };
}

async function release(
  root: string,
  line: string | undefined,
): Promise<{ release: number; version: string } | undefined> {
  const hash = /^v1 ([0-9a-f]{64}) /.exec(line ?? "")?.[1];
  if (hash == null) return undefined;
  try {
    const manifest = JSON.parse(
      await readFile(join(root, "manifests", `${hash}.json`), "utf8"),
    );
    if (
      Number.isSafeInteger(manifest.release) &&
      typeof manifest.version === "string"
    ) {
      return { release: manifest.release, version: manifest.version };
    }
  } catch {
    // not installed this way, or gone
  }
  return undefined;
}

export async function plusUpdateStatus(
  installedBy: { root?: string; active?: string } = INSTALLED,
): Promise<PlusUpdateStatus> {
  const root = installedBy.root;
  const runningLine = installedBy.active;
  if (!root || !runningLine) return { restartToApply: false };
  const installedLine = await readFile(join(root, "active"), "utf8").catch(
    () => undefined,
  );
  const running = await release(root, runningLine);
  const installed = await release(root, installedLine?.trimEnd());
  return {
    running,
    installed,
    restartToApply:
      running != null &&
      installed != null &&
      installed.release > running.release,
  };
}
