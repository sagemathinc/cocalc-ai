/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Managed VMs accept only the project's own SSH key. Arbitrary account keys
// can no longer be authorized; keys authorized earlier can still be listed and
// removed.
export const ARBITRARY_SSH_KEY_UNSUPPORTED =
  "Arbitrary SSH public keys can no longer be authorized on managed VMs; only the project's own SSH key is accepted. Keys authorized earlier can still be listed and removed.";
