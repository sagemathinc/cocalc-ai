/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { until } from "@cocalc/util/async-utils";

function getIds() {
  return {
    storeId: redux.getStore("account")?.get_account_id?.(),
    clientId: webapp_client.account_id,
    signedInId: webapp_client.conat_client?.signedInMessage?.account_id,
  };
}

export function getPersistAccountId(): string | undefined {
  const { storeId, clientId, signedInId } = getIds();
  return signedInId ?? clientId ?? storeId;
}

function idsAgree(): boolean {
  const { storeId, clientId, signedInId } = getIds();
  const effective = signedInId ?? clientId ?? storeId;
  if (!effective) {
    return false;
  }
  return [storeId, clientId, signedInId].every(
    (id) => id == null || id === effective,
  );
}

export async function waitForPersistAccountId(): Promise<string> {
  await until(() => getPersistAccountId() != null, {
    start: 50,
    max: 500,
    timeout: 0,
  });
  try {
    await until(idsAgree, { start: 50, max: 500, timeout: 5000 });
  } catch {
    // Fall back to the current effective account id if store/client state
    // takes too long to settle after authentication.
  }
  const account_id = getPersistAccountId();
  if (!account_id) {
    throw Error("account_id must be defined");
  }
  return account_id;
}
