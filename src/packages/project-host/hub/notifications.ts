import callHub from "@cocalc/conat/hub/call-hub";
import { hubApi } from "@cocalc/lite/hub/api";
import { getMasterConatClient } from "../master-status";

function requireMasterClient(name: string) {
  const client = getMasterConatClient();
  if (!client) {
    throw new Error(`master hub connection unavailable for '${name}'`);
  }
  return client;
}

function defaultHostScope(): { host_id?: string } {
  const host_id = `${process.env.PROJECT_HOST_ID ?? ""}`.trim();
  return host_id ? { host_id } : {};
}

export function wireNotificationsApi(): void {
  if (!hubApi.notifications) {
    (hubApi as any).notifications = {};
  }

  hubApi.notifications.createCodexTurnNotice = async (opts: {
    account_id?: string;
    source_project_id: string;
    source_path: string;
    source_fragment_id?: string;
    thread_id: string;
    thread_label?: string;
    title: string;
    body_markdown: string;
    severity?: "info" | "warning" | "error";
    stable_source_id?: string;
  }) => {
    const scope = defaultHostScope();
    return await callHub({
      client: requireMasterClient("notifications.createCodexTurnNotice"),
      name: "notifications.createCodexTurnNotice",
      args: [opts],
      ...(scope.host_id ? { host_id: scope.host_id } : {}),
    });
  };
}
