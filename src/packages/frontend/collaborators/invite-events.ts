/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const COLLAB_INVITES_CHANGED_EVENT = "cocalc:collab-invites-changed";

type CollabInvitesChangedDetail = {
  project_id?: string;
};

export function notifyCollabInvitesChanged(project_id?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CollabInvitesChangedDetail>(COLLAB_INVITES_CHANGED_EVENT, {
      detail: { project_id },
    }),
  );
}

export function onCollabInvitesChanged(
  cb: (detail: CollabInvitesChangedDetail) => void,
): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }
  const listener = (event: Event) => {
    const custom = event as CustomEvent<CollabInvitesChangedDetail>;
    cb(custom.detail ?? {});
  };
  window.addEventListener(COLLAB_INVITES_CHANGED_EVENT, listener as EventListener);
  return () =>
    window.removeEventListener(
      COLLAB_INVITES_CHANGED_EVENT,
      listener as EventListener,
    );
}

