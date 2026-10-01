/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import getPool, {
  type PoolClient,
  withSessionAdvisoryLock,
} from "@cocalc/database/pool";
import { lockAccountRehomeFence } from "@cocalc/database/postgres/account-rehome-fence";
import type {
  AccountCollaborationHandoff,
  AccountCollaborationPage,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  MAX_ACCOUNT_SUMMARY_RECEIPTS,
  ACCOUNT_NOTIFICATION_RETENTION_BYTES,
} from "@cocalc/util/collaboration-notification-limits";

type DB = Pick<PoolClient, "query">;
type Row = Record<string, any>;
type Operation = Pick<
  AccountCollaborationHandoff,
  "op_id" | "account_id" | "source_bay_id" | "dest_bay_id"
>;
type PageBody = { table: string; rows: Row[] };

export const COLLABORATION_REHOME_PAGE_ROWS = 200;
export const COLLABORATION_REHOME_PAGE_BYTES = 256 * 1024;
// Keep the existing state allowance and separately reserve the bounded receipt
// set plus the one budget and pending summary row. No lifetime receipt growth.
const MAX_BYTES = 128 * 1024 * 1024 + ACCOUNT_NOTIFICATION_RETENTION_BYTES;
const MAX_PAGES =
  4096 +
  Math.ceil(MAX_ACCOUNT_SUMMARY_RECEIPTS / COLLABORATION_REHOME_PAGE_ROWS) +
  2;
const MAX_ROWS = 400_000 + MAX_ACCOUNT_SUMMARY_RECEIPTS + 2;
const PERSONAL_TABLES = {
  collaboration_personal: "entry_key",
  collaboration_notification_delivery_budget: "account_id",
  collaboration_notification_summary: "account_id",
  collaboration_notification_summary_receipts: "event_id",
  collaboration_artifact_bindings: "entry_key",
  collaboration_account_state: "account_id",
};
const GRAPH_TABLES = {
  notification_events: "event_id",
  notification_targets: "event_id",
  notification_target_outbox: "outbox_id",
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const EMPTY_HASH = digest("");
const DEDUPE_PREFIX = '["collaboration-message-v1",';

async function exists(db: DB, table: string): Promise<boolean> {
  return !!(
    await db.query("SELECT to_regclass($1) AS name", [`public.${table}`])
  ).rows[0]?.name;
}

export async function collaborationRehomeTransaction<T>(
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}

/** Install outside the account transaction: trigger DDL takes table locks. */
export async function ensureCollaborationAccountRehomeSchema(): Promise<void> {
  await collaborationRehomeTransaction(async (db) => {
    await db.query(
      "SELECT pg_advisory_xact_lock(hashtext('collaboration-account-rehome-schema'))",
    );
    await db.query(`CREATE TABLE IF NOT EXISTS account_collaboration_handoffs (
      account_id UUID PRIMARY KEY, op_id UUID NOT NULL UNIQUE,
      source_bay_id TEXT NOT NULL, dest_bay_id TEXT NOT NULL,
      manifest JSONB NOT NULL, state TEXT NOT NULL
        CHECK(state IN ('frozen','accepted','imported','active','retired')),
      next_page INTEGER NOT NULL DEFAULT 0, rolling_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK(source_bay_id <> dest_bay_id))`);
    await db.query(`CREATE TABLE IF NOT EXISTS account_collaboration_rehome_pages (
      account_id UUID NOT NULL, op_id UUID NOT NULL, page INTEGER NOT NULL,
      body TEXT, hash TEXT NOT NULL, PRIMARY KEY(account_id,page))`);
    await db.query(`CREATE OR REPLACE FUNCTION fence_account_collaboration_write()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE owner UUID; old_owner UUID; h RECORD;
      BEGIN
        owner := COALESCE(NEW.account_id,OLD.account_id);
        old_owner := OLD.account_id;
        IF TG_OP='UPDATE' AND old_owner IS DISTINCT FROM owner THEN
          RAISE EXCEPTION 'collaboration account identity is immutable';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtext('account-rehome'),hashtext(owner::text));
        SELECT * INTO h FROM account_collaboration_handoffs WHERE account_id=owner;
        IF FOUND AND h.state <> 'active' AND
          current_setting('cocalc.collaboration_rehome_op',true) IS DISTINCT FROM h.op_id::text THEN
          RAISE EXCEPTION 'collaboration account rehome is fenced';
        END IF;
        RETURN COALESCE(NEW,OLD);
      END $$`);
    for (const table of Object.keys(PERSONAL_TABLES).filter(
      (t) => t !== "collaboration_account_state",
    )) {
      if (!(await exists(db, table))) continue;
      await db.query(
        `DROP TRIGGER IF EXISTS account_collaboration_write_fence ON ${table}`,
      );
      await db.query(`CREATE TRIGGER account_collaboration_write_fence BEFORE INSERT OR UPDATE OR DELETE
        ON ${table} FOR EACH ROW EXECUTE FUNCTION fence_account_collaboration_write()`);
    }
    if (await exists(db, "notification_targets"))
      await db.query(`CREATE INDEX IF NOT EXISTS notification_targets_collaboration_rehome
        ON notification_targets(target_account_id,event_id) WHERE dedupe_key LIKE '["collaboration-message-v1",%'`);
    if (await exists(db, "notification_target_outbox"))
      await db.query(`CREATE INDEX IF NOT EXISTS notification_outbox_collaboration_rehome
        ON notification_target_outbox(target_account_id,outbox_id)`);
  });
}

function validate(h: AccountCollaborationHandoff) {
  if (
    h.version !== 1 ||
    h.source_bay_id === h.dest_bay_id ||
    !/^[a-f0-9]{64}$/.test(h.snapshot_hash) ||
    typeof h.notifications !== "boolean" ||
    ![h.page_count, h.row_count, h.byte_count].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    h.page_count > MAX_PAGES ||
    h.row_count > MAX_ROWS ||
    h.byte_count > MAX_BYTES
  )
    throw Error("Invalid collaboration account handoff");
}

export function sameCollaborationHandoff(
  a: AccountCollaborationHandoff,
  b: AccountCollaborationHandoff,
): boolean {
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => a[key] === b[key])
  );
}

function assertIdentity(prior: Row, h: AccountCollaborationHandoff) {
  if (!prior || !sameCollaborationHandoff(prior.manifest, h))
    throw Error("Collaboration handoff conflicts with the durable receipt");
}

async function lock(db: DB, account_id: string) {
  await lockAccountRehomeFence({ db, account_id });
}

async function internal(db: DB, h: AccountCollaborationHandoff) {
  await db.query(
    "SELECT set_config('cocalc.collaboration_rehome_op',$1,true)",
    [h.op_id],
  );
}

export async function getAccountCollaborationHandoff(
  op_id: string,
  db: DB = getPool(),
): Promise<AccountCollaborationHandoff | undefined> {
  if (!(await exists(db, "account_collaboration_handoffs"))) return;
  return (
    await db.query(
      "SELECT manifest FROM account_collaboration_handoffs WHERE op_id=$1",
      [op_id],
    )
  ).rows[0]?.manifest;
}

function filter(table: string): string {
  if (table in PERSONAL_TABLES) return "r.account_id=$1";
  if (table === "notification_targets")
    return `r.target_account_id=$1 AND r.dedupe_key LIKE '["collaboration-message-v1",%'`;
  const key = table === "notification_events" ? "event_id" : "notification_id";
  return `${table === "notification_target_outbox" ? "r.target_account_id=$1 AND " : ""}EXISTS
    (SELECT 1 FROM notification_targets t WHERE t.target_account_id=$1
      AND t.${key}=r.${key} AND t.dedupe_key LIKE '["collaboration-message-v1",%')`;
}

/** Same transaction and canonical fence as creation of the source operation. */
export async function freezeAccountCollaborationState(
  db: DB,
  op: Operation,
  notifications = true,
): Promise<AccountCollaborationHandoff> {
  await lock(db, op.account_id);
  if (
    op.source_bay_id !== getConfiguredBayId() ||
    op.source_bay_id === op.dest_bay_id
  )
    throw Error("Collaboration freeze must run at the source home");
  const prior = (
    await db.query(
      "SELECT * FROM account_collaboration_handoffs WHERE account_id=$1 FOR UPDATE",
      [op.account_id],
    )
  ).rows[0];
  if (prior?.op_id === op.op_id) return prior.manifest;
  if (prior && prior.state !== "active")
    throw Error(
      "A collaboration handoff is already frozen; retry its operation",
    );
  const source = (
    await db.query(
      `SELECT 1 FROM account_rehome_operations WHERE op_id=$1 AND account_id=$2
    AND source_bay_id=$3 AND dest_bay_id=$4 AND status='running' AND stage='requested'`,
      [op.op_id, op.account_id, op.source_bay_id, op.dest_bay_id],
    )
  ).rows;
  if (source.length !== 1)
    throw Error("Missing committed account rehome operation");
  const h: AccountCollaborationHandoff = {
    version: 1,
    op_id: op.op_id,
    account_id: op.account_id,
    source_bay_id: op.source_bay_id,
    dest_bay_id: op.dest_bay_id,
    notifications,
    page_count: 0,
    row_count: 0,
    byte_count: 0,
    snapshot_hash: EMPTY_HASH,
  };
  await db.query(
    "DELETE FROM account_collaboration_rehome_pages WHERE account_id=$1",
    [op.account_id],
  );
  const append = async (table: string, rows: Row[]) => {
    const body = JSON.stringify({ table, rows } satisfies PageBody);
    if (Buffer.byteLength(body) > COLLABORATION_REHOME_PAGE_BYTES) {
      if (rows.length === 1)
        throw Error("Collaboration rehome row exceeds page budget");
      const half = Math.ceil(rows.length / 2);
      await append(table, rows.slice(0, half));
      await append(table, rows.slice(half));
      return;
    }
    const hash = digest(body);
    h.byte_count += Buffer.byteLength(body);
    h.row_count += rows.length;
    h.snapshot_hash = digest(h.snapshot_hash + hash);
    h.page_count++;
    validate(h);
    await db.query(
      `INSERT INTO account_collaboration_rehome_pages(account_id,op_id,page,body,hash) VALUES($1,$2,$3,$4,$5)`,
      [h.account_id, h.op_id, h.page_count - 1, body, hash],
    );
  };
  for (const [table, key] of Object.entries({
    ...PERSONAL_TABLES,
    ...(notifications ? GRAPH_TABLES : {}),
  })) {
    if (!(await exists(db, table))) continue;
    let after: string | null = null;
    for (;;) {
      const { rows } = await db.query(
        `SELECT r.* FROM ${table} r WHERE ${filter(table)}
        ${after == null ? "" : `AND r.${key}>$3`} ORDER BY r.${key} LIMIT $2`,
        after == null
          ? [op.account_id, COLLABORATION_REHOME_PAGE_ROWS]
          : [op.account_id, COLLABORATION_REHOME_PAGE_ROWS, after],
      );
      if (!rows.length) break;
      await append(table, rows);
      after = rows[rows.length - 1][key];
    }
  }
  await db.query(
    `INSERT INTO account_collaboration_handoffs(account_id,op_id,source_bay_id,dest_bay_id,manifest,state,rolling_hash)
    VALUES($1,$2,$3,$4,$5,'frozen',$6) ON CONFLICT(account_id) DO UPDATE SET op_id=excluded.op_id,
    source_bay_id=excluded.source_bay_id,dest_bay_id=excluded.dest_bay_id,manifest=excluded.manifest,state='frozen',next_page=0,rolling_hash=excluded.rolling_hash,updated_at=now()`,
    [h.account_id, h.op_id, h.source_bay_id, h.dest_bay_id, h, EMPTY_HASH],
  );
  return h;
}

/** Caller verifies the manifest against the committed source RPC and directory. */
export async function acceptAccountCollaborationState(
  db: DB,
  h: AccountCollaborationHandoff,
): Promise<boolean> {
  validate(h);
  if (h.dest_bay_id !== getConfiguredBayId())
    throw Error("Wrong collaboration destination bay");
  await lock(db, h.account_id);
  const prior = (
    await db.query(
      "SELECT * FROM account_collaboration_handoffs WHERE account_id=$1 FOR UPDATE",
      [h.account_id],
    )
  ).rows[0];
  if (prior?.op_id === h.op_id) {
    assertIdentity(prior, h);
    if (!["accepted", "imported", "active"].includes(prior.state))
      throw Error("Stale collaboration accept");
    return false;
  }
  if (prior && prior.state !== "retired")
    throw Error("Destination has another collaboration authority");
  // A first destination may have rebuildable projections, but never silently
  // replace personal state whose provenance is unknown.
  if (!prior)
    for (const table of Object.keys(PERSONAL_TABLES).filter(
      (t) => t !== "collaboration_account_state",
    )) {
      if (await exists(db, table)) {
        if (
          (
            await db.query(
              `SELECT 1 FROM ${table} WHERE account_id=$1 LIMIT 1`,
              [h.account_id],
            )
          ).rows.length
        )
          throw Error("Destination has unowned collaboration personal state");
      }
    }
  await db.query(
    "DELETE FROM account_collaboration_rehome_pages WHERE account_id=$1",
    [h.account_id],
  );
  await db.query(
    `INSERT INTO account_collaboration_handoffs(account_id,op_id,source_bay_id,dest_bay_id,manifest,state,rolling_hash)
    VALUES($1,$2,$3,$4,$5,'accepted',$6) ON CONFLICT(account_id) DO UPDATE SET op_id=excluded.op_id,
    source_bay_id=excluded.source_bay_id,dest_bay_id=excluded.dest_bay_id,manifest=excluded.manifest,state='accepted',next_page=0,rolling_hash=excluded.rolling_hash,updated_at=now()`,
    [h.account_id, h.op_id, h.source_bay_id, h.dest_bay_id, h, EMPTY_HASH],
  );
  return true;
}

async function receipt(db: DB, h: AccountCollaborationHandoff): Promise<Row> {
  validate(h);
  if (h.dest_bay_id !== getConfiguredBayId())
    throw Error("Wrong collaboration destination bay");
  await lock(db, h.account_id);
  const row = (
    await db.query(
      "SELECT * FROM account_collaboration_handoffs WHERE account_id=$1 FOR UPDATE",
      [h.account_id],
    )
  ).rows[0];
  assertIdentity(row, h);
  if (!["accepted", "imported", "active"].includes(row.state))
    throw Error("Stale collaboration import");
  return row;
}

export async function getAccountCollaborationPage(
  h: AccountCollaborationHandoff,
  page: number,
): Promise<AccountCollaborationPage> {
  const row = (
    await getPool().query(
      `SELECT page,body,hash FROM account_collaboration_rehome_pages
    WHERE account_id=$1 AND op_id=$2 AND page=$3`,
      [h.account_id, h.op_id, page],
    )
  ).rows[0];
  if (!row?.body) throw Error("Missing frozen collaboration page");
  return row;
}

function parsePage(
  h: AccountCollaborationHandoff,
  page: AccountCollaborationPage,
): PageBody {
  if (
    !Number.isSafeInteger(page.page) ||
    page.page < 0 ||
    page.page >= h.page_count ||
    typeof page.body !== "string" ||
    Buffer.byteLength(page.body) > COLLABORATION_REHOME_PAGE_BYTES ||
    digest(page.body) !== page.hash
  )
    throw Error("Invalid collaboration transfer page");
  const parsed: PageBody = JSON.parse(page.body);
  if (
    !Object.hasOwn(
      { ...PERSONAL_TABLES, ...(h.notifications ? GRAPH_TABLES : {}) },
      parsed.table,
    ) ||
    !Array.isArray(parsed.rows) ||
    !parsed.rows.length ||
    parsed.rows.length > COLLABORATION_REHOME_PAGE_ROWS
  )
    throw Error("Invalid collaboration table or page size");
  for (const row of parsed.rows) {
    if (
      (parsed.table in PERSONAL_TABLES && row.account_id !== h.account_id) ||
      (["notification_targets", "notification_target_outbox"].includes(
        parsed.table,
      ) &&
        row.target_account_id !== h.account_id)
    )
      throw Error("Cross-account collaboration snapshot row");
    if (
      parsed.table === "notification_targets" &&
      !row.dedupe_key?.startsWith(DEDUPE_PREFIX)
    )
      throw Error("Non-collaboration notification in snapshot");
  }
  return parsed;
}

export async function receiveAccountCollaborationPage(
  h: AccountCollaborationHandoff,
  page: AccountCollaborationPage,
): Promise<void> {
  parsePage(h, page);
  await collaborationRehomeTransaction(async (db) => {
    const r = await receipt(db, h);
    if (page.page < r.next_page) {
      const prior = (
        await db.query(
          `SELECT hash FROM account_collaboration_rehome_pages WHERE account_id=$1 AND op_id=$2 AND page=$3`,
          [h.account_id, h.op_id, page.page],
        )
      ).rows[0];
      if (prior?.hash !== page.hash)
        throw Error("Conflicting collaboration page replay");
      return;
    }
    if (r.state !== "accepted" || page.page !== r.next_page)
      throw Error("Out-of-order collaboration page");
    const hash = digest(r.rolling_hash + page.hash);
    if (page.page === h.page_count - 1 && hash !== h.snapshot_hash)
      throw Error("Collaboration snapshot hash mismatch");
    await db.query(
      `INSERT INTO account_collaboration_rehome_pages(account_id,op_id,page,body,hash) VALUES($1,$2,$3,$4,$5)`,
      [h.account_id, h.op_id, page.page, page.body, page.hash],
    );
    await db.query(
      `UPDATE account_collaboration_handoffs SET next_page=next_page+1,rolling_hash=$2,updated_at=now() WHERE account_id=$1`,
      [h.account_id, hash],
    );
  });
}

export async function collaborationImportComplete(
  h: AccountCollaborationHandoff,
): Promise<boolean> {
  return collaborationRehomeTransaction(
    async (db) => (await receipt(db, h)).state !== "accepted",
  );
}

async function insertRows(db: DB, table: string, rows: Row[]) {
  if (!rows.length) return;
  // Explicit columns preserve new destination defaults when rolling versions differ.
  const columns: string[] = (
    await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
      [table],
    )
  ).rows.map((r) => r.column_name);
  if (!columns.length)
    throw Error(`Missing collaboration destination table ${table}`);
  if (
    rows.some((row) =>
      Object.keys(row).some((field) => !columns.includes(field)),
    )
  )
    throw Error(
      `Collaboration destination schema is older than snapshot: ${table}`,
    );
  const fields = columns.filter((c) => Object.hasOwn(rows[0], c));
  const sql = fields.map((c) => `"${c}"`).join(",");
  await db.query(
    `INSERT INTO ${table} (${sql}) SELECT ${sql} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
    [JSON.stringify(rows)],
  );
  // Fail closed on a colliding notification ID rather than replacing another event.
  const keys =
    table in PERSONAL_TABLES
      ? ["account_id", PERSONAL_TABLES[table]]
      : table === "notification_targets"
        ? ["event_id", "target_account_id"]
        : [GRAPH_TABLES[table]];
  const { rows: mismatch } = await db.query(
    `SELECT 1 FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) s
    LEFT JOIN ${table} d ON ${keys.map((k) => `d.${k}=s.${k}`).join(" AND ")}
    WHERE ${fields.map((c) => `d."${c}" IS DISTINCT FROM s."${c}"`).join(" OR ")} LIMIT 1`,
    [JSON.stringify(rows)],
  );
  if (mismatch.length)
    throw Error(`Collaboration import collision in ${table}`);
}

/** All imported personal state becomes durable atomically; it remains fenced. */
export async function importAccountCollaborationState(
  h: AccountCollaborationHandoff,
): Promise<void> {
  await collaborationRehomeTransaction(async (db) => {
    const r = await receipt(db, h);
    if (r.state !== "accepted") return;
    if (r.next_page !== h.page_count || r.rolling_hash !== h.snapshot_hash)
      throw Error("Incomplete collaboration snapshot");
    await internal(db, h);
    for (const table of [
      "collaboration_access",
      "collaboration_participant_index",
      "collaboration_index",
      ...Object.keys(PERSONAL_TABLES).filter(
        (t) => t !== "collaboration_account_state",
      ),
    ])
      if (await exists(db, table))
        await db.query(`DELETE FROM ${table} WHERE account_id=$1`, [
          h.account_id,
        ]);
    let count = 0,
      bytes = 0,
      revision = 0n;
    for (let page = 0; page < h.page_count; page++) {
      const p = (
        await db.query(
          "SELECT page,body,hash FROM account_collaboration_rehome_pages WHERE account_id=$1 AND op_id=$2 AND page=$3",
          [h.account_id, h.op_id, page],
        )
      ).rows[0];
      const { table, rows } = parsePage(h, p);
      count += rows.length;
      bytes += Buffer.byteLength(p.body);
      if (table === "collaboration_account_state") {
        revision = BigInt(rows[0].revision ?? 0);
        continue;
      }
      if (table === "notification_target_outbox") continue; // Publish only after cutover.
      for (const row of rows) {
        if (table === "notification_targets")
          row.target_home_bay_id = h.dest_bay_id;
      }
      await insertRows(db, table, rows);
    }
    if (count !== h.row_count || bytes !== h.byte_count)
      throw Error("Collaboration snapshot counts mismatch");
    if (await exists(db, "collaboration_account_state"))
      await db.query(
        `INSERT INTO collaboration_account_state(account_id,revision,revision_xid) VALUES($1,$2,0)
        ON CONFLICT(account_id) DO UPDATE SET revision=GREATEST(collaboration_account_state.revision,excluded.revision)+1,revision_xid=0`,
        [h.account_id, (revision + 1n).toString()],
      );
    await db.query(
      "UPDATE account_collaboration_handoffs SET state='imported',updated_at=now() WHERE account_id=$1",
      [h.account_id],
    );
  });
}

/** Caller proves directory cutover and source retirement before activation. */
export async function activateAccountCollaborationState(
  h: AccountCollaborationHandoff,
): Promise<void> {
  await collaborationRehomeTransaction(async (db) => {
    const r = await receipt(db, h);
    if (r.state === "active") return;
    if (r.state !== "imported")
      throw Error("Collaboration state is not imported");
    await internal(db, h);
    // Rebuild only empty work items, never lease/generation/grant fields.
    // Active demand and owner-routed notification obligations independently
    // reauthorize work at the new home.
    if (await exists(db, "collaboration_access")) {
      const inventories = [
        "collaboration_personal",
        "collaboration_artifact_bindings",
        "account_project_index",
      ];
      const selects: string[] = [];
      for (const table of inventories)
        if (await exists(db, table))
          selects.push(
            `SELECT project_id FROM ${table} WHERE account_id=$1 AND project_id IS NOT NULL`,
          );
      if (selects.length)
        await db.query(
          `INSERT INTO collaboration_access(account_id,project_id,due_at)
        SELECT $1,project_id,now() FROM (${selects.join(" UNION ")}) projects ON CONFLICT DO NOTHING`,
          [h.account_id],
        );
    }
    for (let page = 0; page < h.page_count; page++) {
      const p = (
        await db.query(
          "SELECT page,body,hash FROM account_collaboration_rehome_pages WHERE account_id=$1 AND op_id=$2 AND page=$3",
          [h.account_id, h.op_id, page],
        )
      ).rows[0];
      const { table, rows } = parsePage(h, p);
      if (table !== "notification_target_outbox") continue;
      for (const row of rows) row.target_home_bay_id = h.dest_bay_id;
      await insertRows(db, table, rows);
    }
    await db.query(
      "UPDATE account_collaboration_handoffs SET state='active',updated_at=now() WHERE account_id=$1",
      [h.account_id],
    );
    await db.query(
      "UPDATE account_collaboration_rehome_pages SET body=NULL WHERE account_id=$1",
      [h.account_id],
    );
  });
}

export async function retireAccountCollaborationState(
  h: AccountCollaborationHandoff,
): Promise<void> {
  if (h.source_bay_id !== getConfiguredBayId())
    throw Error("Wrong collaboration source bay");
  await collaborationRehomeTransaction(async (db) => {
    await lock(db, h.account_id);
    const row = (
      await db.query(
        "SELECT * FROM account_collaboration_handoffs WHERE account_id=$1 FOR UPDATE",
        [h.account_id],
      )
    ).rows[0];
    assertIdentity(row, h);
    if (row.state === "retired") return;
    if (row.state !== "frozen")
      throw Error("Collaboration source is not frozen");
    const acknowledged = await db.query(
      `SELECT 1 FROM account_rehome_operations WHERE op_id=$1
      AND account_id=$2 AND stage IN ('projections_copied','directory_updated','complete')`,
      [h.op_id, h.account_id],
    );
    if (acknowledged.rows.length !== 1)
      throw Error(
        "Cannot retire collaboration state before destination copy acknowledgment",
      );
    await internal(db, h);
    for (const table of [
      "collaboration_access",
      "collaboration_participant_index",
      "collaboration_index",
      ...Object.keys(PERSONAL_TABLES).filter(
        (t) => t !== "collaboration_account_state",
      ),
    ])
      if (await exists(db, table))
        await db.query(`DELETE FROM ${table} WHERE account_id=$1`, [
          h.account_id,
        ]);
    if (h.notifications && (await exists(db, "notification_targets"))) {
      if (await exists(db, "notification_target_outbox"))
        await db.query(
          `DELETE FROM notification_target_outbox r WHERE ${filter("notification_target_outbox")}`,
          [h.account_id],
        );
      // Delete only one-recipient collaboration events, never unrelated graph rows.
      await db.query(
        `DELETE FROM notification_events r WHERE ${filter("notification_events")}
        AND NOT EXISTS(SELECT 1 FROM notification_targets t WHERE t.event_id=r.event_id AND t.target_account_id<>$1)`,
        [h.account_id],
      );
      await db.query(
        `DELETE FROM notification_targets r WHERE ${filter("notification_targets")}`,
        [h.account_id],
      );
    }
    await db.query(
      "UPDATE account_collaboration_handoffs SET state='retired',updated_at=now() WHERE account_id=$1",
      [h.account_id],
    );
    await db.query(
      "UPDATE account_collaboration_rehome_pages SET body=NULL WHERE account_id=$1",
      [h.account_id],
    );
  });
}

/** Never let a legacy RPC bypass an existing collaboration handoff. */
export async function assertNoCollaborationHandoff(
  account_id: string,
): Promise<void> {
  if (!(await exists(getPool(), "account_collaboration_handoffs"))) return;
  if (
    (
      await getPool().query(
        "SELECT 1 FROM account_collaboration_handoffs WHERE account_id=$1",
        [account_id],
      )
    ).rows.length
  )
    throw Error("Account rehome requires its collaboration handoff");
}

/** Copy includes existing non-transactional file/legacy import. Serialize its
 * retries with activation so a late retry cannot overwrite an active account. */
export async function withCollaborationCopyLock<T>(
  account_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withProtocolLock(`collaboration-rehome-copy:${account_id}`, fn);
}

export async function withAccountRehomeAttemptLock<T>(
  op_id: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withProtocolLock(`account-rehome-attempt:${op_id}`, fn);
}

async function withProtocolLock<T>(
  lockKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  // A dedicated connection avoids exhausting the bounded application pool while
  // the coordinator waits for inter-bay RPCs and file/legacy imports.
  const result = await withSessionAdvisoryLock({
    lockKey,
    fn: async () => ({ value: await fn() }),
  });
  if (!result)
    throw Error("Account rehome attempt is already in progress; retry");
  return result.value;
}

/** Old in-flight operations can only resume without a snapshot if no retained
 * collaboration authority exists. They must never implicitly discard it. */
export async function assertLegacyCollaborationRehomeEmpty(
  db: DB,
  account_id: string,
): Promise<void> {
  for (const table of [
    ...Object.keys(PERSONAL_TABLES).filter(
      (t) => t !== "collaboration_account_state",
    ),
    "notification_targets",
  ]) {
    if (
      (await exists(db, table)) &&
      (
        await db.query(
          `SELECT 1 FROM ${table} r WHERE ${filter(table)} LIMIT 1`,
          [account_id],
        )
      ).rows.length
    )
      throw Error(
        "Legacy account rehome has collaboration state but no frozen snapshot; reconcile before retrying",
      );
  }
}
