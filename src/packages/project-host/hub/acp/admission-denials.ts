/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import callHub from "@cocalc/conat/hub/call-hub";
import { setAcpAdmissionDenialRecorder } from "@cocalc/lite/hub/acp";
import { getMasterConatClient } from "../../master-status";
import { getLocalHostId } from "../../sqlite/hosts";

const logger = getLogger("project-host:hub:acp:admission-denials");

export function configureProjectHostAcpAdmissionDenialRecorder(): void {
  setAcpAdmissionDenialRecorder(async (event) => {
    const client = getMasterConatClient();
    const host_id =
      `${process.env.PROJECT_HOST_ID ?? ""}`.trim() || getLocalHostId();
    const project_id = `${event.project_id ?? ""}`.trim();
    if (!client || !host_id || !project_id) {
      logger.debug("skipping ACP admission denial telemetry", {
        has_client: !!client,
        has_host_id: !!host_id,
        has_project_id: !!project_id,
        limit: event.limit,
        source: event.source,
      });
      return;
    }
    await callHub({
      client,
      host_id,
      name: "hosts.recordAcpAdmissionDenial",
      args: [
        {
          host_id,
          account_id: event.account_id,
          project_id,
          path: event.path,
          thread_id: event.thread_id,
          limit: event.limit,
          current: event.current,
          maximum: event.maximum,
          source: event.source,
          time: event.time,
        },
      ],
      timeout: 5_000,
    });
  });
}
