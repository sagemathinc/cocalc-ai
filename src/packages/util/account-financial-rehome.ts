/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

/** Internal, authenticated bay-to-bay transport. Never accepted from a user RPC.
 * The snapshot is an immutable JSON string so NUMERIC values and its digest do
 * not depend on the transport's object serialization.
 */
export interface AccountFinancialHandoff {
  version: 1;
  op_id: string;
  account_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  source_epoch: string;
  dest_epoch: string;
  snapshot: string;
  snapshot_hash: string;
}

export interface AccountFinancialActivation {
  op_id: string;
  target_account_id: string;
  source_bay_id: string;
  dest_bay_id: string;
}
