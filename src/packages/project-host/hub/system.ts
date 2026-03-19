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

async function forwardSystem(
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

export function wireSystemApi(): void {
  hubApi.system.getProjectHostParallelOpsLimit = async (opts?: {
    account_id?: string;
    host_id?: string;
    worker_kind: string;
  }) => {
    return await forwardSystem("system.getProjectHostParallelOpsLimit", [opts]);
  };

  hubApi.system.getCustomize = async (fields?: string[]) => {
    return await forwardSystem("system.getCustomize", [fields]);
  };

  hubApi.system.getProjectAppPublicPolicy = async (opts?: {
    account_id?: string;
    project_id?: string;
    host_id?: string;
  }) => {
    return await forwardSystem("system.getProjectAppPublicPolicy", [opts]);
  };

  hubApi.system.tracePublicAppHostname = async (opts: {
    account_id?: string;
    host_id?: string;
    hostname: string;
  }) => {
    return await forwardSystem("system.tracePublicAppHostname", [opts]);
  };

  hubApi.system.reserveProjectAppPublicSubdomain = async (opts: {
    account_id?: string;
    project_id?: string;
    host_id?: string;
    app_id: string;
    base_path: string;
    ttl_s: number;
    preferred_label?: string;
    random_subdomain?: boolean;
  }) => {
    return await forwardSystem("system.reserveProjectAppPublicSubdomain", [
      opts,
    ]);
  };

  hubApi.system.releaseProjectAppPublicSubdomain = async (opts: {
    account_id?: string;
    project_id?: string;
    host_id?: string;
    app_id: string;
  }) => {
    return await forwardSystem("system.releaseProjectAppPublicSubdomain", [
      opts,
    ]);
  };
}
