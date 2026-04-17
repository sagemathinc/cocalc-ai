/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Host drain and project-placement mutation helpers.

What belongs here:

- validating host drain parallelism and authorization-specific limits
- resolving which account should move a project during host drain
- the side-effecting drain execution flow, including force-unassign and
  move-to-destination behavior

What does not belong here:

- public host API/LRO entrypoints
- unrelated host lifecycle operations
- host listing or normalization logic

`hosts.ts` keeps the public wrappers while this module owns the project
placement mutation logic used by host drain.
*/

import type { HostDrainResult } from "@cocalc/conat/hub/api/hosts";
import getPool from "@cocalc/database/pool";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { notifyProjectHostUpdate } from "@cocalc/server/conat/route-project";
import { moveProjectToHost } from "@cocalc/server/projects/move";

function pool() {
  return getPool();
}

export function parseDrainParallelInternal(
  parallel: number | undefined,
  defaultParallel: number,
): number {
  if (parallel == null) {
    return defaultParallel;
  }
  const n = Math.floor(Number(parallel));
  if (!Number.isFinite(n) || n < 1) {
    throw new Error("drain parallel must be a positive integer");
  }
  return n;
}

export async function resolveDrainParallelInternal({
  owner,
  parallel,
  defaultParallel,
  ownerMaxParallel,
}: {
  owner: string;
  parallel?: number;
  defaultParallel: number;
  ownerMaxParallel: number;
}): Promise<number> {
  const requested = parseDrainParallelInternal(parallel, defaultParallel);
  if (!(await isAdmin(owner)) && requested > ownerMaxParallel) {
    throw new Error(
      `drain parallel cannot exceed ${ownerMaxParallel} for non-admin users`,
    );
  }
  return requested;
}

async function resolveDrainMoveAccount({
  project_id,
  fallback_account_id,
}: {
  project_id: string;
  fallback_account_id: string;
}): Promise<string> {
  const { rows } = await pool().query<{ account_id: string }>(
    `
      SELECT u.key AS account_id
      FROM projects p
      JOIN LATERAL jsonb_each(COALESCE(p.users, '{}'::jsonb)) u(key, value) ON true
      WHERE p.project_id=$1
        AND p.deleted IS NOT true
        AND (u.value ->> 'group') IN ('owner', 'collaborator')
      ORDER BY
        CASE (u.value ->> 'group')
          WHEN 'owner' THEN 0
          WHEN 'collaborator' THEN 1
          ELSE 2
        END,
        u.key
      LIMIT 1
    `,
    [project_id],
  );
  const account_id = `${rows[0]?.account_id ?? ""}`.trim();
  return account_id || fallback_account_id;
}

async function loadProjectIdsAssignedToHost(
  host_id: string,
): Promise<string[]> {
  const { rows } = await pool().query<{ project_id: string }>(
    `
      SELECT project_id
      FROM projects
      WHERE host_id=$1
        AND deleted IS NOT true
      ORDER BY COALESCE(last_edited, created) DESC NULLS LAST, project_id DESC
    `,
    [host_id],
  );
  return rows.map((row) => row.project_id);
}

export async function loadHostForDrainInternal({
  id,
  owner,
}: {
  id: string;
  owner: string;
}): Promise<any> {
  const { rows } = await pool().query(
    `SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("host not found");
  }
  if (await isAdmin(owner)) {
    return row;
  }
  if (row.metadata?.owner && row.metadata.owner !== owner) {
    throw new Error("not authorized");
  }
  return row;
}

export async function drainHostInternalHelper({
  owner,
  id,
  dest_host_id,
  force,
  allow_offline,
  parallel,
  defaultParallel,
  ownerMaxParallel,
  loadHostForListing,
  shouldCancel,
  onProgress,
}: {
  owner: string;
  id: string;
  dest_host_id?: string;
  force?: boolean;
  allow_offline?: boolean;
  parallel?: number;
  defaultParallel: number;
  ownerMaxParallel: number;
  loadHostForListing: (id: string, account_id?: string) => Promise<any>;
  shouldCancel?: () => Promise<boolean>;
  onProgress?: (update: {
    message: string;
    detail?: Record<string, any>;
    progress?: number;
  }) => Promise<void> | void;
}): Promise<HostDrainResult> {
  const row = await loadHostForDrainInternal({ id, owner });
  const drainParallel = await resolveDrainParallelInternal({
    owner,
    parallel,
    defaultParallel,
    ownerMaxParallel,
  });
  const destination = `${dest_host_id ?? ""}`.trim() || undefined;
  if (destination === row.id) {
    throw new Error("destination host must differ from source host");
  }
  if (destination) {
    await loadHostForListing(destination, owner);
  }

  const projectIds = await loadProjectIdsAssignedToHost(row.id);
  const total = projectIds.length;
  const resultBase = {
    host_id: row.id,
    mode: force ? "force" : "move",
    total,
    moved: 0,
    unassigned: 0,
    failed: 0,
    parallel: drainParallel,
    ...(destination ? { dest_host_id: destination } : {}),
  } satisfies HostDrainResult;

  if (!total) {
    await onProgress?.({
      message: "host already drained",
      detail: { host_id: row.id, total: 0 },
      progress: 100,
    });
    return resultBase;
  }

  const canceled = async () => {
    if (!shouldCancel) return false;
    return await shouldCancel();
  };

  if (force) {
    if (await canceled()) {
      throw new Error("host drain canceled");
    }
    await onProgress?.({
      message: "force-unassigning workspaces",
      detail: { host_id: row.id, total },
      progress: 20,
    });
    const { rows } = await pool().query<{ project_id: string }>(
      `
        UPDATE projects
        SET host_id=NULL
        WHERE host_id=$1
          AND deleted IS NOT true
        RETURNING project_id
      `,
      [row.id],
    );
    for (const moved of rows) {
      await notifyProjectHostUpdate({ project_id: moved.project_id });
    }
    await onProgress?.({
      message: "force-unassign complete",
      detail: { host_id: row.id, total, unassigned: rows.length },
      progress: 100,
    });
    return {
      ...resultBase,
      unassigned: rows.length,
      failed: Math.max(0, total - rows.length),
    };
  }

  const maxParallel = Math.max(1, Math.min(drainParallel, total));
  let moved = 0;
  let completed = 0;
  let nextIndex = 0;
  let firstError: Error | undefined;

  await onProgress?.({
    message: "starting host drain",
    detail: {
      host_id: row.id,
      total,
      parallel: maxParallel,
      dest_host_id: destination,
    },
    progress: 5,
  });

  const worker = async () => {
    while (true) {
      if (firstError) return;
      if (await canceled()) {
        firstError = new Error("host drain canceled");
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) return;
      const project_id = projectIds[index];
      try {
        const moveAccountId = await resolveDrainMoveAccount({
          project_id,
          fallback_account_id: owner,
        });
        await moveProjectToHost(
          {
            project_id,
            account_id: moveAccountId,
            dest_host_id: destination,
            allow_offline: !!allow_offline,
            start_dest: true,
            stop_dest_after_start: true,
          },
          { shouldCancel },
        );
        moved += 1;
        completed += 1;
        const started = Math.min(total, nextIndex);
        const in_flight = Math.max(0, started - completed);
        await onProgress?.({
          message: `drained ${completed}/${total}`,
          detail: {
            host_id: row.id,
            project_id,
            moved,
            completed,
            total,
            parallel: maxParallel,
            in_flight,
            dest_host_id: destination,
          },
          progress: Math.min(
            95,
            Math.max(5, Math.round((completed / total) * 95)),
          ),
        });
      } catch (err) {
        completed += 1;
        if (await canceled()) {
          firstError = new Error("host drain canceled");
        } else if (!firstError) {
          firstError = new Error(
            `failed to drain workspace ${project_id}: ${
              err instanceof Error ? err.message : `${err}`
            }`,
          );
        }
        await onProgress?.({
          message: "host drain failed",
          detail: {
            host_id: row.id,
            project_id,
            completed,
            total,
            parallel: maxParallel,
            error: `${err}`,
          },
          progress: Math.min(
            95,
            Math.max(5, Math.round((completed / total) * 95)),
          ),
        });
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: maxParallel }, () => worker()));

  if (firstError) {
    throw firstError;
  }

  await onProgress?.({
    message: "host drain complete",
    detail: {
      host_id: row.id,
      total,
      moved,
      parallel: maxParallel,
      dest_host_id: destination,
    },
    progress: 100,
  });
  return {
    ...resultBase,
    moved,
    failed: Math.max(0, total - moved),
  };
}
