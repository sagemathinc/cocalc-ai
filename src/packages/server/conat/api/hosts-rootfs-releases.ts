/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Managed rootfs release helpers for hosts.

What belongs here:

- mapping managed rootfs images to central release lifecycle rows
- enriching host rootfs image listings with managed-release metadata
- managed rootfs artifact access and replica recording helpers

What does not belong here:

- generic host RPC entrypoints
- unrelated host lifecycle operations
- host response parsing outside rootfs image enrichment

`hosts.ts` keeps the surrounding host API surface while this module owns the
managed rootfs release lookup and enrichment logic.
*/

import type {
  HostManagedRootfsReleaseLifecycle,
  HostRootfsImage,
} from "@cocalc/conat/hub/api/hosts";
import getPool from "@cocalc/database/pool";
import {
  issueRootfsReleaseArtifactAccess,
  recordManagedRootfsRusticReplica,
} from "@cocalc/server/rootfs/releases";
import {
  isManagedRootfsImageName,
  type RootfsReleaseGcStatus,
  type RootfsUploadedArtifactResult,
} from "@cocalc/util/rootfs-images";

type RootfsReleaseLifecycleRow = {
  release_id: string;
  runtime_image: string;
  gc_status: RootfsReleaseGcStatus | null;
};

function pool() {
  return getPool();
}

export async function loadRootfsReleaseLifecycleByImage(
  images: string[],
): Promise<Map<string, RootfsReleaseLifecycleRow>> {
  const managedImages = Array.from(
    new Set(images.filter((image) => isManagedRootfsImageName(image))),
  );
  if (managedImages.length === 0) {
    return new Map();
  }
  const { rows } = await pool().query<RootfsReleaseLifecycleRow>(
    `SELECT release_id, runtime_image, gc_status
     FROM rootfs_releases
     WHERE runtime_image = ANY($1::TEXT[])`,
    [managedImages],
  );
  return new Map(
    rows.map((row) => [
      `${row.runtime_image ?? ""}`.trim(),
      {
        ...row,
        runtime_image: `${row.runtime_image ?? ""}`.trim(),
        gc_status: row.gc_status ?? "active",
      },
    ]),
  );
}

export async function enrichHostRootfsImages(
  entries: HostRootfsImage[],
): Promise<HostRootfsImage[]> {
  const lifecycleByImage = await loadRootfsReleaseLifecycleByImage(
    entries.map((entry) => entry.image),
  );
  return entries.map((entry) => {
    const lifecycle = lifecycleByImage.get(`${entry.image ?? ""}`.trim());
    const managed = isManagedRootfsImageName(entry.image);
    const release_gc_status = lifecycle?.gc_status ?? undefined;
    const centrally_deleted = release_gc_status === "deleted";
    const host_gc_eligible =
      centrally_deleted &&
      (entry.project_count ?? 0) === 0 &&
      (entry.running_project_count ?? 0) === 0;
    return {
      ...entry,
      managed,
      release_id: lifecycle?.release_id ?? entry.release_id,
      release_gc_status,
      centrally_deleted,
      host_gc_eligible,
    };
  });
}

export async function getManagedRootfsReleaseArtifactInternal({
  host_id,
  image,
}: {
  host_id: string;
  image: string;
}) {
  return await issueRootfsReleaseArtifactAccess({
    host_id,
    image,
  });
}

export async function recordManagedRootfsReleaseReplicaInternal({
  image,
  upload,
}: {
  image: string;
  upload: Extract<RootfsUploadedArtifactResult, { backend: "rustic" }>;
}) {
  return await recordManagedRootfsRusticReplica({ image, upload });
}

export async function listManagedRootfsReleaseLifecycleInternal({
  images,
}: {
  images: string[];
}): Promise<HostManagedRootfsReleaseLifecycle[]> {
  const lifecycleByImage = await loadRootfsReleaseLifecycleByImage(
    images ?? [],
  );
  return Array.from(lifecycleByImage.values()).map((row) => ({
    image: row.runtime_image,
    release_id: row.release_id,
    gc_status: row.gc_status ?? undefined,
  }));
}
