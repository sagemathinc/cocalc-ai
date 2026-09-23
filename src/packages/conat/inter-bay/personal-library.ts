/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import type { PersonalLibraryApi } from "@cocalc/conat/hub/api/personal-library";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";

function subject(bayId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bayId)) throw Error("Invalid bay id");
  return `bay.${bayId}.rpc.personal-library.v1`;
}

export function createInterBayPersonalLibraryClient(
  client: Client,
  bayId: string,
): PersonalLibraryApi {
  return createServiceClient<PersonalLibraryApi>({
    client,
    subject: subject(bayId),
    service: "inter-bay-personal-library",
    timeout: 15000,
  });
}

export function createInterBayPersonalLibraryHandler({
  bayId,
  impl,
  ...options
}: { bayId: string; impl: PersonalLibraryApi } & Omit<
  Options,
  "handler" | "service" | "subject"
>) {
  return createServiceHandler<PersonalLibraryApi>({
    ...options,
    impl,
    subject: subject(bayId),
    service: "inter-bay-personal-library",
  });
}
