import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";

export function createProjectSandboxFilesystem({
  project_id,
  home,
  rootfs,
  scratch,
}: {
  project_id: string;
  home: string;
  rootfs: string;
  scratch: string;
}): SandboxedFilesystem {
  return new SandboxedFilesystem(home, {
    host: project_id,
    rootfs,
    scratch,
    homeAliases: [DEFAULT_PROJECT_RUNTIME_HOME],
  });
}
