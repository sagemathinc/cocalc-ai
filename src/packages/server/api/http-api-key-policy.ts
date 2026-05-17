import type { ApiKeyCapability } from "@cocalc/util/db-schema/api-keys";
import {
  type ApiKeyPrincipal,
  requireApiKeyCapability,
  requireApiKeyProjectCapability,
} from "./api-key-scope";
import { recordApiKeyAuditEventSoon } from "./api-key-audit";

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
      recordApiKeyAuditEventSoon({
        event: "api_key_denied",
        value: {
          account_id: principal.account_id,
          api_key_id: principal.api_key_id,
          key_id: principal.key_id,
          source: "http-conat-hub",
          rpc: name,
          reason: "missing project_id for project capability check",
          code: "api_key_missing_project_id",
        },
      });
      throw Error("API key project capability check requires project_id");
    }
    try {
      requireApiKeyProjectCapability(principal, projectCapability, project_id);
    } catch (err) {
      auditHttpApiKeyDenial({
        principal,
        source: "http-conat-hub",
        rpc: name,
        project_id,
        err,
      });
      throw err;
    }
    return;
  }

  const capability = HUB_CAPABILITY_BY_NAME[name];
  if (capability) {
    try {
      requireApiKeyCapability(principal, capability);
    } catch (err) {
      auditHttpApiKeyDenial({
        principal,
        source: "http-conat-hub",
        rpc: name,
        err,
      });
      throw err;
    }
    return;
  }

  recordApiKeyAuditEventSoon({
    event: "api_key_denied",
    value: {
      account_id: principal.account_id,
      api_key_id: principal.api_key_id,
      key_id: principal.key_id,
      source: "http-conat-hub",
      rpc: name,
      reason: "hub RPC is not allowed for API keys",
      code: "api_key_rpc_denied",
    },
  });
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
  try {
    requireApiKeyProjectCapability(principal, "project:exec", project_id);
  } catch (err) {
    auditHttpApiKeyDenial({
      principal,
      source: "http-conat-project",
      project_id,
      err,
    });
    throw err;
  }
}

function auditHttpApiKeyDenial({
  principal,
  source,
  rpc,
  project_id,
  err,
}: {
  principal: ApiKeyPrincipal;
  source: string;
  rpc?: string;
  project_id?: string;
  err: unknown;
}): void {
  const code =
    err && typeof err === "object" && "code" in err
      ? `${(err as any).code ?? ""}`.trim()
      : undefined;
  const capability =
    err && typeof err === "object" && "capability" in err
      ? `${(err as any).capability ?? ""}`.trim()
      : undefined;
  const reason =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : `${err}`;
  recordApiKeyAuditEventSoon({
    event: "api_key_denied",
    value: {
      account_id: principal.account_id,
      api_key_id: principal.api_key_id,
      key_id: principal.key_id,
      source,
      rpc,
      project_id,
      reason,
      code,
      capability,
    },
  });
}
