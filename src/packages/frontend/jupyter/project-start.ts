import { once, until } from "@cocalc/util/async-utils";

import type { ProjectState } from "@cocalc/util/db-schema/projects";
import { lite } from "@cocalc/frontend/lite";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  getProjectStartPolicyBlock,
  throwProjectStartPolicyBlock,
} from "@cocalc/frontend/projects/runtime-start-policy";

export async function ensureProjectRunningForJupyter({
  redux,
  project_id,
  isClosed,
  getProjectState,
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
  getProjectState?: (project_id: string) => Promise<ProjectState | undefined>;
}): Promise<{ initialState?: string; started: boolean; wasRunning: boolean }> {
  if (lite) {
    return { initialState: "running", started: false, wasRunning: true };
  }
  const store = redux.getStore("projects");
  const getFreshProjectState = async (): Promise<string | undefined> => {
    try {
      return (await (getProjectState ?? defaultGetProjectState)(project_id))
        ?.state;
    } catch {
      return undefined;
    }
  };
  const state = (await getFreshProjectState()) ?? store.get_state(project_id);
  let started = false;
  if (state !== "running" && state !== "starting" && !isClosed()) {
    const accountStore = redux.getStore("account");
    const block = getProjectStartPolicyBlock({
      project: store.getIn?.(["project_map", project_id]),
      account_id: accountStore?.get?.("account_id"),
      is_admin: !!accountStore?.get?.("is_admin"),
      autostart: true,
    });
    if (block) {
      throwProjectStartPolicyBlock(block);
    }
    await redux
      .getActions("projects")
      .start_project(project_id, { autostart: true });
    started = true;
  }
  await until(
    async () => {
      const freshState = await getFreshProjectState();
      if (
        freshState == "running" ||
        (freshState == null && store.get_state(project_id) == "running") ||
        isClosed()
      ) {
        return true;
      }
      await waitForProjectStoreChangeOrTimeout(store);
      return false;
    },
    { min: 500, max: 500 },
  );
  return { initialState: state, started, wasRunning: state === "running" };
}

async function defaultGetProjectState(
  project_id: string,
): Promise<ProjectState | undefined> {
  return await webapp_client.conat_client.hub.projects.getProjectState({
    project_id,
  });
}

async function waitForProjectStoreChangeOrTimeout(store): Promise<void> {
  if (store == null || typeof store.once !== "function") {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return;
  }
  await Promise.race([
    once(store as any, "change"),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
}
