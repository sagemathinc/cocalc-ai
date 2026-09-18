/*
Do something somewhat friendly when a user signs in for the first time,
either after creating an account or being signed out.

Users who enable the experimental Agents workspace open it after normal
sign-in. Other existing users open the most recent project they actively used.
Accounts with no projects stay on the Projects page, where the first-run
onboarding flow can ask what they actually want and choose an appropriate RootFS
image. Explicit URL targets are loaded separately before this fallback action.

That's it for now.
*/

import { delay } from "awaiting";
import { redux } from "@cocalc/frontend/app-framework";
import { once } from "@cocalc/util/async-utils";
import { cmp } from "@cocalc/util/misc";
import { QueryParams } from "@cocalc/frontend/misc/query-params";
import { myAgentsUIEnabled } from "@cocalc/frontend/agents/workspace-ui-preference";

export default async function signInAction() {
  const signIn = QueryParams.get("sign-in");
  if (signIn == null) {
    return;
  }
  QueryParams.remove("sign-in");
  await delay(1); // so projects store is created (not in sync initial load loop)
  const account = redux.getStore("account");
  while (account.get("created") == null) {
    await once(account, "change");
  }
  if (myAgentsUIEnabled(account.get("other_settings"))) {
    redux.getActions("page").set_active_tab("agents");
    return;
  }
  const project_id = await getProject();
  if (!project_id) {
    redux.getActions("page").set_active_tab("projects");
    return;
  }
  const actions = redux.getActions("projects");
  actions.open_project({ project_id, switch_to: true, target: "new" });
  await actions.start_project(project_id, { autostart: true });
}

async function getProject(): Promise<string | undefined> {
  const projects = redux.getStore("projects");
  // wait until projects_map is loaded, so we know what projects the users has (probably)
  while (projects.get("project_map") == null) {
    await once(projects, "change");
  }
  let project_map = projects.get("project_map")!;
  if (project_map.size == 0) {
    return undefined;
  }

  const account_id = redux.getStore("account").get("account_id");

  // now there should be at least one project in project_map.
  // Is there a non-deleted non-hidden project?
  const options: any[] = [];
  for (const [_, project] of project_map) {
    if (project.get("deleted")) {
      continue;
    }
    if (project.getIn(["users", account_id, "hide"])) {
      continue;
    }
    options.push(project);
  }
  if (options.length == 0) {
    return undefined;
  }

  // Sort the projects by when YOU were last active on the project, or if you were
  // never active on any project, by when the projects was last_edited.
  const usedByYou = options.filter((x) => x.getIn(["last_active", account_id]));

  if (usedByYou.length == 0) {
    //  you were never active on any project, so just return project most recently edited
    options.sort((x, y) => -cmp(x.get("last_edited"), y.get("last_edited")));
    return options[0].get("project_id");
  }

  usedByYou.sort(
    (x, y) =>
      -cmp(
        x.getIn(["last_active", account_id]),
        y.getIn(["last_active", account_id]),
      ),
  );
  return usedByYou[0].get("project_id");
}
