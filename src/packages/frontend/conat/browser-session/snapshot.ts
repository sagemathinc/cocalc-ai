/*
Browser-session snapshot helpers for open projects/files metadata.
*/

import { redux, project_redux_name } from "@cocalc/frontend/app-framework";
import type { WebappClient } from "@cocalc/frontend/client/client";
import type { BrowserOpenProjectState } from "@cocalc/conat/hub/api/system";
import type { BrowserOpenFileInfo } from "@cocalc/conat/service/browser-session";
import { isValidUUID } from "@cocalc/util/misc";
import { asStringArray, toAbsolutePath } from "./common-utils";

export function getActiveProjectIdFallback(
  openProjectIds: string[],
): string | undefined {
  const activeTopTab = `${redux.getStore("page")?.get("active_top_tab") ?? ""}`;
  if (isValidUUID(activeTopTab)) {
    return activeTopTab;
  }
  return openProjectIds[0];
}

export function collectOpenProjects({
  maxOpenProjects = 64,
  maxOpenFilesPerProject = 256,
}: {
  maxOpenProjects?: number;
  maxOpenFilesPerProject?: number;
} = {}): BrowserOpenProjectState[] {
  const projectsStore = redux.getStore("projects");
  const openProjectIds = asStringArray(projectsStore?.get("open_projects")).slice(
    0,
    maxOpenProjects,
  );
  const out: BrowserOpenProjectState[] = [];
  for (const project_id of openProjectIds) {
    if (!isValidUUID(project_id)) continue;
    const projectStore = redux.getStore(project_redux_name(project_id));
    if (!projectStore) continue;
    const files = asStringArray(projectStore.get("open_files_order"))
      .map(toAbsolutePath)
      .slice(0, maxOpenFilesPerProject);
    const title = `${projectsStore?.getIn(["project_map", project_id, "title"]) ?? ""}`.trim();
    out.push({
      project_id,
      ...(title ? { title } : {}),
      open_files: files,
    });
  }
  return out;
}

export function flattenOpenFiles(
  open_projects: BrowserOpenProjectState[],
): BrowserOpenFileInfo[] {
  const files: BrowserOpenFileInfo[] = [];
  for (const project of open_projects) {
    for (const path of project.open_files ?? []) {
      const absolute_path = toAbsolutePath(path);
      files.push({
        project_id: project.project_id,
        ...(project.title ? { title: project.title } : {}),
        // path is now absolute across frontend/backend/cli.
        path: absolute_path,
      });
    }
  }
  return files;
}

export function buildSessionSnapshot(
  client: WebappClient,
  opts?: { maxOpenProjects?: number; maxOpenFilesPerProject?: number },
): {
  browser_id: string;
  session_name?: string;
  url?: string;
  active_project_id?: string;
  open_projects: BrowserOpenProjectState[];
} {
  const open_projects = collectOpenProjects({
    maxOpenProjects: opts?.maxOpenProjects,
    maxOpenFilesPerProject: opts?.maxOpenFilesPerProject,
  });
  const active_project_id = getActiveProjectIdFallback(
    open_projects.map((x) => x.project_id),
  );
  const session_name =
    typeof document !== "undefined" ? document.title?.trim() || undefined : undefined;
  const url = typeof location !== "undefined" ? location.href : undefined;
  return {
    browser_id: client.browser_id,
    ...(session_name ? { session_name } : {}),
    ...(url ? { url } : {}),
    ...(active_project_id ? { active_project_id } : {}),
    open_projects,
  };
}
