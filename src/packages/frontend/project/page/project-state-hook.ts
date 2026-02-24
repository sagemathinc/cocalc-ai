/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */
import {
  useEffect,
  useRedux,
  useState,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import { ProjectStatus } from "@cocalc/frontend/todo-types";
import { normalizeProjectStateForDisplay } from "@cocalc/frontend/projects/host-operational";

// this is a reasonable default in case we have no information yet or project_id is undefined.
export const init = new ProjectStatus({ state: "opened" });

// this tells you what state the project is in
export function useProjectState(project_id: string | undefined): ProjectStatus {
  const [state, set_state] = useState<ProjectStatus>(init);
  const host_info = useTypedRedux("projects", "host_info");

  const project_state = useRedux([
    "projects",
    "project_map",
    project_id ?? "",
    "state",
  ]);
  const host_id = useRedux([
    "projects",
    "project_map",
    project_id ?? "",
    "host_id",
  ]) as string | undefined;
  const hostInfo = host_id ? host_info?.get(host_id) : undefined;

  useEffect(() => {
    if (project_state != null) {
      const displayState = normalizeProjectStateForDisplay({
        projectState: project_state.get?.("state"),
        hostId: host_id,
        hostInfo,
      });
      const next =
        displayState &&
        project_state.get?.("state") !== displayState &&
        typeof project_state.set === "function"
          ? project_state.set("state", displayState)
          : project_state;
      set_state(new ProjectStatus(next));
    }
  }, [project_state, host_id, hostInfo]);

  return state;
}
