/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { createHash, randomUUID } from "node:crypto";
import getPool, { type PoolClient } from "@cocalc/database/pool";
import { lockAccountRehomeFence } from "@cocalc/database/postgres/account-rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { fundingId } from "@cocalc/util/compute-funding";
import type {
  AccountFinancialHandoff,
  AccountFinancialActivation,
} from "@cocalc/util/account-financial-rehome";
import {
  exportCreditTransferStateInTransaction,
  importCreditTransferStateInTransaction,
  type CreditTransferPortableState,
} from "@cocalc/server/purchases/credit-transfers/portability";

type Row = Record<string, any>;
type IdMaps = Record<
  "purchases" | "subscriptions" | "statements",
  Record<string, number>
>;
type Operation = Pick<
  AccountFinancialHandoff,
  "op_id" | "account_id" | "source_bay_id" | "dest_bay_id"
>;
type Snapshot = {
  rows: Record<string, Row[]>;
  transfers: CreditTransferPortableState;
};

// Ordered by foreign-key dependencies. Global usage epochs are checked, never
// overwritten by an account move. Resource rows stay at their owning bays.
const tables: Record<string, { owner: string; key: string }> = {
  purchases: { owner: "account_id", key: "id" },
  subscriptions: { owner: "account_id", key: "id" },
  statements: { owner: "account_id", key: "id" },
  compute_egress_meter_intervals: { owner: "owner_account_id", key: "id" },
  subscription_renewal_attempts: { owner: "account_id", key: "id" },
  account_usage_windows: { owner: "account_id", key: "id" },
  account_funding_holds: { owner: "payer_account_id", key: "id" },
  compute_funding_pools: { owner: "payer_account_id", key: "id" },
  compute_funding_grants: { owner: "@pool", key: "id" },
  compute_vm_personal_consents: { owner: "payer_account_id", key: "id" },
  compute_funding_reservations: { owner: "payer_account_id", key: "id" },
  compute_funding_events: { owner: "payer_account_id", key: "id" },
  compute_funding_purchase_attributions: {
    owner: "payer_account_id",
    key: "purchase_id",
  },
  payment_fulfillments: { owner: "account_id", key: "payment_id" },
  provider_refund_attempts: { owner: "account_id", key: "id" },
  admin_membership_orders: { owner: "account_id", key: "id" },
  course_funding_approval_intents: { owner: "payer_account_id", key: "id" },
  notification_events: { owner: "@notification", key: "event_id" },
  notification_targets: { owner: "target_account_id", key: "event_id" },
  notification_target_outbox: { owner: "target_account_id", key: "outbox_id" },
  notification_email_outbox: { owner: "target_account_id", key: "email_id" },
  notification_course_credit_states: { owner: "account_id", key: "id" },
};
const transferOwners = {
  credit_payment_roots: "account_id",
  credit_transfers: "sender_account_id",
  credit_transfer_deliveries: "recipient_account_id",
  credit_transfer_entries: "account_id",
  credit_transfer_ledger_observations: "account_id",
};
const ledgerTables = ["purchases", "subscriptions", "statements"] as const;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export function financialRehomeEnabled(): boolean {
  return process.env.COCALC_ENABLE_FINANCIAL_REHOME === "yes";
}

async function exists(client: PoolClient, table: string) {
  return !!(
    await client.query("SELECT to_regclass($1) AS name", [`public.${table}`])
  ).rows[0]?.name;
}

/** Called outside account transactions. Installing triggers takes table locks;
 * it must not be attempted while already holding an account spending lock.
 */
export async function ensureFinancialRehomeSchema(): Promise<void> {
  await (
    await import("@cocalc/server/notifications/course-credit-state")
  ).ensureCourseCreditNoticeSchema();
  await (
    await import("@cocalc/server/compute/funding/approvals")
  ).ensureCourseFundingApprovalSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('financial-rehome-schema'))",
    );
    await (
      await import("@cocalc/server/membership/usage-windows")
    ).ensureAccountUsageWindowSchema(client);
    await client.query(`CREATE TABLE IF NOT EXISTS account_financial_handoffs (
      op_id UUID PRIMARY KEY, account_id UUID NOT NULL,
      source_bay_id TEXT NOT NULL, dest_bay_id TEXT NOT NULL,
      source_epoch UUID NOT NULL, dest_epoch UUID NOT NULL,
      snapshot TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('frozen','accepted','imported','active','retired')),
      id_maps JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK(source_bay_id <> dest_bay_id))`);
    await client.query(`CREATE INDEX IF NOT EXISTS account_financial_handoffs_account
      ON account_financial_handoffs(account_id)`);
    // The trigger is a last-resort fence for legacy SQL writers, not spending
    // admission. Callers still acquire the common lock BEFORE locking rows.
    // A lock-order violation may abort/deadlock; it must never bypass freeze.
    await client.query(`CREATE OR REPLACE FUNCTION fence_account_financial_write()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE payer UUID; a RECORD; old_payer UUID;
      BEGIN
        IF TG_ARGV[0]='@pool' THEN
          SELECT payer_account_id INTO payer FROM compute_funding_pools
            WHERE id=COALESCE(NEW.pool_id,OLD.pool_id);
        ELSE
          payer := COALESCE(to_jsonb(NEW)->>TG_ARGV[0],to_jsonb(OLD)->>TG_ARGV[0])::uuid;
          old_payer := (to_jsonb(OLD)->>TG_ARGV[0])::uuid;
          IF TG_OP='UPDATE' AND old_payer IS DISTINCT FROM payer THEN
            RAISE EXCEPTION 'Financial row ownership cannot change';
          END IF;
        END IF;
        IF payer IS NULL THEN RETURN COALESCE(NEW,OLD); END IF;
        PERFORM pg_advisory_xact_lock(hashtext('account-rehome'),hashtext(payer::text));
        PERFORM pg_advisory_xact_lock(hashtext('account-funding'),hashtext(payer::text));
        SELECT state,home_bay_id INTO a FROM account_funding_authorities
          WHERE payer_account_id=payer FOR SHARE;
        IF FOUND AND a.state <> 'active' THEN
          IF NOT EXISTS (SELECT 1 FROM account_financial_handoffs h
            WHERE h.op_id::text=current_setting('cocalc.financial_rehome_op',true)
              AND h.account_id=payer AND h.state='accepted'
              AND h.dest_bay_id=a.home_bay_id AND a.state='frozen') THEN
            RAISE EXCEPTION 'Financial authority is frozen or retired';
          END IF;
        END IF;
        RETURN COALESCE(NEW,OLD);
      END $$`);
    for (const [table, owner] of Object.entries({
      ...Object.fromEntries(
        Object.entries(tables).map(([t, s]) => [t, s.owner]),
      ),
      ...transferOwners,
    })) {
      if (owner === "@notification") continue;
      if (!(await exists(client, table))) continue;
      await client.query(`CREATE OR REPLACE TRIGGER account_financial_write_fence
        BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW
        EXECUTE FUNCTION fence_account_financial_write('${owner}')`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function lock(client: PoolClient, account_id: string) {
  fundingId(account_id, "Account");
  await lockAccountRehomeFence({ db: client, account_id });
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('account-funding'),hashtext($1))",
    [account_id],
  );
}

function where(owner: string): string {
  if (owner === "@notification")
    return "event_id IN (SELECT event_id FROM notification_targets WHERE target_account_id=$1)";
  return owner === "@pool"
    ? "pool_id IN (SELECT id FROM compute_funding_pools WHERE payer_account_id=$1)"
    : `${owner}=$1`;
}

async function readRows(
  client: PoolClient,
  account_id: string,
  table: string,
  owner: string,
  key: string,
): Promise<Row[]> {
  if (!(await exists(client, table))) return [];
  const { rows: numeric } = await client.query(
    `SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 AND data_type IN ('numeric','bigint') ORDER BY ordinal_position`,
    [table],
  );
  const exact = numeric.length
    ? ` || jsonb_build_object(${numeric.map(({ column_name: c }) => `'${c}',t."${c}"::text`).join(",")})`
    : "";
  const result = await client.query(
    `SELECT to_jsonb(t)${exact} AS row FROM ${table} t
    WHERE ${where(owner)} ORDER BY "${key}" LIMIT 100001`,
    [account_id],
  );
  if (result.rows.length > 100000)
    throw Error(`Financial rehome requires paginated snapshot for ${table}`);
  return result.rows.map(({ row }) => row);
}

function envelope(row: Row): AccountFinancialHandoff {
  return {
    version: 1,
    op_id: row.op_id,
    account_id: row.account_id,
    source_bay_id: row.source_bay_id,
    dest_bay_id: row.dest_bay_id,
    source_epoch: row.source_epoch,
    dest_epoch: row.dest_epoch,
    snapshot: row.snapshot,
    snapshot_hash: row.snapshot_hash,
  };
}

export async function getAccountFinancialHandoff(
  op_id: string,
): Promise<AccountFinancialHandoff | undefined> {
  const {
    rows: [table],
  } = await getPool().query(
    "SELECT to_regclass('public.account_financial_handoffs') AS name",
  );
  if (!table?.name) return;
  const {
    rows: [row],
  } = await getPool().query(
    "SELECT * FROM account_financial_handoffs WHERE op_id=$1",
    [op_id],
  );
  return row ? envelope(row) : undefined;
}

/** Runs in the same transaction that inserts the durable source operation. */
export async function freezeAccountFinancialState(
  client: PoolClient,
  op: Operation,
): Promise<AccountFinancialHandoff> {
  await lock(client, op.account_id);
  if (
    op.source_bay_id !== getConfiguredBayId() ||
    op.source_bay_id === op.dest_bay_id
  )
    throw Error("Financial handoff must start at the source home bay");
  const { rows: operations } = await client.query(
    `SELECT 1 FROM account_rehome_operations
    WHERE op_id=$1 AND account_id=$2 AND source_bay_id=$3 AND dest_bay_id=$4
      AND status='running' AND stage='requested'`,
    [op.op_id, op.account_id, op.source_bay_id, op.dest_bay_id],
  );
  if (operations.length !== 1)
    throw Error("Missing durable source account rehome operation");
  const {
    rows: [prior],
  } = await client.query(
    "SELECT * FROM account_financial_handoffs WHERE op_id=$1 FOR UPDATE",
    [op.op_id],
  );
  if (prior) {
    if (
      prior.account_id !== op.account_id ||
      prior.dest_bay_id !== op.dest_bay_id
    )
      throw Error("Financial handoff conflict");
    return envelope(prior);
  }
  await client.query(
    `INSERT INTO account_funding_authorities(payer_account_id,epoch,home_bay_id,state)
    VALUES($1,$2,$3,'active') ON CONFLICT DO NOTHING`,
    [op.account_id, randomUUID(), op.source_bay_id],
  );
  const {
    rows: [authority],
  } = await client.query(
    "SELECT * FROM account_funding_authorities WHERE payer_account_id=$1 FOR UPDATE",
    [op.account_id],
  );
  if (
    authority.state !== "active" ||
    authority.home_bay_id !== op.source_bay_id
  )
    throw Error("Source financial authority is not active");
  await client.query(
    "UPDATE account_funding_authorities SET state='frozen',updated_at=now() WHERE payer_account_id=$1",
    [op.account_id],
  );
  const rows: Snapshot["rows"] = {};
  for (const [table, spec] of Object.entries(tables))
    rows[table] = await readRows(
      client,
      op.account_id,
      table,
      spec.owner,
      spec.key,
    );
  // Global reset epochs must agree on both bays; copying them would reset other
  // accounts' postpaid windows. Include only the window families being moved.
  rows.account_usage_epochs = (await exists(client, "account_usage_epochs"))
    ? (
        await client.query(
          'SELECT family,"window",epoch::text FROM account_usage_epochs ORDER BY family,"window"',
        )
      ).rows
    : [];
  const transfers = await exportCreditTransferStateInTransaction(
    client,
    op.account_id,
  );
  const snapshot = JSON.stringify({ rows, transfers } satisfies Snapshot);
  if (Buffer.byteLength(snapshot) > 32 * 1024 * 1024)
    throw Error("Financial snapshot requires paginated transport");
  const handoff: AccountFinancialHandoff = {
    version: 1,
    ...op,
    source_epoch: authority.epoch,
    dest_epoch: randomUUID(),
    snapshot,
    snapshot_hash: digest(snapshot),
  };
  await client.query(
    `INSERT INTO account_financial_handoffs
    (op_id,account_id,source_bay_id,dest_bay_id,source_epoch,dest_epoch,snapshot,snapshot_hash,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'frozen')`,
    [
      op.op_id,
      op.account_id,
      op.source_bay_id,
      op.dest_bay_id,
      handoff.source_epoch,
      handoff.dest_epoch,
      snapshot,
      handoff.snapshot_hash,
    ],
  );
  return handoff;
}

function validate(h: AccountFinancialHandoff) {
  for (const id of [h.op_id, h.account_id, h.source_epoch, h.dest_epoch])
    fundingId(id, "Financial handoff identity");
  if (
    h.version !== 1 ||
    h.dest_bay_id !== getConfiguredBayId() ||
    h.source_bay_id === h.dest_bay_id ||
    digest(h.snapshot) !== h.snapshot_hash
  )
    throw Error("Invalid financial handoff identity or digest");
}

async function receipt(client: PoolClient, h: AccountFinancialHandoff) {
  validate(h);
  await lock(client, h.account_id);
  const {
    rows: [row],
  } = await client.query(
    "SELECT * FROM account_financial_handoffs WHERE op_id=$1 FOR UPDATE",
    [h.op_id],
  );
  if (row && JSON.stringify(envelope(row)) !== JSON.stringify(envelope(h)))
    throw Error("Financial handoff replay mismatch");
  return row;
}

/** The caller writes the account row in this transaction AFTER acceptance. */
export async function acceptAccountFinancialState(
  client: PoolClient,
  h: AccountFinancialHandoff,
): Promise<boolean> {
  const prior = await receipt(client, h);
  if (prior) return false;
  const {
    rows: [existing],
  } = await client.query(
    "SELECT epoch,state FROM account_funding_authorities WHERE payer_account_id=$1 FOR UPDATE",
    [h.account_id],
  );
  let replaceRetired = false;
  if (existing) {
    const { rows: retired } = await client.query(
      `SELECT 1 FROM account_financial_handoffs
      WHERE account_id=$1 AND source_epoch=$2 AND source_bay_id=$3 AND state='retired' LIMIT 1`,
      [h.account_id, existing.epoch, getConfiguredBayId()],
    );
    if (existing.state !== "retired" || retired.length !== 1)
      throw Error(
        "Destination already has financial authority; reconcile its prior handoff",
      );
    replaceRetired = true;
  }
  for (const [table, spec] of Object.entries(tables)) {
    if (replaceRetired) break;
    if (!(await exists(client, table))) continue;
    if (
      (
        await client.query(
          `SELECT 1 FROM ${table} WHERE ${where(spec.owner)} LIMIT 1`,
          [h.account_id],
        )
      ).rows.length
    )
      throw Error(`Destination already has ${table} history`);
  }
  await client.query(
    `INSERT INTO account_financial_handoffs
    (op_id,account_id,source_bay_id,dest_bay_id,source_epoch,dest_epoch,snapshot,snapshot_hash,state)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,'accepted')`,
    [
      h.op_id,
      h.account_id,
      h.source_bay_id,
      h.dest_bay_id,
      h.source_epoch,
      h.dest_epoch,
      h.snapshot,
      h.snapshot_hash,
    ],
  );
  await client.query(
    `INSERT INTO account_funding_authorities(payer_account_id,epoch,home_bay_id,state)
    VALUES($1,$2,$3,'frozen') ON CONFLICT(payer_account_id) DO UPDATE SET
    epoch=excluded.epoch,home_bay_id=excluded.home_bay_id,state='frozen',updated_at=now()`,
    [h.account_id, h.dest_epoch, h.dest_bay_id],
  );
  if (replaceRetired) {
    // Prior immutable handoff snapshots remain the audit archive. Only a proven
    // retired shadow may be replaced, never active or partially imported data.
    await client.query(
      "SELECT set_config('cocalc.financial_rehome_op',$1,true)",
      [h.op_id],
    );
    for (const [table, owner] of Object.entries(transferOwners).reverse())
      await client.query(`DELETE FROM ${table} WHERE ${owner}=$1`, [
        h.account_id,
      ]);
    for (const [table, spec] of Object.entries(tables).reverse()) {
      if (spec.owner === "@notification" || !(await exists(client, table)))
        continue;
      await client.query(`DELETE FROM ${table} WHERE ${where(spec.owner)}`, [
        h.account_id,
      ]);
    }
  }
  return true;
}

function mapped(maps: IdMaps, table: keyof IdMaps, id: any) {
  if (id == null) return id;
  const value = maps[table][id];
  if (!value) throw Error(`Missing financial ${table} reference ${id}`);
  return value;
}

/** Only explicitly typed local references are rewritten. Provider requests,
 * canonical operation hashes, transfer manifests and root identities are not.
 */
export function remapFinancialRow(
  table: string,
  original: Row,
  maps: IdMaps,
): Row {
  const row = structuredClone(original);
  const fields = (
    obj: Row | null | undefined,
    names: string[],
    kind: keyof IdMaps = "purchases",
  ) => {
    if (obj)
      for (const key of names)
        if (obj[key] != null) obj[key] = mapped(maps, kind, obj[key]);
  };
  if (ledgerTables.includes(table as any))
    row.id = mapped(maps, table as keyof IdMaps, row.id);
  fields(row, [
    "purchase_id",
    "credit_id",
    "refund_purchase_id",
    "latest_purchase_id",
    "paid_purchase_id",
  ]);
  fields(row, ["subscription_id"], "subscriptions");
  if (table === "purchases") {
    fields(row, ["day_statement_id", "month_statement_id"], "statements");
    fields(row.description, ["purchase_id", "credit_id", "refund_purchase_id"]);
    fields(row.description, ["subscription_id"], "subscriptions");
  }
  if (table === "subscriptions")
    fields(row.payment, ["subscription_id"], "subscriptions");
  if (table === "payment_fulfillments") {
    fields(row.result, ["purchase_id", "credit_id"]);
    fields(row.result, ["subscription_id"], "subscriptions");
  }
  if (table === "course_funding_approval_intents") {
    fields(row.result?.receipt, ["purchase_id"]);
    // Existing browser approval sessions must never migrate to another origin.
    row.approved_session_hash = null;
    if (row.applied_at == null) row.expires_at = row.created_at;
  }
  if (table === "compute_vm_personal_consents" && row.state === "pending") {
    row.state = "expired";
    row.approval_expires_at = row.created_at;
  }
  if (table === "provider_refund_attempts") {
    row.reconcile_token = null;
    row.reconcile_lease_expires_at = null;
  }
  if (table === "subscription_renewal_attempts") row.lease_expires_at = null;
  if (table === "compute_egress_meter_intervals")
    row.owning_bay_id = getConfiguredBayId();
  if (table === "membership_side_effects_outbox") row.lease_expires_at = null;
  if (
    table === "notification_targets" ||
    table === "notification_target_outbox"
  )
    row.target_home_bay_id = getConfiguredBayId();
  if (
    table === "notification_email_outbox" &&
    row.summary_json?.financial_receipt_home_bay_id
  )
    row.summary_json.financial_receipt_home_bay_id = getConfiguredBayId();
  return row;
}

async function insertExact(
  client: PoolClient,
  table: string,
  key: string,
  row: Row,
) {
  const json = JSON.stringify(row);
  await client.query(
    `INSERT INTO ${table} SELECT * FROM jsonb_populate_record(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
    [json],
  );
  const { rows } = await client.query(
    `SELECT 1 FROM ${table} t WHERE "${key}"=$1
    AND to_jsonb(t)=to_jsonb(jsonb_populate_record(NULL::${table},$2::jsonb))`,
    [row[key], json],
  );
  if (rows.length !== 1)
    throw Error(`Destination ${table} conflicts with financial snapshot`);
}

export async function importAccountFinancialState(
  client: PoolClient,
  h: AccountFinancialHandoff,
  copyPortable?: (maps: IdMaps) => Promise<void>,
): Promise<IdMaps> {
  const prior = await receipt(client, h);
  if (!prior) throw Error("Destination has not accepted financial handoff");
  if (["imported", "active"].includes(prior.state)) return prior.id_maps;
  if (prior.state !== "accepted")
    throw Error("Financial handoff is not importable");
  const state: Snapshot = JSON.parse(h.snapshot);
  if (
    state.transfers.account_id !== h.account_id ||
    state.transfers.source_authority_epoch !== h.source_epoch
  )
    throw Error("Transfer participant authority mismatch");
  await client.query(
    "SELECT set_config('cocalc.financial_rehome_op',$1,true)",
    [h.op_id],
  );
  for (const epoch of state.rows.account_usage_epochs ?? []) {
    await client.query(
      `INSERT INTO account_usage_epochs(family,"window",epoch)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      [epoch.family, epoch.window, epoch.epoch],
    );
    const {
      rows: [local],
    } = await client.query(
      'SELECT epoch::text FROM account_usage_epochs WHERE family=$1 AND "window"=$2',
      [epoch.family, epoch.window],
    );
    if (!local || local.epoch !== epoch.epoch)
      throw Error("Postpaid usage reset epochs differ across bays");
  }
  const maps: IdMaps = { purchases: {}, subscriptions: {}, statements: {} };
  for (const table of ledgerTables) {
    let previous = 0;
    for (const row of state.rows[table]) {
      if (!Number.isSafeInteger(row.id) || row.id <= previous)
        throw Error("Invalid financial ledger ordering");
      previous = row.id;
      const {
        rows: [{ id }],
      } = await client.query(
        "SELECT nextval(pg_get_serial_sequence($1,'id'))::integer AS id",
        [table],
      );
      maps[table][row.id] = id;
    }
  }
  for (const [table, spec] of Object.entries(tables)) {
    const rows = state.rows[table];
    if (!Array.isArray(rows))
      throw Error(`Missing financial participant ${table}`);
    for (const original of rows) {
      if (!spec.owner.startsWith("@") && original[spec.owner] !== h.account_id)
        throw Error("Financial snapshot owner mismatch");
      const row = remapFinancialRow(table, original, maps);
      if (
        table === "compute_funding_grants" &&
        !state.rows.compute_funding_pools.some((p) => p.id === row.pool_id)
      )
        throw Error("Financial grant belongs to another payer");
      await insertExact(client, table, spec.key, row);
    }
  }
  await importCreditTransferStateInTransaction(client, {
    account_id: h.account_id,
    state: state.transfers,
    purchase_ids: maps.purchases,
  });
  await copyPortable?.(maps);
  await (
    await import("@cocalc/server/purchases/get-balance")
  ).default({ account_id: h.account_id, client, forceSave: true });
  await client.query(
    "UPDATE account_financial_handoffs SET state='imported',id_maps=$2,updated_at=now() WHERE op_id=$1",
    [h.op_id, maps],
  );
  return maps;
}

export async function retireAccountFinancialState(
  op_id: string,
): Promise<void> {
  await transaction(async (client) => {
    const {
      rows: [h],
    } = await client.query(
      "SELECT * FROM account_financial_handoffs WHERE op_id=$1",
      [op_id],
    );
    if (!h || h.source_bay_id !== getConfiguredBayId())
      throw Error("Missing source financial handoff");
    await lock(client, h.account_id);
    const { rows: operations } = await client.query(
      `SELECT 1 FROM account_rehome_operations WHERE op_id=$1
      AND account_id=$2 AND stage IN ('projections_copied','directory_updated','complete')`,
      [op_id, h.account_id],
    );
    if (operations.length !== 1)
      throw Error("Cannot retire before destination copy acknowledgment");
    await client.query(
      "UPDATE account_funding_authorities SET state='retired',updated_at=now() WHERE payer_account_id=$1 AND epoch=$2 AND state IN ('frozen','retired')",
      [h.account_id, h.source_epoch],
    );
    await client.query(
      "UPDATE account_financial_handoffs SET state='retired',updated_at=now() WHERE op_id=$1",
      [op_id],
    );
  });
}

export async function activateAccountFinancialState(
  opts: AccountFinancialActivation,
): Promise<void> {
  if (opts.dest_bay_id !== getConfiguredBayId())
    throw Error("Financial activation reached wrong destination");
  const { createInterBayAccountLocalClient } =
    await import("@cocalc/conat/inter-bay/api");
  const { getInterBayFabricClient } =
    await import("@cocalc/server/inter-bay/fabric");
  const source = await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: opts.source_bay_id,
  }).getRehomeOperation({ op_id: opts.op_id });
  if (
    !source ||
    source.account_id !== opts.target_account_id ||
    source.source_bay_id !== opts.source_bay_id ||
    source.dest_bay_id !== opts.dest_bay_id ||
    !["directory_updated", "complete"].includes(source.stage)
  )
    throw Error(
      "Source has not committed financial retirement and directory cutover",
    );
  const home = await resolveAccountHomeBay({
    account_id: opts.target_account_id,
  });
  if (home.home_bay_id !== opts.dest_bay_id)
    throw Error("Financial directory cutover has not converged");
  await (
    await import("@cocalc/server/compute/funding/authority")
  ).assertFundingAccountHome(opts.target_account_id);
  await transaction(async (client) => {
    await lock(client, opts.target_account_id);
    const {
      rows: [h],
    } = await client.query(
      "SELECT * FROM account_financial_handoffs WHERE op_id=$1 FOR UPDATE",
      [opts.op_id],
    );
    if (
      !h ||
      h.account_id !== opts.target_account_id ||
      h.source_bay_id !== opts.source_bay_id ||
      h.dest_bay_id !== opts.dest_bay_id ||
      !["imported", "active"].includes(h.state)
    )
      throw Error(
        "Financial import is incomplete or activation identity differs",
      );
    const result = await client.query(
      "UPDATE account_funding_authorities SET state='active',updated_at=now() WHERE payer_account_id=$1 AND epoch=$2 AND home_bay_id=$3 AND state IN ('frozen','active') RETURNING epoch",
      [h.account_id, h.dest_epoch, h.dest_bay_id],
    );
    if (result.rows.length !== 1)
      throw Error("Financial successor authority changed");
    await client.query(
      "UPDATE account_financial_handoffs SET state='active',updated_at=now() WHERE op_id=$1",
      [opts.op_id],
    );
  });
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
