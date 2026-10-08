/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Account facts answered by the account's home bay for code running on other
// bays (e.g., the owning bay of a routed project call).

import type { Client } from "@cocalc/conat/core/client";
import type { Options } from "@cocalc/conat/service/service";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";

export interface InterBayAccountFactsApi {
  isAdmin(opts: { account_id: string }): Promise<boolean>;
  /** The account's product-access trust result, as computed on its home bay. */
  productAccessTrust(opts: { account_id: string }): Promise<any>;
}

const SERVICE = "inter-bay-account-facts";

export function accountFactsSubject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw new Error("invalid bay_id");
  return `bay.${bay_id}.rpc.account-facts.v1`;
}

export function createInterBayAccountFactsClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayAccountFactsApi {
  return createServiceClient<InterBayAccountFactsApi>({
    service: SERVICE,
    subject: accountFactsSubject(bay_id),
    client,
    timeout: 15_000,
  });
}

export function createInterBayAccountFactsHandler({
  bay_id,
  impl,
  ...options
}: {
  bay_id: string;
  impl: InterBayAccountFactsApi;
} & Omit<Options, "handler" | "service" | "subject">) {
  return createServiceHandler<InterBayAccountFactsApi>({
    ...options,
    service: SERVICE,
    subject: accountFactsSubject(bay_id),
    impl,
  });
}
