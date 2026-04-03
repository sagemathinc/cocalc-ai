/*
Broadcast project status whenever it updates.
*/

import { projectSubject } from "@cocalc/conat/names";
import { getLogger } from "@cocalc/conat/logger";
import type {
  Client as ConatClient,
  Subscription,
} from "@cocalc/conat/core/client";

const SERVICE_NAME = "project-status";
const logger = getLogger("project:project-status");

function requireClient(client?: ConatClient): ConatClient {
  if (client == null) {
    throw new Error(
      "project-status helpers must provide an explicit Conat client",
    );
  }
  return client;
}

function getSubject({ project_id }: { project_id: string }) {
  return projectSubject({
    project_id,
    service: SERVICE_NAME,
  });
}

// publishes status updates when they are emitted.
export async function createPublisher({
  client,
  project_id,
  projectStatusServer,
}: {
  client: ConatClient;
  project_id: string;
  projectStatusServer;
}) {
  const subject = getSubject({ project_id });
  logger.debug("publishing status updates on ", { subject });
  projectStatusServer.on("status", (status) => {
    logger.debug("publishing updated status", status);
    requireClient(client).publishSync(subject, status);
  });
}

// async iterator over the status updates:
export async function get({
  client,
  project_id,
}: {
  client: ConatClient;
  project_id: string;
}): Promise<Subscription> {
  const subject = getSubject({ project_id });
  return await requireClient(client).subscribe(subject);
}
