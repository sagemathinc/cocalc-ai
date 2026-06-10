/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { dialogs } from "@cocalc/frontend/i18n";
import { getIntl } from "@cocalc/frontend/i18n/get-intl";
import { lite } from "@cocalc/frontend/lite";
import { getHostInfo } from "@cocalc/frontend/projects/host-info";
import { evaluateHostOperational } from "@cocalc/frontend/projects/host-operational";
import {
  getProjectStartPolicyBlock,
  type ProjectStartPolicyBlock,
} from "@cocalc/frontend/projects/runtime-start-policy";

/* Various actions depend on the project running, so this function currently does the following:
    - Checks whether or not the project is starting or running (assuming project state known -- admins don't know).
    - If running, displays nothing and returns true.
    - If not running displays a project-level modal alert and waits --
       - if user asks to start, then starts and returns true.
       - if user since don't start, return false.

NOTE:
 - I hate this code.  It was very difficult to write.  I'm sorry.

*/

// This explicitly_started is because otherwise is_running_or_starting
// can't **immediately* detect starting the project.
const explicitly_started: { [project_id: string]: number } = {};
const pendingEnsureProjectRunning: { [project_id: string]: Promise<boolean> } =
  {};

function projectsStore(): any {
  return redux.getStore("projects");
}

function projectMap(): any {
  return projectsStore()?.get("project_map");
}

function project(project_id: string): any {
  return projectMap()?.get?.(project_id);
}

function projectState(project_id: string): string | undefined {
  return projectMap()?.getIn?.([project_id, "state", "state"]);
}

export type ProjectReadinessUxSegment =
  | "warm"
  | "already_starting"
  | "restore_autostart"
  | "autostart"
  | "unknown";

export function classifyProjectReadinessUxSegment(
  project_id: string,
  initial_state = projectState(project_id),
): {
  segment: ProjectReadinessUxSegment;
  initial_state?: string;
  provisioned?: unknown;
} {
  if (lite) {
    return { segment: "warm", initial_state: "running" };
  }
  const provisioned = project(project_id)?.get?.("provisioned");
  if (initial_state === "running") {
    return { segment: "warm", initial_state, provisioned };
  }
  if (initial_state === "starting") {
    return { segment: "already_starting", initial_state, provisioned };
  }
  if (initial_state === "archived" || provisioned === false) {
    return { segment: "restore_autostart", initial_state, provisioned };
  }
  return {
    segment: initial_state == null ? "unknown" : "autostart",
    initial_state,
    provisioned,
  };
}

function accountStore(): any {
  return redux.getStore("account");
}

function autostartBlock(
  project_id: string,
): ProjectStartPolicyBlock | undefined {
  const account = accountStore();
  return getProjectStartPolicyBlock({
    project: project(project_id),
    account_id: account?.get?.("account_id"),
    is_admin: !!account?.get?.("is_admin"),
    autostart: true,
  });
}

function is_running(project_id: string): boolean {
  if (lite) {
    return true;
  }

  const state = projectState(project_id);
  if (state == null) {
    // Some admin paths do not have project state in the local store.
    return true;
  }
  if (state !== "running") {
    return false;
  }
  const host_id = projectMap()?.getIn?.([project_id, "host_id"]) as
    | string
    | undefined;
  if (!host_id) return true;
  const hostState = evaluateHostOperational(getHostInfo(host_id));
  return hostState.state !== "unavailable";
}

export function is_running_or_starting(project_id: string): boolean {
  if (lite) {
    return true;
  }
  const t = explicitly_started[project_id];
  if (t != null && Date.now() - t <= 15000) {
    return true;
  }

  const project_map = projectMap();
  if (!project_map) {
    return false;
  }
  const state = project_map.getIn([project_id, "state", "state"]);
  if (state == null || state == "starting") {
    return true;
  }
  if (state == "running") {
    const host_id = project_map.getIn([project_id, "host_id"]) as
      | string
      | undefined;
    if (!host_id) return true;
    const hostState = evaluateHostOperational(getHostInfo(host_id));
    if (hostState.state === "unavailable") {
      return false;
    }
    return true;
  }
  return false;
}

async function wait_until_running(project_id: string): Promise<boolean> {
  if (is_running(project_id)) {
    return true;
  }
  const store = projectsStore();
  if (store == null || typeof store.once !== "function") {
    return is_running(project_id);
  }
  while (!is_running(project_id)) {
    await new Promise<void>((resolve) => {
      store.once("change", resolve);
    });
  }
  return true;
}

async function showStartRequiredModal({
  project_id,
  what,
  block,
}: {
  project_id: string;
  what: string;
  block?: ProjectStartPolicyBlock;
}): Promise<boolean> {
  const intl = await getIntl();
  const project_actions = redux.getProjectActions(project_id);
  await project_actions.wait_until_no_modals();
  if (is_running(project_id)) {
    return true;
  }

  const project_title = projectsStore().get_title(project_id);
  const title = intl.formatMessage(dialogs.project_start_warning_title);
  const content =
    block == null
      ? intl.formatMessage(dialogs.project_start_warning_content, {
          project_title,
          title,
          what,
        })
      : `${block.message} ${block.action ?? ""}`.trim();

  let result = "";
  const interval = setInterval(() => {
    if (result != "") {
      clearInterval(interval);
      return;
    }
    if (is_running(project_id)) {
      clearInterval(interval);
      project_actions.clear_modal();
    }
  }, 1000);

  result = await project_actions.show_modal({ title, content });
  if (result == "ok") {
    if (block?.code === "collaborator_sponsor_disabled") {
      await redux
        .getActions("projects")
        .set_project_runtime_sponsor_to_me(project_id);
    }
    explicitly_started[project_id] = Date.now();
    await redux
      .getActions("projects")
      .start_project(project_id, { autostart: false });
    return await wait_until_running(project_id);
  }
  return is_running(project_id);
}

export async function ensure_project_running(
  project_id: string,
  what: string,
): Promise<boolean> {
  if (is_running(project_id)) {
    return true;
  }
  const pending = pendingEnsureProjectRunning[project_id];
  if (pending != null) {
    return await pending;
  }

  const request = (async () => {
    if (is_running(project_id)) {
      return true;
    }

    const block = autostartBlock(project_id);
    if (block == null) {
      explicitly_started[project_id] = Date.now();
      await redux
        .getActions("projects")
        .start_project(project_id, { autostart: true });
      return await wait_until_running(project_id);
    }

    return await showStartRequiredModal({ project_id, what, block });
  })();

  pendingEnsureProjectRunning[project_id] = request;
  try {
    return await request;
  } finally {
    if (pendingEnsureProjectRunning[project_id] === request) {
      delete pendingEnsureProjectRunning[project_id];
    }
  }
}
