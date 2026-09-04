import { getClient, Client } from "@cocalc/database/pool";
import type { DBSchema, TableSchema } from "./types";
import { quoteField } from "./util";
import { pgType } from "./pg-type";
import { createTable } from "./table";
import getLogger from "@cocalc/backend/logger";
import { SCHEMA } from "@cocalc/util/schema";
import {
  dropDeprecatedTables,
  hasDeprecatedTables,
} from "./drop-deprecated-tables";
import { primaryKeys } from "./table";
import { isEqual } from "lodash";
import {
  accountNotificationRevisionSchemaNeedsSync,
  ensureAccountNotificationRevisionSchema,
} from "./account-notification-revision";
import {
  ensurePurchaseCostCentsSchema,
  purchaseCostCentsSchemaNeedsSync,
  withPurchaseCostCentsTriggerSuspended,
} from "./purchase-cost-cents";
import {
  commercialNextActionSchemaNeedsSync,
  ensureCommercialNextActionSchema,
} from "./commercial-next-action";
import {
  commercialQuoteLifecycleSchemaNeedsSync,
  ensureCommercialQuoteLifecycleSchema,
} from "./commercial-quote-lifecycle";
import {
  getColumnInvariantActions,
  syncTableSchemaColumnInvariants,
} from "./column-invariants";
import { getIndexActions, syncTableSchemaIndexes } from "./index-convergence";
import { backfillComputeVmProjectAccess } from "./compute-vm-project-access";
import { cleanupLegacyCrmBeforeSchemaSync } from "./crm-legacy-cleanup";
import {
  schemaConstraintsNeedSync,
  syncSchemaConstraints,
} from "./constraints";
import { schemaSequencesNeedSync, syncSchemaSequences } from "./sequences";
import {
  ensureSubscriptionStatusSchema,
  subscriptionStatusSchemaNeedsSync,
} from "./subscription-status";

const log = getLogger("db:schema:sync");

type InformationSchemaColumn = {
  character_maximum_length?: number | null;
  column_name: string;
  column_default?: string | null;
  data_type: string;
  is_nullable?: "YES" | "NO";
  numeric_precision?: number | null;
  numeric_scale?: number | null;
};

export function columnTypeFromInformationSchema(
  column: InformationSchemaColumn,
): string {
  if (column.character_maximum_length) {
    return `varchar(${column.character_maximum_length})`;
  }
  if (
    column.data_type === "numeric" &&
    column.numeric_precision != null &&
    column.numeric_scale != null
  ) {
    return `numeric(${column.numeric_precision},${column.numeric_scale})`;
  }
  return column.data_type;
}

async function syncTableSchema(db: Client, schema: TableSchema): Promise<void> {
  const dbg = (...args) => log.debug("syncTableSchema", schema.name, ...args);
  dbg();
  if (schema.virtual) {
    dbg("nothing to do -- table is virtual");
    return;
  }
  await syncTableSchemaColumns(db, schema);
  await syncTableSchemaColumnInvariants(db, schema);
  await syncTableSchemaIndexes(db, schema);
  await syncTableSchemaPrimaryKeys(db, schema);
}

async function getColumnTypeInfo(
  db: Client,
  table: string,
): Promise<{ [column_name: string]: string }> {
  // may from column to type info
  const columns: { [column_name: string]: string } = {};

  const { rows } = await db.query(
    `SELECT column_name, data_type, character_maximum_length,
            numeric_precision, numeric_scale, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_name=$1`,
    [table],
  );

  for (const y of rows as InformationSchemaColumn[]) {
    columns[y.column_name] = columnTypeFromInformationSchema(y);
  }

  return columns;
}

function parseTriggerDependencyError(
  err: unknown,
  table: string,
): { trigger: string; table: string } | null {
  if (err == null || typeof err !== "object") {
    return null;
  }
  const pgErr = err as { code?: string; detail?: string };
  if (pgErr.code !== "0A000" || typeof pgErr.detail !== "string") {
    return null;
  }
  const match = pgErr.detail.match(
    /trigger ([^ ]+) on table ([^ ]+) depends on column/,
  );
  if (!match) {
    return null;
  }
  const trigger = match[1];
  const triggerTable = match[2];
  const normalizedTable = triggerTable.includes(".")
    ? triggerTable.split(".").pop()
    : triggerTable;
  if (!trigger.startsWith("change_") || normalizedTable !== table) {
    return null;
  }
  return { trigger, table: normalizedTable };
}
type ColumnAction = {
  action: "alter" | "add";
  column: string;
};

async function alterColumnOfTable(
  db: Client,
  schema: TableSchema,
  action: "alter" | "add",
  column: string,
): Promise<void> {
  // Note: changing column ordering is NOT supported in PostgreSQL, so
  // it's critical to not depend on it!
  // https://wiki.postgresql.org/wiki/Alter_column_position
  const qTable = quoteField(schema.name);

  const info = schema.fields[column];
  if (info == null) throw Error(`invalid column ${column}`);
  const col = quoteField(column);
  const type = pgType(info);
  let desc = type;
  if (info.unique) {
    desc += " UNIQUE";
  }
  if (info.pg_check) {
    desc += " " + info.pg_check;
  }
  if (action == "alter") {
    log.debug(
      "alterColumnOfTable",
      schema.name,
      "alter this column's type:",
      col,
    );
    const query = `ALTER TABLE ${qTable} ALTER COLUMN ${col} TYPE ${desc} USING ${col}::${type}`;
    try {
      if (schema.name === "purchases" && column === "cost") {
        await withPurchaseCostCentsTriggerSuspended(
          db,
          async () => await db.query(query),
        );
      } else {
        await db.query(query);
      }
    } catch (err) {
      const dependency = parseTriggerDependencyError(err, schema.name);
      if (!dependency) {
        throw err;
      }
      log.debug(
        "alterColumnOfTable",
        schema.name,
        "dropping trigger",
        dependency.trigger,
        "on",
        dependency.table,
      );
      await db.query(
        `DROP TRIGGER IF EXISTS ${quoteField(dependency.trigger)} ON ${quoteField(
          dependency.table,
        )}`,
      );
      await db.query(
        `DROP FUNCTION IF EXISTS ${quoteField(dependency.trigger)}()`,
      );
      await db.query(query);
    }
  } else if (action == "add") {
    log.debug("alterColumnOfTable", schema.name, "add this column:", col);
    if (info.pg_default != null) {
      desc += ` DEFAULT ${info.pg_default}`;
    }
    if (info.not_null && info.pg_default != null) {
      desc += " NOT NULL";
    }
    await db.query(`ALTER TABLE ${qTable} ADD COLUMN ${col} ${desc}`);
  } else {
    throw Error(`unknown action '${action}`);
  }
}

async function getColumnActions(
  db: Client,
  schema: TableSchema,
): Promise<ColumnAction[]> {
  const columnTypeInfo = await getColumnTypeInfo(db, schema.name);
  const actions: ColumnAction[] = [];

  for (const column in schema.fields) {
    const info = schema.fields[column];
    let cur_type = columnTypeInfo[column]?.toLowerCase();
    if (cur_type != null) {
      if (cur_type === "timestamp with time zone") {
        cur_type = "timestamptz";
      } else if (cur_type === "timestamp without time zone") {
        cur_type = "timestamp";
      } else {
        cur_type = cur_type.split(" ")[0];
      }
    }
    const goal_type_raw = pgType(info).toLowerCase();
    if (cur_type == null) {
      // Missing serial columns still need to be added. Only skip serial type
      // comparison after PostgreSQL has materialized the pseudo-type.
      actions.push({ action: "add", column });
      continue;
    }
    let goal_type = goal_type_raw;
    if (goal_type_raw.includes("[]")) {
      goal_type = "array";
    } else {
      goal_type = goal_type_raw.split(" ")[0];
      if (["smallserial", "serial", "bigserial"].includes(goal_type)) {
        // Serial pseudo-types materialize as integer columns backed by a
        // sequence, so information_schema will never report the pseudo-type.
        continue;
      }
      if (goal_type.slice(0, 4) === "char") {
        // we do NOT support changing between fixed length and variable length strength
        goal_type = "var" + goal_type;
      }
    }
    if (cur_type !== goal_type) {
      if (goal_type_raw.includes("[]") || goal_type_raw.includes("varchar")) {
        // NO support for array or varchar schema changes (even detecting)!
        continue;
      }
      actions.push({ action: "alter", column });
    }
  }

  return actions;
}

async function syncTableSchemaColumns(
  db: Client,
  schema: TableSchema,
): Promise<void> {
  log.debug("syncTableSchemaColumns", "table = ", schema.name);
  const actions = await getColumnActions(db, schema);
  for (const { action, column } of actions) {
    await alterColumnOfTable(db, schema, action, column);
  }
}

// Names of all tables owned by the current user.
async function getAllTables(db: Client): Promise<Set<string>> {
  const { rows } = await db.query(
    "SELECT tablename FROM pg_tables WHERE tableowner = current_user",
  );
  const v = new Set<string>();
  for (const { tablename } of rows) {
    v.add(tablename);
  }
  return v;
}

async function hasTable(db: Client, table: string): Promise<boolean> {
  const { rows } = await db.query(
    "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tableowner = current_user AND tablename = $1) AS exists",
    [table],
  );
  return Boolean(rows[0]?.exists);
}

async function hasColumn(
  db: Client,
  table: string,
  column: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  );
  return Boolean(rows[0]?.exists);
}

async function hasLegacyRenames(db: Client): Promise<boolean> {
  if (
    (await hasTable(db, "openai_chatgpt_log")) &&
    !(await hasTable(db, "ai_usage_log"))
  ) {
    return true;
  }
  if (
    (await hasTable(db, "membership_tiers")) &&
    (await hasColumn(db, "membership_tiers", "llm_limits")) &&
    !(await hasColumn(db, "membership_tiers", "ai_limits"))
  ) {
    return true;
  }
  return false;
}

async function applyLegacyRenames(db: Client): Promise<void> {
  if (
    (await hasTable(db, "openai_chatgpt_log")) &&
    !(await hasTable(db, "ai_usage_log"))
  ) {
    await db.query(`ALTER TABLE openai_chatgpt_log RENAME TO ai_usage_log`);
  }
  if (
    (await hasTable(db, "membership_tiers")) &&
    (await hasColumn(db, "membership_tiers", "llm_limits")) &&
    !(await hasColumn(db, "membership_tiers", "ai_limits"))
  ) {
    await db.query(
      `ALTER TABLE membership_tiers RENAME COLUMN llm_limits TO ai_limits`,
    );
  }
}

async function backfillAccountDisplayNames(db: Client): Promise<void> {
  if (
    !(await hasTable(db, "accounts")) ||
    !(await hasColumn(db, "accounts", "display_name")) ||
    !(await hasColumn(db, "accounts", "first_name")) ||
    !(await hasColumn(db, "accounts", "last_name"))
  ) {
    return;
  }
  await db.query(`
    UPDATE accounts
       SET display_name = LEFT(
         BTRIM(
           CONCAT_WS(
             ' ',
             NULLIF(BTRIM(first_name), ''),
             NULLIF(BTRIM(last_name), '')
           )
         ),
         254
       )
     WHERE NULLIF(BTRIM(COALESCE(display_name, '')), '') IS NULL
       AND (
         NULLIF(BTRIM(COALESCE(first_name, '')), '') IS NOT NULL OR
         NULLIF(BTRIM(COALESCE(last_name, '')), '') IS NOT NULL
       )
  `);
}

// Determine names of all tables that are in our schema but not in the
// actual database.
function getMissingTables(
  dbSchema: DBSchema,
  allTables: Set<string>,
): Set<string> {
  const missing = new Set<string>();
  for (const table in dbSchema) {
    const s = dbSchema[table];
    if (
      !allTables.has(table) &&
      !s.virtual &&
      !s.external &&
      s.durability != "ephemeral"
    ) {
      missing.add(table);
    }
  }
  return missing;
}

export async function syncSchema(
  dbSchema: DBSchema = SCHEMA,
  role?: string,
): Promise<void> {
  const dbg = (...args) => log.debug("syncSchema", { role }, ...args);
  dbg();

  // We use a single connection for the schema update so that it's possible
  // to set the role for that connection without causing any side effects
  // elsewhere.
  const db = getClient();
  try {
    await db.connect();
    if (role) {
      // change to that user for the rest of this connection.
      await db.query(`SET ROLE ${role}`);
    }
    dbg("applying any legacy schema renames");
    await applyLegacyRenames(db);
    dbg("dropping any deprecated tables");
    await dropDeprecatedTables(db);
    dbg("applying guarded legacy CRM cleanup");
    await cleanupLegacyCrmBeforeSchemaSync(db, dbSchema);
    dbg("creating declared auxiliary sequences");
    await syncSchemaSequences(db, dbSchema);

    const allTables = await getAllTables(db);
    // dbg("allTables", allTables);

    // Create from scratch any missing tables -- usually this creates all tables and
    // indexes the first time around.
    const missingTables = await getMissingTables(dbSchema, allTables);
    dbg("missingTables", missingTables);
    for (const table of missingTables) {
      dbg("create missing table", table);
      const schema = dbSchema[table];
      if (schema == null) {
        throw Error("BUG -- inconsistent schema");
      }
      await createTable(db, schema);
    }
    // For each table that already exists and is in the schema,
    // ensure that the columns are correct,
    // have the correct type, and all indexes exist.
    for (const table of allTables) {
      if (missingTables.has(table)) {
        // already handled above -- we created this table just a moment ago
        continue;
      }
      const schema = dbSchema[table];
      if (schema == null || schema.external) {
        // table not in our schema at all or managed externally -- ignore
        continue;
      }
      // not newly created and in the schema so check if anything changed
      //dbg("sync existing table", table);
      await syncTableSchema(db, schema);
    }
    // Constraints are synchronized after all tables and columns exist. This
    // supports cross-table references without coupling correctness to import
    // order and keeps application request paths free of schema mutations.
    await syncSchemaConstraints(db, dbSchema);
    if (dbSchema.subscriptions != null) {
      await ensureSubscriptionStatusSchema(db);
    }
    if (dbSchema.account_notification_index != null) {
      await ensureAccountNotificationRevisionSchema(db);
    }
    if (dbSchema.purchases != null) {
      await ensurePurchaseCostCentsSchema(db);
    }
    if (dbSchema.commercial_orders != null) {
      await ensureCommercialNextActionSchema(db);
    }
    if (dbSchema.commercial_quotes != null) {
      await ensureCommercialQuoteLifecycleSchema(db);
    }
    if (dbSchema.compute_vm_project_access != null) {
      await backfillComputeVmProjectAccess(db);
    }
    dbg("backfilling account display names");
    await backfillAccountDisplayNames(db);
  } catch (err) {
    dbg("FAILED to sync schema ", { role }, err);
    throw err;
  } finally {
    db.end();
  }
}

export async function schemaNeedsSync(
  dbSchema: DBSchema = SCHEMA,
  role?: string,
): Promise<boolean> {
  const dbg = (...args) => log.info("schemaNeedsSync", { role }, ...args);
  dbg("checking schema");

  const db = getClient();
  try {
    await db.connect();
    if (role) {
      await db.query(`SET ROLE ${role}`);
    }
    if (await hasLegacyRenames(db)) {
      dbg("detected legacy schema names");
      return true;
    }
    if (await hasDeprecatedTables(db)) {
      dbg("detected deprecated tables");
      return true;
    }

    const allTables = await getAllTables(db);
    const missingTables = await getMissingTables(dbSchema, allTables);
    if (missingTables.size > 0) {
      dbg("detected missing tables", missingTables);
      return true;
    }
    if (await schemaSequencesNeedSync(db, dbSchema)) {
      dbg("detected missing auxiliary sequences");
      return true;
    }

    for (const table of allTables) {
      const schema = dbSchema[table];
      if (schema == null || schema.external || schema.virtual) {
        continue;
      }
      const columnActions = await getColumnActions(db, schema);
      if (columnActions.length > 0) {
        dbg("detected column changes needed", schema.name, columnActions);
        return true;
      }
      const invariantActions = await getColumnInvariantActions(db, schema);
      if (invariantActions.length > 0) {
        dbg(
          "detected column invariant changes needed",
          schema.name,
          invariantActions,
        );
        return true;
      }
      const indexActions = await getIndexActions(db, schema);
      if (indexActions.length > 0) {
        dbg("detected index changes needed", schema.name, indexActions);
        return true;
      }
      const primaryKeyDiff = await getPrimaryKeyDiff(db, schema);
      if (primaryKeyDiff != null) {
        dbg("detected primary key changes needed", schema.name, primaryKeyDiff);
        return true;
      }
    }
    if (await schemaConstraintsNeedSync(db, dbSchema)) {
      dbg("detected missing or invalid table constraints");
      return true;
    }
    if (
      dbSchema.subscriptions != null &&
      (await subscriptionStatusSchemaNeedsSync(db))
    ) {
      dbg("detected stale personal subscription status guard");
      return true;
    }
    if (
      dbSchema.account_notification_index != null &&
      (await accountNotificationRevisionSchemaNeedsSync(db))
    ) {
      dbg("detected missing account notification revision default");
      return true;
    }
    if (
      dbSchema.purchases != null &&
      (await purchaseCostCentsSchemaNeedsSync(db))
    ) {
      dbg("detected missing purchase whole-cent guard");
      return true;
    }
    if (
      dbSchema.commercial_orders != null &&
      (await commercialNextActionSchemaNeedsSync(db))
    ) {
      dbg("detected missing commercial next-action guard");
      return true;
    }
    if (
      dbSchema.commercial_quotes != null &&
      (await commercialQuoteLifecycleSchemaNeedsSync(db))
    ) {
      dbg("detected stale commercial quote lifecycle guard");
      return true;
    }
    dbg("schema matches");
    return false;
  } catch (err) {
    dbg("FAILED to check schema", { role }, err);
    throw err;
  } finally {
    db.end();
  }
}

async function syncTableSchemaPrimaryKeys(
  db: Client,
  schema: TableSchema,
): Promise<void> {
  log.debug("syncTableSchemaPrimaryKeys", "table = ", schema.name);
  const primaryKeyDiff = await getPrimaryKeyDiff(db, schema);
  if (primaryKeyDiff == null) {
    return;
  }
  const { actualPrimaryKeys, goalPrimaryKeys } = primaryKeyDiff;
  log.debug("syncTableSchemaPrimaryKeys", "table = ", schema.name, {
    actualPrimaryKeys,
    goalPrimaryKeys,
  });
  for (const key of goalPrimaryKeys) {
    if (!actualPrimaryKeys.includes(key)) {
      const defaultValue = schema.default_primary_key_value?.[key];
      if (defaultValue == null) {
        throw Error(
          `must specify default_primary_key_value for '${schema.name}' and key='${key}'`,
        );
      } else {
        await db.query(`update "${schema.name}" set "${key}"=$1`, [
          defaultValue,
        ]);
      }
    }
  }
  await db.query(`
ALTER TABLE "${schema.name}" DROP CONSTRAINT ${schema.name}_pkey;
`);
  await db.query(`
  ALTER TABLE "${schema.name}" ADD PRIMARY KEY (${goalPrimaryKeys
    .map((name) => `"${name}"`)
    .join(",")})
`);
}

async function getPrimaryKeys(db: Client, table: string): Promise<string[]> {
  const { rows } = await db.query(`
SELECT a.attname as name
FROM   pg_index i
JOIN   pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
WHERE  i.indrelid = '${table}'::regclass
AND    i.indisprimary
`);
  return rows.map((row) => row.name);
}

async function getPrimaryKeyDiff(
  db: Client,
  schema: TableSchema,
): Promise<
  | {
      actualPrimaryKeys: string[];
      goalPrimaryKeys: string[];
    }
  | undefined
> {
  const actualPrimaryKeys = (await getPrimaryKeys(db, schema.name)).sort();
  const goalPrimaryKeys = primaryKeys(schema.name).sort();
  if (isEqual(actualPrimaryKeys, goalPrimaryKeys)) {
    return undefined;
  }
  return { actualPrimaryKeys, goalPrimaryKeys };
}
