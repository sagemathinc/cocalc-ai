/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  connect as connectToConat,
  type Client,
} from "@cocalc/conat/core/client";
import { inboxPrefix } from "@cocalc/conat/names";

export async function withProjectHostAccountClient<T>({
  account_id,
  address,
  token,
  action,
}: {
  account_id: string;
  address: string;
  token: string;
  action: (client: Client) => Promise<T>;
}): Promise<T> {
  const client = connectToConat({
    address,
    inboxPrefix: inboxPrefix({ account_id }),
    auth: (cb) => cb({ bearer: token }),
    reconnection: false,
    noCache: true,
    forceNew: true,
  });
  try {
    await client.waitUntilSignedIn({ timeout: 30_000 });
    return await action(client);
  } finally {
    client.close();
  }
}
