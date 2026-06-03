import { SCHEMA } from "./index";
import { TABLE_OWNERSHIP } from "./table-ownership";

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
});
