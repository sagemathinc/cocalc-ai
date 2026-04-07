/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getNames } from "@cocalc/server/accounts/get-name";
import type {
  ProjectRootfsStateEntry,
  ProjectRootfsStateRole,
} from "@cocalc/util/rootfs-images";
import { isManagedRootfsImageName } from "@cocalc/util/rootfs-images";
import { publishProjectDetailInvalidationBestEffort } from "@cocalc/server/account/project-detail-feed";

type RootfsStateRow = {
  project_id: string;
  state_role: ProjectRootfsStateRole;
  runtime_image: string;
  release_id: string | null;
  image_id: string | null;
  set_by_account_id: string | null;
  created: Date | null;
  updated: Date | null;
};

type ProjectRootfsBinding = {
  image: string;
  image_id?: string;
  release_id?: string;
};

type ProjectRow = {
  rootfs_image: string | null;
  rootfs_image_id: string | null;
};

function trimString(value?: string | null): string | undefined {
  const next = `${value ?? ""}`.trim();
  return next.length > 0 ? next : undefined;
}

function toEntry(
  row: RootfsStateRow,
  set_by_name?: string,
): ProjectRootfsStateEntry {
  return {
    project_id: row.project_id,
    state_role: row.state_role,
    image: row.runtime_image,
    release_id: trimString(row.release_id),
    image_id: trimString(row.image_id),
    set_by_account_id: trimString(row.set_by_account_id),
    set_by_name,
    created_at: row.created?.toISOString(),
    updated_at: row.updated?.toISOString(),
  };
}

async function resolveManagedBinding({
  image,
  image_id,
}: {
  image: string;
  image_id?: string;
}): Promise<ProjectRootfsBinding> {
  const pool = getPool("medium");
  const runtimeImage = trimString(image);
  if (!runtimeImage) {
    throw new Error("rootfs image is required");
  }
  const catalogId = trimString(image_id);
  if (catalogId) {
    const { rows } = await pool.query<{
      runtime_image: string;
      release_id: string | null;
    }>(
      `SELECT runtime_image, release_id
       FROM rootfs_images
       WHERE image_id=$1
       LIMIT 1`,
      [catalogId],
    );
    const row = rows[0];
    if (row) {
      return {
        image: trimString(row.runtime_image) ?? runtimeImage,
        image_id: catalogId,
        release_id: trimString(row.release_id),
      };
    }
  }
  const { rows } = await pool.query<{
    release_id: string | null;
  }>(
    `SELECT release_id
     FROM rootfs_images
     WHERE runtime_image=$1
     ORDER BY
       COALESCE(deleted, false) ASC,
       COALESCE(official, false) DESC,
       updated DESC
     LIMIT 1`,
    [runtimeImage],
  );
  if (rows[0]?.release_id) {
    return {
      image: runtimeImage,
      image_id: catalogId,
      release_id: trimString(rows[0].release_id),
    };
  }
  const releaseRows = await pool.query<{
    release_id: string;
  }>(
    `SELECT release_id
     FROM rootfs_releases
     WHERE runtime_image=$1
       AND COALESCE(gc_status, 'active') <> 'deleted'
     ORDER BY updated DESC
    LIMIT 1`,
    [runtimeImage],
  );
  const releaseId = trimString(releaseRows.rows[0]?.release_id);
  if (isManagedRootfsImageName(runtimeImage) && !releaseId) {
    throw new Error(
      `managed RootFS image '${runtimeImage}' has no registered release`,
    );
  }
  return {
    image: runtimeImage,
    image_id: catalogId,
    release_id: releaseId,
  };
}

async function loadProjectRootfsStateRows(
  project_id: string,
): Promise<RootfsStateRow[]> {
  const pool = getPool("medium");
  const { rows } = await pool.query<RootfsStateRow>(
    `SELECT
      project_id,
      state_role,
      runtime_image,
      release_id,
      image_id,
      set_by_account_id,
      created,
      updated
     FROM project_rootfs_states
     WHERE project_id=$1
     ORDER BY CASE state_role WHEN 'current' THEN 0 ELSE 1 END`,
    [project_id],
  );
  return rows;
}

async function loadProjectRootfsStateEntries(
  project_id: string,
): Promise<ProjectRootfsStateEntry[]> {
  const rows = await loadProjectRootfsStateRows(project_id);
  const hasCurrent = rows.some((row) => row.state_role === "current");
  if (!hasCurrent) {
    const projectRow = await loadProjectRow(project_id);
    const runtimeImage = trimString(projectRow?.rootfs_image);
    if (runtimeImage) {
      const binding = await resolveManagedBinding({
        image: runtimeImage,
        image_id: trimString(projectRow?.rootfs_image_id),
      });
      rows.unshift({
        project_id,
        state_role: "current",
        runtime_image: binding.image,
        release_id: binding.release_id ?? null,
        image_id: binding.image_id ?? null,
        set_by_account_id: null,
        created: null,
        updated: null,
      });
    }
  }
  const accountIds = Array.from(
    new Set(
      rows
        .map((row) => trimString(row.set_by_account_id))
        .filter((value): value is string => !!value),
    ),
  );
  const names = accountIds.length > 0 ? await getNames(accountIds) : {};
  return rows.map((row) =>
    toEntry(
      row,
      row.set_by_account_id
        ? [
            names[row.set_by_account_id]?.first_name,
            names[row.set_by_account_id]?.last_name,
          ]
            .filter(Boolean)
            .join(" ")
            .trim() || undefined
        : undefined,
    ),
  );
}

async function loadProjectRow(
  project_id: string,
): Promise<ProjectRow | undefined> {
  const { rows } = await getPool("medium").query<ProjectRow>(
    `SELECT rootfs_image, rootfs_image_id
     FROM projects
     WHERE project_id=$1`,
    [project_id],
  );
  return rows[0];
}

function bindingsEqual(
  a?: ProjectRootfsBinding,
  b?: ProjectRootfsBinding,
): boolean {
  return (
    trimString(a?.image) === trimString(b?.image) &&
    trimString(a?.image_id) === trimString(b?.image_id)
  );
}

export async function getProjectRootfsStates({
  project_id,
}: {
  project_id: string;
}): Promise<ProjectRootfsStateEntry[]> {
  return await loadProjectRootfsStateEntries(project_id);
}

export async function getCurrentProjectRootfsBinding({
  project_id,
}: {
  project_id: string;
}): Promise<ProjectRootfsBinding | undefined> {
  const rows = await loadProjectRootfsStateRows(project_id);
  const currentRow = rows.find((row) => row.state_role === "current");
  if (currentRow) {
    return {
      image: currentRow.runtime_image,
      image_id: trimString(currentRow.image_id),
      release_id: trimString(currentRow.release_id),
    };
  }
  const projectRow = await loadProjectRow(project_id);
  const image = trimString(projectRow?.rootfs_image);
  if (!image) {
    return undefined;
  }
  const image_id = trimString(projectRow?.rootfs_image_id);
  if (isManagedRootfsImageName(image) || image_id) {
    return await resolveManagedBinding({ image, image_id });
  }
  return { image, image_id };
}

export async function assertPortableProjectRootfs({
  project_id,
  operation,
}: {
  project_id: string;
  operation: "backup" | "move";
}): Promise<void> {
  const current = await getCurrentProjectRootfsBinding({ project_id });
  const image = trimString(current?.image);
  if (!image) {
    return;
  }
  if (trimString(current?.release_id)) {
    return;
  }
  throw new Error(
    `cannot ${operation} project while its RootFS is still backed by unsealed OCI image '${image}'; publish the current RootFS first so the project uses an immutable managed artifact`,
  );
}

export async function replaceProjectRootfsStates({
  project_id,
  current,
  previous,
}: {
  project_id: string;
  current?: ProjectRootfsBinding;
  previous?: ProjectRootfsBinding;
}): Promise<ProjectRootfsStateEntry[]> {
  const pool = getPool("medium");
  const currentBinding =
    current && trimString(current.image)
      ? await resolveManagedBinding(current)
      : undefined;
  const previousBinding =
    previous && trimString(previous.image)
      ? await resolveManagedBinding(previous)
      : undefined;
  await pool.query("BEGIN");
  try {
    await pool.query("DELETE FROM project_rootfs_states WHERE project_id=$1", [
      project_id,
    ]);
    if (currentBinding) {
      await pool.query(
        `INSERT INTO project_rootfs_states
         (project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)
         VALUES ($1, 'current', $2, $3, $4, NULL, NOW(), NOW())`,
        [
          project_id,
          currentBinding.image,
          currentBinding.release_id ?? null,
          currentBinding.image_id ?? null,
        ],
      );
      await pool.query(
        `UPDATE projects
         SET rootfs_image=$2,
             rootfs_image_id=$3
         WHERE project_id=$1`,
        [project_id, currentBinding.image, currentBinding.image_id ?? null],
      );
    }
    if (previousBinding) {
      await pool.query(
        `INSERT INTO project_rootfs_states
         (project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)
         VALUES ($1, 'previous', $2, $3, $4, NULL, NOW(), NOW())`,
        [
          project_id,
          previousBinding.image,
          previousBinding.release_id ?? null,
          previousBinding.image_id ?? null,
        ],
      );
    }
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["rootfs"],
  });
  return await loadProjectRootfsStateEntries(project_id);
}

export async function initializeProjectRootfsStates({
  project_id,
  image,
  image_id,
  set_by_account_id,
}: {
  project_id: string;
  image?: string | null;
  image_id?: string | null;
  set_by_account_id?: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const runtimeImage = trimString(image);
  if (!runtimeImage) {
    return [];
  }
  const binding = await resolveManagedBinding({
    image: runtimeImage,
    image_id: trimString(image_id),
  });
  const pool = getPool("medium");
  await pool.query(
    `INSERT INTO project_rootfs_states
     (project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)
     VALUES ($1, 'current', $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (project_id, state_role) DO UPDATE
     SET runtime_image=EXCLUDED.runtime_image,
         release_id=EXCLUDED.release_id,
         image_id=EXCLUDED.image_id,
         set_by_account_id=COALESCE(EXCLUDED.set_by_account_id, project_rootfs_states.set_by_account_id),
         updated=NOW()`,
    [
      project_id,
      binding.image,
      binding.release_id ?? null,
      binding.image_id ?? null,
      trimString(set_by_account_id) ?? null,
    ],
  );
  return await loadProjectRootfsStateEntries(project_id);
}

export async function cloneProjectRootfsStates({
  project_id,
  src_project_id,
}: {
  project_id: string;
  src_project_id: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const pool = getPool("medium");
  const result = await pool.query(
    `INSERT INTO project_rootfs_states
     (project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)
     SELECT $1, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated
     FROM project_rootfs_states
     WHERE project_id=$2
     ON CONFLICT (project_id, state_role) DO UPDATE
     SET runtime_image=EXCLUDED.runtime_image,
         release_id=EXCLUDED.release_id,
         image_id=EXCLUDED.image_id,
         set_by_account_id=EXCLUDED.set_by_account_id,
         created=EXCLUDED.created,
         updated=EXCLUDED.updated`,
    [project_id, src_project_id],
  );
  if (result.rowCount === 0) {
    const projectRow = await loadProjectRow(project_id);
    return await initializeProjectRootfsStates({
      project_id,
      image: projectRow?.rootfs_image,
      image_id: projectRow?.rootfs_image_id,
    });
  }
  return await loadProjectRootfsStateEntries(project_id);
}

export async function setProjectRootfsImageWithRollback({
  project_id,
  image,
  image_id,
  set_by_account_id,
}: {
  project_id: string;
  image: string;
  image_id?: string;
  set_by_account_id?: string;
}): Promise<ProjectRootfsStateEntry[]> {
  const next = await resolveManagedBinding({ image, image_id });
  const existingRows = await loadProjectRootfsStateRows(project_id);
  const currentRow = existingRows.find((row) => row.state_role === "current");
  const previousRow = existingRows.find((row) => row.state_role === "previous");
  const projectRow = await loadProjectRow(project_id);
  const legacyCurrent =
    !currentRow && trimString(projectRow?.rootfs_image)
      ? await resolveManagedBinding({
          image: trimString(projectRow?.rootfs_image)!,
          image_id: trimString(projectRow?.rootfs_image_id),
        })
      : undefined;
  const currentBinding: ProjectRootfsBinding | undefined = currentRow
    ? {
        image: currentRow.runtime_image,
        image_id: trimString(currentRow.image_id),
        release_id: trimString(currentRow.release_id),
      }
    : legacyCurrent;
  const previousBinding: ProjectRootfsBinding | undefined = previousRow
    ? {
        image: previousRow.runtime_image,
        image_id: trimString(previousRow.image_id),
        release_id: trimString(previousRow.release_id),
      }
    : undefined;

  const pool = getPool("medium");
  await pool.query("BEGIN");
  try {
    if (bindingsEqual(currentBinding, next)) {
      await pool.query(
        `INSERT INTO project_rootfs_states
         (project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)
         VALUES ($1, 'current', $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (project_id, state_role) DO UPDATE
         SET runtime_image=EXCLUDED.runtime_image,
             release_id=EXCLUDED.release_id,
             image_id=EXCLUDED.image_id,
             set_by_account_id=EXCLUDED.set_by_account_id,
             updated=NOW()`,
        [
          project_id,
          next.image,
          next.release_id ?? null,
          next.image_id ?? null,
          trimString(set_by_account_id) ?? null,
        ],
      );
      await pool.query(
        `UPDATE projects
         SET rootfs_image=$2,
             rootfs_image_id=$3
         WHERE project_id=$1`,
        [project_id, next.image, next.image_id ?? null],
      );
    } else {
      await pool.query(
        "DELETE FROM project_rootfs_states WHERE project_id=$1 AND state_role='previous'",
        [project_id],
      );
      if (currentBinding?.image) {
        await pool.query(
          `INSERT INTO project_rootfs_states
           (project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)
           VALUES ($1, 'previous', $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (project_id, state_role) DO UPDATE
           SET runtime_image=EXCLUDED.runtime_image,
               release_id=EXCLUDED.release_id,
               image_id=EXCLUDED.image_id,
               set_by_account_id=$5,
               updated=NOW()`,
          [
            project_id,
            currentBinding.image,
            currentBinding.release_id ?? null,
            currentBinding.image_id ?? null,
            trimString(currentRow?.set_by_account_id) ?? null,
          ],
        );
      }
      await pool.query(
        `INSERT INTO project_rootfs_states
         (project_id, state_role, runtime_image, release_id, image_id, set_by_account_id, created, updated)
         VALUES ($1, 'current', $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (project_id, state_role) DO UPDATE
         SET runtime_image=EXCLUDED.runtime_image,
             release_id=EXCLUDED.release_id,
             image_id=EXCLUDED.image_id,
             set_by_account_id=EXCLUDED.set_by_account_id,
             created=EXCLUDED.created,
             updated=NOW()`,
        [
          project_id,
          next.image,
          next.release_id ?? null,
          next.image_id ?? null,
          trimString(set_by_account_id) ?? null,
        ],
      );
      await pool.query(
        `UPDATE projects
         SET rootfs_image=$2,
             rootfs_image_id=$3
         WHERE project_id=$1`,
        [project_id, next.image, next.image_id ?? null],
      );
    }
    if (!previousBinding && !currentBinding?.image) {
      await pool.query(
        "DELETE FROM project_rootfs_states WHERE project_id=$1 AND state_role='previous'",
        [project_id],
      );
    }
    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
  }
  await publishProjectDetailInvalidationBestEffort({
    project_id,
    fields: ["rootfs"],
  });
  return await loadProjectRootfsStateEntries(project_id);
}
