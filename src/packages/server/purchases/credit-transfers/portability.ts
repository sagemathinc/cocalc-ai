/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import { lockAccountRehomeFence } from "@cocalc/database/postgres/account-rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { fundingId } from "@cocalc/util/compute-funding";

const tables = {
  credit_payment_roots: { owner: "account_id", key: "root_id" },
  credit_transfers: { owner: "sender_account_id", key: "transfer_id" },
  credit_transfer_deliveries: {
    owner: "recipient_account_id",
    key: "transfer_id",
  },
  credit_transfer_entries: { owner: "account_id", key: "id" },
  credit_transfer_ledger_observations: {
    owner: "account_id",
    key: "purchase_id",
  },
} as const;
type TransferTable = keyof typeof tables;
type Row = Record<string, any>;
export interface CreditTransferPortableState {
  version: 1;
  account_id: string;
  source_bay_id: string;
  source_authority_epoch: string;
  rows: Record<TransferTable, Row[]>;
}

async function requireFrozen(client: PoolClient, account_id: string) {
  fundingId(account_id, "Transfer account");
  await lockAccountRehomeFence({ db: client, account_id });
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('account-funding'),hashtext($1))",
    [account_id],
  );
  const {
    rows: [authority],
  } = await client.query(
    "SELECT epoch,home_bay_id,state FROM account_funding_authorities WHERE payer_account_id=$1 FOR UPDATE",
    [account_id],
  );
  if (
    authority?.state !== "frozen" ||
    authority.home_bay_id !== getConfiguredBayId()
  )
    throw Error(
      "Transfer portability requires frozen local financial authority",
    );
  return authority;
}

/** Participant in the trusted account rehome transaction, never a public RPC.
 * The coordinator owns freeze/cutover/retirement and the complete purchase copy.
 * Retain source delivery fences: delayed deliveries must still observe receipt.
 */
export async function exportCreditTransferStateInTransaction(
  client: PoolClient,
  account_id: string,
): Promise<CreditTransferPortableState> {
  const authority = await requireFrozen(client, account_id);
  const rows = {} as CreditTransferPortableState["rows"];
  for (const [table, spec] of Object.entries(tables)) {
    // PostgreSQL NUMERIC must not round-trip through JavaScript JSON numbers.
    const amount =
      table === "credit_payment_roots"
        ? "amount_usd"
        : table === "credit_transfer_ledger_observations"
          ? "max_cost"
          : undefined;
    const exact = amount
      ? ` || jsonb_build_object('${amount}',t.${amount}::text)`
      : "";
    const result = await client.query(
      `SELECT to_jsonb(t)${exact} AS row FROM ${table} t WHERE ${spec.owner}=$1 ORDER BY ${spec.key} LIMIT 100001`,
      [account_id],
    );
    if (result.rows.length > 100000)
      throw Error("Transfer portability needs a paginated checkpoint");
    rows[table as TransferTable] = result.rows.map(({ row }) => row);
  }
  return {
    version: 1,
    account_id,
    source_bay_id: getConfiguredBayId(),
    source_authority_epoch: authority.epoch,
    rows,
  };
}

/** Import only after the coordinator authenticates the source operation and
 * copies the complete ledger in posting order. No activation or hold release.
 * The ID map is the coordinator's durable map, not a client-provided mapping.
 */
export async function importCreditTransferStateInTransaction(
  client: PoolClient,
  opts: {
    account_id: string;
    state: CreditTransferPortableState;
    purchase_ids: Readonly<Record<string, number>>;
  },
): Promise<void> {
  const { account_id, state, purchase_ids } = opts;
  await requireFrozen(client, account_id);
  if (
    state.version !== 1 ||
    state.account_id !== account_id ||
    state.source_bay_id === getConfiguredBayId()
  )
    throw Error("Transfer portability identity mismatch");
  fundingId(state.source_authority_epoch, "Source financial authority");
  const ordered = Object.entries(purchase_ids).sort(
    (a, b) => Number(a[0]) - Number(b[0]),
  );
  let previous = 0;
  for (const [source, target] of ordered) {
    if (
      !Number.isSafeInteger(Number(source)) ||
      Number(source) <= 0 ||
      String(Number(source)) !== source ||
      !Number.isSafeInteger(target) ||
      target <= previous
    )
      throw Error("Transfer purchase mapping must preserve posting order");
    previous = target;
  }
  const { rows: purchases } = await client.query(
    "SELECT id FROM purchases WHERE account_id=$1 AND id=ANY($2::integer[])",
    [account_id, ordered.map(([, id]) => id)],
  );
  if (purchases.length !== ordered.length)
    throw Error("Transfer destination ledger is incomplete");
  const mapped = (id: number): number => {
    const result = purchase_ids[id];
    if (result == null) throw Error("Missing transfer purchase mapping");
    return result;
  };
  for (const [table, spec] of Object.entries(tables)) {
    const entries = state.rows[table as TransferTable];
    if (!Array.isArray(entries) || entries.length > 100000)
      throw Error("Invalid transfer portability rows");
    for (const original of entries) {
      if (original[spec.owner] !== account_id)
        throw Error("Transfer row belongs to another account");
      const row = structuredClone(original);
      if (table === "credit_payment_roots") {
        row.original_purchase_id ??= row.purchase_id;
        row.purchase_id = mapped(row.purchase_id);
      } else if (table === "credit_transfer_entries") {
        row.purchase_id = mapped(row.purchase_id);
        row.receipt.purchase_id = row.purchase_id;
        if (row.leg === "debit")
          row.fragments = row.fragments.map((fragment) => ({
            ...fragment,
            source_purchase_id: mapped(fragment.source_purchase_id),
          }));
      } else if (table === "credit_transfer_ledger_observations")
        row.purchase_id = mapped(row.purchase_id);
      // Manifests, root identities and receiving-fence hashes are immutable.
      const json = JSON.stringify(row);
      await client.query(
        `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
        [json],
      );
      const { rows: same } = await client.query(
        `SELECT 1 FROM ${table} t WHERE ${spec.key}=$1 AND to_jsonb(t)=to_jsonb(jsonb_populate_record(NULL::${table},$2::jsonb))`,
        [row[spec.key], json],
      );
      if (same.length !== 1)
        throw Error(
          "Transfer portability conflicts with existing destination history",
        );
    }
  }
}
