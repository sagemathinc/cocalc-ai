// Bridge hub calls through the server-side Conat client.

import { type Client as ConatClient } from "@cocalc/conat/core/client";
import callHub from "@cocalc/conat/hub/call-hub";

export default async function hubBridge({
  account_id,
  name,
  args,
  timeout,
  client,
}: {
  account_id: string;
  name: string;
  args?: any[];
  timeout?: number;
  client: ConatClient;
}) {
  return await callHub({
    client,
    account_id,
    name,
    args,
    timeout,
  });
}
