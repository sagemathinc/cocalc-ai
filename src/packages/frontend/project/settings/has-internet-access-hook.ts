/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import {
  useEffect,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { PLATFORM_MODE_SINGLE_NODE } from "@cocalc/util/db-schema/site-defaults";
import { useRunQuota } from "./run-quota/hooks";

function legacyEnabledByDefault(value: unknown): boolean {
  return value !== false && value !== 0;
}

// this reacts to changes of settings, user contributions, and licenses
export function useProjectHasInternetAccess(
  project_id: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [state, set_state] = useState<boolean>(false);
  const platformMode = useTypedRedux("customize", "platform_mode");
  const singleNodePlatform = platformMode === PLATFORM_MODE_SINGLE_NODE;
  const runQuota = useRunQuota(project_id, null, { enabled });

  useEffect(() => {
    if (!enabled) {
      set_state(false);
      return;
    }
    // Single-node/self-contained deployments historically do not report this
    // through run quota; assume project internet access is available.
    if (singleNodePlatform) {
      set_state(true);
      return;
    }
    // otherwise, we use the run quota information, which is set server-side after processing
    // the default quotas and any licenses/upgrades on top of it.
    set_state(legacyEnabledByDefault(runQuota?.network));
  }, [enabled, singleNodePlatform, runQuota?.network]);

  return state;
}
