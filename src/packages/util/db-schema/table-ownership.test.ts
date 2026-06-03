import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SCHEMA } from "./index";
import {
  AD_HOC_POSTGRES_TABLE_OWNERSHIP,
  TABLE_OWNERSHIP,
} from "./table-ownership";

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

function postgresCreateTableNames({
  file,
  source,
}: {
  file: string;
  source: string;
}): { table?: string; unresolved?: string; file: string }[] {
  const constants = stringConstants(source);
  return [
    ...source.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/gi),
  ].map((match) => {
    const raw = match[1].trim();
    const constant = raw.match(/^\$\{([A-Z0-9_]+)\}$/)?.[1];
    if (constant != null) {
      const table = constants[constant];
      return table == null
        ? { unresolved: raw, file }
        : { table: normalizeTableName(table), file };
    }
    return { table: normalizeTableName(raw.replace(/"/g, "")), file };
  });
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
      for (const match of postgresCreateTableNames({ file, source })) {
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
});
