/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  browserTablesModule,
  SERVER_TABLES_REQUEST,
} from "./server-only-tables";

describe("leaving server-only tables out of the browser", () => {
  it("replaces only db-schema's ./server-tables, with a module that exists", () => {
    const dbSchema = join(__dirname, "..", "..", "util", "db-schema");
    expect(SERVER_TABLES_REQUEST.test("./server-tables")).toBe(true);
    expect(SERVER_TABLES_REQUEST.test("./server-tables-browser")).toBe(false);
    expect(SERVER_TABLES_REQUEST.test("../server-tables")).toBe(false);
    const replacement = browserTablesModule(dbSchema);
    expect(replacement).toBe("./server-tables-browser");
    expect(existsSync(join(dbSchema, `${replacement}.ts`))).toBe(true);
    expect(existsSync(join(dbSchema, "server-tables.ts"))).toBe(true);
    // Another package's ./server-tables is left alone.
    expect(browserTablesModule("/x/frontend/admin")).toBeUndefined();
  });
});
