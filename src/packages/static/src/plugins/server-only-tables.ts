/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Leave the server-only database tables out of the browser: @cocalc/util's
db-schema/index.ts imports "./server-tables" (tables no user or project query
reaches), and here that one module becomes server-tables-browser.ts, which is
empty. Node keeps loading everything. Measured Oct 14 2026: about 44 KiB Brotli
off every page that loads the schema (the notifications and Codex chat
ultralite routes, and the full app).
*/

import { NormalModuleReplacementPlugin } from "@rspack/core";
import {
  browserTablesModule,
  SERVER_TABLES_REQUEST,
} from "../server-only-tables";

export default function serverOnlyTablesPlugin(registerPlugin) {
  registerPlugin(
    "NormalModuleReplacementPlugin -- leave server-only db-schema tables out of the browser",
    new NormalModuleReplacementPlugin(SERVER_TABLES_REQUEST, (resource) => {
      const replacement = browserTablesModule(resource.context ?? "");
      if (replacement != null) resource.request = replacement;
    }),
  );
}
