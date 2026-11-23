/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The lists of tables protected by guard triggers. Tests check them against the
triggers actually installed (append-only-guards.test.ts), so a new guarded
table has to be added to one of them or that test fails.
*/

import { FEDERATED_MINT_LOG_TABLE } from "./federated-connector-mint-log";

export const APPEND_ONLY_GUARDED_TABLES: readonly string[] = [
  FEDERATED_MINT_LOG_TABLE,
  "federated_connector_assignment_audit",
];

// Guarded, but not append-only (an open row may change once, e.g. a lease
// ends): only TRUNCATE is refused here. Their full guard semantics are tested
// in federated-connector-guards.test.ts.
export const TRUNCATE_GUARDED_TABLES: readonly string[] = [
  "federated_connector_turn_leases",
];
