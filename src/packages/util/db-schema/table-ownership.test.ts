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
  "bay_id",
] as const satisfies readonly TableReferenceField[];

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
    "seed-global",
    "stable-bay",
  ]),
  owner_account_id: new Set([
    "account-home",
    "audit-local",
    "cache",
    "ephemeral",
    "projection",
    "seed-global",
    "stable-bay",
  ]),
  project_id: new Set([
    "audit-local",
    "cache",
    "ephemeral",
    "project-owning",
    "projection",
    "seed-global",
    "stable-bay",
  ]),
  host_id: new Set([
    "audit-local",
    "cache",
    "ephemeral",
    "host-owning",
    "projection",
    "seed-global",
    "stable-bay",
  ]),
  bay_id: new Set([
    "audit-local",
    "cache",
    "ephemeral",
    "host-owning",
    "projection",
    "seed-global",
    "stable-bay",
  ]),
};

function serverSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
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

  it("keeps schema reference fields consistent with ownership", () => {
    expect(checkReferenceFieldConsistency(durableSchemaFields())).toEqual([]);
  });

  it("keeps ad hoc Postgres reference fields consistent with ownership", () => {
    expect(checkReferenceFieldConsistency(adHocPostgresFields())).toEqual([]);
  });
});
