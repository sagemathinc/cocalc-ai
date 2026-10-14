/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The site's computers switch (Admin → Site Settings → AI & Agents →
// Computers, off by default). The server refuses everything while it is off;
// this only keeps the UI from offering what can't work.

import { useTypedRedux } from "@cocalc/frontend/app-framework";

export function useComputersEnabled(): boolean {
  return useTypedRedux("customize", "computers_enabled") === true;
}
