/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "node:path";
import {
  existsBeneathHome,
  writeFileBeneathHome,
} from "@cocalc/backend/files/beneath-home";
import { INTERNAL_SSH_CONFIG } from "@cocalc/conat/project/runner/constants";

// Writes the managed authorized_keys file in a project's home, never through
// a symlink the project user planted (see beneath-home).
//
// An empty key list empties an existing file rather than leaving it alone: the
// file is merged into the project's effective keys, so a key list that went
// from one key to none must not keep the removed key.
export async function writeManagedAuthorizedKeysFile(
  home: string,
  keys?: string,
): Promise<void> {
  const content = (keys ?? "").trim();
  const formatted = content
    ? content.endsWith("\n")
      ? content
      : `${content}\n`
    : "";
  const managedPath = join(INTERNAL_SSH_CONFIG, "authorized_keys");
  if (!formatted && !existsBeneathHome(home, managedPath)) return;
  writeFileBeneathHome(home, managedPath, formatted);
}
