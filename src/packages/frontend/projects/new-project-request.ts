/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// "+ New Project" outside the Projects page opens that page's create dialog;
// the request may be made before the page mounts.

const EVENT = "cocalc:new-project";
let requested = false;

export function requestNewProject(): void {
  requested = true;
  window.dispatchEvent(new Event(EVENT));
}

// Calls `open` now if a request is pending, and for later requests.
export function onNewProjectRequest(open: () => void): () => void {
  const handle = () => {
    if (!requested) return;
    requested = false;
    open();
  };
  handle();
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
