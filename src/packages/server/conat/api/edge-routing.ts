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
import {
  forwardedCallHash,
  OUTCOME_UNKNOWN,
  runForwardedCallOnce,
} from "@cocalc/server/inter-bay/forwarded-calls";
import { randomUUID } from "node:crypto";

const logger = getLogger("server:conat:api:edge-routing");

export type HubApiCall = Omit<ForwardedHubApiCall, "source_bay_id" | "call_id">;

// A forwarded call gets two attempts with the same call id, within the
// caller's own 30 s hub call timeout, so the caller hears the outcome (or that
// it is unknown) from this bay rather than timing out itself.
const FORWARD_ATTEMPTS = 2;
const FORWARD_ATTEMPT_TIMEOUT_MS = 12_000;
// How long the owning bay lets a repeat wait for the first attempt to finish;
// shorter than an attempt, so the answer arrives before the attempt times out.
const REPEAT_WAIT_MS = 9_000;

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
      return typeof key === "string"
        ? (await resolveProjectBay(key))?.bay_id
        : undefined;
    case "collab-invite":
      return typeof key === "object"
        ? await collabInviteOwnerBay(key)
        : undefined;
  }
}

async function collabInviteOwnerBay({
  invite_id,
  token,
}: {
  invite_id?: string;
  token?: string;
}): Promise<string | undefined> {
  // Loaded on use: these modules are large and import much of the server.
  const { hashProjectCollabInviteToken } =
    await import("@cocalc/server/projects/collaborators");
  const { resolveProjectCollabInviteDirectory } =
    await import("@cocalc/server/projects/collab-invite-directory");
  const token_hash = token
    ? await hashProjectCollabInviteToken(token)
    : undefined;
  const entry = await resolveProjectCollabInviteDirectory({
    ...(invite_id ? { invite_id } : {}),
    ...(token_hash ? { token_hash } : {}),
  });
  // An unknown invite runs where it was received, which reports it as missing.
  return entry?.owning_bay_id ?? undefined;
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
  return await forwardHubApiCall(owner, call);
}

/**
 * Forward an authenticated, authorized hub API call to the bay that owns its
 * data, which re-checks the route and runs it there exactly once. If that bay
 * does not answer, send the call again with the same call id: it returns the
 * first attempt's outcome rather than running it twice. If there is still no
 * answer, the call may or may not have run: say so (code OUTCOME_UNKNOWN)
 * rather than report a failure.
 */
export async function forwardHubApiCall(
  bay_id: string,
  call: HubApiCall,
): Promise<any> {
  const forwarded: ForwardedHubApiCall = {
    ...call,
    source_bay_id: getConfiguredBayId(),
    call_id: randomUUID(),
  };
  let lastError: unknown;
  for (let attempt = 1; attempt <= FORWARD_ATTEMPTS; attempt++) {
    let response: ForwardedResult;
    try {
      response = await createInterBayHubApiClient({
        client: getInterBayFabricClient(),
        bay_id,
        timeout: FORWARD_ATTEMPT_TIMEOUT_MS,
      }).call(forwarded);
    } catch (err) {
      // No answer. Even "no responders" (503) does not prove the call was not
      // delivered: the transport retries an unacknowledged fast request over
      // its fallback path, which then reports 503. The call id makes the next
      // attempt safe either way.
      lastError = err;
      logger.debug("forwarded hub API call got no answer", {
        name: call.name,
        bay_id,
        attempt,
        err: `${err}`,
      });
      continue;
    }
    if (response.ok) return response.result;
    // The same error the owning bay raised, as if the call had run here.
    throw Object.assign(new Error(response.error), response.attrs);
  }
  throw Object.assign(
    new Error(
      `outcome unknown: ${bay_id} did not answer '${call.name}' (${lastError}); it may or may not have been applied`,
    ),
    { code: OUTCOME_UNKNOWN },
  );
}

/** The owning bay's side of a forwarded call. */
export async function handleForwardedHubApiCall(
  call: ForwardedHubApiCall,
): Promise<ForwardedResult> {
  const { call_id } = call;
  if (call_id == null) return await runForwardedHubApiCall(call);
  try {
    return await runForwardedCallOnce({
      call_id,
      name: call.name,
      account_id: call.account_id,
      source_bay_id: call.source_bay_id,
      call_hash: forwardedCallHash(call),
      wait_ms: REPEAT_WAIT_MS,
      run: async () => await runForwardedHubApiCall(call),
    });
  } catch (err) {
    // The call id could not be recorded, so the call did not run.
    return {
      ok: false,
      error: err instanceof Error ? err.message : `${err}`,
      attrs: hubApiErrorAttrs(err),
    };
  }
}

async function runForwardedHubApiCall(
  call: ForwardedHubApiCall,
): Promise<ForwardedResult> {
  try {
    const { source_bay_id, call_id: _call_id, ...rest } = call;
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
