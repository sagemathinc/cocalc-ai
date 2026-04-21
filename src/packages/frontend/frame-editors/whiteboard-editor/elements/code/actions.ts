/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { reuseInFlight } from "@cocalc/util/reuse-in-flight";
import { delay } from "awaiting";

import { redux } from "@cocalc/frontend/app-framework";
import type { JupyterEditorActions } from "@cocalc/frontend/frame-editors/jupyter-editor/actions";
import { createInitialIpynbContent } from "@cocalc/frontend/jupyter/new-notebook";
import type { JupyterActions } from "@cocalc/frontend/jupyter/browser-actions";
import { once } from "@cocalc/util/async-utils";
import { aux_file } from "@cocalc/util/misc";

export type { JupyterActions };

async function getJupyterActions0({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<JupyterActions> {
  const actions = await getJupyterFrameEditorActions({ project_id, path });
  const { jupyter_actions } = actions;
  if (jupyter_actions.syncdb.get_state() != "ready") {
    await once(jupyter_actions.syncdb, "ready");
  }
  return jupyter_actions;
}

// very important to debounce, since we create an event listener (via the once) above.
type F = (X: { project_id: string; path: string }) => Promise<JupyterActions>;
export const getJupyterActions: F = reuseInFlight(getJupyterActions0);

async function ensureAuxNotebookExists({
  project_id,
  aux_path,
}: {
  project_id: string;
  aux_path: string;
}): Promise<void> {
  const projectActions = redux.getProjectActions(project_id);
  const fs = projectActions.fs();
  try {
    if (await fs.exists(aux_path)) {
      const content = await fs.readFile(aux_path);
      if (Buffer.from(content).length > 0) {
        return;
      }
    }
  } catch (err) {
    if ((err as any)?.code !== "ENOENT") {
      throw err;
    }
  }
  const preferredKernel = redux
    .getStore("account")
    ?.getIn(["editor_settings", "jupyter", "kernel"]);
  await projectActions.ensureContainingDirectoryExists(aux_path);
  await fs.writeFile(
    aux_path,
    await createInitialIpynbContent(project_id, preferredKernel),
  );
}

export async function getJupyterFrameEditorActions({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<JupyterEditorActions> {
  const aux_path = pathToIpynb(path);
  let actions = redux.getEditorActions(project_id, aux_path) as
    | JupyterEditorActions
    | undefined;
  if (actions == null) {
    const projectActions = redux.getProjectActions(project_id);
    await ensureAuxNotebookExists({ project_id, aux_path });
    await projectActions.initFileRedux(aux_path, "ipynb");
    actions = redux.getEditorActions(project_id, aux_path) as
      | JupyterEditorActions
      | undefined;
    for (let i = 0; actions == null && i < 25; i++) {
      await delay(100);
      actions = redux.getEditorActions(project_id, aux_path) as
        | JupyterEditorActions
        | undefined;
    }
  }
  if (actions == null) {
    throw Error("bug -- actions must be defined");
  }
  // do not waste effort on saving the aux ipynb to disk...
  //  actions.jupyter_actions.noSaveToDisk = true;
  return actions;
}

export function openJupyterNotebook({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): void {
  const aux_path = pathToIpynb(path);
  redux
    .getProjectActions(project_id)
    .open_file({ path: aux_path, ext: "ipynb" });
}

export function pathToIpynb(pathToWhiteboard: string): string {
  return aux_file(pathToWhiteboard, "ipynb");
}

export async function getMode({ project_id, path }) {
  return (await getJupyterActions({ project_id, path })).store.get_cm_mode();
}
