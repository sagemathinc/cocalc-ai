/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import {
  setServiceAdmissionDenialRecorder,
  type ServiceAdmissionDenialEvent,
} from "@cocalc/conat/admission/denials";
import callHub from "@cocalc/conat/hub/call-hub";
import { getMasterConatClient } from "../master-status";
import { getLocalHostId } from "../sqlite/hosts";

const logger = getLogger("project-host:hub:service-admission-denials");

export function configureProjectHostServiceAdmissionDenialRecorder(): void {
  setServiceAdmissionDenialRecorder(
    async (event: ServiceAdmissionDenialEvent) => {
      const client = getMasterConatClient();
      const host_id =
        `${event.host_id ?? process.env.PROJECT_HOST_ID ?? ""}`.trim() ||
        getLocalHostId();
      const project_id = `${event.project_id ?? ""}`.trim();
      if (!client || !host_id || !project_id) {
        logger.debug("skipping service admission denial telemetry", {
          has_client: !!client,
          has_host_id: !!host_id,
          has_project_id: !!project_id,
          surface: event.surface,
          limit: event.limit,
        });
        return;
      }
      await callHub({
        client,
        host_id,
        name: "hosts.recordServiceAdmissionDenial",
        args: [{ ...event, host_id, project_id }],
        timeout: 5_000,
      });
    },
  );
}
