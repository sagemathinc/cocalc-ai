import { once, until } from "@cocalc/util/async-utils";

import { lite } from "@cocalc/frontend/lite";
import {
  formatProjectStartPolicyBlock,
  getProjectStartPolicyBlock,
} from "@cocalc/frontend/projects/runtime-start-policy";

export async function ensureProjectRunningForJupyter({
  redux,
  project_id,
  isClosed,
}: {
  redux: {
    getStore: (name: string) => {
      get_state: (project_id: string) => string | undefined;
      get?: (key: string) => any;
      getIn?: (path: string[]) => any;
    };
    getActions: (name: string) => {
      start_project: (
        project_id: string,
        opts?: { autostart?: boolean },
      ) => Promise<void> | void;
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
    const accountStore = redux.getStore("account");
    const block = getProjectStartPolicyBlock({
      project: store.getIn?.(["project_map", project_id]),
      account_id: accountStore?.get?.("account_id"),
      is_admin: !!accountStore?.get?.("is_admin"),
      autostart: true,
    });
    if (block) {
      throw Error(formatProjectStartPolicyBlock(block));
    }
    await redux
      .getActions("projects")
      .start_project(project_id, { autostart: true });
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
