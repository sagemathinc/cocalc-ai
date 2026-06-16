import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export async function reopenProjectAfterMove({
  project_id,
  op_id,
}: {
  project_id: string;
  op_id: string;
}): Promise<void> {
  void webapp_client.conat_client.hub.lro.dismiss({ op_id }).catch((err) => {
    console.warn("failed to dismiss completed project move operation", err);
  });
  redux.getActions("page").close_project_tab(project_id);
  await Promise.resolve();
  await redux.getActions("projects").open_project({
    project_id,
    switch_to: true,
    restore_session: true,
    change_history: true,
  });
}
