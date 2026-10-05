/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Route hub API calls to the bay that owns their data, at the edge: the hub
// that receives a routed call (see @cocalc/conat/hub/api/routes) resolves the
// owning bay and, if it is another bay, forwards the whole authenticated call
// there exactly once. The owning bay runs it through its normal hub API
// pipeline, so the method itself is single-bay code with no local/remote
// branches.

import getLogger from "@cocalc/backend/logger";
import { hubApiErrorAttrs } from "@cocalc/conat/hub/api/error-attrs";
import {
  getHubApiPrincipalPolicy,
  isHubApiPrincipalAllowed,
} from "@cocalc/conat/hub/api";
import {
  getHubApiRoute,
  hubApiRouteKey,
  type HubApiRoute,
} from "@cocalc/conat/hub/api/routes";
import {
  createInterBayHubApiClient,
  type ForwardedHubApiCall,
} from "@cocalc/conat/inter-bay/hub-api";
import { isAccountBannedCached } from "@cocalc/server/accounts/security-state";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

const logger = getLogger("server:conat:api:edge-routing");

export type HubApiCall = Omit<ForwardedHubApiCall, "source_bay_id">;

type Executor = (call: HubApiCall) => Promise<any>;

let executeLocal: Executor | undefined;

/** The hub API's own local executor; registered when the API starts. */
export function registerHubApiLocalExecutor(executor: Executor): void {
  executeLocal = executor;
}

function requireExecutor(): Executor {
  if (executeLocal == null) {
    throw new Error("hub API local executor is not registered");
  }
  return executeLocal;
}

/** The bay owning a routed call's data, or undefined to run it here. */
async function ownerBay(
  route: HubApiRoute,
  args: any[],
): Promise<string | undefined> {
  // Malformed keys run locally, where the method rejects them as usual.
  const key = hubApiRouteKey(route, args);
  if (key == null) return;
  switch (route.owner) {
    case "project":
      return (await resolveProjectBay(key))?.bay_id;
  }
}

type ForwardedResult =
  | { ok: true; result: any }
  | { ok: false; error: string; attrs: Record<string, unknown> };

/**
 * Run a hub API call where its data lives: here, or forwarded once to the
 * owning bay. The caller has already authenticated and authorized it.
 */
export async function executeHubApiCall(call: HubApiCall): Promise<any> {
  const route = getHubApiRoute(call.name);
  if (route == null) return await requireExecutor()(call);
  const owner = await ownerBay(route, call.args);
  const here = getConfiguredBayId();
  if (owner == null || owner === here) return await requireExecutor()(call);
  const response: ForwardedResult = await createInterBayHubApiClient({
    client: getInterBayFabricClient(),
    bay_id: owner,
  }).call({ ...call, source_bay_id: here });
  if (response.ok) return response.result;
  // The same error the owning bay raised, as if the call had run here.
  throw Object.assign(new Error(response.error), response.attrs);
}

/** The owning bay's side of a forwarded call. */
export async function handleForwardedHubApiCall(
  call: ForwardedHubApiCall,
): Promise<ForwardedResult> {
  try {
    const { source_bay_id, ...rest } = call;
    const route = getHubApiRoute(rest.name);
    // Only routed methods cross bays this way.
    if (route == null) {
      throw Object.assign(
        new Error(`hub API method '${rest.name}' is not routable`),
        { code: 403 },
      );
    }
    const policy = getHubApiPrincipalPolicy(rest.name);
    if (
      policy == null ||
      !isHubApiPrincipalAllowed({
        policy,
        account_id: rest.account_id,
        project_id: rest.project_id,
        host_id: rest.host_id,
        auth_actor: rest.auth_actor,
      })
    ) {
      throw Object.assign(
        new Error(`principal is not permitted for '${rest.name}'`),
        { code: 403 },
      );
    }
    // Agent-scoped calls carry per-method limits checked at the edge; none
    // of the routed methods accept agents, so refuse rather than re-derive.
    if (rest.auth_actor === "agent") {
      throw Object.assign(
        new Error(`agent principals are not routed for '${rest.name}'`),
        { code: 403 },
      );
    }
    if (rest.account_id && isAccountBannedCached(rest.account_id)) {
      throw Object.assign(new Error("account is banned"), { code: 403 });
    }
    // Never forward twice: if ownership moved since the edge resolved it,
    // fail and let the caller retry through a fresh route.
    const owner = await ownerBay(route, rest.args);
    if (owner != null && owner !== getConfiguredBayId()) {
      logger.debug("stale hub API route", {
        name: rest.name,
        source_bay_id,
        owner,
      });
      throw Object.assign(
        new Error(
          `stale route for '${rest.name}': owned by ${owner}, not ${getConfiguredBayId()}`,
        ),
        { code: 409 },
      );
    }
    return { ok: true, result: (await requireExecutor()(rest)) ?? null };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `${err}`,
      attrs: hubApiErrorAttrs(err),
    };
  }
}
