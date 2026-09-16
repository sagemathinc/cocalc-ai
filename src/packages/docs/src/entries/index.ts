/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { ADMIN_ENTRIES } from "./admin";
import { NON_ADMIN_ENTRIES } from "./non-admin";
import { orderDocsEntries } from "./order";

export { isPlusDocsEntryId } from "./order";

export const DOCS_ENTRIES = orderDocsEntries([
  ...NON_ADMIN_ENTRIES,
  ...ADMIN_ENTRIES,
]);
