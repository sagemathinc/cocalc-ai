/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { v4 } from "uuid";
import type {
  PublishProjectRootfsArtifact,
  PublishProjectRootfsBody,
  RootfsCatalogSaveBody,
  RootfsImageArch,
  RootfsImageEntry,
  RootfsImageManifest,
  RootfsImageSection,
  RootfsImageTheme,
  RootfsImageVisibility,
  RootfsImageWarning,
} from "@cocalc/util/rootfs-images";
import {
  BUILTIN_ROOTFS_IMAGES,
  DEFAULT_ROOTFS_CATALOG_URL,
  normalizeRootfsEntry,
  ROOTFS_IMAGE_MANIFEST_VERSION,
} from "@cocalc/util/rootfs-images";

type RootfsImageRow = {
  image_id: string;
  owner_id: string | null;
  runtime_image: string;
  label: string;
  description: string | null;
  visibility: RootfsImageVisibility | null;
  official: boolean | null;
  prepull: boolean | null;
  hidden: boolean | null;
  arch: string | null;
  gpu: boolean | null;
  size_gb: number | null;
  tags: string[] | null;
  digest: string | null;
  content_key: string | null;
  deprecated: boolean | null;
  deprecated_reason: string | null;
  theme: RootfsImageTheme | null;
  owner_first_name: string | null;
  owner_last_name: string | null;
};

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v.length > 0 ? v : undefined;
}

function normalizeTags(tags?: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(
    new Set(tags.map((tag) => trimString(tag)).filter(Boolean) as string[]),
  );
}

function normalizeTheme(theme?: unknown): RootfsImageTheme | null {
  if (theme == null || typeof theme !== "object") return null;
  const value = theme as Record<string, unknown>;
  return {
    title: trimString(value.title),
    description: trimString(value.description),
    color: trimString(value.color) ?? null,
    accent_color: trimString(value.accent_color) ?? null,
    icon: trimString(value.icon) ?? null,
    image_blob: trimString(value.image_blob) ?? null,
  };
}

function normalizeArch(value?: unknown): string {
  if (Array.isArray(value)) {
    return trimString(value[0]) ?? "any";
  }
  return trimString(value) ?? "any";
}

function fullName(row: RootfsImageRow): string | undefined {
  const first = trimString(row.owner_first_name);
  const last = trimString(row.owner_last_name);
  const name = [first, last].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function sectionFor({
  row,
  account_id,
  collaboratorIds,
}: {
  row: RootfsImageRow;
  account_id?: string;
  collaboratorIds: Set<string>;
}): RootfsImageSection | undefined {
  if (row.hidden) return undefined;
  if (row.official) return "official";
  if (account_id && row.owner_id === account_id) return "mine";
  if (
    row.visibility === "collaborators" &&
    row.owner_id &&
    collaboratorIds.has(row.owner_id)
  ) {
    return "collaborators";
  }
  if (row.visibility === "public") return "public";
}

function warningFor(section?: RootfsImageSection): RootfsImageWarning {
  switch (section) {
    case "collaborators":
      return "collaborator";
    case "public":
      return "public";
    default:
      return "none";
  }
}

function rowToEntry({
  row,
  account_id,
  collaboratorIds,
  admin,
}: {
  row: RootfsImageRow;
  account_id?: string;
  collaboratorIds: Set<string>;
  admin: boolean;
}): RootfsImageEntry | undefined {
  const section = sectionFor({ row, account_id, collaboratorIds });
  if (!section) return undefined;
  return normalizeRootfsEntry(
    {
      id: row.image_id,
      label: row.label || row.runtime_image,
      image: row.runtime_image,
      description: row.description ?? undefined,
      digest: row.digest ?? undefined,
      arch: row.arch ? [row.arch as any] : undefined,
      gpu: row.gpu ?? undefined,
      size_gb: row.size_gb ?? undefined,
      tags: row.tags ?? undefined,
      prepull: row.prepull ?? undefined,
      deprecated: row.deprecated ?? undefined,
      deprecated_reason: row.deprecated_reason ?? undefined,
      visibility: row.visibility ?? "public",
      official: row.official ?? false,
      hidden: row.hidden ?? false,
      owner_id: row.owner_id ?? undefined,
      owner_name: fullName(row),
      section,
      warning: warningFor(section),
      theme: row.theme ?? undefined,
      can_manage:
        admin ||
        (!!account_id && !!row.owner_id && row.owner_id === account_id),
    },
    DEFAULT_ROOTFS_CATALOG_URL,
  );
}

async function collaboratorIdsFor(account_id?: string): Promise<Set<string>> {
  if (!account_id) return new Set<string>();
  const pool = getPool("medium");
  const { rows } = await pool.query<{ jsonb_object_keys?: string }>(
    "SELECT DISTINCT jsonb_object_keys(users) FROM projects WHERE users ? $1::TEXT",
    [account_id],
  );
  return new Set(
    rows
      .map((row) => row.jsonb_object_keys)
      .filter((value): value is string => typeof value === "string"),
  );
}

export async function ensureBuiltinRootfsImages(): Promise<void> {
  const pool = getPool("medium");
  for (const entry of BUILTIN_ROOTFS_IMAGES) {
    await pool.query(
      `INSERT INTO rootfs_images
      (image_id, owner_id, runtime_image, label, description, visibility, official, prepull, hidden, arch, gpu, size_gb, tags, digest, content_key, deprecated, deprecated_reason, theme, created, updated)
      VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, false, $8, $9, $10, $11::TEXT[], $12, $13, $14, $15, $16::JSONB, NOW(), NOW())
      ON CONFLICT (image_id) DO NOTHING`,
      [
        entry.id,
        entry.image,
        entry.label,
        entry.description ?? null,
        entry.visibility ?? "public",
        entry.official ?? false,
        entry.prepull ?? false,
        Array.isArray(entry.arch) ? entry.arch[0] : (entry.arch ?? "any"),
        entry.gpu ?? false,
        entry.size_gb ?? null,
        entry.tags ?? [],
        entry.digest ?? null,
        null,
        entry.deprecated ?? false,
        entry.deprecated_reason ?? null,
        entry.theme ? JSON.stringify(entry.theme) : null,
      ],
    );
  }
}

async function queryRootfsRows(): Promise<RootfsImageRow[]> {
  const pool = getPool("medium");
  const { rows } = await pool.query<RootfsImageRow>(
    `SELECT
      r.image_id,
      r.owner_id,
      r.runtime_image,
      r.label,
      r.description,
      r.visibility,
      r.official,
      r.prepull,
      r.hidden,
      r.arch,
      r.gpu,
      r.size_gb,
      r.tags,
      r.digest,
      r.content_key,
      r.deprecated,
      r.deprecated_reason,
      r.theme,
      a.first_name AS owner_first_name,
      a.last_name AS owner_last_name
    FROM rootfs_images AS r
    LEFT JOIN accounts AS a ON a.account_id = r.owner_id
    ORDER BY r.official DESC, COALESCE(r.updated, r.created) DESC, r.label ASC`,
  );
  return rows;
}

export async function listVisibleRootfsImages(
  account_id?: string,
): Promise<RootfsImageManifest> {
  await ensureBuiltinRootfsImages();
  const [rows, collaboratorIds, admin] = await Promise.all([
    queryRootfsRows(),
    collaboratorIdsFor(account_id),
    account_id ? isAdmin(account_id) : Promise.resolve(false),
  ]);
  const images = rows
    .map((row) => rowToEntry({ row, account_id, collaboratorIds, admin }))
    .filter((entry): entry is RootfsImageEntry => !!entry);
  return {
    version: ROOTFS_IMAGE_MANIFEST_VERSION,
    generated_at: new Date().toISOString(),
    source: DEFAULT_ROOTFS_CATALOG_URL,
    images,
  };
}

function normalizeVisibility(value?: unknown): RootfsImageVisibility {
  const trimmed = trimString(value);
  if (
    trimmed === "private" ||
    trimmed === "collaborators" ||
    trimmed === "public"
  ) {
    return trimmed;
  }
  return "private";
}

async function upsertRootfsRow({
  account_id,
  body,
  digest,
  content_key,
}: {
  account_id: string;
  body: RootfsCatalogSaveBody;
  digest?: string | null;
  content_key?: string | null;
}): Promise<{ image_id: string; entry?: RootfsImageEntry }> {
  const pool = getPool("medium");
  const admin = await isAdmin(account_id);
  const image = trimString(body.image);
  const label = trimString(body.label);
  if (!image) {
    throw Error("image must be specified");
  }
  if (!label) {
    throw Error("label must be specified");
  }

  let image_id = trimString(body.image_id);
  let owner_id = account_id;

  if (image_id) {
    const { rows } = await pool.query<{
      image_id: string;
      owner_id: string | null;
    }>("SELECT image_id, owner_id FROM rootfs_images WHERE image_id=$1", [
      image_id,
    ]);
    const existing = rows[0];
    if (!existing) {
      throw Error("rootfs image not found");
    }
    if (!admin && existing.owner_id !== account_id) {
      throw Error("not allowed to update this rootfs image");
    }
    owner_id = existing.owner_id ?? owner_id;
  } else {
    const { rows } = await pool.query<{ image_id: string }>(
      `SELECT image_id
       FROM rootfs_images
       WHERE owner_id=$1 AND runtime_image=$2
       ORDER BY updated DESC NULLS LAST, created DESC NULLS LAST
       LIMIT 1`,
      [account_id, image],
    );
    image_id = rows[0]?.image_id ?? v4();
  }

  const visibility = normalizeVisibility(body.visibility);
  const tags = normalizeTags(body.tags);
  const description = trimString(body.description) ?? null;
  const theme = normalizeTheme(body.theme);
  const arch = normalizeArch(body.arch);
  const gpu = body.gpu === true;
  const size_gb =
    typeof body.size_gb === "number" && Number.isFinite(body.size_gb)
      ? body.size_gb
      : null;
  const official = admin && body.official === true;
  const prepull = admin && body.prepull === true;
  const hidden = admin && body.hidden === true;

  await pool.query(
    `INSERT INTO rootfs_images
      (image_id, owner_id, runtime_image, label, description, visibility, official, prepull, hidden, arch, gpu, size_gb, tags, digest, content_key, deprecated, deprecated_reason, theme, created, updated)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::TEXT[], $14, $15, false, NULL, $16::JSONB, NOW(), NOW())
     ON CONFLICT (image_id) DO UPDATE SET
      owner_id = EXCLUDED.owner_id,
      runtime_image = EXCLUDED.runtime_image,
      label = EXCLUDED.label,
      description = EXCLUDED.description,
      visibility = EXCLUDED.visibility,
      official = EXCLUDED.official,
      prepull = EXCLUDED.prepull,
      hidden = EXCLUDED.hidden,
      arch = EXCLUDED.arch,
      gpu = EXCLUDED.gpu,
      size_gb = EXCLUDED.size_gb,
      tags = EXCLUDED.tags,
      digest = COALESCE(EXCLUDED.digest, rootfs_images.digest),
      content_key = COALESCE(EXCLUDED.content_key, rootfs_images.content_key),
      theme = EXCLUDED.theme,
      updated = NOW()`,
    [
      image_id,
      owner_id,
      image,
      label,
      description,
      visibility,
      official,
      prepull,
      hidden,
      arch,
      gpu,
      size_gb,
      tags,
      digest ?? null,
      content_key ?? null,
      theme ? JSON.stringify(theme) : null,
    ],
  );

  const manifest = await listVisibleRootfsImages(account_id);
  return {
    image_id,
    entry: manifest.images.find((item) => item.id === image_id),
  };
}

export async function saveRootfsImage({
  account_id,
  body,
}: {
  account_id: string;
  body: RootfsCatalogSaveBody;
}): Promise<RootfsImageEntry> {
  const { image_id, entry } = await upsertRootfsRow({
    account_id,
    body,
  });
  if (entry) {
    return entry;
  }
  const image = trimString(body.image)!;
  const label = trimString(body.label)!;
  const visibility = normalizeVisibility(body.visibility);
  const tags = normalizeTags(body.tags);
  const description = trimString(body.description);
  const theme = normalizeTheme(body.theme);
  const arch = normalizeArch(body.arch);
  const gpu = body.gpu === true;
  const size_gb =
    typeof body.size_gb === "number" && Number.isFinite(body.size_gb)
      ? body.size_gb
      : null;
  const admin = await isAdmin(account_id);
  const official = admin && body.official === true;
  const prepull = admin && body.prepull === true;
  const hidden = admin && body.hidden === true;
  return normalizeRootfsEntry(
    {
      id: image_id,
      label,
      image,
      description: description ?? undefined,
      visibility,
      official,
      prepull,
      hidden,
      arch: arch as RootfsImageArch,
      gpu,
      size_gb: size_gb ?? undefined,
      tags,
      theme: theme ?? undefined,
      section: official ? "official" : "mine",
      warning: "none",
      can_manage: true,
    },
    DEFAULT_ROOTFS_CATALOG_URL,
  );
}

export async function publishProjectRootfsCatalogEntry({
  account_id,
  body,
  artifact,
}: {
  account_id: string;
  body: PublishProjectRootfsBody;
  artifact: PublishProjectRootfsArtifact;
}): Promise<RootfsImageEntry> {
  const tags = Array.from(
    new Set(
      [
        ...(body.tags ?? []),
        "project-publish",
        `snapshot:${artifact.snapshot}`,
      ].filter(Boolean),
    ),
  );
  const size_gb =
    artifact.size_bytes != null
      ? Number((artifact.size_bytes / 1_000_000_000).toFixed(3))
      : undefined;
  const { image_id, entry } = await upsertRootfsRow({
    account_id,
    body: {
      image: artifact.image,
      label: body.label,
      description: body.description,
      visibility: body.visibility,
      arch: artifact.arch,
      tags,
      theme: body.theme,
      official: body.official,
      prepull: body.prepull,
      hidden: body.hidden,
      size_gb,
    },
    digest: artifact.digest,
    content_key: artifact.content_key,
  });
  if (entry) {
    return entry;
  }
  const visibility = normalizeVisibility(body.visibility);
  return normalizeRootfsEntry(
    {
      id: image_id,
      label: body.label,
      image: artifact.image,
      description: body.description,
      digest: artifact.digest,
      arch: artifact.arch,
      visibility,
      official: false,
      prepull: false,
      hidden: body.hidden === true,
      size_gb,
      tags,
      theme: normalizeTheme(body.theme) ?? undefined,
      section: "mine",
      warning: "none",
      can_manage: true,
    },
    DEFAULT_ROOTFS_CATALOG_URL,
  );
}
