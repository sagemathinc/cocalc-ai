import callHub from "@cocalc/conat/hub/call-hub";
import { agent as agentContract } from "@cocalc/conat/hub/api/agent";
import { authFirstRequireHostWithAccountTarget } from "@cocalc/conat/hub/api/util";
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

export function hostAgentMethods(): string[] {
  return Object.keys(agentContract).filter(
    (name) => agentContract[name] === authFirstRequireHostWithAccountTarget,
  );
}

export function wireHostsApi(): void {
  if (!hubApi.hosts) {
    (hubApi as any).hosts = {};
  }
  if (!hubApi.agent) (hubApi as any).agent = {};
  // Every agent method only a host may call goes to the hub as this host.
  // Derived from the API contract, so a new one can't be left unforwarded
  // (the lite hub has no local version: the call would throw).
  for (const name of hostAgentMethods()) {
    (hubApi.agent as any)[name] = (opts) =>
      forwardHost(`agent.${name}`, [opts]);
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
