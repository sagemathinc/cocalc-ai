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
