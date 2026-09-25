/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import type { Client } from "@cocalc/conat/core/client";
import {
  createServiceClient,
  createServiceHandler,
} from "@cocalc/conat/service/typed";
import type { Options } from "@cocalc/conat/service/service";
import type {
  ArtifactCatalogApi,
  CatalogSourceRequest,
  CatalogRegistrationRequest,
  CatalogIngestRequest,
  CatalogProjectRequest,
  CatalogEntryRequest,
  CatalogSourcePageRequest,
} from "@cocalc/conat/hub/api/artifact-catalog";

export interface CatalogOwnerRoute {
  bay_id: string;
  epoch: number;
}
export interface InterBayArtifactCatalogApi {
  sourcePage(
    opts: CatalogSourcePageRequest & { route: CatalogOwnerRoute },
  ): ReturnType<ArtifactCatalogApi["sourcePage"]>;
  listProject(
    opts: CatalogProjectRequest & { route: CatalogOwnerRoute },
  ): ReturnType<ArtifactCatalogApi["listProject"]>;
  getEntry(
    opts: CatalogEntryRequest & { route: CatalogOwnerRoute },
  ): ReturnType<ArtifactCatalogApi["getEntry"]>;
  writerState(
    opts: CatalogSourceRequest & { route: CatalogOwnerRoute },
  ): ReturnType<ArtifactCatalogApi["writerState"]>;
  registerSource(
    opts: CatalogRegistrationRequest & { route: CatalogOwnerRoute },
  ): ReturnType<ArtifactCatalogApi["registerSource"]>;
  ingest(
    opts: CatalogIngestRequest & { route: CatalogOwnerRoute },
  ): ReturnType<ArtifactCatalogApi["ingest"]>;
}
function subject(bay_id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(bay_id)) throw Error("invalid bay id");
  return `bay.${bay_id}.rpc.artifact-catalog.v1`;
}
export function createInterBayArtifactCatalogClient({
  client,
  bay_id,
}: {
  client: Client;
  bay_id: string;
}): InterBayArtifactCatalogApi {
  return createServiceClient<InterBayArtifactCatalogApi>({
    client,
    subject: subject(bay_id),
    service: "inter-bay-artifact-catalog",
    timeout: 15000,
  });
}
export function createInterBayArtifactCatalogHandler({
  bay_id,
  impl,
  ...options
}: { bay_id: string; impl: InterBayArtifactCatalogApi } & Omit<
  Options,
  "handler" | "service" | "subject"
>) {
  return createServiceHandler<InterBayArtifactCatalogApi>({
    ...options,
    impl,
    subject: subject(bay_id),
    service: "inter-bay-artifact-catalog",
  });
}
