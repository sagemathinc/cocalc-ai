import { isValidUUID } from "@cocalc/util/misc";

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
  return remoteProjectId === normalizedProjectId;
}
