/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Privileges that read like the person's mail. During a turn, everyone in the
// agent's project can use its key, so a managed connector key may use these
// only while that project has no other collaborators (cocalc-connector-scope).
export const SOLO_PROJECT_ACCOUNT_CAPABILITIES: ReadonlySet<string> = new Set([
  "notifications:manage",
]);
