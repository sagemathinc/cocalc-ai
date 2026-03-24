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

async function forwardHost(
  name: string,
  args: any[],
  scope = defaultHostScope(),
) {
  return await callHub({
    client: requireMasterClient(name),
    name,
    args,
    ...(scope?.host_id ? { host_id: scope.host_id } : {}),
  });
}

export function wireHostsApi(): void {
  if (!hubApi.hosts) {
    (hubApi as any).hosts = {};
  }

  hubApi.hosts.issueProjectHostAgentAuthToken = async (opts: {
    host_id?: string;
    account_id: string;
    project_id: string;
    ttl_seconds?: number;
  }) => {
    return await forwardHost("hosts.issueProjectHostAgentAuthToken", [opts]);
  };
}
