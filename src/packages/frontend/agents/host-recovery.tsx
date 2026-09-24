/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import { redux, useProjectFromMap } from "@cocalc/frontend/app-framework";
import { HostRecoveryBanner } from "@cocalc/frontend/project/page/host-recovery-banner";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import {
  evaluateHostOperational,
  getHostRecoveryDisplay,
  hostLabel,
  isHostRecoveryTransient,
} from "@cocalc/frontend/projects/host-operational";

export function AgentHostRecovery({ projectId }: { projectId: string }) {
  const project = useProjectFromMap<any>(projectId);
  const hostId = project?.get("host_id") as string | undefined;
  const hostInfo = useHostInfo(hostId);
  const [now, setNow] = useState(Date.now());
  const recovery = getHostRecoveryDisplay(hostInfo, now);
  const hostOperational = evaluateHostOperational(hostInfo);
  const projectState = project?.getIn(["state", "state"]);
  const visible =
    !!hostId &&
    recovery.active &&
    (projectState !== "running" || hostOperational.state !== "operational");

  useEffect(() => {
    if (!visible || !hostId) return;
    const refresh = () => {
      setNow(Date.now());
      void redux.getActions("projects")?.ensure_host_info(hostId, true);
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [hostId, visible]);

  if (!visible) return null;
  return (
    <HostRecoveryBanner
      assignedHostLabel={hostLabel(hostInfo, hostId)}
      canReconnectAutomatically={isHostRecoveryTransient(hostInfo)}
      hostUnavailableReason={
        hostOperational.reason ?? "Assigned host is unavailable."
      }
      onCheckStatus={async () => {
        await redux.getActions("projects")?.ensure_host_info(hostId, true);
        setNow(Date.now());
      }}
      recovery={recovery}
    />
  );
}
