/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { authFirst, authFirstRequireAccount } from "./util";
import type { CopyOptions } from "@cocalc/conat/files/fs";
import type { FileTypeLabel } from "@cocalc/conat/files/listing";
import type { HostConnectionInfo } from "./hosts";
import type { ProjectViewerReadPolicy } from "@cocalc/util/project-access";

export type PublicDirectoryShareVisibility =
  | "listed"
  | "unlisted"
  | "private"
  | "disabled";

export type PublicDirectoryShareAvailability =
  | "available"
  | "pending"
  | "unavailable"
  | "unknown";

export interface PublicDirectoryShareSummary {
  id: string;
  project_id: string;
  path: string;
  slug: string;
  visibility: PublicDirectoryShareVisibility;
  requires_auth: boolean;
  availability_status: PublicDirectoryShareAvailability;
  availability_message?: string | null;
  title?: string | null;
  description?: string | null;
  license?: string | null;
  image?: string | null;
  redirect?: string | null;
  legacy_public_path_id?: string | null;
  legacy_url?: string | null;
  site_license_id?: string | null;
  site_license_pool_id?: string | null;
  site_license_membership_tier_id?: string | null;
  site_license_duration_days?: number | null;
  site_license_grant_on_copy: boolean;
  site_license_copy_requires_grant: boolean;
  disabled: boolean;
  created_by?: string | null;
  updated_by?: string | null;
  last_edited?: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export interface ResolvedPublicDirectoryShare extends PublicDirectoryShareSummary {
  read_policy: ProjectViewerReadPolicy;
  available: boolean;
  project_title?: string | null;
  host_id?: string | null;
  host_connection?: HostConnectionInfo | null;
  owning_bay_id?: string | null;
}

export interface ResolvePublicDirectoryShareOptions {
  account_id?: string;
  slug: string;
}

export interface ListPublicDirectorySharesOptions {
  account_id?: string;
  prefix?: string;
  limit?: number;
  offset?: number;
  include_unlisted?: boolean;
  include_unavailable?: boolean;
}

export interface ListPublicDirectorySharesResponse {
  shares: PublicDirectoryShareSummary[];
  total_count: number;
}

export interface ListMyPublicDirectorySharesOptions {
  account_id?: string;
  limit?: number;
  offset?: number;
  include_disabled?: boolean;
}

export interface ListProjectPublicDirectorySharesOptions {
  account_id?: string;
  project_id: string;
  path?: string;
  limit?: number;
  offset?: number;
  include_disabled?: boolean;
}

export interface DisableMyPublicDirectorySharesByActorOptions {
  account_id?: string;
  session_hash?: string | null;
  actor_account_id: string;
}

export interface DisableMyPublicDirectorySharesByActorResponse {
  disabled_count: number;
  share_ids: string[];
}

export interface UpsertPublicDirectoryShareOptions {
  account_id?: string;
  id?: string;
  project_id: string;
  path: string;
  slug: string;
  visibility?: PublicDirectoryShareVisibility;
  requires_auth?: boolean;
  availability_status?: PublicDirectoryShareAvailability;
  availability_message?: string | null;
  title?: string | null;
  description?: string | null;
  license?: string | null;
  image?: string | null;
  redirect?: string | null;
  legacy_public_path_id?: string | null;
  legacy_url?: string | null;
  site_license_id?: string | null;
  site_license_pool_id?: string | null;
  site_license_membership_tier_id?: string | null;
  site_license_duration_days?: number | null;
  site_license_grant_on_copy?: boolean;
  site_license_copy_requires_grant?: boolean;
  metadata?: Record<string, unknown> | null;
  last_edited?: Date | string | null;
  disabled?: boolean;
}

export interface CreatePublicDirectoryShareOptions {
  account_id?: string;
  project_id: string;
  path: string;
  slug: string;
  title?: string | null;
  description?: string | null;
  license?: string | null;
  site_license_id?: string | null;
  site_license_pool_id?: string | null;
  site_license_duration_days?: number | null;
  site_license_grant_on_copy?: boolean;
  site_license_copy_requires_grant?: boolean;
}

export interface UpdatePublicDirectoryShareOptions {
  account_id?: string;
  id: string;
  slug?: string;
  title?: string | null;
  description?: string | null;
  license?: string | null;
  site_license_id?: string | null;
  site_license_pool_id?: string | null;
  site_license_duration_days?: number | null;
  site_license_grant_on_copy?: boolean;
  site_license_copy_requires_grant?: boolean;
  disabled?: boolean;
}

export interface CopyPublicDirectoryShareToProjectOptions {
  account_id?: string;
  slug: string;
  path?: string;
  destination_project_id: string;
  destination_path?: string;
  options?: CopyOptions;
}

export interface CopyPublicDirectoryShareToNewProjectOptions {
  account_id?: string;
  slug: string;
  path?: string;
  title?: string;
  options?: CopyOptions;
}

export interface AuthorizePublicDirectoryShareReadOptions {
  account_id?: string;
  host_id?: string;
  project_id: string;
  share_id: string;
}

export interface AuthorizePublicDirectoryShareReadResponse {
  project_id: string;
  share_id: string;
  read_policy: ProjectViewerReadPolicy;
}

export interface GrantTemporaryViewerAccessOptions {
  account_id?: string;
  slug: string;
}

export interface GrantTemporaryViewerAccessResponse {
  project_id: string;
  share_id: string;
  path: string;
  read_policy: ProjectViewerReadPolicy;
  expires_at: Date | string;
  project_url: string;
  project_title?: string | null;
  share_title?: string | null;
  host_id?: string | null;
  host_connection?: ResolvedPublicDirectoryShare["host_connection"];
  owning_bay_id?: string | null;
}

export interface GetTemporaryViewerReadPolicyOptions {
  account_id?: string;
  project_id: string;
}

export interface GetTemporaryViewerReadPolicyResponse {
  project_id: string;
  account_id: string;
  read_policy?: ProjectViewerReadPolicy;
}

export interface PublicDirectoryShareDirectoryEntry {
  name: string;
  path: string;
  type?: FileTypeLabel;
  size?: number;
  mtime?: number;
  isDir?: boolean;
  isSymLink?: boolean;
  linkTarget?: string;
}

export interface ListPublicDirectoryShareDirectoryOptions {
  account_id?: string;
  slug: string;
  path?: string;
}

export interface ListPublicDirectoryShareDirectoryResponse {
  share: ResolvedPublicDirectoryShare;
  path: string;
  entries: PublicDirectoryShareDirectoryEntry[];
  truncated?: boolean;
}

export interface CopyPublicDirectoryShareToProjectResponse {
  destination_project_id: string;
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
  site_license_grant?: {
    granted: boolean;
    message?: string;
    expires_at?: Date | string | null;
    membership_class?: string | null;
    site_license_id?: string | null;
    package_id?: string | null;
  };
}

export interface CopyPublicDirectoryShareToNewProjectResponse extends CopyPublicDirectoryShareToProjectResponse {
  created_project: true;
  requested_host_id?: string | null;
  placed_on_requested_host: boolean;
  host_placement_message?: string | null;
}

export interface PublicDirectoryShares {
  resolve: (
    opts: ResolvePublicDirectoryShareOptions,
  ) => Promise<ResolvedPublicDirectoryShare>;
  list: (
    opts?: ListPublicDirectorySharesOptions,
  ) => Promise<ListPublicDirectorySharesResponse>;
  listMine: (
    opts?: ListMyPublicDirectorySharesOptions,
  ) => Promise<ListPublicDirectorySharesResponse>;
  listProject: (
    opts: ListProjectPublicDirectorySharesOptions,
  ) => Promise<ListPublicDirectorySharesResponse>;
  disableMineByActor: (
    opts: DisableMyPublicDirectorySharesByActorOptions,
  ) => Promise<DisableMyPublicDirectorySharesByActorResponse>;
  upsert: (
    opts: UpsertPublicDirectoryShareOptions,
  ) => Promise<PublicDirectoryShareSummary>;
  create: (
    opts: CreatePublicDirectoryShareOptions,
  ) => Promise<PublicDirectoryShareSummary>;
  update: (
    opts: UpdatePublicDirectoryShareOptions,
  ) => Promise<PublicDirectoryShareSummary>;
  listDirectory: (
    opts: ListPublicDirectoryShareDirectoryOptions,
  ) => Promise<ListPublicDirectoryShareDirectoryResponse>;
  copyToProject: (
    opts: CopyPublicDirectoryShareToProjectOptions,
  ) => Promise<CopyPublicDirectoryShareToProjectResponse>;
  copyToNewProject: (
    opts: CopyPublicDirectoryShareToNewProjectOptions,
  ) => Promise<CopyPublicDirectoryShareToNewProjectResponse>;
  authorizeRead: (
    opts: AuthorizePublicDirectoryShareReadOptions,
  ) => Promise<AuthorizePublicDirectoryShareReadResponse>;
  grantTemporaryViewerAccess: (
    opts: GrantTemporaryViewerAccessOptions,
  ) => Promise<GrantTemporaryViewerAccessResponse>;
  getTemporaryViewerReadPolicy: (
    opts: GetTemporaryViewerReadPolicyOptions,
  ) => Promise<GetTemporaryViewerReadPolicyResponse>;
}

export const publicDirectoryShares = {
  resolve: authFirstRequireAccount,
  list: authFirstRequireAccount,
  listMine: authFirstRequireAccount,
  listProject: authFirstRequireAccount,
  disableMineByActor: authFirstRequireAccount,
  upsert: authFirstRequireAccount,
  create: authFirstRequireAccount,
  update: authFirstRequireAccount,
  listDirectory: authFirstRequireAccount,
  copyToProject: authFirstRequireAccount,
  copyToNewProject: authFirstRequireAccount,
  authorizeRead: authFirst,
  grantTemporaryViewerAccess: authFirstRequireAccount,
  getTemporaryViewerReadPolicy: authFirst,
} as const;
