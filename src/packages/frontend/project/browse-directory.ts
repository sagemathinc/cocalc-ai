import { redux } from "@cocalc/frontend/app-framework";

/** Bring the file browser forward, including when invoked from an overlay. */
export async function browseProjectDirectory(projectId: string, path: string) {
  await redux.getProjectActions(projectId).open_directory(path);
  await redux.getActions("page").set_active_tab(projectId);
}
