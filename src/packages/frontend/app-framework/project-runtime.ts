/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { loadWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import type { AppRedux } from "./index";
import type { ProjectStore } from "../project/redux/store";

type ProjectStoreInitializer = (
  projectId: string,
  redux: AppRedux,
) => ProjectStore;

let initializer: ProjectStoreInitializer | undefined;
let loadPromise: Promise<void> | undefined;

export function registerProjectStoreInitializer(
  next: ProjectStoreInitializer,
): void {
  if (initializer != null && initializer !== next) {
    throw Error("project store initializer is already registered");
  }
  initializer = next;
}

export function initializeProjectStore(
  projectId: string,
  redux: AppRedux,
): ProjectStore {
  if (initializer == null) {
    throw Error(
      "project runtime is not loaded; call ensureProjectReduxRuntime first",
    );
  }
  return initializer(projectId, redux);
}

export async function ensureProjectReduxRuntime(): Promise<void> {
  if (initializer != null) return;
  if (loadPromise == null) {
    loadPromise = loadWithRetry(
      async () => {
        // Editor registration can import project actions through an editor.
        // Complete it before importing the actions class for this runtime.
        await import("../editors/register-all");
        // Load actions first. The project store needs its class and query
        // definitions, and its production chunk can otherwise evaluate with
        // an incomplete actions module while restoring a project session.
        const projectActions = await import("../project/redux/actions");
        const { init } = await import("../project/redux/store");
        return {
          init: (projectId: string, redux: AppRedux) =>
            init(projectId, redux, projectActions),
        };
      },
      { name: "project Redux runtime" },
    )
      .then(({ init }) => registerProjectStoreInitializer(init))
      .catch((err) => {
        loadPromise = undefined;
        throw err;
      });
  }
  await loadPromise;
}
