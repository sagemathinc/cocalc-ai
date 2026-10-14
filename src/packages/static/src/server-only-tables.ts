/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Which module the browser build loads instead of @cocalc/util's
// db-schema/server-tables.ts (see plugins/server-only-tables.ts).

export const SERVER_TABLES_REQUEST = /^\.\/server-tables$/;

export function browserTablesModule(context: string): string | undefined {
  return /[\\/]db-schema$/.test(context)
    ? "./server-tables-browser"
    : undefined;
}
