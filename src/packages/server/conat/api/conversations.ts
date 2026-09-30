/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { conversationsApi } from "@cocalc/server/conversations/api";

export const {
  list,
  get,
  addExisting,
  touch,
  rename,
  remove,
  setPinned,
  markRead,
} = conversationsApi;
