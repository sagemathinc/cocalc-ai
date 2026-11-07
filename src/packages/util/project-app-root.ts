/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { trimTrailingSlashes } from "./linear-text";

export interface ProjectAppProxySpec {
  base_path?: string;
  strip_prefix?: boolean;
}

// The project-local mount (e.g. "/apps/foo") of an app that can be served at
// the root of its own origin (trust-free step 6, phase 7c), or undefined.
// The project host mounts it there only when it strips its prefix and has a
// base path of its own; the project starts and reports the app the same way,
// so both sides agree on whether it runs at the root.
export function appRootMountBase(
  proxy?: ProjectAppProxySpec | null,
): string | undefined {
  if (proxy == null || proxy.strip_prefix === false) return;
  const value = proxy.base_path ?? "/";
  const base = trimTrailingSlashes(value.startsWith("/") ? value : `/${value}`);
  if (!base || base === "/" || /[?#\\]/.test(base) || base.includes("//")) {
    return;
  }
  return base;
}
