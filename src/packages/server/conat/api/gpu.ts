/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// Hub API `gpu.*`: see @cocalc/conat/hub/api/gpu and server/gpu. Only the
// first argument is passed on: the implementations' second argument is for
// tests and must never come from a caller.

import type { GpuApi } from "@cocalc/conat/hub/api/gpu";
import {
  getGpuAvailability,
  getGpuCatalog,
  getGpuPods,
} from "@cocalc/server/gpu/read";
import {
  acknowledgeGpuAlert,
  getGpuBudget,
  listGpuAlerts,
  releaseQuarantined as releaseQuarantinedImpl,
  resumeGpuLaunches,
  setGpuBudget as setGpuBudgetImpl,
} from "@cocalc/server/gpu/budget-api";
import { allowStaleWorkers } from "@cocalc/server/gpu/admin";
import { listAdminAlertsLocal } from "@cocalc/server/gpu/admin-alerts";
import {
  confirmAccountChecks as confirmGpuAccountChecks,
  getAccountChecks,
} from "@cocalc/server/gpu/account-watch";
import {
  killSwitch as gpuKillSwitch,
  launchGpuPod,
  terminateGpuPod,
  whoGpuPod,
} from "@cocalc/server/gpu/pods";
import { gpuSshInfo } from "@cocalc/server/gpu/hostkey";
import { getGpuSpend } from "@cocalc/server/gpu/spend";
import { reportCompromised as reportGpuKeyCompromised } from "@cocalc/server/gpu/compromise";
import {
  approveAgentRequest as approveAgentRequestImpl,
  getAgentRequests,
  revokeAgentGrant as revokeAgentGrantImpl,
} from "@cocalc/server/gpu/agent-api";
import { resolveGpuAgentPrincipal } from "@cocalc/server/gpu/agent-identity";
import type { GpuAgentPrincipal } from "@cocalc/server/gpu/agent-grants";

// The agent principal, only when the account-or-gpu-agent policy attached
// the verified token (gpu_agent_auth); resolved here, on the bay that
// authenticated it. Any other identity in opts is ignored.
async function agentPrincipal(
  opts: any,
): Promise<GpuAgentPrincipal | undefined> {
  const auth = opts?.gpu_agent_auth;
  if (!auth) return undefined;
  return await resolveGpuAgentPrincipal({
    account_id: auth.account_id,
    project_id: auth.project_id,
    auth_token_fingerprint: auth.auth_token_fingerprint,
    auth_exp_s: auth.auth_exp_s,
  });
}

function scopeOf(p: GpuAgentPrincipal | undefined) {
  return p
    ? {
        agent: {
          project_id: p.project_id,
          agent_id: p.agent_id,
          // attribution only
          run_id: p.run_id,
        },
      }
    : {};
}

export const catalog: GpuApi["catalog"] = async (opts = {}) =>
  await getGpuCatalog(opts);

export const availability: GpuApi["availability"] = async (opts = {}) =>
  await getGpuAvailability(opts);

export const pods: GpuApi["pods"] = async (opts = {}) => {
  const principal = await agentPrincipal(opts);
  const { gpu_agent_auth: _auth, ...rest } = opts as any;
  return await getGpuPods({ ...rest, ...scopeOf(principal) });
};

export async function launch(
  opts: Parameters<GpuApi["launch"]>[0],
): ReturnType<GpuApi["launch"]> {
  const principal = await agentPrincipal(opts);
  return await launchGpuPod({
    account_id: opts?.account_id,
    project_id: opts?.project_id,
    spec: opts?.spec,
    ...(principal
      ? {
          agent: {
            principal,
            operation_id: `${opts?.operation_id ?? ""}`,
          },
        }
      : {}),
  });
}

export async function terminate(
  opts: Parameters<GpuApi["terminate"]>[0],
): ReturnType<GpuApi["terminate"]> {
  const principal = await agentPrincipal(opts);
  return await terminateGpuPod({
    account_id: opts?.account_id,
    pod_id: opts?.pod_id,
    ...scopeOf(principal),
  });
}

export async function who(
  opts: Parameters<GpuApi["who"]>[0],
): ReturnType<GpuApi["who"]> {
  const principal = await agentPrincipal(opts);
  return await whoGpuPod({
    account_id: opts?.account_id,
    query: opts?.query,
    ...scopeOf(principal),
  });
}

export async function budget(
  opts: Parameters<GpuApi["budget"]>[0],
): ReturnType<GpuApi["budget"]> {
  return await getGpuBudget({ account_id: opts?.account_id });
}

export async function spend(
  opts: Parameters<GpuApi["spend"]>[0],
): ReturnType<GpuApi["spend"]> {
  return await getGpuSpend({
    account_id: opts?.account_id,
    since: opts?.since,
    until: opts?.until,
    group_by: opts?.group_by,
  });
}

export async function killSwitch(
  opts: Parameters<GpuApi["killSwitch"]>[0],
): ReturnType<GpuApi["killSwitch"]> {
  return await gpuKillSwitch({
    account_id: opts?.account_id,
    project_id: opts?.project_id,
    pause: opts?.pause,
  });
}

export async function resume(
  opts: Parameters<GpuApi["resume"]>[0],
): ReturnType<GpuApi["resume"]> {
  return await resumeGpuLaunches({
    account_id: opts?.account_id,
    browser_id: opts?.browser_id,
    session_hash: opts?.session_hash,
  });
}

export async function accountChecks(
  opts: Parameters<GpuApi["accountChecks"]>[0],
): ReturnType<GpuApi["accountChecks"]> {
  return await getAccountChecks({ account_id: opts?.account_id });
}

export async function confirmAccountChecks(
  opts: Parameters<GpuApi["confirmAccountChecks"]>[0],
): ReturnType<GpuApi["confirmAccountChecks"]> {
  return await confirmGpuAccountChecks({
    account_id: opts?.account_id,
    browser_id: opts?.browser_id,
    session_hash: opts?.session_hash,
    confirm: opts?.confirm,
  });
}

export async function reportCompromised(
  opts: Parameters<GpuApi["reportCompromised"]>[0],
): ReturnType<GpuApi["reportCompromised"]> {
  return await reportGpuKeyCompromised({
    account_id: opts?.account_id,
    browser_id: opts?.browser_id,
    session_hash: opts?.session_hash,
    confirm_cocalc_only: opts?.confirm_cocalc_only,
  });
}

export async function setBudget(
  opts: Parameters<GpuApi["setBudget"]>[0],
): ReturnType<GpuApi["setBudget"]> {
  return await setGpuBudgetImpl({
    account_id: opts?.account_id,
    browser_id: opts?.browser_id,
    session_hash: opts?.session_hash,
    change: opts?.change,
    expected_version: opts?.expected_version,
  });
}

export async function adminAllowStaleWorkers(
  opts: Parameters<GpuApi["adminAllowStaleWorkers"]>[0],
): ReturnType<GpuApi["adminAllowStaleWorkers"]> {
  return await allowStaleWorkers({
    account_id: opts?.account_id,
    browser_id: opts?.browser_id,
    session_hash: opts?.session_hash,
    target_account_id: opts?.target_account_id,
    hours: opts?.hours,
    reason: opts?.reason,
  });
}

export async function sshInfo(
  opts: Parameters<GpuApi["sshInfo"]>[0],
): ReturnType<GpuApi["sshInfo"]> {
  const principal = await agentPrincipal(opts);
  return await gpuSshInfo({
    account_id: opts?.account_id,
    pod_id: opts?.pod_id,
    ...scopeOf(principal),
  });
}

export async function agentRequests(
  opts: Parameters<GpuApi["agentRequests"]>[0],
): ReturnType<GpuApi["agentRequests"]> {
  return await getAgentRequests({
    account_id: opts?.account_id,
    project_id: opts?.project_id,
    include_decided: opts?.include_decided,
  });
}

export async function approveAgentRequest(
  opts: Parameters<GpuApi["approveAgentRequest"]>[0],
): ReturnType<GpuApi["approveAgentRequest"]> {
  return await approveAgentRequestImpl({
    account_id: opts?.account_id,
    browser_id: opts?.browser_id,
    session_hash: opts?.session_hash,
    request_id: opts?.request_id,
    expected_hash: opts?.expected_hash,
  });
}

export async function revokeAgentGrant(
  opts: Parameters<GpuApi["revokeAgentGrant"]>[0],
): ReturnType<GpuApi["revokeAgentGrant"]> {
  return await revokeAgentGrantImpl({
    account_id: opts?.account_id,
    grant_id: opts?.grant_id,
  });
}

export async function alerts(
  opts: Parameters<GpuApi["alerts"]>[0],
): ReturnType<GpuApi["alerts"]> {
  return await listGpuAlerts({
    account_id: opts?.account_id,
    include_resolved: opts?.include_resolved,
  });
}

export async function acknowledgeAlert(
  opts: Parameters<GpuApi["acknowledgeAlert"]>[0],
): ReturnType<GpuApi["acknowledgeAlert"]> {
  return await acknowledgeGpuAlert({
    account_id: opts?.account_id,
    id: opts?.id,
  });
}

export async function releaseQuarantined(
  opts: Parameters<GpuApi["releaseQuarantined"]>[0],
): ReturnType<GpuApi["releaseQuarantined"]> {
  return await releaseQuarantinedImpl({
    account_id: opts?.account_id,
    browser_id: opts?.browser_id,
    session_hash: opts?.session_hash,
    pod_id: opts?.pod_id,
  });
}

export async function adminAlerts(
  opts: Parameters<GpuApi["adminAlerts"]>[0],
): ReturnType<GpuApi["adminAlerts"]> {
  return await listAdminAlertsLocal({
    account_id: opts?.account_id,
    include_resolved: opts?.include_resolved,
    bay_id: opts?.bay_id,
  });
}
