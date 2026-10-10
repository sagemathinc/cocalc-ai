/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The project secret that keys the saved sign-ins of the project's web
// browsers (see cli/src/bin/core/shared-browser/keyring.ts).  A human creates
// it when they open a browser: agents do not create project secrets, and a
// browser decides when it starts whether it keeps sign-ins.

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { SHARED_BROWSER_KEY_SECRET } from "@cocalc/util/shared-browser";

// Checked recently, by project.
const CHECKED_MS = 60_000;
const checked = new Map<string, { at: number; done: Promise<void> }>();

export function newSharedBrowserKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function ensureSharedBrowserKey(project_id: string): Promise<void> {
  const known = checked.get(project_id);
  if (known && Date.now() - known.at < CHECKED_MS) return known.done;
  const done = (async () => {
    const hub = webapp_client.conat_client.hub.projects;
    const secrets = await hub.listProjectSecrets({ project_id });
    if (secrets.some(({ name }) => name === SHARED_BROWSER_KEY_SECRET)) return;
    await hub.setProjectSecret({
      project_id,
      name: SHARED_BROWSER_KEY_SECRET,
      value: newSharedBrowserKey(),
    });
  })();
  checked.set(project_id, { at: Date.now(), done });
  done.catch(() => checked.delete(project_id));
  return done;
}

// A new key: every browser in the project restarts signed out, and the
// sign-ins in copies of their profiles (snapshots, backups) are unreadable.
export async function forgetSharedBrowserSignIns(
  project_id: string,
): Promise<void> {
  const result = await webapp_client.conat_client.hub.projects.setProjectSecret(
    {
      project_id,
      name: SHARED_BROWSER_KEY_SECRET,
      value: newSharedBrowserKey(),
    },
  );
  checked.set(project_id, { at: Date.now(), done: Promise.resolve() });
  if (result.runtime_refresh?.status === "retry_pending")
    throw Error(
      "The new key is saved, but the running project has not received it yet; its browsers sign out when it does (at the latest when the project restarts).",
    );
}
