/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import type {
  ArtifactCatalogSnapshot,
  ArtifactCatalogSource,
  ArtifactCatalogItem,
} from "@cocalc/util/artifact-catalog";
import { authFirstRequireHost, authFirstRequireAccount } from "./util";

export interface CatalogProjectRequest {
  project_id: string;
  account_id?: string;
  after?: string;
}
export interface CatalogEntryRequest {
  project_id: string;
  /** Existing lowercase SHA-256 catalog entry identity, not an artifact UUID. */
  entry_id: string;
  account_id?: string;
}
export interface CatalogEntriesRequest {
  /** Up to 100 {project_id, entry_id} pairs; all-or-nothing authorization. */
  items: { project_id: string; entry_id: string }[];
  account_id?: string;
}
export interface CatalogSourcePageRequest {
  project_id: string;
  host_id?: string;
  after?: string;
}
export interface CatalogEntry extends ArtifactCatalogSource {
  entry_id: string;
  item: ArtifactCatalogItem;
}
export interface CatalogPage {
  entries: CatalogEntry[];
  next?: string;
  indexed_sources: number;
}

export interface CatalogSourceRequest extends ArtifactCatalogSource {
  /** Bound by the authenticated host transform, not trusted from callers. */
  host_id?: string;
}
export interface CatalogRegistrationRequest extends CatalogSourceRequest {
  expected_epoch: string | null;
  registration_id: string;
}
export interface CatalogIngestRequest extends CatalogSourceRequest {
  snapshot: ArtifactCatalogSnapshot;
}
export interface CatalogWriterState {
  epoch: string;
  registration_id: string;
  source_sequence: number;
  writer_host_id: string | null;
}
export interface ArtifactCatalogApi {
  sourcePage(
    opts: CatalogSourcePageRequest,
  ): Promise<{ paths: string[]; next?: string }>;
  listProject(opts: CatalogProjectRequest): Promise<CatalogPage>;
  /** Metadata-only lookup; absent or tombstoned entries return null. */
  getEntry(opts: CatalogEntryRequest): Promise<CatalogEntry | null>;
  /** Batch point lookup; absent entries are omitted. */
  getEntries(opts: CatalogEntriesRequest): Promise<CatalogEntry[]>;
  writerState(opts: CatalogSourceRequest): Promise<CatalogWriterState | null>;
  registerSource(opts: CatalogRegistrationRequest): Promise<{ epoch: string }>;
  ingest(
    opts: CatalogIngestRequest,
  ): Promise<{ revision: number; replayed: boolean }>;
}
export const artifactCatalog = {
  sourcePage: authFirstRequireHost,
  listProject: authFirstRequireAccount,
  getEntry: authFirstRequireAccount,
  getEntries: authFirstRequireAccount,
  writerState: authFirstRequireHost,
  registerSource: authFirstRequireHost,
  ingest: authFirstRequireHost,
};
