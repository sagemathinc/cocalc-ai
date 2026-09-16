/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { useMemo } from "react";
import {
  useHostInfo,
  useProjectHostConnectionState,
} from "@cocalc/frontend/projects/host-info";
import { evaluateHostOperational } from "@cocalc/frontend/projects/host-operational";

export function useProjectPageHostState(
  hostId?: string,
  opts?: { enabled?: boolean },
) {
  const hostInfo = useHostInfo(hostId, opts);
  const hostOperational = useMemo(
    () => evaluateHostOperational(hostInfo),
    [hostInfo],
  );
  // An unavailable reason can make the operational result omit status.
  // Startup timing must still observe the host's actual status transition.
  const hostStatus = `${hostInfo?.get("status") ?? ""}`.trim().toLowerCase();
  const projectHostConnection = useProjectHostConnectionState(
    hostId,
    hostStatus,
  );
  return { hostInfo, hostOperational, projectHostConnection };
}
