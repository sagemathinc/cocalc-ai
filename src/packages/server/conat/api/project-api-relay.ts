/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import basePath from "@cocalc/backend/base-path";
import type { ProjectApiRelayTarget } from "@cocalc/conat/project-host/api-relay";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  resolveHostBay,
  resolveProjectBay,
} from "@cocalc/server/inter-bay/directory";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import { isValidUUID } from "@cocalc/util/misc";

export type RelayTargetRequest = {
  target_host_id: string;
  target_project_id: string;
};

function validateTarget(opts: RelayTargetRequest): void {
  if (
    !isValidUUID(opts.target_host_id) ||
    !isValidUUID(opts.target_project_id)
  ) {
    throw Error("invalid API relay target");
  }
}

// This grants transport reachability, not access to a project. The destination
// still authenticates the caller's original credential and enforces its ACLs.
export async function resolveProjectApiRelayTarget({
  host_id,
  ...target
}: RelayTargetRequest & { host_id?: string }): Promise<ProjectApiRelayTarget> {
  if (!isValidUUID(host_id))
    throw Error("project-host authentication required");
  validateTarget(target);
  const owner = await resolveProjectBay(target.target_project_id);
  if (!owner) throw Error("API relay target project not found");
  if (owner.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .hostConnection(owner.bay_id)
      .getApiRelayTarget(target);
  }
  return await resolveLocalProjectApiRelayTarget(target);
}

export async function resolveLocalProjectApiRelayTarget(
  target: RelayTargetRequest,
): Promise<ProjectApiRelayTarget> {
  validateTarget(target);
  const { rows } = await getPool().query(
    `SELECT host_id FROM projects
      WHERE project_id = $1 AND host_id = $2 AND deleted IS NOT TRUE
        AND COALESCE(owning_bay_id, $3) = $3`,
    [target.target_project_id, target.target_host_id, getConfiguredBayId()],
  );
  if (!rows.length) throw Error("API relay target project is not on this host");
  // Project ownership and host ownership can differ, including during moves.
  const owner = await resolveHostBay(target.target_host_id);
  if (!owner) throw Error("API relay target host not found");
  if (owner.bay_id !== getConfiguredBayId()) {
    return await getInterBayBridge()
      .hostConnection(owner.bay_id)
      .getApiRelayHostUrl(target);
  }
  return await resolveLocalApiRelayHostUrl(target);
}

// Cluster-internal host metadata only. The project-owning bay checks placement
// before calling this; the upstream service still authorizes the actual caller.
export async function resolveLocalApiRelayHostUrl(
  target: RelayTargetRequest,
): Promise<ProjectApiRelayTarget> {
  validateTarget(target);
  const { rows } = await getPool().query(
    `SELECT h.public_url, h.internal_url, h.metadata
       FROM project_hosts h
      WHERE h.id = $1 AND h.deleted IS NULL
        AND COALESCE(h.bay_id, $2) = $2`,
    [target.target_host_id, getConfiguredBayId()],
  );
  const row = rows[0];
  if (!row) throw Error("API relay target host is not owned by this bay");
  const metadata = row.metadata ?? {};
  const machine = metadata.machine ?? {};
  const localProxy =
    (machine.cloud === "self-host" &&
      (machine.metadata?.self_host_mode ?? "local") === "local") ||
    metadata.local === true ||
    metadata.provider === "star" ||
    metadata.cloud_provider === "star";
  let url = row.public_url || row.internal_url;
  if (localProxy) {
    // Existing on-prem hosts have only a reverse tunnel at their owning hub.
    // Other hosts connect directly; this is not a new hub data-plane relay.
    if (!metadata.self_host?.http_tunnel_port) {
      throw Error("API relay target host tunnel is unavailable");
    }
    const { dns } = await getServerSettings();
    if (!dns) throw Error("public site URL is not configured");
    const site = /^https?:\/\//i.test(dns) ? dns : `https://${dns}`;
    url = `${site.replace(/\/+$/, "")}/${basePath ?? ""}/${target.target_project_id}`;
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    url = parsed.toString();
  }
  if (!url) throw Error("API relay target host has no connection URL");
  const parsed = new URL(url);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw Error("invalid API relay target URL");
  }
  return {
    host_id: target.target_host_id,
    project_id: target.target_project_id,
    url: parsed.toString(),
  };
}
