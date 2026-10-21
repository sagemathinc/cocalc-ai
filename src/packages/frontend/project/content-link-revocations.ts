/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Tells open content-origin previews in this browser that their links were
// revoked, so they get new ones at once.  No imports: the account client
// uses it too.

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function onContentLinksRevoked(
  project_id: string,
  listener: Listener,
): () => void {
  const set = listeners.get(project_id) ?? new Set();
  set.add(listener);
  listeners.set(project_id, set);
  return () => {
    set.delete(listener);
    if (set.size == 0) listeners.delete(project_id);
  };
}

// "Revoke content links" for one project.
export function notifyContentLinksRevoked(project_id: string): void {
  for (const listener of [...(listeners.get(project_id) ?? [])]) listener();
}

// A password change or "sign out other sessions" revokes the account's
// content links in every project, this browser's included.
export function notifyAllContentLinksRevoked(): void {
  for (const project_id of [...listeners.keys()]) {
    notifyContentLinksRevoked(project_id);
  }
}
