/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "rootfs_images",
  rules: {
    primary_key: "image_id",
    pg_indexes: [
      "owner_id",
      "official",
      "prepull",
      "hidden",
      "blocked",
      "deleted",
      "visibility",
      "runtime_image",
      "updated",
    ],
  },
  fields: {
    image_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable identifier for this RootFS image release/catalog entry.",
    },
    release_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Optional immutable RootFS release referenced by this catalog entry.",
    },
    owner_id: {
      type: "uuid",
      desc: "Account that published this image, if any.",
    },
    runtime_image: {
      type: "string",
      desc: "Concrete runtime image string currently used by project-hosts.",
    },
    label: {
      type: "string",
      desc: "Human-facing label shown in pickers.",
    },
    description: {
      type: "string",
      desc: "Longer description shown to users.",
    },
    visibility: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Sharing level: private, collaborators, or public.",
    },
    official: {
      type: "boolean",
      desc: "Whether admins marked this image as official.",
    },
    prepull: {
      type: "boolean",
      desc: "Whether new hosts should pre-pull this image.",
    },
    hidden: {
      type: "boolean",
      desc: "Hide this image from normal user-facing pickers.",
    },
    blocked: {
      type: "boolean",
      desc: "Prevent this image from being newly selected or published from.",
    },
    blocked_reason: {
      type: "string",
      desc: "Optional explanation for why this image was blocked.",
    },
    deleted: {
      type: "boolean",
      desc: "Soft-delete this catalog entry while retaining referenced releases.",
    },
    deleted_reason: {
      type: "string",
      desc: "Optional explanation for why this catalog entry was deleted.",
    },
    deleted_at: {
      type: "timestamp",
      desc: "When this catalog entry was soft-deleted.",
    },
    deleted_by: {
      type: "uuid",
      desc: "Account that soft-deleted this catalog entry.",
    },
    arch: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Target architecture for this release (amd64, arm64, any).",
    },
    gpu: {
      type: "boolean",
      desc: "Whether this image targets GPU-enabled hosts.",
    },
    size_gb: {
      type: "number",
      desc: "Approximate uncompressed size in GB.",
    },
    tags: {
      type: "array",
      pg_type: "TEXT[]",
      desc: "Search/grouping tags for this image.",
    },
    digest: {
      type: "string",
      desc: "Optional source digest or immutable OCI digest.",
    },
    content_key: {
      type: "string",
      desc: "Optional immutable content key for future R2/btrfs artifacts.",
    },
    deprecated: {
      type: "boolean",
      desc: "Whether this image is deprecated in the catalog.",
    },
    deprecated_reason: {
      type: "string",
      desc: "Optional explanation shown for deprecated images.",
    },
    theme: {
      type: "map",
      desc: "Optional theme metadata for this image.",
    },
    created: {
      type: "timestamp",
      desc: "When this image row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this image row was last updated.",
    },
  },
});
