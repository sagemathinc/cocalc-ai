/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Local host connection resolution and project-host token helpers.

What belongs here:

- local host connection resolution for browser/project-host access
- local project-host browser token issuance and its authorization checks
- local project-host agent token issuance and browser ACL sync helpers

What does not belong here:

- cross-bay wrapper entrypoints
- unrelated host lifecycle operations
- generic host listing or mutation logic

`hosts.ts` keeps the public wrappers and bay-routing behavior while this module
owns the local connection and token mechanics.
*/

import type { HostConnectionInfo } from "@cocalc/conat/hub/api/hosts";
import { issueProjectHostAuthToken as issueProjectHostAuthTokenJwt } from "@cocalc/conat/auth/project-host-token";
import { getProjectHostAuthTokenPrivateKey } from "@cocalc/backend/data";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";
import {
  resolveHostBay,
  resolveProjectBay,
} from "@cocalc/server/inter-bay/directory";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import { desiredHostState } from "@cocalc/server/cloud/spot-restore";
import { syncProjectUsersOnHost } from "@cocalc/server/project-host/control";
import { getRoutedHostControlClient } from "@cocalc/server/project-host/client";
import {
  computePlacementPermission,
  getUserHostTier,
} from "@cocalc/server/project-host/placement";
import isAdmin from "@cocalc/server/accounts/is-admin";
import isBanned from "@cocalc/server/accounts/is-banned";
import {
  assertAccountProjectHostTokenProjectAccess,
  assertProjectHostAgentTokenAccess,
  hasAccountProjectHostTokenHostAccess,
} from "./project-host-token-auth";
import {
  computeHostOperationalAvailability,
  defaultInterruptionRestorePolicy,
  normalizeHostInterruptionRestorePolicy,
  normalizeHostPricingModel,
} from "./hosts-normalization";

function pool() {
  return getPool();
}

async function hostControlClient(host_id: string, timeout?: number) {
  return await getRoutedHostControlClient({
    host_id,
    timeout,
  });
}

async function assertAccountCanIssueProjectHostToken({
  account_id,
  host_id,
  project_id,
  loadHostForListing,
}: {
  account_id: string;
  host_id: string;
  project_id?: string;
  loadHostForListing: (id: string, account_id?: string) => Promise<any>;
}): Promise<void> {
  if (await isAdmin(account_id)) {
    return;
  }

  if (project_id) {
    await assertAccountProjectHostTokenProjectAccess({
      account_id,
      host_id,
      project_id,
    });
    return;
  }

  try {
    await loadHostForListing(host_id, account_id);
    return;
  } catch {
    // continue to project-based fallback check
  }

  if (
    !(await hasAccountProjectHostTokenHostAccess({
      account_id,
      host_id,
    }))
  ) {
    throw new Error("not authorized for project-host access token");
  }
}

async function syncProjectUsersOnHostForBrowserAccess({
  account_id,
  project_id,
  expected_host_id,
}: {
  account_id: string;
  project_id: string;
  expected_host_id: string;
}): Promise<void> {
  const hostBay = await resolveHostBay(expected_host_id);
  if (hostBay && hostBay.bay_id !== getConfiguredBayId()) {
    return;
  }
  const ownership = await resolveProjectBay(project_id);
  if (ownership && ownership.bay_id !== getConfiguredBayId()) {
    const remote = await getInterBayBridge()
      .projectReference(ownership.bay_id, {
        timeout_ms: 15_000,
      })
      .get({
        account_id,
        project_id,
      });
    if (!remote) {
      throw new Error("not authorized for project-host access token");
    }
    if (remote.host_id !== expected_host_id) {
      throw new Error("project is not assigned to the requested host");
    }
    const client = await hostControlClient(expected_host_id);
    await client.updateProjectUsers({
      project_id,
      users: remote.users ?? {},
    });
    return;
  }
  await syncProjectUsersOnHost({
    project_id,
    expected_host_id,
  });
}

export async function issueProjectHostAuthTokenLocalHelper({
  account_id,
  host_id,
  project_id,
  ttl_seconds,
  loadHostForListing,
}: {
  account_id: string;
  host_id: string;
  project_id?: string;
  ttl_seconds?: number;
  loadHostForListing: (id: string, account_id?: string) => Promise<any>;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  if (await isBanned(account_id)) {
    throw new Error("account is banned");
  }

  await assertAccountCanIssueProjectHostToken({
    account_id,
    host_id,
    project_id,
    loadHostForListing,
  });
  if (project_id) {
    await syncProjectUsersOnHostForBrowserAccess({
      account_id,
      project_id,
      expected_host_id: host_id,
    });
  }

  const { token, expires_at } = issueProjectHostAuthTokenJwt({
    account_id,
    host_id,
    ttl_seconds,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { host_id, token, expires_at };
}

export async function issueProjectHostHubAuthTokenInternalHelper({
  host_id,
  ttl_seconds,
}: {
  host_id: string;
  ttl_seconds?: number;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  const { token, expires_at } = issueProjectHostAuthTokenJwt({
    actor: "hub",
    hub_id: "hub",
    host_id,
    ttl_seconds,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { host_id, token, expires_at };
}

export async function issueProjectHostAgentAuthTokenInternalHelper({
  host_id,
  account_id,
  project_id,
  ttl_seconds,
}: {
  host_id: string;
  account_id: string;
  project_id: string;
  ttl_seconds?: number;
}): Promise<{
  host_id: string;
  token: string;
  expires_at: number;
}> {
  await assertProjectHostAgentTokenAccess({
    host_id,
    account_id,
    project_id,
  });
  await syncProjectUsersOnHost({
    project_id,
    expected_host_id: host_id,
  });
  const { token, expires_at } = issueProjectHostAuthTokenJwt({
    account_id,
    host_id,
    ttl_seconds,
    private_key: getProjectHostAuthTokenPrivateKey(),
  });
  return { host_id, token, expires_at };
}

export async function resolveHostConnectionLocalHelper({
  account_id,
  host_id,
  allowMissing = false,
  loadMembership,
}: {
  account_id: string;
  host_id: string;
  allowMissing?: boolean;
  loadMembership: (account_id: string) => Promise<any>;
}): Promise<HostConnectionInfo | undefined> {
  if (!host_id) {
    throw new Error("host_id must be specified");
  }
  const { rows } = await pool().query(
    `SELECT id, bay_id, name, public_url, internal_url, ssh_server, metadata, tier, status, last_seen, region
     FROM project_hosts
     WHERE id=$1 AND deleted IS NULL`,
    [host_id],
  );
  const row = rows[0];
  if (!row) {
    if (allowMissing) {
      return undefined;
    }
    throw new Error("host not found");
  }
  const metadata = row.metadata ?? {};
  const rowOwner = metadata.owner ?? "";
  const collaborators = (metadata.collaborators ?? []) as string[];
  const isOwner = rowOwner === account_id;
  const isCollab = collaborators.includes(account_id);
  const isShared = row.tier != null;
  const membership = await loadMembership(account_id);
  const userTier = getUserHostTier(membership.entitlements);
  const placement = computePlacementPermission({
    tier: row.tier,
    userTier,
    isOwner,
    isCollab,
  });
  if (!isOwner && !isCollab && !isShared) {
    const { rows: projectRows } = await pool().query(
      `SELECT 1
       FROM projects
       WHERE host_id=$1 AND users ? $2
       LIMIT 1`,
      [host_id, account_id],
    );
    if (!projectRows.length) {
      throw new Error("not authorized");
    }
  }
  const machine = metadata?.machine ?? {};
  const selfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !selfHostMode ? "local" : selfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";

  let connect_url: string | null = null;
  let ssh_server: string | null = row.ssh_server ?? null;
  let local_proxy = false;
  let ready = false;
  const availability = computeHostOperationalAvailability(row);
  const normalizedStatus =
    row.status === "active" ? "running" : (row.status ?? null);
  const pricingModel =
    normalizeHostPricingModel(metadata.pricing_model) ?? "on_demand";
  const interruptionRestorePolicy =
    normalizeHostInterruptionRestorePolicy(
      metadata.interruption_restore_policy,
    ) ?? defaultInterruptionRestorePolicy(pricingModel);
  const lastSeenIso = row.last_seen
    ? new Date(row.last_seen).toISOString()
    : undefined;
  if (isLocalSelfHost) {
    local_proxy = true;
    ready = !!metadata?.self_host?.http_tunnel_port;
    const sshPort = metadata?.self_host?.ssh_tunnel_port;
    if (sshPort) {
      const sshHost = resolveOnPremHost();
      ssh_server = `${sshHost}:${sshPort}`;
    }
  } else {
    connect_url = row.public_url ?? row.internal_url ?? null;
    ready = !!connect_url;
  }

  return {
    host_id: row.id,
    bay_id:
      typeof row.bay_id === "string" && row.bay_id.trim()
        ? row.bay_id.trim()
        : null,
    name: row.name ?? null,
    can_place: placement.can_place,
    region: row.region ?? null,
    size: typeof metadata?.size === "string" ? metadata.size : null,
    ssh_server,
    connect_url,
    host_session_id:
      typeof metadata?.host_session_id === "string" &&
      metadata.host_session_id.trim()
        ? metadata.host_session_id.trim()
        : undefined,
    local_proxy,
    ready,
    status: normalizedStatus,
    tier: typeof row.tier === "number" ? row.tier : null,
    pricing_model: pricingModel,
    interruption_restore_policy: interruptionRestorePolicy,
    desired_state: desiredHostState({
      status: normalizedStatus ?? undefined,
      metadata,
    }),
    last_seen: lastSeenIso,
    online: availability.online,
    reason_unavailable: availability.operational
      ? undefined
      : availability.reason_unavailable,
  } as HostConnectionInfo;
}
