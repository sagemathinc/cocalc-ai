/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getSoftwareEnvironments } from "@cocalc/server/software-envs";
import { DEFAULT_COMPUTE_IMAGE } from "@cocalc/util/db-schema/defaults";
import { isValidUUID } from "@cocalc/util/misc";
import { v4 } from "uuid";
import getLogger from "@cocalc/backend/logger";
import { getProject } from "@cocalc/server/projects/control";
import { type CreateProjectOptions } from "@cocalc/util/db-schema/projects";
import { delay } from "awaiting";
import isAdmin from "@cocalc/server/accounts/is-admin";
import isCollaborator from "@cocalc/server/projects/is-collaborator";
import { client as filesystemClient } from "@cocalc/conat/files/file-server";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import { conatWithProjectRouting } from "../conat/route-client";
import {
  computePlacementPermission,
  getUserHostTier,
} from "@cocalc/server/project-host/placement";
import { resolveMembershipForAccount } from "@cocalc/server/membership/resolve";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
} from "@cocalc/util/consts";

const log = getLogger("server:projects:create");

export default async function createProject(opts: CreateProjectOptions) {
  if (opts.account_id != null) {
    if (!isValidUUID(opts.account_id)) {
      throw Error("if account_id given, it must be a valid uuid v4");
    }
  }
  log.debug("createProject ", opts);

  const {
    account_id,
    title,
    description,
    image,
    rootfs_image,
    start,
    src_project_id,
    ephemeral,
    host_id: requested_host_id,
    region: requested_region_raw_input,
  } = opts;
  let project_id;
  if (opts.project_id) {
    if (!account_id || !(await isAdmin(account_id))) {
      throw Error("only admins can specify the project_id");
    }
    if (!isValidUUID(opts.project_id)) {
      throw Error("if project_id is given, it must be a valid uuid v4");
    }
    project_id = opts.project_id;
  } else {
    project_id = v4();
  }

  const pool = getPool();

  async function projectIdConflictsDeleted(project_id: string): Promise<boolean> {
    try {
      const { rows } = await pool.query<{ project_id: string }>(
        "SELECT project_id FROM deleted_projects WHERE project_id=$1 LIMIT 1",
        [project_id],
      );
      return !!rows[0];
    } catch (err: any) {
      // Table may not exist until first hard-delete run.
      if (err?.code === "42P01") {
        return false;
      }
      throw err;
    }
  }

  async function projectIdExists(project_id: string): Promise<boolean> {
    const { rows } = await pool.query<{ project_id: string }>(
      "SELECT project_id FROM projects WHERE project_id=$1 LIMIT 1",
      [project_id],
    );
    return !!rows[0];
  }

  if (opts.project_id) {
    if (await projectIdConflictsDeleted(project_id)) {
      throw Error(
        "project_id belongs to a permanently deleted workspace; restore that workspace instead of reusing its project_id",
      );
    }
    if (await projectIdExists(project_id)) {
      throw Error("project_id already exists");
    }
  } else {
    // Ensure generated id never collides with active or hard-deleted projects.
    for (let attempt = 0; attempt < 16; attempt += 1) {
      if (
        !(await projectIdExists(project_id)) &&
        !(await projectIdConflictsDeleted(project_id))
      ) {
        break;
      }
      project_id = v4();
      if (attempt === 15) {
        throw Error(
          "failed to allocate a fresh project_id; please retry project creation",
        );
      }
    }
  }
  let host_id: string | undefined = requested_host_id;
  let requested_region_raw: string | undefined = requested_region_raw_input;

  async function resolveHostPlacement(host_id: string) {
    if (!account_id) {
      throw Error("must be signed in to place a project on a host");
    }
    const { rows } = await pool.query(
      "SELECT * FROM project_hosts WHERE id=$1 AND deleted IS NULL",
      [host_id],
    );
    const row = rows[0];
    if (!row) {
      throw Error(`host ${host_id} not found`);
    }
    const metadata = row.metadata ?? {};
    const owner = metadata.owner;
    const collaborators: string[] = metadata.collaborators ?? [];
    const tier = row.tier as number | undefined;
    const membership = await resolveMembershipForAccount(account_id);
    const userTier = getUserHostTier(membership.entitlements);
    const { can_place } = computePlacementPermission({
      tier,
      userTier,
      isOwner: owner === account_id,
      isCollab: collaborators.includes(account_id ?? ""),
    });
    if (!can_place) {
      throw Error("not allowed to place a project on that host");
    }
    const hostRegion = mapCloudRegionToR2Region(row.region ?? "");
    const machine = metadata?.machine ?? {};
    const selfHostMode = machine?.metadata?.self_host_mode;
    const effectiveSelfHostMode =
      machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
    const isLocalSelfHost =
      machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
    log.debug("resolveHostPlacement", {
      host_id,
      isLocalSelfHost,
    });
    return { host_id, hostRegion };
  }

  if (src_project_id) {
    if (
      !account_id ||
      !(await isCollaborator({ account_id, project_id: src_project_id }))
    ) {
      throw Error("user must be a collaborator on src_project_id");
    }
    // keep the clone on the same project-host as the source unless explicitly overridden
    const { rows } = await pool.query(
      "SELECT host_id, region FROM projects WHERE project_id=$1",
      [src_project_id],
    );
    if (!host_id && rows[0]?.host_id) {
      host_id = rows[0].host_id;
    }
    if (!opts.region && rows[0]?.region) {
      opts.region = rows[0].region;
    }
    if (!requested_region_raw && rows[0]?.region) {
      requested_region_raw = rows[0].region;
    }
    // create filesystem for new project as a clone.
    // Route clone to the host that owns the source project.
    const client = filesystemClient({ project_id: src_project_id });
    await client.clone({ project_id, src_project_id });
  }

  const requestedRegion = parseR2Region(requested_region_raw);
  if (requested_region_raw && !requestedRegion) {
    throw Error("invalid region");
  }

  let hostRegion: string | undefined;
  if (host_id) {
    ({ host_id, hostRegion } = await resolveHostPlacement(host_id));
  }

  const projectRegion = requestedRegion ?? hostRegion ?? DEFAULT_R2_REGION;
  if (requestedRegion && hostRegion && requestedRegion !== hostRegion) {
    throw Error("project region must match host region");
  }
  const users =
    account_id == null ? null : { [account_id]: { group: "owner" } };

  const envs = await getSoftwareEnvironments("server");

  await pool.query(
    "INSERT INTO projects (project_id, title, description, users, compute_image, created, last_edited, rootfs_image, ephemeral, host_id, region) VALUES($1, $2, $3, $4, $5, NOW(), NOW(), $6, $7::BIGINT, $8, $9)",
    [
      project_id,
      title ?? "No Title",
      description ?? "",
      users != null ? JSON.stringify(users) : users,
      image ?? envs?.default ?? DEFAULT_COMPUTE_IMAGE,
      rootfs_image,
      ephemeral ?? null,
      host_id ?? null,
      projectRegion,
    ],
  );

  // If this is a clone with a known host, register the project row on that host
  // so it is visible in its local sqlite/changefeeds without starting it.
  if (host_id) {
    try {
      const client = createHostControlClient({
        host_id,
        client: conatWithProjectRouting(),
        timeout: 10000,
      });
      await client.createProject({
        project_id,
        title,
        users,
        image: rootfs_image ?? image,
        start: false,
      });
    } catch (err) {
      log.warn("createProject: failed to register clone on host", {
        project_id,
        host_id,
        err: `${err}`,
      });
    }
  }

  if (start) {
    const project = getProject(project_id);
    // intentionally not blocking
    startNewProject(project, project_id, account_id);
  }

  return project_id;
}

async function startNewProject(
  project,
  project_id: string,
  account_id?: string,
) {
  log.debug("startNewProject", { project_id });
  try {
    await project.start({ account_id });
    // just in case
    await delay(5000);
    await project.start({ account_id });
  } catch (err) {
    log.debug(`WARNING: problem starting new project -- ${err}`, {
      project_id,
    });
  }
}
