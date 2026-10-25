/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  authFirstRequireAccount,
  authFirstRequireAccountOrHostWithAccountTarget,
} from "./util";
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

export type PublicDirectorySharePathType = "directory" | "file";

export interface PublicDirectoryShareSummary {
  id: string;
  project_id: string;
  path: string;
  path_type: PublicDirectorySharePathType;
  slug: string;
  visibility: PublicDirectoryShareVisibility;
  requires_auth: boolean;
  availability_status: PublicDirectoryShareAvailability;
  availability_message?: string | null;
  title?: string | null;
  description?: string | null;
  reader_instructions?: string | null;
  license?: string | null;
  image?: string | null;
  theme?: PublicDirectoryShareTheme | null;
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
  publisher_account_id?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  last_edited?: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export interface PublicDirectoryShareTheme {
  title?: string | null;
  description?: string | null;
  color?: string | null;
  accent_color?: string | null;
  icon?: string | null;
  image_blob?: string | null;
}

export interface ResolvedPublicDirectoryShare extends PublicDirectoryShareSummary {
  read_policy: ProjectViewerReadPolicy;
  available: boolean;
  project_title?: string | null;
  host_id?: string | null;
  host_connection?: HostConnectionInfo | null;
  owning_bay_id?: string | null;
  publisher_reader_instructions?: string | null;
}

export interface PublicSharePublisherProfile {
  reader_instructions_markdown?: string | null;
  updated_at?: Date | string | null;
}

export interface GetPublicSharePublisherProfileOptions {
  account_id?: string;
}

export interface UpdatePublicSharePublisherProfileOptions {
  account_id?: string;
  reader_instructions_markdown?: string | null;
}

export interface ResolvePublicDirectoryShareOptions {
  account_id?: string;
  slug: string;
}

export interface ResolveLegacyPublicDirectorySharePathOptions {
  path: string;
}

export interface ResolveLegacyPublicDirectorySharePathResponse {
  path: string;
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

export interface DisablePublicDirectorySharesForBannedActorOptions {
  actor_account_id: string;
  reason?: string | null;
}

export interface DisablePublicDirectorySharesForBannedActorResponse {
  disabled_count: number;
  share_ids: string[];
}

export interface UpsertPublicDirectoryShareOptions {
  account_id?: string;
  id?: string;
  project_id: string;
  path: string;
  path_type?: PublicDirectorySharePathType;
  slug: string;
  visibility?: PublicDirectoryShareVisibility;
  requires_auth?: boolean;
  availability_status?: PublicDirectoryShareAvailability;
  availability_message?: string | null;
  title?: string | null;
  description?: string | null;
  reader_instructions?: string | null;
  license?: string | null;
  image?: string | null;
  theme?: PublicDirectoryShareTheme | null;
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
  reader_instructions?: string | null;
  license?: string | null;
  image?: string | null;
  theme?: PublicDirectoryShareTheme | null;
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
  reader_instructions?: string | null;
  license?: string | null;
  image?: string | null;
  theme?: PublicDirectoryShareTheme | null;
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
  reuse_existing?: boolean;
  overwrite_existing?: boolean;
}

export interface AuthorizePublicDirectoryShareReadOptions {
  account_id?: string;
  host_id?: string;
  project_id: string;
  share_id: string;
  // Internal, between bays: false for a check that is not itself a read of
  // the share, so it isn't recorded as a view. The hub API ignores it.
  record_view?: boolean;
}

export interface AuthorizePublicDirectoryShareReadResponse {
  project_id: string;
  share_id: string;
  read_policy: ProjectViewerReadPolicy;
}

// Who read a share, recorded at most once per (share, account, UTC day):
// the share's project's owner, a collaborator, or anybody else.
export type PublicDirectoryShareViewerRole = "owner" | "collaborator" | "other";

export interface PublicDirectoryShareViewCounts {
  viewers: number;
  owner: number;
  collaborator: number;
  other: number;
}

export interface GetPublicDirectoryShareViewsOptions {
  account_id?: string;
  project_id: string;
  share_id: string;
  // the last this many days, today included (default 30)
  days?: number;
}

// For a share's owners and collaborators: counts only, never who the other
// viewers were.
export interface GetPublicDirectoryShareViewsResponse {
  project_id: string;
  share_id: string;
  since: string; // first day included, YYYY-MM-DD (UTC)
  by_day: (PublicDirectoryShareViewCounts & { day: string })[];
  distinct_viewers: PublicDirectoryShareViewCounts;
}

export interface GetPublicDirectoryShareViewAggregatesOptions {
  account_id?: string;
  // Only this share (with its project_id, to find the share's bay);
  // otherwise all shares stored on the bay that receives the call.
  share_id?: string;
  project_id?: string;
  viewer_role?: PublicDirectoryShareViewerRole;
  days?: number;
}

export interface PublicDirectoryShareViewAggregate {
  viewer_days: number;
  distinct_viewers: number;
}

// For admins: aggregates only. Anything made up of fewer than min_count
// distinct accounts is left out: the totals are null, and such a day or
// country is not listed at all, so not even its existence shows. This makes
// one report safe to hand on (e.g. to an institution). It does not stop an
// admin, who can read the table anyway, from subtracting overlapping reports
// (a different role filter or range) to recover a suppressed count.
export interface GetPublicDirectoryShareViewAggregatesResponse {
  since: string;
  min_count: number;
  totals: PublicDirectoryShareViewAggregate | null;
  by_day: (PublicDirectoryShareViewAggregate & { day: string })[];
  // country: ISO 3166-1 alpha-2, or null when it isn't known
  by_country: (PublicDirectoryShareViewAggregate & {
    country: string | null;
  })[];
}

export interface GrantTemporaryViewerAccessOptions {
  account_id?: string;
  slug: string;
}

export interface GrantTemporaryViewerAccessResponse {
  project_id: string;
  share_id: string;
  legacy_public_path_id?: string | null;
  path: string;
  path_type: PublicDirectorySharePathType;
  read_policy: ProjectViewerReadPolicy;
  expires_at: Date | string;
  project_url: string;
  project_title?: string | null;
  share_title?: string | null;
  share_description?: string | null;
  reader_instructions?: string | null;
  publisher_reader_instructions?: string | null;
  publisher_account_id?: string | null;
  license?: string | null;
  image?: string | null;
  theme?: PublicDirectoryShareTheme | null;
  site_license_grant_on_copy?: boolean;
  site_license_copy_requires_grant?: boolean;
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
  destination_path: string;
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

export interface CopyPublicDirectoryShareToNewProjectConflictResponse {
  destination_project_id: string;
  created_project: false;
  reused_project: true;
  requested_host_id?: string | null;
  placed_on_requested_host: true;
  host_placement_message?: string | null;
  conflict: {
    reason: "already_copied" | "path_exists";
    message: string;
    destination_path?: string | null;
    can_overwrite: boolean;
  };
}

export type CopyPublicDirectoryShareToNewProjectResponse =
  CopyPublicDirectoryShareToProjectResponse & {
    created_project: boolean;
    reused_project?: boolean;
    requested_host_id?: string | null;
    placed_on_requested_host: boolean;
    host_placement_message?: string | null;
  };

export type CopyPublicDirectoryShareToNewProjectResult =
  | CopyPublicDirectoryShareToNewProjectResponse
  | CopyPublicDirectoryShareToNewProjectConflictResponse;

export function isCopyPublicDirectoryShareToNewProjectConflict(
  response: CopyPublicDirectoryShareToNewProjectResult,
): response is CopyPublicDirectoryShareToNewProjectConflictResponse {
  return "conflict" in response;
}

export interface PublicDirectoryShares {
  getPublisherProfile: (
    opts?: GetPublicSharePublisherProfileOptions,
  ) => Promise<PublicSharePublisherProfile>;
  updatePublisherProfile: (
    opts: UpdatePublicSharePublisherProfileOptions,
  ) => Promise<PublicSharePublisherProfile>;
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
  ) => Promise<CopyPublicDirectoryShareToNewProjectResult>;
  authorizeRead: (
    opts: AuthorizePublicDirectoryShareReadOptions,
  ) => Promise<AuthorizePublicDirectoryShareReadResponse>;
  grantTemporaryViewerAccess: (
    opts: GrantTemporaryViewerAccessOptions,
  ) => Promise<GrantTemporaryViewerAccessResponse>;
  getTemporaryViewerReadPolicy: (
    opts: GetTemporaryViewerReadPolicyOptions,
  ) => Promise<GetTemporaryViewerReadPolicyResponse>;
  getViews: (
    opts: GetPublicDirectoryShareViewsOptions,
  ) => Promise<GetPublicDirectoryShareViewsResponse>;
  getViewAggregates: (
    opts: GetPublicDirectoryShareViewAggregatesOptions,
  ) => Promise<GetPublicDirectoryShareViewAggregatesResponse>;
}

export const publicDirectoryShares = {
  getPublisherProfile: authFirstRequireAccount,
  updatePublisherProfile: authFirstRequireAccount,
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
  authorizeRead: authFirstRequireAccountOrHostWithAccountTarget,
  grantTemporaryViewerAccess: authFirstRequireAccount,
  getTemporaryViewerReadPolicy: authFirstRequireAccountOrHostWithAccountTarget,
  getViews: authFirstRequireAccount,
  getViewAggregates: authFirstRequireAccount,
} as const;
