// Bridge hub calls through the server-side Conat client.

import { conat } from "@cocalc/backend/conat";
import { type Client as ConatClient } from "@cocalc/conat/core/client";
import callHub from "@cocalc/conat/hub/call-hub";

let defaultClient: ConatClient | null = null;
export function getDefaultServerConatClient(): ConatClient {
  defaultClient ??= conat();
  return defaultClient;
}

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
  client?: ConatClient;
}) {
  const resolvedClient = client ?? getDefaultServerConatClient();
  return await callHub({
    client: resolvedClient,
    account_id,
    name,
    args,
    timeout,
  });
}
