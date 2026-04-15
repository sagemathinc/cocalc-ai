/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type {
  HostManagedComponentRolloutRequest,
  HostManagedComponentRolloutResponse,
  HostManagedComponentRolloutResult,
  ManagedComponentKind,
} from "@cocalc/conat/project-host/api";
import {
  restartManagedLocalConatPersist,
  restartManagedLocalConatRouter,
} from "./daemon";
import { rolloutProjectHostAcpWorker } from "./hub/acp/worker-manager";
import { getManagedComponentStatus } from "./managed-components";
import { scheduleProjectHostRestart } from "./upgrade";

const logger = getLogger("project-host:managed-components:rollout");

function uniqueRequestedComponents(
  components: ManagedComponentKind[],
): ManagedComponentKind[] {
  return [...new Set(components)];
}

function noopResult(
  component: ManagedComponentKind,
  message: string,
): HostManagedComponentRolloutResult {
  return {
    component,
    action: "noop",
    message,
  };
}

export async function rolloutManagedComponents({
  components,
  reason,
}: HostManagedComponentRolloutRequest): Promise<HostManagedComponentRolloutResponse> {
  const requested = uniqueRequestedComponents(components ?? []);
  if (!requested.length) {
    throw new Error(
      "managed component rollout requires at least one component",
    );
  }
  const statusByComponent = new Map(
    getManagedComponentStatus().map((status) => [status.component, status]),
  );
  const results: HostManagedComponentRolloutResult[] = [];
  for (const component of requested) {
    const status = statusByComponent.get(component);
    switch (component) {
      case "project-host":
        await scheduleProjectHostRestart();
        results.push({
          component,
          action: "restart_scheduled",
          message: "scheduled project-host restart",
        });
        break;
      case "conat-router":
        if (!status?.managed) {
          results.push(
            noopResult(
              component,
              "conat router is not running in managed local mode",
            ),
          );
          break;
        }
        restartManagedLocalConatRouter();
        results.push({
          component,
          action: "restarted",
          message: "restarted managed local conat router",
        });
        break;
      case "conat-persist":
        if (!status?.managed) {
          results.push(
            noopResult(
              component,
              "conat persist is not running in managed local mode",
            ),
          );
          break;
        }
        restartManagedLocalConatPersist();
        results.push({
          component,
          action: "restarted",
          message: "restarted managed local conat persist",
        });
        break;
      case "acp-worker": {
        const outcome = await rolloutProjectHostAcpWorker({
          restartReason: reason || "managed_component_rollout",
        });
        results.push({
          component,
          action: outcome.action,
          message: outcome.message,
        });
        break;
      }
      default: {
        const exhaustive: never = component;
        throw new Error(`unsupported managed component: ${exhaustive}`);
      }
    }
  }
  logger.info("managed component rollout requested", {
    components: requested,
    reason,
    results,
  });
  return { results };
}
