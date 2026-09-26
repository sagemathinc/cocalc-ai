import { isValidUUID } from "@cocalc/util/misc";
import { openCurrentProjectConnection } from "../../api/current-project";

export interface CommandContextOptions {
  // The operation needs only project data, not account/control-plane APIs.
  projectOnly?: { projectIdentifier?: string };
}

export async function openProjectOnlyContextConnection({
  projectOnly,
  apiBaseUrl,
  timeoutMs,
  agentMode,
  explicitTransport,
  explicitAuth,
  disableEnvAuthDefaults,
  env = process.env,
  connect = openCurrentProjectConnection,
}: CommandContextOptions & {
  apiBaseUrl: string;
  timeoutMs: number;
  agentMode: boolean;
  explicitTransport: boolean;
  explicitAuth?: boolean;
  disableEnvAuthDefaults?: boolean;
  env?: NodeJS.ProcessEnv;
  connect?: typeof openCurrentProjectConnection;
}) {
  const projectId = `${env.COCALC_PROJECT_ID ?? ""}`.trim();
  const target = `${projectOnly?.projectIdentifier ?? ""}`.trim();
  if (
    !projectOnly ||
    !agentMode ||
    explicitTransport ||
    explicitAuth ||
    disableEnvAuthDefaults ||
    !env.CONAT_SERVER?.trim() ||
    !isValidUUID(projectId) ||
    (target && target !== projectId)
  ) {
    return;
  }
  // Network-disabled projects can reach their host-local Conat service, not
  // necessarily the public hub. Keep the same runtime credential and scope.
  return await connect({ apiBaseUrl, projectId, timeoutMs });
}
