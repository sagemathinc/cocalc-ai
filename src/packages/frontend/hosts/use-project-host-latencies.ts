/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useMemo, useState } from "react";

import type { Host } from "@cocalc/conat/hub/api/hosts";
import type { ConnectionTargetSnapshot } from "@cocalc/frontend/conat/client";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const PROJECT_HOST_TARGET_PREFIX = "project-host:";

function projectHostIdFromTarget(
  target: ConnectionTargetSnapshot,
): string | undefined {
  if (target.kind !== "project-host") return;
  if (!target.id.startsWith(PROJECT_HOST_TARGET_PREFIX)) return;
  return target.id.slice(PROJECT_HOST_TARGET_PREFIX.length);
}

export function useProjectHostLatencies(active: boolean, hosts: Host[]) {
  const [latencies, setLatencies] = useState<Record<string, number>>({});
  const hostIdsKey = useMemo(
    () =>
      hosts
        .map((host) => host.id)
        .sort()
        .join("\n"),
    [hosts],
  );

  useEffect(() => {
    if (!active || hosts.length === 0) {
      setLatencies({});
      return;
    }

    const hostIds = new Set(hosts.map((host) => host.id));
    let cancelled = false;

    const probe = async () => {
      const targets = webapp_client.conat_client
        .getConnectionTargets()
        .filter(
          (target) =>
            target.kind === "project-host" &&
            target.status.state === "connected",
        );
      const next: Record<string, number> = {};

      await Promise.all(
        targets.map(async (target) => {
          const hostId = projectHostIdFromTarget(target);
          if (hostId == null || !hostIds.has(hostId)) return;
          try {
            const ping = await webapp_client.conat_client.probeConnectionTarget(
              target.id,
            );
            if (typeof ping === "number") {
              next[hostId] = Math.round(ping);
            }
          } catch {
            // Project-host latency is best-effort diagnostic data.
          }
        }),
      );

      if (!cancelled) {
        setLatencies(next);
      }
    };

    void probe();
    const interval = window.setInterval(() => void probe(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [active, hostIdsKey]);

  return latencies;
}
