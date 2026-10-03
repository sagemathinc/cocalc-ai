/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import type { PersonalUrlsApi } from "@cocalc/conat/hub/api/personal-urls";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";

// Internal requests retain the authenticated actor, never a caller-supplied
// authorization decision. The seed verifies admin authority on the actor's home.
export type InterBayUsernamesApi = {
  [K in Exclude<keyof PersonalUrlsApi, "resolveUrl" | "resolveOwner">]: (
    opts: NonNullable<Parameters<PersonalUrlsApi[K]>[0]> & {
      account_id: string;
      session_hash?: string;
    },
  ) => ReturnType<PersonalUrlsApi[K]>;
} & Pick<PersonalUrlsApi, "resolveOwner">;

function subject(bayId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bayId)) throw Error("Invalid bay id");
  return `bay.${bayId}.rpc.usernames.v1`;
}

export function createInterBayUsernamesClient(
  client: Client,
  bayId: string,
): InterBayUsernamesApi {
  return createServiceClient<InterBayUsernamesApi>({
    client,
    subject: subject(bayId),
    service: "inter-bay-usernames",
    timeout: 15000,
  });
}

export function createInterBayUsernamesHandler({
  bayId,
  impl,
  ...options
}: {
  bayId: string;
  impl: InterBayUsernamesApi;
} & Omit<Options, "handler" | "service" | "subject">) {
  return createServiceHandler<InterBayUsernamesApi>({
    ...options,
    impl,
    subject: subject(bayId),
    service: "inter-bay-usernames",
  });
}
