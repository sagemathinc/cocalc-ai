/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import { GitReadService } from "./read-service";

// Reuse the project's authorized data-plane path; no hub file proxy or new RPC.
export const projectGitReader = new GitReadService((options) =>
  webapp_client.project_client.exec(options),
);
