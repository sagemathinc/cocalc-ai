/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import {
  normalizePublicDirectoryShareSlug,
  repairMigratedLegacyPublicDirectoryShareSlug,
} from "@cocalc/server/public-directory-shares";
import {
  clean,
  legacyPublicPathSlugForRecord,
  normalizeLegacyPublicPathDescription,
} from "@cocalc/server/legacy-migration/public-path-slugs";

type Options = {
  apply: boolean;
  limit?: number;
  legacyProjectId?: string;
  legacyPublicPathId?: string;
  onlyImportedShares?: boolean;
};

type RepairRow = {
  legacy_id: string;
  payload: Record<string, any>;
  share_id: string | null;
  share_slug: string | null;
  share_description: string | null;
};

let poolUsed = false;

function pool() {
  poolUsed = true;
  return getPool();
}

function usage(): never {
  console.log(`Usage:
  node packages/server/dist/legacy-migration/repair-public-path-slugs.js [options]

Options:
  --apply                       Write changes. Default is dry-run.
  --limit <n>                   Stop after scanning n legacy public_paths rows.
  --legacy-project-id <uuid>    Restrict to one legacy project.
  --legacy-public-path-id <id>  Restrict to one legacy public_paths.id.
  --only-imported-shares        Only scan rows with an imported public_project_paths row.
  --help                        Show this help.
`);
  process.exit(0);
}

function positiveInt(value: string, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function isSlugTakenError(err: unknown): boolean {
  return `${(err as Error | undefined)?.message ?? err}`.includes(
    "already taken",
  );
}

function isInvalidSlugError(err: unknown): boolean {
  return `${(err as Error | undefined)?.message ?? err}`.includes("slug must");
}

function duplicateSlugFallbackValue(
  slug: string,
  legacyPublicPathId: string,
): string {
  return `${slug}~${legacyPublicPathId.slice(0, 10)}`;
}

function duplicateSlugFallback(
  slug: string,
  legacyPublicPathId: string,
): string {
  return normalizePublicDirectoryShareSlug(
    duplicateSlugFallbackValue(slug, legacyPublicPathId),
  );
}

function parseArgs(argv: string[]): Options {
  const options: Options = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--only-imported-shares") {
      options.onlyImportedShares = true;
      continue;
    }
    const value = argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    if (arg === "--limit") {
      options.limit = positiveInt(value, "--limit");
    } else if (arg === "--legacy-project-id") {
      options.legacyProjectId = value.trim();
    } else if (arg === "--legacy-public-path-id") {
      options.legacyPublicPathId = value.trim();
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

async function rowsToRepair(options: Options): Promise<RepairRow[]> {
  const params: unknown[] = [];
  const clauses = ["raw.source='public_paths'"];
  if (options.legacyProjectId) {
    params.push(options.legacyProjectId);
    clauses.push(`raw.payload->>'project_id'=$${params.length}`);
  }
  if (options.legacyPublicPathId) {
    params.push(options.legacyPublicPathId);
    clauses.push(
      `(raw.legacy_id=$${params.length} OR raw.payload->>'id'=$${params.length})`,
    );
  }
  if (options.onlyImportedShares) {
    clauses.push("shares.id IS NOT NULL");
  }
  const limitClause =
    options.limit == null ? "" : `LIMIT ${Math.floor(options.limit)}`;
  const { rows } = await pool().query<RepairRow>(
    `
      SELECT raw.legacy_id,
             raw.payload,
             shares.id AS share_id,
             shares.slug AS share_slug,
             shares.description AS share_description
        FROM legacy_migration_raw_records raw
        LEFT JOIN public_project_paths shares
          ON shares.legacy_public_path_id=COALESCE(raw.payload->>'id', raw.legacy_id)
       WHERE ${clauses.join(" AND ")}
       ORDER BY raw.payload->>'project_id', raw.legacy_id
       ${limitClause}
    `,
    params,
  );
  return rows;
}

async function updateRawPayloadSlug({
  legacy_id,
  slug,
}: {
  legacy_id: string;
  slug: string;
}): Promise<void> {
  await pool().query(
    `
      UPDATE legacy_migration_raw_records
         SET payload=jsonb_set(payload, '{slug}', to_jsonb($2::text), true),
             updated=NOW()
       WHERE source='public_paths'
         AND legacy_id=$1
    `,
    [legacy_id, slug],
  );
}

async function updateRawPayloadDescription({
  legacy_id,
  description,
}: {
  legacy_id: string;
  description: string | null;
}): Promise<void> {
  await pool().query(
    description == null
      ? `
      UPDATE legacy_migration_raw_records
         SET payload=payload - 'description',
             updated=NOW()
       WHERE source='public_paths'
         AND legacy_id=$1
    `
      : `
      UPDATE legacy_migration_raw_records
         SET payload=jsonb_set(payload, '{description}', to_jsonb($2::text), true),
             updated=NOW()
       WHERE source='public_paths'
         AND legacy_id=$1
    `,
    description == null ? [legacy_id] : [legacy_id, description],
  );
}

async function updateShareDescription({
  share_id,
  description,
}: {
  share_id: string;
  description: string | null;
}): Promise<void> {
  await pool().query(
    `
      UPDATE public_project_paths
         SET description=$2,
             updated_at=NOW()
       WHERE id=$1
    `,
    [share_id, description],
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rows = await rowsToRepair(options);
  let rawChanged = 0;
  let shareChanged = 0;
  let descriptionChanged = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const legacyPublicPathId = clean(row.payload.id) ?? row.legacy_id;
    let nextSlug: string | null;
    try {
      nextSlug = await legacyPublicPathSlugForRecord(row.payload, pool());
    } catch (err) {
      if (isInvalidSlugError(err)) {
        skipped += 1;
        console.warn(
          `skipping legacy_public_path=${legacyPublicPathId}: ${err}`,
        );
      } else {
        failed += 1;
        console.error(
          `failed to compute slug for legacy_public_path=${legacyPublicPathId}: ${err}`,
        );
      }
      continue;
    }
    if (!nextSlug || !legacyPublicPathId) {
      skipped += 1;
      continue;
    }
    const payloadSlug = clean(row.payload.slug);
    const fallbackSlug = duplicateSlugFallbackValue(
      nextSlug,
      legacyPublicPathId,
    );
    const usesDuplicateFallback =
      payloadSlug === fallbackSlug && row.share_slug === fallbackSlug;
    let needsRawUpdate = payloadSlug !== nextSlug;
    let needsShareUpdate = row.share_id != null && row.share_slug !== nextSlug;
    const rawDescription = clean(row.payload.description) ?? null;
    const nextDescription =
      normalizeLegacyPublicPathDescription(row.payload.description) ?? null;
    const needsRawDescriptionUpdate = rawDescription !== nextDescription;
    const needsShareDescriptionUpdate =
      row.share_id != null &&
      row.share_description === rawDescription &&
      row.share_description !== nextDescription;
    if (usesDuplicateFallback) {
      needsRawUpdate = false;
      needsShareUpdate = false;
    }
    if (
      !needsRawUpdate &&
      !needsShareUpdate &&
      !needsRawDescriptionUpdate &&
      !needsShareDescriptionUpdate
    ) {
      unchanged += 1;
      continue;
    }
    const changes: string[] = [];
    if (needsRawUpdate || needsShareUpdate) {
      changes.push(
        `slug ${payloadSlug ?? "(none)"} -> ${nextSlug}${row.share_slug ? `; share ${row.share_slug} -> ${nextSlug}` : ""}`,
      );
    }
    if (needsRawDescriptionUpdate || needsShareDescriptionUpdate) {
      changes.push("description escaped newlines -> real newlines");
    }
    console.log(
      `${options.apply ? "repair" : "dry-run"} legacy_public_path=${legacyPublicPathId} ${changes.join("; ")}`,
    );
    if (!options.apply) {
      if (needsRawUpdate) rawChanged += 1;
      if (needsShareUpdate) shareChanged += 1;
      if (needsRawDescriptionUpdate || needsShareDescriptionUpdate) {
        descriptionChanged += 1;
      }
      continue;
    }
    try {
      let slugToWrite = nextSlug;
      if (needsShareUpdate) {
        try {
          await repairMigratedLegacyPublicDirectoryShareSlug({
            id: row.share_id,
            legacy_public_path_id: legacyPublicPathId,
            slug: nextSlug,
            legacy_url: clean(row.payload.url) ?? null,
          });
        } catch (err) {
          if (!isSlugTakenError(err)) {
            throw err;
          }
          slugToWrite = duplicateSlugFallback(nextSlug, legacyPublicPathId);
          console.warn(
            `slug conflict for legacy_public_path=${legacyPublicPathId}; retrying with ${slugToWrite}`,
          );
          await repairMigratedLegacyPublicDirectoryShareSlug({
            id: row.share_id,
            legacy_public_path_id: legacyPublicPathId,
            slug: slugToWrite,
            legacy_url: clean(row.payload.url) ?? null,
          });
        }
        shareChanged += 1;
      }
      if (needsRawUpdate || slugToWrite !== nextSlug) {
        await updateRawPayloadSlug({
          legacy_id: row.legacy_id,
          slug: slugToWrite,
        });
        rawChanged += 1;
      }
      if (needsShareDescriptionUpdate && row.share_id) {
        await updateShareDescription({
          share_id: row.share_id,
          description: nextDescription,
        });
      }
      if (needsRawDescriptionUpdate) {
        await updateRawPayloadDescription({
          legacy_id: row.legacy_id,
          description: nextDescription,
        });
      }
      if (needsRawDescriptionUpdate || needsShareDescriptionUpdate) {
        descriptionChanged += 1;
      }
    } catch (err) {
      failed += 1;
      console.error(
        `failed to repair legacy_public_path=${legacyPublicPathId}: ${err}`,
      );
    }
  }
  console.log(
    `done: scanned=${rows.length} raw_changed=${rawChanged} share_changed=${shareChanged} description_changed=${descriptionChanged} unchanged=${unchanged} skipped=${skipped} failed=${failed}`,
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (poolUsed) {
      await getPool().end();
    }
    process.exit(process.exitCode ?? 0);
  });
