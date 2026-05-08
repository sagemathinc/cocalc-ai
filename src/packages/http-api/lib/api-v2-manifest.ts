/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getLogger } from "@cocalc/backend/logger";
import {
  discoverApiV2Routes,
  type ApiV2Handler,
  type ApiV2RouteEntry,
} from "./api-v2-routes";

export type { ApiV2Handler };

export type ApiV2ManifestEntry = ApiV2RouteEntry;

// Compatibility shim for older imports. Route discovery is now the source of
// truth; there is no generated manifest step anymore.
export const apiV2Manifest: ApiV2ManifestEntry[] = discoverApiV2Routes({
  includeDocs: true,
  logger: getLogger("http-api-routes"),
});
