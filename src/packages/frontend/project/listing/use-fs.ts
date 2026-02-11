/*
Hook for getting a FilesystemClient.
*/
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { type FilesystemClient } from "@cocalc/conat/files/fs";
import { useMemo } from "react";
import { useRedux, useTypedRedux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import { normalizeAbsolutePath } from "@cocalc/util/path-model";
import { selectFsService } from "@cocalc/frontend/project/fs-router";

// this will probably get more complicated temporarily when we
// are transitioning between filesystems (hence why we return null in
// the typing for now)
export default function useFs({
  project_id,
  path = "/",
}: {
  project_id: string;
  path?: string;
}): FilesystemClient {
  const projectState = useRedux([
    "projects",
    "project_map",
    project_id,
    "state",
    "state",
  ]) as string | undefined;
  const availableFeatures = useTypedRedux({ project_id }, "available_features");
  const homeDirectory = useMemo(() => {
    if (!lite) {
      return "/root";
    }
    const homeFromFeatures = availableFeatures?.get?.("homeDirectory");
    if (typeof homeFromFeatures === "string" && homeFromFeatures.length > 0) {
      return normalizeAbsolutePath(homeFromFeatures);
    }
    return "/";
  }, [availableFeatures]);
  const projectRunning = lite || projectState === "running";

  return useMemo<FilesystemClient>(
    () => {
      const decision = selectFsService(path, {
        lite,
        projectRunning,
        homeDirectory,
      });
      if ((globalThis as any)?.__COCALC_FS_ROUTER_DEBUG) {
        console.log("[fs-router] useFs", { project_id, path, decision });
      }
      // TODO: route to distinct in-project fs service for project_runtime.
      return webapp_client.conat_client.conat().fs({
        project_id,
      });
    },
    [project_id, path, homeDirectory, projectRunning],
  );
}
