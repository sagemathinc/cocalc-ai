/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "public_project_paths",
  rules: {
    primary_key: "id",
    pg_indexes: [
      "project_id",
      "slug",
      "visibility",
      "availability_status",
      "legacy_public_path_id",
      "site_license_id",
      "updated_at",
    ],
    user_query: {
      get: {
        admin: true,
        fields: {
          id: null,
          project_id: null,
          path: null,
          slug: null,
          visibility: null,
          requires_auth: null,
          availability_status: null,
          availability_message: null,
          title: null,
          description: null,
          license: null,
          image: null,
          redirect: null,
          site_license_id: null,
          site_license_pool_id: null,
          site_license_membership_tier_id: null,
          site_license_duration_days: null,
          site_license_grant_on_copy: null,
          site_license_copy_requires_grant: null,
          metadata: null,
          legacy_public_path_id: null,
          legacy_url: null,
          created_by: null,
          updated_by: null,
          created_at: null,
          updated_at: null,
          last_edited: null,
          disabled: null,
        },
      },
      set: {
        admin: true,
        delete: true,
        fields: {
          project_id: null,
          path: null,
          slug: null,
          visibility: null,
          requires_auth: null,
          availability_status: null,
          availability_message: null,
          title: null,
          description: null,
          license: null,
          image: null,
          redirect: null,
          site_license_id: null,
          site_license_pool_id: null,
          site_license_membership_tier_id: null,
          site_license_duration_days: null,
          site_license_grant_on_copy: null,
          site_license_copy_requires_grant: null,
          metadata: null,
          legacy_public_path_id: null,
          legacy_url: null,
          created_by: null,
          updated_by: null,
          last_edited: null,
          disabled: null,
        },
      },
    },
  },
  fields: {
    id: {
      type: "uuid",
      desc: "Public directory share id.",
    },
    project_id: {
      type: "uuid",
      desc: "Project that owns the shared directory.",
      render: { type: "project_link" },
    },
    path: {
      type: "string",
      desc: "Directory path inside the project that is visible through the public share.",
    },
    slug: {
      type: "string",
      desc: "Stable URL slug, e.g. Cambridge/9781009209090/Code.",
    },
    visibility: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Share visibility: listed, unlisted, private, or disabled.",
    },
    requires_auth: {
      type: "boolean",
      desc: "Whether signed-in account authentication is required before resolving this share.",
    },
    availability_status: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Whether backing files are available: available, pending, unavailable, or unknown.",
    },
    availability_message: {
      type: "string",
      desc: "Optional user-facing explanation when backing files are pending or unavailable.",
    },
    title: {
      type: "string",
      desc: "Display title.",
    },
    description: {
      type: "string",
      desc: "Display description.",
    },
    license: {
      type: "string",
      desc: "Display license text or identifier.",
    },
    image: {
      type: "string",
      desc: "Optional image URL inherited from the legacy share server.",
    },
    redirect: {
      type: "string",
      desc: "Optional legacy redirect target.",
    },
    site_license_id: {
      type: "uuid",
      desc: "Site license to grant when this share is copied, if configured.",
    },
    site_license_pool_id: {
      type: "uuid",
      desc: "Site license pool to consume from when this share is copied.",
    },
    site_license_membership_tier_id: {
      type: "string",
      desc: "Membership tier id to grant when this share is copied.",
    },
    site_license_duration_days: {
      type: "integer",
      desc: "Temporary grant duration in days for copy-time site license grants.",
    },
    site_license_grant_on_copy: {
      type: "boolean",
      desc: "Whether copying this share should attempt a temporary site-license grant.",
    },
    site_license_copy_requires_grant: {
      type: "boolean",
      desc: "Whether copy should fail if the temporary site-license grant fails.",
    },
    metadata: {
      type: "map",
      desc: "Legacy and auxiliary metadata for migration/support.",
    },
    legacy_public_path_id: {
      type: "string",
      desc: "Old cocalc.com public_paths.id, when imported from the legacy share server.",
    },
    legacy_url: {
      type: "string",
      desc: "Old cocalc.com public URL or URL path.",
    },
    created_by: {
      type: "uuid",
      desc: "Account that created this share, if known.",
      render: { type: "account" },
    },
    updated_by: {
      type: "uuid",
      desc: "Account that last updated this share, if known.",
      render: { type: "account" },
    },
    created_at: {
      type: "timestamp",
      desc: "When this share row was created.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this share row was last updated.",
    },
    last_edited: {
      type: "timestamp",
      desc: "Last known edit time of the legacy publication.",
    },
    disabled: {
      type: "boolean",
      desc: "Emergency disable flag. Disabled rows do not resolve.",
    },
  },
});

Table({
  name: "public_project_path_slugs",
  rules: {
    primary_key: "slug_lower",
    pg_indexes: ["project_id", "public_project_path_id", "owning_bay_id"],
  },
  fields: {
    slug_lower: {
      type: "string",
      desc: "Lowercase normalized slug used as the global lookup key.",
    },
    slug: {
      type: "string",
      desc: "Canonical display slug.",
    },
    owning_bay_id: {
      type: "string",
      desc: "Bay that owns the authoritative public_project_paths row.",
    },
    public_project_path_id: {
      type: "uuid",
      desc: "Authoritative public_project_paths.id.",
    },
    project_id: {
      type: "uuid",
      desc: "Project that owns the shared directory.",
      render: { type: "project_link" },
    },
    disabled: {
      type: "boolean",
      desc: "Whether slug resolution is disabled.",
    },
    updated_at: {
      type: "timestamp",
      desc: "When this slug directory row was last updated.",
    },
  },
});
