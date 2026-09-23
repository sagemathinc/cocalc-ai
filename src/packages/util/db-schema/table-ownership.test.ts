import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SCHEMA } from "./index";
import {
  AD_HOC_POSTGRES_TABLE_OWNERSHIP,
  POSTGRES_TABLE_OWNERSHIP,
  TABLE_OWNERSHIP,
  type TableOwnershipEntry,
  type TableReferenceField,
} from "./table-ownership";

const REFERENCE_FIELDS = [
  "account_id",
  "owner_account_id",
  "project_id",
  "host_id",
  "connector_id",
  "bay_id",
] as const satisfies readonly TableReferenceField[];

// Transitional debt only: these tables are declared in db-schema but still
// contain a runtime CREATE TABLE bootstrap. Do not add entries. Move supported
// invariants into db-schema and leave only explicit data/rename migrations in
// the runtime module, then remove the corresponding entry here.
const LEGACY_DUAL_SCHEMA_OWNERSHIP: Record<string, string> = {
  account_admin_audit_log: "packages/server/accounts/admin-audit.ts",
  account_ban_audit_log: "packages/server/accounts/ban-audit.ts",
  account_resource_quarantine_audit_log:
    "packages/server/accounts/resource-quarantine-audit.ts",
  deleted_projects: "packages/server/projects/hard-delete.ts",
  email_auth_challenges: "packages/server/auth/email/challenge-store.ts",
  legacy_migration_account_link_events:
    "packages/server/legacy-migration/index.ts",
  legacy_migration_financial_claims:
    "packages/server/legacy-migration/index.ts",
  legacy_migration_public_share_replay_events:
    "packages/server/legacy-migration/index.ts",
  membership_analytics_daily_counts: "packages/server/membership/analytics.ts",
  membership_analytics_events: "packages/server/membership/analytics.ts",
  membership_claim_identities: "packages/server/membership/claim-directory.ts",
  membership_claim_scopes: "packages/server/membership/claim-directory.ts",
  project_access_request_blocks: "packages/server/projects/collaborators.ts",
  project_access_requests: "packages/server/projects/collaborators.ts",
  project_backup_indexes: "packages/server/project-backup/index.ts",
  project_backup_repos: "packages/server/project-backup/index.ts",
  project_entitlement_override_events:
    "packages/server/membership/project-entitlement-overrides.ts",
  project_entitlement_overrides:
    "packages/server/membership/project-entitlement-overrides.ts",
  project_host_exam_configs: "packages/server/project-host/exam.ts",
  project_host_exam_runs: "packages/server/project-host/exam.ts",
  project_rootfs_builds: "packages/server/rootfs/build-index.ts",
  public_project_path_slugs: "packages/server/public-directory-shares/index.ts",
  public_project_paths: "packages/server/public-directory-shares/index.ts",
  rootfs_rustic_repos: "packages/server/rootfs/rustic-repo-schema.ts",
  site_license_audit_log: "packages/server/membership/site-licenses.ts",
  site_license_external_claim_consumptions:
    "packages/server/membership/site-licenses.ts",
  site_license_external_claim_keys:
    "packages/server/membership/site-licenses.ts",
  site_license_external_claim_pools:
    "packages/server/membership/site-licenses.ts",
  site_license_managers: "packages/server/membership/site-licenses.ts",
  site_license_pool_requests: "packages/server/membership/site-licenses.ts",
  site_licenses: "packages/server/membership/site-licenses.ts",
};

const ALLOWED_OWNERSHIP_BY_REFERENCE_FIELD: Record<
  TableReferenceField,
  Set<TableOwnershipEntry["ownership"]>
> = {
  account_id: new Set([
    "account-home",
    "audit-local",
    "cache",
    "ephemeral",
    "projection",
    "row-scoped",
    "seed-global",
    "stable-bay",
  ]),
  owner_account_id: new Set([
    "account-home",
    "audit-local",
    "cache",
    "ephemeral",
    "projection",
    "row-scoped",
    "seed-global",
    "stable-bay",
  ]),
  project_id: new Set([
    "audit-local",
    "cache",
    "ephemeral",
    "project-owning",
    "projection",
    "row-scoped",
    "seed-global",
    "stable-bay",
  ]),
  host_id: new Set([
    "audit-local",
    "cache",
    "ephemeral",
    "host-owning",
    "projection",
    "row-scoped",
    "seed-global",
    "stable-bay",
  ]),
  connector_id: new Set([
    "audit-local",
    "cache",
    "ephemeral",
    "host-owning",
    "projection",
    "stable-bay",
  ]),
  bay_id: new Set([
    "audit-local",
    "cache",
    "ephemeral",
    "host-owning",
    "projection",
    "row-scoped",
    "seed-global",
    "stable-bay",
  ]),
};

function serverSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build"
      ) {
        continue;
      }
      files.push(...serverSourceFiles(path));
      continue;
    }
    if (
      !entry.name.endsWith(".ts") ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".integration.test.ts")
    ) {
      continue;
    }
    files.push(path);
  }
  return files;
}

function stringConstants(source: string): Record<string, string> {
  return Object.fromEntries(
    [
      ...source.matchAll(/\bconst\s+([A-Z0-9_]+)\s*=\s*"([a-zA-Z0-9_.]+)"/g),
    ].map((match) => [match[1], match[2]]),
  );
}

function normalizeTableName(name: string): string {
  return name.replace(/^public\./, "");
}

function postgresCreateTables({
  file,
  source,
}: {
  file: string;
  source: string;
}): {
  table?: string;
  fields?: Set<string>;
  unresolved?: string;
  file: string;
}[] {
  const constants = stringConstants(source);
  return [
    ...source.matchAll(
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)\s*\(([\s\S]*?)\n\s*\)/gi,
    ),
  ].map((match) => {
    const raw = match[1].trim();
    const fields = new Set(
      match[2]
        .split("\n")
        .map((line) => line.trim().replace(/,$/, ""))
        .map((line) => line.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+/)?.[1])
        .filter((field): field is string => {
          if (field == null) return false;
          return ![
            "CHECK",
            "CONSTRAINT",
            "FOREIGN",
            "PRIMARY",
            "UNIQUE",
          ].includes(field.toUpperCase());
        }),
    );
    const constant = raw.match(/^\$\{([A-Z0-9_]+)\}$/)?.[1];
    if (constant != null) {
      const table = constants[constant];
      return table == null
        ? { unresolved: raw, file }
        : { table: normalizeTableName(table), fields, file };
    }
    return { table: normalizeTableName(raw.replace(/"/g, "")), fields, file };
  });
}

function durableSchemaFields(): Map<string, Set<string>> {
  return new Map(
    Object.values(SCHEMA)
      .filter((table) => !table.virtual && !table.external)
      .map((table) => [table.name, new Set(Object.keys(table.fields ?? {}))]),
  );
}

function adHocPostgresFields(): Map<string, Set<string>> {
  const serverDir = resolve(__dirname, "../../server");
  const fields = new Map<string, Set<string>>();
  for (const file of serverSourceFiles(serverDir)) {
    const source = readFileSync(file, "utf8");
    if (!source.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i)) continue;
    for (const match of postgresCreateTables({ file, source })) {
      if (match.table == null || match.fields == null) continue;
      if (AD_HOC_POSTGRES_TABLE_OWNERSHIP[match.table] == null) continue;
      fields.set(match.table, match.fields);
    }
  }
  return fields;
}

function checkReferenceFieldConsistency(
  fieldsByTable: Map<string, Set<string>>,
): string[] {
  const failures: string[] = [];
  for (const [table, fields] of fieldsByTable) {
    const entry = POSTGRES_TABLE_OWNERSHIP[table];
    if (entry == null) {
      failures.push(`${table}: missing ownership entry`);
      continue;
    }
    for (const field of REFERENCE_FIELDS) {
      if (!fields.has(field)) continue;
      if (entry.authority === field) continue;
      if (entry.secondary_reference_fields?.[field]) continue;
      if (ALLOWED_OWNERSHIP_BY_REFERENCE_FIELD[field].has(entry.ownership)) {
        continue;
      }
      failures.push(
        `${table}: field ${field} is inconsistent with ${entry.ownership}/${entry.authority}; add an explicit secondary_reference_fields note if this is intentional`,
      );
    }
  }
  return failures.sort();
}

describe("table ownership manifest", () => {
  it("classifies every durable db-schema table", () => {
    const durableTables = Object.values(SCHEMA)
      .filter((table) => !table.virtual && !table.external)
      .map((table) => table.name)
      .sort();
    const classifiedTables = Object.keys(TABLE_OWNERSHIP).sort();

    expect(classifiedTables).toEqual(durableTables);
  });

  it("keeps manifest keys and table names in sync", () => {
    for (const [table, entry] of Object.entries(TABLE_OWNERSHIP)) {
      expect(entry.table).toBe(table);
      expect(entry.notes.trim()).not.toBe("");
      if (entry.portability === "rebuildable") {
        expect(entry.rebuild?.trim()).not.toBe("");
      }
    }
  });

  it("classifies server-side Postgres tables created outside db-schema", () => {
    const serverDir = resolve(__dirname, "../../server");
    const unknown: string[] = [];
    const unresolved: string[] = [];

    for (const file of serverSourceFiles(serverDir)) {
      const source = readFileSync(file, "utf8");
      if (!source.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i)) continue;
      for (const match of postgresCreateTables({ file, source })) {
        const location = relative(resolve(__dirname, "../../.."), match.file);
        if (match.unresolved != null) {
          unresolved.push(`${location}: ${match.unresolved}`);
          continue;
        }
        const table = match.table;
        if (table == null) continue;
        if (SCHEMA[table] != null && !SCHEMA[table].virtual) continue;
        if (AD_HOC_POSTGRES_TABLE_OWNERSHIP[table] != null) continue;
        unknown.push(`${location}: ${table}`);
      }
    }

    expect(unresolved).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it("does not add new runtime CREATE TABLE bootstraps for db-schema tables", () => {
    const serverDir = resolve(__dirname, "../../server");
    const dualOwned: Record<string, string> = {};

    for (const file of serverSourceFiles(serverDir)) {
      const source = readFileSync(file, "utf8");
      if (!source.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i)) continue;
      for (const match of postgresCreateTables({ file, source })) {
        const table = match.table;
        if (table == null || SCHEMA[table] == null || SCHEMA[table].virtual) {
          continue;
        }
        dualOwned[table] = relative(resolve(__dirname, "../../.."), file);
      }
    }

    expect(
      Object.fromEntries(
        Object.entries(dualOwned).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ).toEqual(LEGACY_DUAL_SCHEMA_OWNERSHIP);
  });

  it("keeps schema reference fields consistent with ownership", () => {
    expect(checkReferenceFieldConsistency(durableSchemaFields())).toEqual([]);
  });

  it("keeps ad hoc Postgres reference fields consistent with ownership", () => {
    expect(checkReferenceFieldConsistency(adHocPostgresFields())).toEqual([]);
  });
});
