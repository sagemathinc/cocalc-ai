/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { syncSchema } from "@cocalc/database/postgres/schema";
import { lockProjectRehomeFence } from "@cocalc/database/postgres/project-rehome-fence";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { SCHEMA } from "@cocalc/util/schema";
import {
  PROJECT_COLLABORATION_REHOME_TRANSFERS as TRANSFERS,
  PROJECT_COLLABORATION_REHOME_TABLES as TABLES,
} from "@cocalc/util/project-collaboration-rehome";
import type {
  ProjectCollaborationRehomeOp as Op,
  ProjectCollaborationRehomeHeader as Header,
  ProjectCollaborationRehomeManifest as Manifest,
  ProjectCollaborationRehomePage as Page,
  ProjectCollaborationRehomeAck as Ack,
  ProjectCollaborationRehomeTable as Table,
} from "@cocalc/util/project-collaboration-rehome";

export type Queryable = {
  query(
    sql: string,
    params?: any[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
};
const PAGES = "project_collaboration_rehome_pages";
export const PAGE_ROWS = 50;
export const PAGE_BYTES = 256 * 1024;
export const ROW_BYTES = 64 * 1024;
// Include the bounded two-million-edge relation catalog in the durable handoff.
export const MAX_ROWS = 2_500_000;
export const MAX_BYTES = 1024 * 1024 * 1024;
export const MAX_PAGES = 60_000;
const columns: Record<Table, string[]> = {
  collaboration_relation_sets: [
    "set_key",
    "project_id",
    "source_id",
    "epoch",
    "sequence",
    "manifest",
    "byte_count",
    "row_count",
    "created_at",
  ],
  collaboration_participants: [
    "id",
    "project_id",
    "set_key",
    "thread_key",
    "participant_id",
  ],
  collaboration_references: [
    "id",
    "project_id",
    "set_key",
    "thread_key",
    "message_id",
    "payload",
  ],
  collaboration_projects: [
    "project_id",
    "generation",
    "revision",
    "window_start",
    "work_units",
    "notification_due",
    "notification_claim",
  ],
  collaboration_sources: [
    "source_id",
    "project_id",
    "chat_path",
    "owning_bay_id",
    "writer_host_id",
    "epoch",
    "registration_id",
    "source_sequence",
    "revision",
    "payload_hash",
    "metadata_hash",
    "coverage",
    "coverage_message",
    "relocated_to",
    "retired_room_id",
    "relation_set",
  ],
  collaboration_catalog: [
    "entry_key",
    "source_id",
    "project_id",
    "kind",
    "resource_id",
    "activity_floor",
    "metadata",
    "artifact_entry_ids",
    "agent_resource_ids",
    "agent_source_activity",
    "relation_set",
    "relation_thread",
    "relation_count",
    "revision",
    "activity",
    "deleted_at",
  ],
  collaboration_rooms: [
    "project_id",
    "room_id",
    "chat_path",
    "request_id",
    "initialized",
  ],
  collaboration_room_replacements: [
    "operation_id",
    "project_id",
    "requesting_account_id",
    "request_id",
    "previous_room_id",
    "previous_source_id",
    "receipt",
  ],
  collaboration_memberships: [
    "project_id",
    "account_id",
    "epoch",
    "notification_position",
  ],
  collaboration_notification_events: [
    "event_id",
    "project_id",
    "generation",
    "position",
    "event_json",
    "event_hash",
    "fanout_pending",
    "fanout_after",
    "fanout_due",
    "created_at",
  ],
  collaboration_notification_recipients: [
    "id",
    "event_id",
    "project_id",
    "account_id",
    "membership_epoch",
    "due_at",
    "claim_id",
    "claim_until",
  ],
  collaboration_notification_floors: ["project_id", "position"],
  collaboration_source_requests: [
    "project_id",
    "chat_path",
    "requested_by",
    "requested_at",
  ],
  collaboration_relocations: [
    "operation_id",
    "project_id",
    "request_hash",
    "epoch",
    "revision",
    "created_at",
  ],
};
const keys: Record<Table, { column: string; type: "text" | "uuid" }> = {
  collaboration_relation_sets: { column: "set_key", type: "text" },
  collaboration_participants: { column: "id", type: "text" },
  collaboration_references: { column: "id", type: "text" },
  collaboration_projects: { column: "project_id", type: "uuid" },
  collaboration_sources: { column: "source_id", type: "text" },
  collaboration_catalog: { column: "entry_key", type: "text" },
  collaboration_rooms: { column: "project_id", type: "uuid" },
  collaboration_room_replacements: { column: "operation_id", type: "uuid" },
  collaboration_memberships: { column: "account_id", type: "uuid" },
  collaboration_notification_events: { column: "event_id", type: "uuid" },
  collaboration_notification_recipients: { column: "id", type: "uuid" },
  collaboration_notification_floors: { column: "project_id", type: "uuid" },
  collaboration_source_requests: { column: "chat_path", type: "text" },
  collaboration_relocations: { column: "operation_id", type: "uuid" },
};
const bigints = new Set([
  "sequence",
  "byte_count",
  "row_count",
  "relation_count",
  "revision",
  "work_units",
  "source_sequence",
  "activity_floor",
  "agent_source_activity",
  "activity",
  "notification_position",
  "position",
]);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function json(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
export const SCHEMA_HASH = hash(
  json({ version: 1, tables: TABLES, columns, keys, bigints: [...bigints] }),
);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function validateOp(op: Op, direction: "export" | "import") {
  if (
    !op ||
    !UUID.test(op.op_id) ||
    !UUID.test(op.project_id) ||
    typeof op.source_bay_id !== "string" ||
    !op.source_bay_id.length ||
    op.source_bay_id.length > 256 ||
    typeof op.dest_bay_id !== "string" ||
    !op.dest_bay_id.length ||
    op.dest_bay_id.length > 256 ||
    op.source_bay_id === op.dest_bay_id
  )
    throw Error("invalid project collaboration transfer identity");
  if (
    (direction === "export" ? op.source_bay_id : op.dest_bay_id) !==
    getConfiguredBayId()
  )
    throw Error("project collaboration transfer reached the wrong bay");
}
function boundedInteger(value: unknown, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  );
}
function validateHeader(h: Header, direction: "export" | "import") {
  validateOp(h, direction);
  if (h.version !== 1 || h.schema_hash !== SCHEMA_HASH)
    throw Error("unsupported project collaboration transfer schema");
}
function headerFor(op: Op): Header {
  return {
    version: 1,
    schema_hash: SCHEMA_HASH,
    op_id: op.op_id,
    project_id: op.project_id,
    source_bay_id: op.source_bay_id,
    dest_bay_id: op.dest_bay_id,
  };
}
let schemaReady: Promise<void> | undefined;
export async function ensureProjectCollaborationRehomeSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const db = getPool();
    // Rehome also serves old/feature-disabled databases. Install just the
    // canonical project collaboration schema before referring to its indexes.
    const { rows: fields } = await db.query(
      `SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema=current_schema() AND table_name=ANY($1::text[])`,
      [[...TABLES]],
    );
    const installed = new Set(
      fields.map((r) => `${r.table_name}.${r.column_name}`),
    );
    if (
      TABLES.some((table) =>
        columns[table].some((column) => !installed.has(`${table}.${column}`)),
      )
    ) {
      await syncSchema(
        Object.fromEntries(TABLES.map((table) => [table, SCHEMA[table]])),
      );
    }
    await db.query(`CREATE TABLE IF NOT EXISTS project_collaboration_rehome_transfers (
      op_id UUID NOT NULL, direction TEXT NOT NULL, project_id UUID NOT NULL,
      source_bay_id TEXT NOT NULL, dest_bay_id TEXT NOT NULL, schema_hash TEXT NOT NULL,
      header JSONB NOT NULL, state TEXT NOT NULL, table_index INTEGER NOT NULL DEFAULT 0, last_key TEXT,
      next_page INTEGER NOT NULL DEFAULT 0, row_count INTEGER NOT NULL DEFAULT 0,
      byte_count BIGINT NOT NULL DEFAULT 0, table_rows JSONB NOT NULL, chain_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY(op_id,direction), CHECK(direction IN ('export','import')))`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS project_collaboration_rehome_active
      ON ${TRANSFERS}(project_id,direction) WHERE state IN ('exporting','exported','staging','ready')`);
    await db.query(
      `CREATE INDEX IF NOT EXISTS project_collaboration_rehome_project ON ${TRANSFERS}(project_id)`,
    );
    await db.query(`CREATE TABLE IF NOT EXISTS ${PAGES} (
      op_id UUID NOT NULL, direction TEXT NOT NULL, page INTEGER NOT NULL, project_id UUID NOT NULL,
      payload JSONB, hash TEXT NOT NULL, table_name TEXT NOT NULL,
      PRIMARY KEY(op_id,direction,page), FOREIGN KEY(op_id,direction) REFERENCES ${TRANSFERS}(op_id,direction) ON DELETE CASCADE)`);
    // Support receipts created by the earlier PR implementation, without losing
    // an interrupted snapshot or staging its pages under an unrelated project.
    await db.query(
      `ALTER TABLE ${PAGES} ADD COLUMN IF NOT EXISTS project_id UUID`,
    );
    await db.query(`ALTER TABLE ${PAGES} ALTER COLUMN payload DROP NOT NULL`);
    await db.query(`UPDATE ${PAGES} p SET project_id=t.project_id FROM ${TRANSFERS} t
      WHERE p.op_id=t.op_id AND p.direction=t.direction AND p.project_id IS NULL`);
    await db.query(`ALTER TABLE ${PAGES} ALTER COLUMN project_id SET NOT NULL`);
    await db.query(`DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='${PAGES}'::regclass
        AND conname='${PAGES}_op_id_direction_fkey' AND confdeltype<>'c') THEN
        ALTER TABLE ${PAGES} DROP CONSTRAINT ${PAGES}_op_id_direction_fkey;
        ALTER TABLE ${PAGES} ADD FOREIGN KEY(op_id,direction) REFERENCES ${TRANSFERS}(op_id,direction) ON DELETE CASCADE;
      END IF;
    END $$`);
    await db.query(
      `CREATE INDEX IF NOT EXISTS project_collaboration_rehome_pages_project ON ${PAGES}(project_id)`,
    );
    for (const table of TABLES) {
      const { column, type } = keys[table];
      if (column === "project_id") continue;
      await db.query(`CREATE INDEX IF NOT EXISTS ${table}_rehome_page ON ${table}
        (project_id,${column}${type === "text" ? ' COLLATE "C"' : ""})`);
    }
  })().catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  await schemaReady;
}
async function transaction<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  } finally {
    db.release();
  }
}
async function load(
  db: Queryable,
  header: Header,
  direction: "export" | "import",
  lock = true,
) {
  const state = (
    await db.query(
      `SELECT * FROM ${TRANSFERS} WHERE op_id=$1 AND direction=$2${lock ? " FOR UPDATE" : ""}`,
      [header.op_id, direction],
    )
  ).rows[0];
  if (state && json(state.header) !== json(header))
    throw Error("project collaboration transfer identity/schema conflict");
  return state;
}
function emptyCounts() {
  return Object.fromEntries(TABLES.map((t) => [t, 0])) as Record<Table, number>;
}
async function insertTransfer(
  db: Queryable,
  header: Header,
  direction: "export" | "import",
) {
  await db.query(
    `INSERT INTO ${TRANSFERS}(op_id,direction,project_id,source_bay_id,dest_bay_id,schema_hash,header,state,table_rows,chain_hash)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)`,
    [
      header.op_id,
      direction,
      header.project_id,
      header.source_bay_id,
      header.dest_bay_id,
      SCHEMA_HASH,
      JSON.stringify(header),
      direction === "export" ? "exporting" : "staging",
      JSON.stringify(emptyCounts()),
      hash(json(header)),
    ],
  );
}
function manifestFor(state: any): Manifest {
  return {
    pages: Number(state.next_page),
    rows: Number(state.row_count),
    bytes: Number(state.byte_count),
    table_rows: state.table_rows,
  };
}
function ack(state: any): Ack {
  const complete = ["exported", "retired", "ready", "activated"].includes(
    state.state,
  );
  return {
    version: 1,
    op_id: state.op_id,
    schema_hash: SCHEMA_HASH,
    next: complete ? null : String(state.next_page),
    complete,
    activated: state.state === "activated",
  };
}
function pageHash(page: Omit<Page, "hash"> | Page) {
  const { hash: _hash, ...body } = page as Page;
  return hash(json(body));
}
function validatePage(header: Header, page: Page) {
  if (
    !page ||
    page.version !== 1 ||
    page.op_id !== header.op_id ||
    page.schema_hash !== SCHEMA_HASH ||
    !boundedInteger(page.index, MAX_PAGES - 1) ||
    !HASH.test(page.hash) ||
    !HASH.test(page.previous_hash) ||
    pageHash(page) !== page.hash ||
    Buffer.byteLength(json(page)) > PAGE_BYTES ||
    !TABLES.includes(page.table) ||
    typeof page.table_complete !== "boolean" ||
    !Array.isArray(page.rows) ||
    page.rows.length > PAGE_ROWS ||
    (!page.rows.length && !page.table_complete) ||
    (page.next !== null && page.next !== String(page.index + 1))
  )
    throw Error("invalid project collaboration page/hash");
  for (const row of page.rows) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      row.project_id !== header.project_id ||
      json(Object.keys(row).sort()) !== json([...columns[page.table]].sort()) ||
      Buffer.byteLength(json(row)) > ROW_BYTES
    )
      throw Error(
        "foreign, incompatible or oversized project collaboration row",
      );
    for (const field of columns[page.table].filter((c) => bigints.has(c))) {
      if (
        typeof row[field] !== "string" ||
        !/^(0|[1-9][0-9]{0,18})$/.test(row[field] as string) ||
        BigInt(row[field] as string) > 9223372036854775807n
      )
        throw Error("invalid lossless project collaboration integer");
    }
  }
}
function progress(state: any, page: Page) {
  if (
    page.index !== Number(state.next_page) ||
    page.previous_hash !== state.chain_hash ||
    page.table !== TABLES[state.table_index]
  )
    throw Error("project collaboration page order/chain mismatch");
  let key: string | null = state.last_key;
  for (const row of page.rows) {
    const next = row[keys[page.table].column];
    if (
      typeof next !== "string" ||
      !next.length ||
      (key !== null && Buffer.compare(Buffer.from(next), Buffer.from(key)) <= 0)
    )
      throw Error("project collaboration page key order mismatch");
    key = next;
  }
  const next_page = Number(state.next_page) + 1,
    row_count = Number(state.row_count) + page.rows.length,
    byte_count =
      Number(state.byte_count) +
      page.rows.reduce((n, row) => n + Buffer.byteLength(json(row)), 0);
  if (next_page > MAX_PAGES || row_count > MAX_ROWS || byte_count > MAX_BYTES)
    throw Error(
      "project collaboration transfer capacity exceeded; export remains fenced",
    );
  return {
    ...state,
    next_page,
    row_count,
    byte_count,
    chain_hash: page.hash,
    table_rows: {
      ...state.table_rows,
      [page.table]: Number(state.table_rows[page.table]) + page.rows.length,
    },
    table_index: Number(state.table_index) + (page.table_complete ? 1 : 0),
    last_key: page.table_complete ? null : key,
  };
}
async function storePage(db: Queryable, state: any, page: Page) {
  const next = progress(state, page);
  const complete = next.table_index === TABLES.length;
  if (
    complete
      ? page.next !== null || json(page.manifest) !== json(manifestFor(next))
      : page.next === null || page.manifest !== undefined
  )
    throw Error("incomplete project collaboration snapshot manifest");
  await db.query(
    `INSERT INTO ${PAGES}(op_id,direction,page,payload,hash,table_name,project_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)`,
    [
      state.op_id,
      state.direction,
      page.index,
      JSON.stringify(page),
      page.hash,
      page.table,
      state.project_id,
    ],
  );
  next.state = complete
    ? state.direction === "export"
      ? "exported"
      : "ready"
    : state.state;
  await db.query(
    `UPDATE ${TRANSFERS} SET next_page=$3,row_count=$4,byte_count=$5,chain_hash=$6,table_index=$7,last_key=$8,table_rows=$9::jsonb,state=$10,updated_at=now()
    WHERE op_id=$1 AND direction=$2`,
    [
      state.op_id,
      state.direction,
      next.next_page,
      next.row_count,
      next.byte_count,
      next.chain_hash,
      next.table_index,
      next.last_key,
      JSON.stringify(next.table_rows),
      next.state,
    ],
  );
  return next;
}

function nonportableAuthority(kind: string): never {
  const dependency =
    kind === "artifact"
      ? "artifact_catalog/artifact_catalog_sources"
      : "agent_identities";
  throw Error(
    `collaboration project rehome requires nonportable ${dependency} authority; explicit owner migration/reconciliation is not implemented`,
  );
}

/** Metadata is not a substitute for the registered identity/Library authority.
 * Discovery may be partial: inspect active authority even when not indexed.
 * Caller holds the project rehome fence.
 */
async function assertPortableCollaborationAuthority(
  db: Queryable,
  project_id: string,
) {
  const dependency = (
    await db.query(
      `SELECT kind FROM collaboration_catalog
    WHERE project_id=$1 AND deleted_at IS NULL AND metadata IS NOT NULL
      AND (kind='artifact' OR (kind='agent' AND metadata->>'agent_id' IS NOT NULL)) LIMIT 1`,
      [project_id],
    )
  ).rows[0];
  if (dependency) nonportableAuthority(dependency.kind);

  // Registration and publication use this same fence, so new authority cannot
  // appear between this check and the durable export receipt. Keep this check
  // after the retained-state test so the legacy no-collaboration path is intact.
  for (const [table, live, kind] of [
    ["agent_identities", "disabled_at IS NULL", "agent"],
    ["artifact_catalog", "deleted IS NOT TRUE", "artifact"],
  ]) {
    const exists = (
      await db.query("SELECT to_regclass($1) AS name", [`public.${table}`])
    ).rows[0]?.name;
    if (!exists) continue;
    const active = (
      await db.query(
        `SELECT 1 FROM ${table} WHERE project_id=$1 AND ${live} LIMIT 1`,
        [project_id],
      )
    ).rows[0];
    if (active) nonportableAuthority(kind);
  }
}

/** Also reject snapshots prepared by older senders before invoking any upsert. */
async function assertPortableStagedCollaborationAuthority(
  db: Queryable,
  header: Header,
) {
  const dependency = (
    await db.query(
      `SELECT r->>'kind' AS kind FROM ${PAGES} p,
    LATERAL jsonb_array_elements(p.payload->'rows') r
    WHERE p.op_id=$1 AND p.direction='import' AND p.table_name='collaboration_catalog'
      AND r->>'deleted_at' IS NULL AND r->'metadata'<>'null'::jsonb
      AND (r->>'kind'='artifact' OR (r->>'kind'='agent' AND r->'metadata'->>'agent_id' IS NOT NULL)) LIMIT 1`,
      [header.op_id],
    )
  ).rows[0];
  if (dependency) nonportableAuthority(dependency.kind);
}

/** Durable source freeze precedes the first page. Failed operations stay frozen. */
export async function freezeProjectCollaborationExport(
  op: Op,
): Promise<Header | undefined> {
  validateOp(op, "export");
  await ensureProjectCollaborationRehomeSchema();
  const header = headerFor(op);
  const exists = await transaction(async (db) => {
    await lockProjectRehomeFence({ db, project_id: op.project_id });
    const existing = await load(db, header, "export");
    if (existing) {
      if (existing.state !== "retired")
        await assertPortableCollaborationAuthority(db, op.project_id);
      return true;
    }
    const active = (
      await db.query(
        `SELECT 1 FROM project_rehome_operations WHERE op_id=$1 AND project_id=$2
      AND source_bay_id=$3 AND dest_bay_id=$4 AND status='running'`,
        [op.op_id, op.project_id, op.source_bay_id, op.dest_bay_id],
      )
    ).rows[0];
    if (!active)
      throw Error(
        "collaboration export requires an active source rehome operation",
      );
    const project = (
      await db.query(
        "SELECT owning_bay_id FROM projects WHERE project_id=$1 FOR UPDATE",
        [op.project_id],
      )
    ).rows[0];
    // Match resolveProjectBayDirect: legacy NULL ownership means this bay,
    // but a missing project must never be mistaken for local authority.
    if (
      !project ||
      (project.owning_bay_id ?? getConfiguredBayId()) !== op.source_bay_id
    )
      throw Error("collaboration export source is not authoritative");
    const populated = (
      await db.query(
        `SELECT ${TABLES.map((t) => `EXISTS(SELECT 1 FROM ${t} WHERE project_id=$1)`).join(" OR ")} AS populated`,
        [op.project_id],
      )
    ).rows[0]?.populated;
    if (!populated) return false;
    await assertPortableCollaborationAuthority(db, op.project_id);
    await insertTransfer(db, header, "export");
    return true;
  });
  if (!exists) return undefined;
  // Every bounded page commits separately; interrupted retries resume rather than
  // re-snapshotting state that could have changed after destination activation.
  while (true) {
    const done = await transaction(async (db) => {
      await lockProjectRehomeFence({ db, project_id: op.project_id });
      const state = await load(db, header, "export");
      if (state.state === "exported" || state.state === "retired") return true;
      const project = (
        await db.query(
          "SELECT owning_bay_id FROM projects WHERE project_id=$1 FOR UPDATE",
          [op.project_id],
        )
      ).rows[0];
      if (
        !project ||
        (project.owning_bay_id ?? getConfiguredBayId()) !== op.source_bay_id
      )
        throw Error("collaboration source moved before snapshot completion");
      const table = TABLES[state.table_index],
        { column, type } = keys[table];
      const integers = columns[table].filter((c) => bigints.has(c));
      const encoded = `to_jsonb(t)${integers.length ? ` || jsonb_build_object(${integers.map((c) => `'${c}',t.${c}::text`).join(",")})` : ""}`;
      const key = `t.${column}${type === "text" ? ' COLLATE "C"' : ""}`;
      const { rows } = await db.query(
        `SELECT (${key})::text AS key,
        CASE WHEN octet_length((${encoded})::text)<=$3 THEN ${encoded} ELSE NULL END AS payload
        FROM ${table} t WHERE project_id=$1 AND ($2::${type} IS NULL OR ${key}>$2::${type}${type === "text" ? ' COLLATE "C"' : ""})
        ORDER BY ${key} LIMIT ${PAGE_ROWS + 1}`,
        [op.project_id, state.last_key, ROW_BYTES],
      );
      const selected: Record<string, unknown>[] = [];
      let bytes = 0;
      for (const row of rows.slice(0, PAGE_ROWS)) {
        if (row.payload === null)
          throw Error("project collaboration row exceeds snapshot capacity");
        const size = Buffer.byteLength(json(row.payload));
        if (bytes + size > PAGE_BYTES - 4096) break;
        selected.push(row.payload);
        bytes += size;
      }
      const table_complete = rows.length === selected.length;
      const final = table_complete && state.table_index === TABLES.length - 1;
      const page: Page = {
        version: 1,
        op_id: op.op_id,
        schema_hash: SCHEMA_HASH,
        index: Number(state.next_page),
        previous_hash: state.chain_hash,
        hash: "",
        table,
        rows: selected,
        table_complete,
        next: final ? null : String(Number(state.next_page) + 1),
      };
      if (final) page.manifest = manifestFor(progress(state, page));
      page.hash = pageHash(page);
      validatePage(header, page);
      await storePage(db, state, page);
      return final;
    });
    if (done) return header;
  }
}
export async function readProjectCollaborationExportHeader(
  op_id: string,
): Promise<Header | undefined> {
  if (!UUID.test(op_id)) throw Error("invalid collaboration export operation");
  await ensureProjectCollaborationRehomeSchema();
  const row = (
    await getPool().query(
      `SELECT header FROM ${TRANSFERS} WHERE op_id=$1 AND direction='export' AND source_bay_id=$2 AND state IN ('exported','retired')`,
      [op_id, getConfiguredBayId()],
    )
  ).rows[0];
  return row?.header;
}
/** Also returns an incomplete export so a failed source operation can be resumed. */
export async function readFrozenProjectCollaborationExport(
  project_id: string,
): Promise<Header | undefined> {
  if (!UUID.test(project_id))
    throw Error("invalid collaboration export project");
  await ensureProjectCollaborationRehomeSchema();
  return (
    await getPool().query(
      `SELECT header FROM ${TRANSFERS} WHERE project_id=$1 AND direction='export' AND source_bay_id=$2 AND state IN ('exporting','exported')`,
      [project_id, getConfiguredBayId()],
    )
  ).rows[0]?.header;
}
export async function readProjectCollaborationExportPage(
  header: Header,
  cursor: string,
): Promise<Page> {
  validateHeader(header, "export");
  if (
    !/^(0|[1-9][0-9]*)$/.test(cursor) ||
    !boundedInteger(Number(cursor), MAX_PAGES - 1)
  )
    throw Error("invalid collaboration export cursor");
  await ensureProjectCollaborationRehomeSchema();
  const state = await load(getPool(), header, "export", false);
  if (!state || !["exported", "retired"].includes(state.state))
    throw Error("collaboration export is incomplete");
  const value = (
    await getPool().query(
      `SELECT payload FROM ${PAGES} WHERE op_id=$1 AND direction='export' AND page=$2`,
      [header.op_id, Number(cursor)],
    )
  ).rows[0]?.payload;
  if (!value) throw Error("collaboration export page unavailable");
  return value;
}
export async function prepareProjectCollaborationImport(
  header: Header,
): Promise<Ack> {
  validateHeader(header, "import");
  await ensureProjectCollaborationRehomeSchema();
  return transaction(async (db) => {
    await lockProjectRehomeFence({ db, project_id: header.project_id });
    let state = await load(db, header, "import");
    if (!state) {
      const project = (
        await db.query(
          "SELECT owning_bay_id FROM projects WHERE project_id=$1 FOR UPDATE",
          [header.project_id],
        )
      ).rows[0];
      if (project?.owning_bay_id === header.dest_bay_id)
        throw Error(
          "refusing to replace a live destination collaboration project",
        );
      await insertTransfer(db, header, "import");
      state = await load(db, header, "import");
    }
    return ack(state);
  });
}
export async function receiveProjectCollaborationPage(
  header: Header,
  page: Page,
): Promise<Ack> {
  validateHeader(header, "import");
  validatePage(header, page);
  await ensureProjectCollaborationRehomeSchema();
  return transaction(async (db) => {
    await lockProjectRehomeFence({ db, project_id: header.project_id });
    const state = await load(db, header, "import");
    if (!state) throw Error("collaboration import must be prepared first");
    if (page.index < state.next_page) {
      const old = (
        await db.query(
          `SELECT hash FROM ${PAGES} WHERE op_id=$1 AND direction='import' AND page=$2`,
          [header.op_id, page.index],
        )
      ).rows[0];
      if (old?.hash !== page.hash)
        throw Error("collaboration import page replay conflict");
      return ack(state);
    }
    if (state.state !== "staging")
      throw Error("collaboration import no longer accepts new pages");
    return ack(await storePage(db, state, page));
  });
}

/** Caller owns the transaction. Check receipt BEFORE invoking project upsert. */
export async function activateProjectCollaborationImport(
  db: Queryable,
  header: Header,
  upsertProject: () => Promise<void>,
): Promise<Ack> {
  validateHeader(header, "import");
  await lockProjectRehomeFence({ db, project_id: header.project_id });
  const state = await load(db, header, "import");
  if (!state) throw Error("collaboration import receipt missing");
  if (state.state === "activated") return ack(state);
  if (state.state !== "ready")
    throw Error("collaboration import is incomplete");
  await assertPortableStagedCollaborationAuthority(db, header);
  await upsertProject();
  const project = (
    await db.query(
      "SELECT owning_bay_id FROM projects WHERE project_id=$1 FOR UPDATE",
      [header.project_id],
    )
  ).rows[0];
  if (project?.owning_bay_id !== header.dest_bay_id)
    throw Error("collaboration destination project owner mismatch");
  for (const table of [...TABLES].reverse())
    await db.query(`DELETE FROM ${table} WHERE project_id=$1`, [
      header.project_id,
    ]);
  for (const table of TABLES) {
    let value = "data";
    if (table === "collaboration_projects")
      value += " || jsonb_build_object('generation',gen_random_uuid())";
    if (table === "collaboration_sources")
      value +=
        " || jsonb_build_object('owning_bay_id',$3::text,'writer_host_id',NULL,'epoch',gen_random_uuid(),'registration_id',NULL,'source_sequence','0','payload_hash',NULL)";
    await db.query(
      `INSERT INTO ${table}(${columns[table].join(",")})
      SELECT ${columns[table].map((c) => `r.${c}`).join(",")} FROM
      (SELECT jsonb_array_elements(payload->'rows') AS data FROM ${PAGES}
       WHERE op_id=$1 AND direction='import' AND table_name=$2) p,
      LATERAL jsonb_populate_record(NULL::${table},${value}) r`,
      table === "collaboration_sources"
        ? [header.op_id, table, header.dest_bay_id]
        : [header.op_id, table],
    );
  }
  // Keep only hashes for duplicate/conflicting retries. Payloads are no longer
  // needed after activation; cleanup is bounded by this transfer's hard caps.
  await db.query(
    `UPDATE ${PAGES} SET payload=NULL WHERE op_id=$1 AND direction='import'`,
    [header.op_id],
  );
  await db.query(
    `UPDATE ${TRANSFERS} SET state='activated',updated_at=now() WHERE op_id=$1 AND direction='import'`,
    [header.op_id],
  );
  return ack({ ...state, state: "activated" });
}
export async function assertProjectCollaborationImportActive(
  db: Queryable,
  header: Header,
): Promise<Ack> {
  validateHeader(header, "import");
  const state = await load(db, header, "import");
  if (state?.state !== "activated")
    throw Error("collaboration import is not active");
  return ack(state);
}
export async function retireProjectCollaborationExport(
  header: Header,
): Promise<void> {
  validateHeader(header, "export");
  await transaction(async (db) => {
    await lockProjectRehomeFence({ db, project_id: header.project_id });
    const state = await load(db, header, "export");
    if (!state || !["exported", "retired"].includes(state.state))
      throw Error("collaboration export receipt missing or incomplete");
    const project = (
      await db.query(
        "SELECT owning_bay_id FROM projects WHERE project_id=$1 FOR UPDATE",
        [header.project_id],
      )
    ).rows[0];
    if (project?.owning_bay_id !== header.dest_bay_id)
      throw Error("cannot retire collaboration export before ownership flip");
    await db.query(
      `UPDATE ${TRANSFERS} SET state='retired',updated_at=now() WHERE op_id=$1 AND direction='export'`,
      [header.op_id],
    );
    // Completed source retries use the header/checkpoint, never re-export pages.
    await db.query(
      `DELETE FROM ${PAGES} WHERE op_id=$1 AND direction='export'`,
      [header.op_id],
    );
  });
}
