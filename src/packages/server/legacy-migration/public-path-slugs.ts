/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { normalizePublicDirectoryShareSlug } from "@cocalc/server/public-directory-shares";

type QueryClient = PoolClient | ReturnType<typeof getPool>;

let projectNameSchemaReady: Promise<void> | undefined;

export type LegacyPublicPathSlugContext = {
  owner_name?: string | null;
  project_name?: string | null;
};

export function clean(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = `${value}`.trim();
  return s ? s : undefined;
}

function normalizeSlug(raw: string): string {
  let slug = raw.trim();
  try {
    if (/^https?:\/\//i.test(slug)) {
      slug = new URL(slug).pathname;
    }
  } catch {
    // Fall through to path-style normalization below.
  }
  slug = slug.replace(/^\/+|\/+$/g, "");
  if (slug.toLowerCase().startsWith("share/")) {
    slug = slug.slice("share/".length);
  }
  return normalizePublicDirectoryShareSlug(slug);
}

export function legacyPublicPathSlugFromRecord(
  row: Record<string, any>,
  context: LegacyPublicPathSlugContext = {},
): string | null {
  const url = clean(row.url);
  if (url) {
    return normalizeSlug(url);
  }

  const ownerName = clean(context.owner_name);
  const projectName = clean(context.project_name);
  const shareName = clean(row.name) ?? clean(row.slug) ?? clean(row.path);
  if (ownerName && projectName && shareName) {
    return normalizeSlug(`${ownerName}/${projectName}/${shareName}`);
  }

  const raw =
    clean(row.slug) ??
    clean(row.name) ??
    (clean(row.project_id) && clean(row.path)
      ? `${clean(row.project_id)}/${clean(row.path)}`
      : undefined);
  return raw ? normalizeSlug(raw) : null;
}

export async function legacyPublicPathSlugContextForProject(
  legacy_project_id: string,
  client: QueryClient = getPool(),
): Promise<LegacyPublicPathSlugContext> {
  projectNameSchemaReady ??= client
    .query(
      `
      ALTER TABLE legacy_migration_projects
        ADD COLUMN IF NOT EXISTS name TEXT
    `,
    )
    .then(() => undefined);
  await projectNameSchemaReady;
  const { rows } = await client.query<{
    owner_name: string | null;
    project_name: string | null;
  }>(
    `
      SELECT accounts.metadata->>'name' AS owner_name,
             COALESCE(projects.name, projects.metadata->>'name') AS project_name
        FROM legacy_migration_projects projects
        LEFT JOIN legacy_migration_accounts accounts
          ON accounts.legacy_account_id=projects.owner_legacy_account_id
       WHERE projects.legacy_project_id=$1
       LIMIT 1
    `,
    [legacy_project_id],
  );
  return rows[0] ?? {};
}

export async function legacyPublicPathSlugForRecord(
  row: Record<string, any>,
  client: QueryClient = getPool(),
): Promise<string | null> {
  const legacyProjectId = clean(row.project_id);
  const context = legacyProjectId
    ? await legacyPublicPathSlugContextForProject(legacyProjectId, client)
    : {};
  return legacyPublicPathSlugFromRecord(row, context);
}
