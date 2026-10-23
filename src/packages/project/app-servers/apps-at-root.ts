/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// On a host whose site has app origins (trust-free step 6, phase 7c), each
// app runs at the root of its own origin, so managed apps are started
// without a base URL (APP_BASE_URL="/").  The project-local route
// (APP_LOCAL_BASE_URL, the status url) is unchanged.
export function appsAtRoot(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COCALC_PROJECT_APPS_AT_ROOT === "1";
}
