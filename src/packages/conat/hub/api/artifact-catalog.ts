/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import type {
  ArtifactCatalogSnapshot,
  ArtifactCatalogSource,
} from "@cocalc/util/artifact-catalog";
import { authFirstRequireHost } from "./util";

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
  writerState(opts: CatalogSourceRequest): Promise<CatalogWriterState | null>;
  registerSource(opts: CatalogRegistrationRequest): Promise<{ epoch: string }>;
  ingest(
    opts: CatalogIngestRequest,
  ): Promise<{ revision: number; replayed: boolean }>;
}
export const artifactCatalog = {
  writerState: authFirstRequireHost,
  registerSource: authFirstRequireHost,
  ingest: authFirstRequireHost,
};
