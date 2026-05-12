import type { ApiKeyCapability } from "@cocalc/util/db-schema/api-keys";
import {
  type ApiKeyPrincipal,
  requireApiKeyCapability,
  requireApiKeyProjectCapability,
} from "./api-key-scope";

const HUB_CAPABILITY_BY_NAME: Record<string, ApiKeyCapability> = {
  "system.getNames": "account:read",
  "projects.createProject": "project:create",
};

const HUB_API_KEY_HELLO_WORLD = new Set(["system.ping"]);

const HUB_PROJECT_CAPABILITY_BY_NAME: Record<string, ApiKeyCapability> = {
  "projects.exec": "project:exec",
  "projects.getProjectState": "project:read",
  "projects.getProjectAddress": "project:read",
  "projects.getProjectSettings": "project:read",
  "projects.getProjectCreated": "project:read",
  "projects.getProjectRunQuota": "project:read",
};

export function assertHttpHubApiKeyAllowed({
  principal,
  name,
  args,
}: {
  principal: ApiKeyPrincipal;
  name: string;
  args?: any[];
}): void {
  if (HUB_API_KEY_HELLO_WORLD.has(name)) {
    return;
  }

  const projectCapability = HUB_PROJECT_CAPABILITY_BY_NAME[name];
  if (projectCapability) {
    const project_id = `${args?.[0]?.project_id ?? ""}`.trim();
    if (!project_id) {
      throw Error("API key project capability check requires project_id");
    }
    requireApiKeyProjectCapability(principal, projectCapability, project_id);
    return;
  }

  const capability = HUB_CAPABILITY_BY_NAME[name];
  if (capability) {
    requireApiKeyCapability(principal, capability);
    return;
  }

  throw Object.assign(
    new Error(`API keys are not allowed to call hub RPC '${name}'`),
    {
      code: "api_key_rpc_denied",
      rpc: name,
    },
  );
}

export function assertHttpProjectApiKeyAllowed({
  principal,
  project_id,
}: {
  principal: ApiKeyPrincipal;
  project_id: string;
}): void {
  requireApiKeyProjectCapability(principal, "project:exec", project_id);
}
