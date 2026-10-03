/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import type {
  PersonalUrlKind,
  PersonalUrlTarget,
} from "@cocalc/util/personal-urls";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";

/** Internal exact-name lookup, not an owner impersonation or listing API. */
export interface PersonalUrlAliasesApi {
  lookup(opts: {
    owner_account_id: string;
    home_bay_id: string;
    kind: PersonalUrlKind;
    alias: string;
  }): Promise<PersonalUrlTarget | null>;
}

function subject(bayId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bayId)) throw Error("Invalid bay id");
  return `bay.${bayId}.rpc.personal-url-aliases.v1`;
}

export function createInterBayPersonalUrlAliasesClient(
  client: Client,
  bayId: string,
): PersonalUrlAliasesApi {
  return createServiceClient<PersonalUrlAliasesApi>({
    client,
    subject: subject(bayId),
    service: "inter-bay-personal-url-aliases",
    timeout: 15000,
  });
}

export function createInterBayPersonalUrlAliasesHandler({
  bayId,
  impl,
  ...options
}: {
  bayId: string;
  impl: PersonalUrlAliasesApi;
} & Omit<Options, "handler" | "service" | "subject">) {
  return createServiceHandler<PersonalUrlAliasesApi>({
    ...options,
    impl,
    subject: subject(bayId),
    service: "inter-bay-personal-url-aliases",
  });
}
