import type { Client } from "@cocalc/conat/core/client";
import { extractProjectSubject } from "@cocalc/conat/auth/subject-policy";
import getLogger from "@cocalc/backend/logger";
import { touchProjectLastEdited } from "./last-edited";

const logger = getLogger("project-host:touch-service");

export const PROJECT_TOUCH_SUBJECT = "project.*.touch.-";

export async function handleProjectTouchRequest(this: {
  subject?: string;
}): Promise<null> {
  const subject = `${this?.subject ?? ""}`;
  const project_id = extractProjectSubject(subject);
  if (!project_id) {
    throw new Error(`invalid project touch subject '${subject}'`);
  }
  await touchProjectLastEdited(project_id, "browser-touch");
  return null;
}

export async function initProjectTouchService(client: Client) {
  logger.debug("starting project touch service", {
    subject: PROJECT_TOUCH_SUBJECT,
  });
  return await client.service(PROJECT_TOUCH_SUBJECT, {
    touch: handleProjectTouchRequest,
  });
}
