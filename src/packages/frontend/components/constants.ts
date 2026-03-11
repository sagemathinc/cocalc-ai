/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// base unit in pixel for margin/size/padding
export const UNIT = 15;

// injected by webpack, but not for react-static renderings
declare var SMC_VERSION,
  BUILD_DATE,
  COCALC_GIT_REVISION,
  FRONTEND_BUILD_FINGERPRINT,
  FRONTEND_BUILD_AVAILABLE,
  FRONTEND_BUILD_LATEST_MTIME_MS,
  FRONTEND_BUILD_LATEST_MTIME_ISO,
  FRONTEND_BUILD_LATEST_PATH,
  FRONTEND_BUILD_WATCHED_ROOTS;
export let smc_version, build_date, smc_git_rev;
export let frontend_build_fingerprint,
  frontend_build_available,
  frontend_build_latest_mtime_ms,
  frontend_build_latest_mtime_iso,
  frontend_build_latest_path,
  frontend_build_watched_roots;
try {
  smc_version = SMC_VERSION ?? "N/A";
  build_date = BUILD_DATE ?? "N/A";
  smc_git_rev = COCALC_GIT_REVISION ?? "N/A";
  frontend_build_fingerprint = FRONTEND_BUILD_FINGERPRINT ?? "N/A";
  frontend_build_available = FRONTEND_BUILD_AVAILABLE ?? false;
  frontend_build_latest_mtime_ms = FRONTEND_BUILD_LATEST_MTIME_MS ?? 0;
  frontend_build_latest_mtime_iso = FRONTEND_BUILD_LATEST_MTIME_ISO ?? "N/A";
  frontend_build_latest_path = FRONTEND_BUILD_LATEST_PATH ?? "N/A";
  frontend_build_watched_roots = FRONTEND_BUILD_WATCHED_ROOTS ?? [];
} catch (_err) {
  // Happens potentially when running on backend.
  smc_version = "N/A";
  build_date = "N/A";
  smc_git_rev = "N/A";
  frontend_build_fingerprint = "N/A";
  frontend_build_available = false;
  frontend_build_latest_mtime_ms = 0;
  frontend_build_latest_mtime_iso = "N/A";
  frontend_build_latest_path = "N/A";
  frontend_build_watched_roots = [];
}
