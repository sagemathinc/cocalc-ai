/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  appRootMountBase,
  type ProjectAppProxySpec,
} from "@cocalc/util/project-app-root";

// On a host whose site has app origins (trust-free step 6, phase 7c), each
// app runs at the root of its own origin, so managed apps are started
// without a base URL (APP_BASE_URL="/").  The project-local route
// (APP_LOCAL_BASE_URL, the status url) is unchanged.
export function appsAtRoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COCALC_PROJECT_APPS_AT_ROOT === "1";
}

// Whether this app runs at the root of its own origin here: apps at the
// root on this host, and an app the host mounts there (it strips its prefix
// and has a base path of its own; see appRootMountBase). An app that keeps
// its prefix runs with its project-local base URL.
export function appServedAtRoot(
  proxy?: ProjectAppProxySpec | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return appsAtRoot(env) && appRootMountBase(proxy) != null;
}
