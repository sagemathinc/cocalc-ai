/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { defaultGitCache } from "./immutable-cache";
import { GitReadService } from "./read-service";

// Reuse the project's authorized data-plane path; no hub file proxy or new RPC.
// Output named only by object ids is kept in this browser across reloads.
export const projectGitReader = new GitReadService(
  (options) => webapp_client.project_client.exec(options),
  Date.now,
  16_000_000,
  defaultGitCache(),
);
