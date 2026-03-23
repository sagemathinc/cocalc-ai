/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { Table } from "./types";

Table({
  name: "rootfs_releases",
  rules: {
    primary_key: "release_id",
    pg_indexes: ["content_key", "runtime_image", "created"],
  },
  fields: {
    release_id: {
      type: "string",
      pg_type: "VARCHAR(128)",
      desc: "Stable identifier for this immutable RootFS release.",
    },
    content_key: {
      type: "string",
      unique: true,
      desc: "Immutable logical content hash for the full RootFS tree.",
    },
    runtime_image: {
      type: "string",
      unique: true,
      desc: "Concrete managed runtime image name for this release.",
    },
    source_image: {
      type: "string",
      desc: "Source image or parent runtime image used to build this release.",
    },
    parent_release_id: {
      type: "uuid",
      desc: "Optional parent immutable RootFS release when this release is stored as a delta.",
    },
    depth: {
      type: "number",
      desc: "Delta ancestry depth for this release. Full releases have depth 0.",
    },
    arch: {
      type: "string",
      pg_type: "VARCHAR(16)",
      desc: "Target architecture for this release (amd64, arm64, any).",
    },
    size_bytes: {
      type: "number",
      desc: "Approximate unpacked size of the release tree in bytes.",
    },
    artifact_kind: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Artifact kind for this release (full, delta).",
    },
    artifact_format: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Artifact encoding used for transport (currently btrfs-send).",
    },
    artifact_backend: {
      type: "string",
      pg_type: "VARCHAR(32)",
      desc: "Storage backend where the artifact lives (currently hub-local).",
    },
    artifact_path: {
      type: "string",
      desc: "Relative storage path/key for the immutable release artifact.",
    },
    artifact_sha256: {
      type: "string",
      desc: "SHA256 of the stored artifact bytes.",
    },
    artifact_bytes: {
      type: "number",
      desc: "Stored artifact size in bytes.",
    },
    inspect_json: {
      type: "map",
      desc: "Cached inspect metadata used to reconstruct host-local cache entries.",
    },
    created: {
      type: "timestamp",
      desc: "When this release row was created.",
    },
    updated: {
      type: "timestamp",
      desc: "When this release row was last updated.",
    },
  },
});
