import { isValidUUID } from "@cocalc/util/misc";

function isLiteScopedEnvProject(projectId: string): boolean {
  const mode = `${process.env.COCALC_DEV_ENV_MODE ?? ""}`.trim().toLowerCase();
  const liteConnection =
    `${process.env.COCALC_LITE_CONNECTION_INFO ?? ""}`.trim();
  if (mode !== "lite" && !liteConnection) {
    return false;
  }
  const envProjectId = `${process.env.COCALC_PROJECT_ID ?? ""}`.trim();
  return isValidUUID(envProjectId) && envProjectId === projectId;
}

export function isProjectScopedRemoteForProject(
  remote: {
    user?: {
      project_id?: string | null;
    } | null;
  },
  projectId: string | null | undefined,
): boolean {
  const normalizedProjectId = `${projectId ?? ""}`.trim();
  if (!isValidUUID(normalizedProjectId)) {
    return false;
  }
  const remoteProjectId = `${remote.user?.project_id ?? ""}`.trim();
  return (
    remoteProjectId === normalizedProjectId ||
    isLiteScopedEnvProject(normalizedProjectId)
  );
}
