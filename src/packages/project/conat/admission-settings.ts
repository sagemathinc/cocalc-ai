/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  setServiceAdmissionLimitOverrides,
  setServiceAdmissionNearLimitConfig,
} from "@cocalc/conat/admission/limits";
import {
  setServiceAdmissionDenialRecorder,
  setServiceAdmissionNearLimitRecorder,
  type ServiceAdmissionDenialEvent,
} from "@cocalc/conat/admission/denials";
import { getLogger } from "@cocalc/project/logger";
import { getProjectHubApi } from "./hub";
import { project_id } from "@cocalc/project/data";

const logger = getLogger("project:conat:admission-settings");
const REFRESH_MS = 30_000;

let refreshStarted = false;

function configureTelemetryRecorders(): void {
  setServiceAdmissionDenialRecorder(
    async (event: ServiceAdmissionDenialEvent) => {
      await getProjectHubApi().system.recordServiceAdmissionDenial({
        ...event,
        project_id,
      });
    },
  );
  setServiceAdmissionNearLimitRecorder(
    async (event: ServiceAdmissionDenialEvent) => {
      await getProjectHubApi().system.recordServiceAdmissionNearLimit({
        ...event,
        project_id,
      });
    },
  );
}

export function startProjectConatAdmissionSettingsRefresh(): void {
  if (refreshStarted) {
    return;
  }
  refreshStarted = true;
  configureTelemetryRecorders();
  const refresh = () => {
    void getProjectHubApi()
      .system.getServiceAdmissionConfig()
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
