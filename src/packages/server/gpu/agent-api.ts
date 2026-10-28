/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
gpu.agentRequests / gpu.approveAgentRequest / gpu.revokeAgentGrant (step 6b):
the human's side of agent GPU launches, on the key owner's home bay.

Approval names the exact request (request_id + payload hash) the human was
shown and needs fresh authentication, which the bay the user is signed in to
checks before forwarding (fresh_auth_verified). There is no other approval
path. Until the browser approval card exists (6b-2), the hub API is the only
way to approve, and it needs a fresh browser session.
*/

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import type { GpuAgentRequestView } from "@cocalc/conat/hub/api/gpu";
import {
  createInterBayAccountLocalClient,
  type InterBayGpuApi,
} from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import { getRunpodLaunchAccessForAccount } from "@cocalc/server/gpu/provider-keys";
import { inTransaction } from "@cocalc/server/gpu/pods";
import {
  approveAgentRequestLocal as approveInTransaction,
  closeExpiredAgentGrant,
  revokeAgentGrantLocal as revokeInTransaction,
  type GpuAgentGrantDeps,
  type GpuAgentGrantView,
} from "@cocalc/server/gpu/agent-grants";

export interface GpuAgentApiDeps extends GpuAgentGrantDeps {
  // for tests
  homeClient?: (account_id: string) => Promise<InterBayGpuApi | undefined>;
  freshAuth?: typeof requireDangerousSessionAuth;
  credentialId?: (account_id: string) => Promise<string | undefined>;
}

function requireAccount(account_id: unknown): string {
  if (typeof account_id !== "string" || !isValidUUID(account_id)) {
    throw Error("must be signed in");
  }
  return account_id;
}

async function credentialIdFor(
  account_id: string,
): Promise<string | undefined> {
  // Only the id is used; nothing is sent to RunPod.
  return (
    await getRunpodLaunchAccessForAccount(account_id).catch(() => undefined)
  )?.credential_id;
}

// What the agent is, said plainly: never the raw principal key of a chat
// session.
function principalView(agent_id: string, run_id: string) {
  if (agent_id.startsWith("agent:")) {
    return {
      principal_kind: "registered_agent" as const,
      agent_id: agent_id.slice("agent:".length),
      run_id,
    };
  }
  return { principal_kind: "chat_session" as const };
}

export async function listAgentRequestsLocal(opts: {
  account_id?: string;
  project_id?: unknown;
  include_decided?: boolean;
}): Promise<GpuAgentRequestView[]> {
  const account_id = requireAccount(opts.account_id);
  const project_id = opts.project_id == null ? null : `${opts.project_id}`;
  if (project_id != null && !isValidUUID(project_id)) {
    throw Error("invalid project id");
  }
  const { rows } = await getPool().query(
    `SELECT r.*, g.grant_id, g.state AS grant_state,
            g.expires_at AS grant_expires_at, g.launches_used
       FROM gpu_agent_requests r
       LEFT JOIN gpu_agent_grants g ON g.request_id = r.request_id
      WHERE r.account_id = $1
        AND ($2::uuid IS NULL OR r.project_id = $2)
        AND ($3::boolean OR (r.state = 'pending' AND r.expires_at > now())
             OR g.state = 'active')
      ORDER BY r.created DESC
      LIMIT 100`,
    [account_id, project_id, opts.include_decided === true],
  );
  return rows.map((r: any) => ({
    request_id: r.request_id,
    project_id: r.project_id,
    ...principalView(r.agent_id, r.run_id),
    operation_id: r.operation_id,
    // exactly the stored payload and hash: what approval must name
    payload: r.payload,
    payload_hash: r.payload_hash,
    state:
      r.state === "pending" && new Date(r.expires_at) <= new Date()
        ? "expired"
        : r.state,
    created: new Date(r.created).toISOString(),
    expires_at: new Date(r.expires_at).toISOString(),
    ...(r.grant_id
      ? {
          grant: {
            grant_id: r.grant_id,
            state: r.grant_state,
            expires_at: new Date(r.grant_expires_at).toISOString(),
            launches_used: r.launches_used,
          },
        }
      : {}),
  }));
}

export async function approveAgentRequestLocal(
  opts: {
    account_id?: string;
    request_id?: unknown;
    expected_hash?: unknown;
    fresh_auth_verified?: boolean;
  },
  deps: GpuAgentApiDeps = {},
): Promise<GpuAgentGrantView> {
  const account_id = requireAccount(opts.account_id);
  return await inTransaction((db) =>
    approveInTransaction(
      db,
      {
        account_id,
        request_id: opts.request_id,
        expected_hash: opts.expected_hash,
        fresh_auth_verified: opts.fresh_auth_verified,
      },
      { ...deps, credentialId: deps.credentialId ?? credentialIdFor },
    ),
  );
}

export async function revokeAgentGrantLocal(
  opts: { account_id?: string; grant_id?: unknown },
  deps: GpuAgentApiDeps = {},
): Promise<GpuAgentGrantView> {
  const account_id = requireAccount(opts.account_id);
  return await inTransaction((db) =>
    revokeInTransaction(db, { account_id, grant_id: opts.grant_id }, deps),
  );
}

// The end of runs: admission closes on each expired grant's layer (its pods
// keep running to their deadlines). Idempotent; run periodically.
export async function closeExpiredAgentGrants(
  deps: GpuAgentApiDeps = {},
): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT grant_id, account_id FROM gpu_agent_grants
      WHERE state = 'active' AND expires_at <= now()
      ORDER BY expires_at LIMIT 500`,
  );
  let closed = 0;
  for (const row of rows) {
    try {
      if (
        await inTransaction((db) =>
          closeExpiredAgentGrant(
            db,
            { account_id: row.account_id, grant_id: row.grant_id },
            deps,
          ),
        )
      ) {
        closed += 1;
      }
    } catch {
      // e.g. the account is being rehomed: the next pass retries
    }
  }
  return closed;
}

// ---- routed entry points (hub API) ----

async function agentHomeClient(
  account_id: string,
): Promise<InterBayGpuApi | undefined> {
  const { home_bay_id } = await resolveAccountHomeBay({
    account_id,
    user_account_id: account_id,
  });
  const dest_bay = `${home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (dest_bay === getConfiguredBayId()) return undefined;
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay,
    timeout: 30_000,
  });
}

export async function getAgentRequests(
  opts: { account_id?: string; project_id?: string; include_decided?: boolean },
  deps: GpuAgentApiDeps = {},
): Promise<GpuAgentRequestView[]> {
  const account_id = requireAccount(opts.account_id);
  const forwarded = {
    account_id,
    project_id: opts.project_id,
    include_decided: opts.include_decided,
  };
  const home = await (deps.homeClient ?? agentHomeClient)(account_id);
  if (home) return await home.gpuAgentRequests(forwarded);
  return await listAgentRequestsLocal(forwarded);
}

// Fresh authentication is checked here, on the bay the user is signed in
// to, for the caller's own session (bound by the hub transform). Without
// it, nothing is approved.
export async function approveAgentRequest(
  opts: {
    account_id?: string;
    browser_id?: string | null;
    session_hash?: string | null;
    request_id?: unknown;
    expected_hash?: unknown;
  },
  deps: GpuAgentApiDeps = {},
): Promise<GpuAgentGrantView> {
  const account_id = requireAccount(opts.account_id);
  await (deps.freshAuth ?? requireDangerousSessionAuth)({
    account_id,
    browser_id: opts.browser_id,
    session_hash: opts.session_hash,
    require_second_factor: false,
  });
  const forwarded = {
    account_id,
    request_id: opts.request_id,
    expected_hash: opts.expected_hash,
    fresh_auth_verified: true,
  };
  const home = await (deps.homeClient ?? agentHomeClient)(account_id);
  if (home) return await home.gpuApproveAgentRequest(forwarded);
  return await approveAgentRequestLocal(forwarded, deps);
}

export async function revokeAgentGrant(
  opts: { account_id?: string; grant_id?: unknown },
  deps: GpuAgentApiDeps = {},
): Promise<GpuAgentGrantView> {
  const account_id = requireAccount(opts.account_id);
  const forwarded = { account_id, grant_id: opts.grant_id };
  const home = await (deps.homeClient ?? agentHomeClient)(account_id);
  if (home) return await home.gpuRevokeAgentGrant(forwarded);
  return await revokeAgentGrantLocal(forwarded, deps);
}
