/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// The key owner's GPU dashboard in Settings → Connectors → RunPod GPUs.

import { useMemo } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { MAX_GET_NAMES_ACCOUNT_IDS } from "@cocalc/util/security-limits";
import { GpuCostDashboard } from "./cost-dashboard";
import { hubGpuDashboardApi } from "./hub-dashboard-api";
import { ReportCompromisedKey } from "./report-compromised";
import { GpuAlertsOnly } from "./alerts-only";

async function accountNames(
  account_ids: string[],
): Promise<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (let i = 0; i < account_ids.length; i += MAX_GET_NAMES_ACCOUNT_IDS) {
    const found = await webapp_client.users_client.getNames(
      account_ids.slice(i, i + MAX_GET_NAMES_ACCOUNT_IDS),
    );
    for (const [id, name] of Object.entries(found)) {
      if (name == null) continue;
      result[id] =
        name.display_name ||
        `${name.first_name ?? ""} ${name.last_name ?? ""}`.trim() ||
        undefined;
    }
  }
  return result;
}

function projectTitle(project_id: string): string | undefined {
  const title = redux
    .getStore("projects")
    ?.getIn(["project_map", project_id, "title"]);
  return typeof title === "string" && title ? title : undefined;
}

export function RunpodDashboardSection({
  account_id,
  onKeyChanged,
}: {
  account_id: string;
  // the key's state may have changed (e.g. a compromise report closed it)
  onKeyChanged?: () => void;
}) {
  const api = useMemo(
    () =>
      hubGpuDashboardApi({
        gpu: webapp_client.conat_client.hub.gpu,
        viewerAccountId: account_id,
        browserId: webapp_client.browser_id,
        names: accountNames,
        projectTitle,
      }),
    [account_id],
  );
  // Keyed by account: nothing of another account's survives a switch.
  return (
    <div style={{ marginTop: 20 }} key={account_id}>
      <GpuCostDashboard api={api} viewerAccountId={account_id} />
      <ReportCompromisedKey
        report={api.reportCompromised}
        onReported={() => onKeyChanged?.()}
      />
    </div>
  );
}

// While no key is connected: only the alerts that still need the owner.
export function RunpodAlertsSection({ account_id }: { account_id: string }) {
  const api = useMemo(
    () =>
      hubGpuDashboardApi({
        gpu: webapp_client.conat_client.hub.gpu,
        viewerAccountId: account_id,
        browserId: webapp_client.browser_id,
      }),
    [account_id],
  );
  return <GpuAlertsOnly key={account_id} api={api} />;
}
