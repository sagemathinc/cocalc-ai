/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { handleProjectControlStart } from "@cocalc/server/inter-bay/project-control";
import { projectControlSubject } from "@cocalc/server/inter-bay/subjects";

const logger = getLogger("server:inter-bay:service");

let serviceStarted = false;

export async function initInterBayServices(): Promise<void> {
  if (serviceStarted) {
    return;
  }
  serviceStarted = true;
  try {
    await startProjectControlStartService();
  } catch (err) {
    serviceStarted = false;
    throw err;
  }
}

async function startProjectControlStartService(): Promise<void> {
  const subject = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "start",
  });
  logger.debug("starting inter-bay project-control listener", { subject });
  const client = conat({ noCache: true });
  const sub = await client.subscribe(subject, { queue: "0" });
  (async () => {
    for await (const mesg of sub) {
      try {
        await handleProjectControlStart(mesg.data);
        mesg.respond(null, { noThrow: true });
      } catch (err) {
        mesg.respond(
          { error: err instanceof Error ? err.message : `${err}` },
          { noThrow: true },
        );
      }
    }
  })().catch((err) => {
    logger.warn("inter-bay project-control listener stopped", {
      subject,
      err: `${err}`,
    });
    serviceStarted = false;
  });
}
