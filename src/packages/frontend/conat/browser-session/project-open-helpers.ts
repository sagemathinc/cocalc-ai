import { redux } from "@cocalc/frontend/app-framework";
import { isValidUUID } from "@cocalc/util/misc";
import { requireAbsolutePath } from "./common-utils";

export async function openFileInProject({
  project_id,
  path,
  foreground = true,
  foreground_project = true,
}: {
  project_id: string;
  path: string;
  foreground?: boolean;
  foreground_project?: boolean;
}): Promise<{ ok: true }> {
  if (!isValidUUID(project_id)) {
    throw Error("project_id must be a UUID");
  }
  const cleanPath = `${path ?? ""}`.trim();
  if (!cleanPath) {
    throw Error("path must be specified");
  }
  const projectsActions = redux.getActions("projects") as any;
  if (!projectsActions?.open_project) {
    throw Error("projects actions unavailable");
  }
  await projectsActions.open_project({
    project_id,
    switch_to: !!foreground_project,
    restore_session: false,
  });
  const projectActions = redux.getProjectActions(project_id) as any;
  if (!projectActions?.open_file) {
    throw Error(`project actions unavailable for ${project_id}`);
  }
  await projectActions.open_file({
    path: cleanPath,
    foreground: !!foreground,
    foreground_project: !!foreground_project,
  });
  return { ok: true };
}

export async function closeFileInProject({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<{ ok: true }> {
  if (!isValidUUID(project_id)) {
    throw Error("project_id must be a UUID");
  }
  const cleanPath = `${path ?? ""}`.trim();
  if (!cleanPath) {
    throw Error("path must be specified");
  }
  const projectActions = redux.getProjectActions(project_id) as any;
  if (!projectActions?.close_file) {
    throw Error(`project actions unavailable for ${project_id}`);
  }
  projectActions.close_file(cleanPath);
  return { ok: true };
}

export async function getEditorActionsForPath({
  project_id,
  path,
  foreground = false,
  foreground_project = false,
  timeout_ms = 15_000,
}: {
  project_id: string;
  path: string;
  foreground?: boolean;
  foreground_project?: boolean;
  timeout_ms?: number;
}): Promise<any> {
  if (!isValidUUID(project_id)) {
    throw Error("project_id must be a UUID");
  }
  const cleanPath = requireAbsolutePath(path);
  await openFileInProject({
    project_id,
    path: cleanPath,
    foreground,
    foreground_project,
  });
  const started = Date.now();
  while (Date.now() - started < timeout_ms) {
    const editorActions = redux.getEditorActions(project_id, cleanPath) as any;
    if (editorActions != null) {
      return editorActions;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error(`editor actions unavailable for ${cleanPath}`);
}

export async function getJupyterActionsForPath({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<any> {
  if (!isValidUUID(project_id)) {
    throw Error("project_id must be a UUID");
  }
  const cleanPath = `${path ?? ""}`.trim();
  if (!cleanPath) {
    throw Error("notebook path must be specified");
  }
  if (!cleanPath.startsWith("/")) {
    throw Error("notebook path must be absolute");
  }
  if (!cleanPath.toLowerCase().endsWith(".ipynb")) {
    throw Error("notebook path must end with .ipynb");
  }
  const editorActions = await getEditorActionsForPath({
    project_id,
    path: cleanPath,
    foreground: false,
    foreground_project: false,
  });
  const jupyterActions = editorActions?.jupyter_actions;
  if (jupyterActions == null) {
    throw Error(`jupyter actions unavailable for ${cleanPath}`);
  }
  if (typeof jupyterActions.wait_until_ready === "function") {
    await jupyterActions.wait_until_ready();
  }
  return jupyterActions;
}
