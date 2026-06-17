import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export async function reopenProjectAfterMove({
  project_id,
  op_id,
  source_host_id,
  dest_host_id,
}: {
  project_id: string;
  op_id: string;
  source_host_id?: string;
  dest_host_id?: string;
}): Promise<void> {
  void webapp_client.conat_client.hub.lro.dismiss({ op_id }).catch((err) => {
    console.warn("failed to dismiss completed project move operation", err);
  });
  webapp_client.conat_client.releaseProjectHostRouting({ project_id });
  webapp_client.conat_client.refreshProjectHostRouting({
    source_host_id,
    dest_host_id,
  });
  redux.getActions("page").close_project_tab(project_id);
  redux.removeProjectReferences(project_id);
  if (dest_host_id) {
    await redux
      .getActions("projects")
      ?.ensure_host_info(dest_host_id, true)
      .catch((err) => {
        console.warn(
          "failed to refresh destination host info before reopening moved project",
          err,
        );
      });
  }
  await Promise.resolve();
  await redux.getActions("projects").open_project({
    project_id,
    switch_to: true,
    restore_session: true,
    change_history: true,
  });
}
