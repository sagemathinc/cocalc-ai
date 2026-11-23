/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The one list of tables protected by append-only guard triggers. Tests check it
against the triggers actually installed (append-only-guards.test.ts), so a new
guarded table has to be added here or that test fails.
*/

import { FEDERATED_MINT_LOG_TABLE } from "./federated-connector-mint-log";

export const APPEND_ONLY_GUARDED_TABLES: readonly string[] = [
  FEDERATED_MINT_LOG_TABLE,
];
