/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Where you last were in the app (an app path like "agents/foo" or
// "projects/<id>/files/a.md"), so "Open CoCalc" on the public pages
// returns there.

const KEY = "cocalc-last-app-path-v1";

export function rememberAppPath(path: string): void {
  const clean = path.replace(/^\/+/, "");
  // Transient pages are not a place to return to.
  if (!clean || /^(search|auth|u)(\/|$)/.test(clean)) return;
  try {
    localStorage.setItem(KEY, clean.slice(0, 2000));
  } catch {
    // optional
  }
}

export function lastAppPath(): string | undefined {
  try {
    const path = localStorage.getItem(KEY);
    // Only a relative app path; never a URL to elsewhere.
    return path && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path) ? path : undefined;
  } catch {
    return undefined;
  }
}
