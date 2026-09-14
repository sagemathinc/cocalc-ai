/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, { type PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { assertProjectNotRehoming } from "@cocalc/database/postgres/project-rehome-fence";
import type { TrustedCourseProjectQuoteContext } from "@cocalc/server/membership/packages";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import { isValidUUID } from "@cocalc/util/misc";

function sameOwnership(
  left: { bay_id: string; epoch: number } | null,
  right: { bay_id: string; epoch: number } | null,
): boolean {
  return (
    left != null &&
    right != null &&
    left.bay_id === right.bay_id &&
    left.epoch === right.epoch
  );
}

export async function resolveAdminCourseProjectQuoteContext({
  admin_account_id,
  product,
}: {
  admin_account_id: string;
  product: MembershipPackageProduct;
}): Promise<TrustedCourseProjectQuoteContext | undefined> {
  if (product.kind !== "course") return undefined;
  const projectId = `${product.course_project_id ?? ""}`.trim();
  if (!isValidUUID(projectId)) {
    throw Error("course_project_id is required for course packages");
  }
  const ownership = await resolveProjectBay(projectId);
  if (!ownership) throw Error("course project not found");

  let coursePath: string | undefined;
  let courseTitle: string | undefined;
  if (ownership.bay_id === getConfiguredBayId()) {
    const { rows } = await getPool().query<{
      title: string | null;
      course: { path?: string | null } | null;
    }>(
      `SELECT title, course
         FROM projects
        WHERE project_id=$1
          AND deleted IS NOT TRUE
        LIMIT 1`,
      [projectId],
    );
    if (!rows[0]) throw Error("course project not found");
    coursePath = `${rows[0].course?.path ?? ""}`.trim() || undefined;
    courseTitle = `${rows[0].title ?? ""}`.trim() || undefined;
  } else {
    const details = await getInterBayBridge()
      .projectDetails(ownership.bay_id)
      .get({
        account_id: admin_account_id,
        project_id: projectId,
        trusted_admin: true,
      });
    coursePath = `${details.course?.path ?? ""}`.trim() || undefined;
  }

  const currentOwnership = await resolveProjectBay(projectId);
  if (!sameOwnership(ownership, currentOwnership)) {
    throw Error("course project ownership changed while preparing the quote");
  }
  return {
    project_id: projectId,
    owning_bay_id: ownership.bay_id,
    ownership_epoch: ownership.epoch,
    course_path: coursePath,
    course_title: courseTitle,
  };
}

export async function resolveLockedLocalAdminCourseProjectQuoteContext({
  client,
  product,
}: {
  client: PoolClient;
  product: MembershipPackageProduct;
}): Promise<TrustedCourseProjectQuoteContext | undefined> {
  if (product.kind !== "course") return undefined;
  const projectId = `${product.course_project_id ?? ""}`.trim();
  if (!isValidUUID(projectId)) {
    throw Error("course_project_id is required for course packages");
  }
  await assertProjectNotRehoming({
    db: client,
    project_id: projectId,
    action: "create admin course membership package",
  });
  const localBayId = getConfiguredBayId();
  const { rows } = await client.query<{
    title: string | null;
    course: { path?: string | null } | null;
    owning_bay_id: string | null;
  }>(
    `SELECT title, course, owning_bay_id
       FROM projects
      WHERE project_id=$1
        AND deleted IS NOT TRUE
      FOR SHARE`,
    [projectId],
  );
  const row = rows[0];
  if (!row) throw Error("course project not found");
  const owningBayId = `${row.owning_bay_id ?? localBayId}`.trim();
  if (owningBayId !== localBayId) {
    throw Error(
      "cross-bay admin course purchases require a transactional project-ownership protocol",
    );
  }
  return {
    project_id: projectId,
    owning_bay_id: localBayId,
    ownership_epoch: 0,
    course_path: `${row.course?.path ?? ""}`.trim() || undefined,
    course_title: `${row.title ?? ""}`.trim() || undefined,
  };
}
