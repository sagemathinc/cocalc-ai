/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import callHub from "@cocalc/conat/hub/call-hub";
import { setAgentMemoryContextProvider } from "@cocalc/lite/hub/acp";
import { isValidUUID } from "@cocalc/util/misc";
import { getMasterConatClient } from "../master-conat-client";
import { getLocalHostId } from "../sqlite/hosts";

// Supplies each turn's saved-note index from the account's home bay. The hub
// returns null unless the account enabled agent memory.
export function initAgentMemoryContextProvider(): void {
  setAgentMemoryContextProvider(async ({ projectId, accountId }) => {
    const client = getMasterConatClient();
    const host_id = getLocalHostId();
    if (
      !client ||
      !host_id ||
      !isValidUUID(projectId) ||
      !isValidUUID(accountId)
    )
      return null;
    return await callHub({
      client,
      host_id,
      name: "hosts.getAgentMemoryContext",
      args: [{ project_id: projectId, account_id: accountId }],
      timeout: 5_000,
    });
  });
}
