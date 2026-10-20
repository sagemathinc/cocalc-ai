/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The record cap a persist stream is opened with: a board stream never yields
(or allocates) a record over a board's record limit (board-history.ts), so a
stored record can't be decompressed past it (storage.ts
assertWithinRecordCap). Server side only: board-policy.ts needs node:path,
and util.ts (which client.ts, and so the frontend, imports) must not load it.
*/

import { classifyStreamPath } from "./board-policy";
import { BOARD_HISTORY_LIMITS } from "./board-history";

export function boardRecordCap(logicalPath: string): number | undefined {
  return classifyStreamPath(logicalPath).board
    ? BOARD_HISTORY_LIMITS.recordBytes
    : undefined;
}
