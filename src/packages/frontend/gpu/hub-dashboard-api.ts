/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

/*
The cost dashboard's API for the key owner ("funded"), on the `gpu` hub API.
Every call has a transport timeout, so a hung request is released and the
dashboard's polling carries on.
*/

import type { GpuApi } from "@cocalc/conat/hub/api/gpu";
import type { DashboardPod, GpuCostDashboardApi } from "./types";
import type { ReportCompromised } from "./report-compromised";

export const GPU_REQUEST_TIMEOUT_MS = 20_000;

type GpuHub = Pick<
  GpuApi,
  | "pods"
  | "spend"
  | "budget"
  | "terminate"
  | "killSwitch"
  | "resume"
  | "reportCompromised"
  | "alerts"
  | "acknowledgeAlert"
  | "releaseQuarantined"
>;

// The hub transport reads `timeout` from the first argument; the server
// ignores it.
function withTimeout<T>(opts: T): T {
  return { ...opts, timeout: GPU_REQUEST_TIMEOUT_MS } as T;
}

export function hubGpuDashboardApi({
  gpu,
  viewerAccountId,
  browserId,
  names,
  projectTitle,
}: {
  gpu: GpuHub;
  // the signed-in key owner: only pods their key pays for are shown, the
  // same pods their kill switch terminates
  viewerAccountId: string;
  browserId?: string;
  names?: (
    account_ids: string[],
  ) => Promise<Record<string, string | undefined>>;
  projectTitle?: (project_id: string) => string | undefined;
}): GpuCostDashboardApi & { reportCompromised: ReportCompromised } {
  return {
    scope: "funded",
    pods: async () => {
      const result = await gpu.pods(
        withTimeout({ scope: "managed" as const, include_ended: true }),
      );
      const records = (result.records ?? []).filter(
        (pod) => pod.key_owner_account_id === viewerAccountId,
      );
      const found = names
        ? await names([
            ...new Set(records.map((pod) => pod.beneficiary_account_id)),
          ]).catch(() => ({}) as Record<string, string | undefined>)
        : {};
      return records.map(
        (pod): DashboardPod => ({
          ...pod,
          beneficiary_name: found[pod.beneficiary_account_id],
        }),
      );
    },
    spend: async ({ since, group_by }) =>
      await gpu.spend(withTimeout({ since, group_by })),
    budget: async () => await gpu.budget(withTimeout({})),
    terminate: async ({ pod_id }) =>
      await gpu.terminate(withTimeout({ pod_id })),
    killSwitch: async () => await gpu.killSwitch(withTimeout({})),
    resume: async () =>
      await gpu.resume(withTimeout({ browser_id: browserId ?? null })),
    reportCompromised: async ({ confirm_cocalc_only }) =>
      await gpu.reportCompromised(
        withTimeout({ confirm_cocalc_only, browser_id: browserId ?? null }),
      ),
    alerts: async () => await gpu.alerts(withTimeout({})),
    acknowledgeAlert: async ({ id }) =>
      await gpu.acknowledgeAlert(withTimeout({ id })),
    releaseQuarantined: async ({ pod_id }) =>
      await gpu.releaseQuarantined(
        withTimeout({ pod_id, browser_id: browserId ?? null }),
      ),
    names,
    projectTitle,
  };
}
