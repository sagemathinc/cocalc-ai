import { once, until } from "@cocalc/util/async-utils";

import { lite } from "@cocalc/frontend/lite";

export async function ensureProjectRunningForJupyter({
  redux,
  project_id,
  isClosed,
}: {
  redux: {
    getStore: (name: string) => {
      get_state: (project_id: string) => string | undefined;
    };
    getActions: (name: string) => {
      start_project: (project_id: string) => Promise<void> | void;
    };
  };
  project_id: string;
  isClosed: () => boolean;
}): Promise<void> {
  if (lite) {
    return;
  }
  const store = redux.getStore("projects");
  const state = store.get_state(project_id);
  if (state !== "running" && state !== "starting" && !isClosed()) {
    await redux.getActions("projects").start_project(project_id);
  }
  await until(
    async () => {
      if (store.get_state(project_id) == "running" || isClosed()) {
        return true;
      }
      await once(store as any, "change");
      return false;
    },
    { min: 500, max: 500 },
  );
}
