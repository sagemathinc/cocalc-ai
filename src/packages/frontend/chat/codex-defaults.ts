/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import type { CodexSessionMode } from "@cocalc/util/ai/codex";

export function getDefaultCodexSessionMode(): CodexSessionMode {
  if (lite) return "workspace-write";
  const customizeStore = redux?.getStore?.("customize");
  if (customizeStore?.get?.("is_launchpad") === true) return "full-access";
  return "workspace-write";
}
