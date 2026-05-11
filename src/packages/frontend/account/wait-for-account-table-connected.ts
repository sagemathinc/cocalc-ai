/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { EventEmitter } from "events";

import { getLogger } from "@cocalc/frontend/logger";
import { once } from "@cocalc/util/async-utils";

const ACCOUNT_TABLE_CONNECT_TIMEOUT_MS = 15_000;
const log = getLogger("account:sign-in");

interface AccountTableEmitter extends EventEmitter {
  get_state?: () => string | undefined;
}

export async function waitForAccountTableConnectedForSignIn(
  table: AccountTableEmitter,
): Promise<void> {
  if (table.get_state?.() === "connected") {
    return;
  }
  try {
    await once(table, "connected", ACCOUNT_TABLE_CONNECT_TIMEOUT_MS);
  } catch (err) {
    log.info(
      "account table did not connect cleanly during sign-in; continuing",
      err,
    );
  }
}
