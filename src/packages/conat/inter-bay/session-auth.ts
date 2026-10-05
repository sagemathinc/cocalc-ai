/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Fresh-auth checks run where the session lives: the account's home bay.
// Another bay that needs one (e.g., the owning bay of a routed project call)
// asks the home bay to perform the same check with the same options.

import type { Client } from "@cocalc/conat/core/client";
import type { Options } from "@cocalc/conat/service/service";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";

export interface DangerousSessionAuthRequest {
  account_id: string;
  browser_id?: string | null;
  session_hash?: string | null;
  require_second_factor?: boolean | "if_enabled";
  allow_actor_impersonation?: boolean;
}

export interface InterBaySessionAuthApi {
  /** Resolves to the verified session row, or rejects as the local check would. */
  requireDangerousSessionAuth(opts: DangerousSessionAuthRequest): Promise<any>;
}

const SERVICE = "inter-bay-session-auth";

export function sessionAuthSubject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw new Error("invalid bay_id");
  return `bay.${bay_id}.rpc.session-auth.v1`;
}

export function createInterBaySessionAuthClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBaySessionAuthApi {
  return createServiceClient<InterBaySessionAuthApi>({
    service: SERVICE,
    subject: sessionAuthSubject(bay_id),
    client,
    timeout: 15_000,
  });
}

export function createInterBaySessionAuthHandler({
  bay_id,
  impl,
  ...options
}: {
  bay_id: string;
  impl: InterBaySessionAuthApi;
} & Omit<Options, "handler" | "service" | "subject">) {
  return createServiceHandler<InterBaySessionAuthApi>({
    ...options,
    service: SERVICE,
    subject: sessionAuthSubject(bay_id),
    impl,
  });
}
