// Strip this retired header at the final upstream boundary so stale clients
// cannot pass historical CoCalc routing metadata into user applications.
export const LEGACY_APP_PROXY_EXPOSURE_HEADER = "x-cocalc-app-exposure";
