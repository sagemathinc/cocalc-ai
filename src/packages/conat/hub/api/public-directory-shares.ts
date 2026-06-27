/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { authFirstRequireAccount } from "./util";
import type { CopyOptions } from "@cocalc/conat/files/fs";
import type { FileTypeLabel } from "@cocalc/conat/files/listing";
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
  last_edited?: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}

export interface ResolvedPublicDirectoryShare extends PublicDirectoryShareSummary {
  read_policy: ProjectViewerReadPolicy;
  available: boolean;
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
  destination_project_id: string;
  destination_path?: string;
  options?: CopyOptions;
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
}

export const publicDirectoryShares = {
  resolve: authFirstRequireAccount,
  list: authFirstRequireAccount,
  listMine: authFirstRequireAccount,
  upsert: authFirstRequireAccount,
  create: authFirstRequireAccount,
  update: authFirstRequireAccount,
  listDirectory: authFirstRequireAccount,
  copyToProject: authFirstRequireAccount,
} as const;
