import { type CustomizeState } from "@cocalc/frontend/customize";
import { ACCOUNT_ID_COOKIE } from "@cocalc/frontend/client/client";
import { recreate_account_table } from "@cocalc/frontend/account/table-bootstrap";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  FALLBACK_PROJECT_UUID,
  FALLBACK_ACCOUNT_UUID,
} from "@cocalc/util/misc";
import { init as initSyncDoc } from "./sync";
import Cookies from "js-cookie";

export let lite = false;
export let project_id: string = "";
export let account_id: string = "";

export function init(redux, configuration: CustomizeState) {
  console.log("Initializing CoCalc Lite!");
  lite = true;
  ({ account_id = FALLBACK_ACCOUNT_UUID, project_id = FALLBACK_PROJECT_UUID } =
    configuration);
  const previousAccountId = webapp_client.account_id;
  Cookies.remove(ACCOUNT_ID_COOKIE);
  webapp_client.account_id = account_id;
  redux.getActions("account").setState({ is_logged_in: true, account_id });
  if (previousAccountId !== account_id) {
    recreate_account_table(redux);
  }
  redux.getActions("projects").setState({
    open_projects: [project_id],
  });
  void redux
    .getActions("projects")
    .open_project({
      project_id,
      target: "project-home",
      switch_to: true,
      restore_session: false,
    })
    .catch((err) => {
      console.warn(
        "lite/init: failed to open default project-home target",
        err,
      );
    });

  if (configuration.remote_sync) {
    initSyncDoc();
  }
}
