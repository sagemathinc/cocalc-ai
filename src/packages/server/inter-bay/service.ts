/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  resolveHostBayDirect,
  resolveProjectBayDirect,
} from "@cocalc/server/inter-bay/directory";
import { handleProjectControlStart } from "@cocalc/server/inter-bay/project-control";
import {
  directorySubject,
  projectControlSubject,
} from "@cocalc/server/inter-bay/subjects";

const logger = getLogger("server:inter-bay:service");

let serviceStarted = false;

export async function initInterBayServices(): Promise<void> {
  if (serviceStarted) {
    return;
  }
  serviceStarted = true;
  try {
    await startDirectoryService();
    await startProjectControlStartService();
  } catch (err) {
    serviceStarted = false;
    throw err;
  }
}

async function startDirectoryService(): Promise<void> {
  await Promise.all([
    startRequestReplyService({
      subject: directorySubject({ method: "resolve-project-bay" }),
      handler: async (data) =>
        resolveProjectBayDirect(`${data?.project_id ?? ""}`),
    }),
    startRequestReplyService({
      subject: directorySubject({ method: "resolve-host-bay" }),
      handler: async (data) => resolveHostBayDirect(`${data?.host_id ?? ""}`),
    }),
  ]);
}

async function startProjectControlStartService(): Promise<void> {
  await startRequestReplyService({
    subject: projectControlSubject({
      dest_bay: getConfiguredBayId(),
      method: "start",
    }),
    handler: async (data) => {
      await handleProjectControlStart(data);
      return null;
    },
  });
}

async function startRequestReplyService({
  subject,
  handler,
}: {
  subject: string;
  handler: (data: any) => Promise<any>;
}): Promise<void> {
  logger.debug("starting inter-bay listener", { subject });
  const client = conat({ noCache: true });
  const sub = await client.subscribe(subject, { queue: "0" });
  (async () => {
    for await (const mesg of sub) {
      try {
        const result = await handler(mesg.data);
        mesg.respond(result, { noThrow: true });
      } catch (err) {
        mesg.respond(
          { error: err instanceof Error ? err.message : `${err}` },
          { noThrow: true },
        );
      }
    }
  })().catch((err) => {
    logger.warn("inter-bay listener stopped", {
      subject,
      err: `${err}`,
    });
    serviceStarted = false;
  });
}
