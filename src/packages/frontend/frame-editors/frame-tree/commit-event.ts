/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Emitted by frame leaves after React commits DOM/visibility changes. Consumers
// can wait for a frame to become visible before assigning keyboard focus.
export const FRAME_COMMIT_EVENT = "cocalc:frame-committed";
