/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The browser build leaves out the tables that server-tables.ts imports (see
// static/src/plugins/server-only-tables.ts). These checks keep that split
// correct and complete as tables are added.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA } from "./index";

const dir = __dirname;

function sideEffectImports(file: string): string[] {
  const source = readFileSync(join(dir, file), "utf8");
  return [...source.matchAll(/^import "\.\/([^"]+)";/gm)].map((m) => m[1]);
}

// The tables a module defines: each Table({ name: "..." }) it contains.
function tablesDefinedIn(module: string): string[] {
  const source = readFileSync(join(dir, `${module}.ts`), "utf8");
  const names = new Set<string>();
  for (const m of source.matchAll(/\bname:\s*["'`]([a-z0-9_]+)["'`]/g)) {
    if (SCHEMA[m[1]] != null) names.add(m[1]);
  }
  return [...names];
}

// What a browser can reach: user and project queries, and the tables they are
// virtual views of (client_db looks those up).
function browserTables(): Set<string> {
  const reachable = new Set<string>();
  for (const [name, table] of Object.entries(SCHEMA)) {
    if (table.user_query != null || table.project_query != null) {
      reachable.add(name);
    }
  }
  for (const name of [...reachable]) {
    const virtual = SCHEMA[name].virtual;
    if (typeof virtual === "string") reachable.add(virtual);
  }
  return reachable;
}

const serverModules = sideEffectImports("server-tables.ts");
const indexModules = sideEffectImports("index.ts").filter(
  (m) => m !== "server-tables",
);

describe("server-only tables", () => {
  it("server-tables.ts lists only tables no browser query reaches", () => {
    const reachable = browserTables();
    const wrong = serverModules.flatMap((module) =>
      tablesDefinedIn(module)
        .filter((table) => reachable.has(table))
        .map((table) => `${table} (./${module}: import it from index.ts)`),
    );
    expect(wrong).toEqual([]);
  });

  it("index.ts imports no module that defines only server-side tables", () => {
    const reachable = browserTables();
    const serverOnly = indexModules.filter((module) => {
      const tables = tablesDefinedIn(module);
      return tables.length > 0 && tables.every((t) => !reachable.has(t));
    });
    // Move these imports to server-tables.ts to keep them out of the browser.
    expect(serverOnly).toEqual([]);
  });

  it("finds the module of every table (so the checks above see them all)", () => {
    const modules = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => f.slice(0, -3));
    const found = new Set(modules.flatMap(tablesDefinedIn));
    expect(Object.keys(SCHEMA).filter((t) => !found.has(t))).toEqual([]);
  });

  it("every server module is imported once, and the browser stub defines nothing", () => {
    expect(new Set(serverModules).size).toBe(serverModules.length);
    expect(serverModules.filter((m) => indexModules.includes(m))).toEqual([]);
    const stub = readFileSync(join(dir, "server-tables-browser.ts"), "utf8");
    expect(stub).not.toMatch(/^import /m);
  });
});
