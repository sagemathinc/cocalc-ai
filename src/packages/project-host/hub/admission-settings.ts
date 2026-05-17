/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  setServiceAdmissionLimitOverrides,
  setServiceAdmissionNearLimitConfig,
} from "@cocalc/conat/admission/limits";
import { hubApi } from "@cocalc/lite/hub/api";
import getLogger from "@cocalc/backend/logger";

const logger = getLogger("project-host:hub:admission-settings");
const REFRESH_MS = 30_000;

let refreshStarted = false;

export function startProjectHostConatAdmissionSettingsRefresh(): void {
  if (refreshStarted) {
    return;
  }
  refreshStarted = true;
  const refresh = () => {
    void hubApi.system
      .getServiceAdmissionConfig()
      .then((config) => {
        setServiceAdmissionLimitOverrides(config.limits);
        setServiceAdmissionNearLimitConfig(config.near_limit);
      })
      .catch((err) => {
        logger.debug("failed to refresh Conat admission settings", {
          err: `${err}`,
        });
      });
  };
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref?.();
}
