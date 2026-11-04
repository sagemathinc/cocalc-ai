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
  CatalogEntriesRequest,
  CatalogSourcePageRequest,
  CatalogAccountListRequest,
  CatalogAccountPage,
  CatalogEntry,
  CatalogProjectVersion,
  CatalogView,
} from "@cocalc/conat/hub/api/artifact-catalog";

export interface CatalogOwnerRoute {
  bay_id: string;
  epoch: number;
}
/**
 * One owner bay's part of an account-wide page. The filter lists come from
 * the account's home bay and only narrow what the owner bay authorizes.
 */
export interface CatalogOwnedListRequest {
  account_id: string;
  limit: number;
  before?: string;
  project_id?: string;
  view: CatalogView;
  mine?: { source_ids: string[]; thread_ids: string[] };
  query?: string;
  name_hits?: { source_ids: string[]; thread_ids: string[] };
  alias_hits?: { project_ids: string[]; entry_ids: string[] };
  library_name_hit?: boolean;
  versions?: boolean;
}
export interface CatalogOwnedListReply {
  entries: CatalogEntry[];
  /** Keyset position of each entry, aligned with entries. */
  keys: string[];
  more: boolean;
  versions?: Record<string, CatalogProjectVersion>;
  /** Readable projects on this bay, with or without a catalog (counts only). */
  authorized: number;
  too_many_projects: number;
  not_ready: number;
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
  /** The owner bay authorizes every project itself from account_id. */
  getEntries(
    opts: CatalogEntriesRequest,
  ): ReturnType<ArtifactCatalogApi["getEntries"]>;
  /** On the account's home bay: assemble the page from the owner bays. */
  listAccountHome(
    opts: CatalogAccountListRequest & { home_bay_id: string },
  ): Promise<CatalogAccountPage>;
  /** On an owner bay: it authorizes every project itself from account_id. */
  listAccountOwned(
    opts: CatalogOwnedListRequest,
  ): Promise<CatalogOwnedListReply>;
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
