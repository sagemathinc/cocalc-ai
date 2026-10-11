/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Transport for hub API calls routed to the bay that owns their data. The
// receiving hub has already authenticated the caller; the owning bay trusts
// that attested context (bays are one trusted application) and runs the call
// through its normal hub API pipeline.

import type { Client } from "@cocalc/conat/core/client";
import type { Options } from "@cocalc/conat/service/service";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";

export interface ForwardedHubApiCall {
  name: string;
  args: any[];
  account_id?: string;
  auth_session_hash?: string | null;
  project_id?: string;
  host_id?: string;
  auth_actor?: "agent";
  auth_token_fingerprint?: string;
  auth_iat_s?: number;
  auth_exp_s?: number;
  /** The bay that received the call and resolved this bay as its owner. */
  source_bay_id: string;
  /**
   * Set by the receiving bay; the same for a repeat of the call. The owning
   * bay runs each call id at most once (server/inter-bay/forwarded-calls).
   */
  call_id?: string;
}

export interface InterBayHubApi {
  call(call: ForwardedHubApiCall): Promise<any>;
}

const SERVICE = "inter-bay-hub-api";

export function hubApiSubject(bay_id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw new Error("invalid bay_id");
  return `bay.${bay_id}.rpc.hub-api.v1`;
}

export function createInterBayHubApiClient({
  client,
  bay_id,
  timeout,
}: {
  client: Client;
  bay_id: string;
  timeout?: number;
}): InterBayHubApi {
  return createServiceClient<InterBayHubApi>({
    service: SERVICE,
    subject: hubApiSubject(bay_id),
    client,
    timeout: timeout ?? 30_000,
  });
}

export function createInterBayHubApiHandler({
  bay_id,
  impl,
  ...options
}: {
  bay_id: string;
  impl: InterBayHubApi;
} & Omit<Options, "handler" | "service" | "subject">) {
  return createServiceHandler<InterBayHubApi>({
    ...options,
    service: SERVICE,
    subject: hubApiSubject(bay_id),
    impl,
  });
}
