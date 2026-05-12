import type { ApiKeyCapability } from "@cocalc/util/db-schema/api-keys";
import { isValidUUID } from "@cocalc/util/misc";

const CAPABILITY_SET = new Set<string>([
  "account:read",
  "project:create",
  "project:list",
  "project:read",
  "project:write",
  "file:read",
  "file:write",
  "project:exec",
  "codex:run",
]);

const PROJECT_ALLOWLIST_REQUIRED = new Set<ApiKeyCapability>([
  "project:read",
  "project:write",
  "file:read",
  "file:write",
  "project:exec",
  "codex:run",
]);

export interface ApiKeyPrincipal {
  account_id: string;
  api_key_id: number;
  key_id: string;
  auth_method: "api_key";
  capabilities: ApiKeyCapability[];
  allowed_project_ids: string[];
}

export function normalizeApiKeyCapabilities(
  capabilities: unknown,
): ApiKeyCapability[] {
  const input = Array.isArray(capabilities) ? capabilities : [];
  const normalized: ApiKeyCapability[] = [];
  for (const capability of input) {
    const value = `${capability ?? ""}`.trim();
    if (!CAPABILITY_SET.has(value)) {
      throw Error(`invalid API key capability '${value}'`);
    }
    if (!normalized.includes(value as ApiKeyCapability)) {
      normalized.push(value as ApiKeyCapability);
    }
  }
  if (normalized.length === 0) {
    throw Error("API keys must have at least one explicit capability");
  }
  return normalized;
}

export function normalizeAllowedProjectIds(projectIds: unknown): string[] {
  const input = Array.isArray(projectIds) ? projectIds : [];
  const normalized: string[] = [];
  for (const projectId of input) {
    const value = `${projectId ?? ""}`.trim();
    if (!isValidUUID(value)) {
      throw Error(`invalid allowed project id '${value}'`);
    }
    if (!normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

export function validateApiKeyScope({
  capabilities,
  allowed_project_ids,
}: {
  capabilities: ApiKeyCapability[];
  allowed_project_ids: string[];
}): void {
  if (
    capabilities.some((capability) =>
      PROJECT_ALLOWLIST_REQUIRED.has(capability),
    ) &&
    allowed_project_ids.length === 0
  ) {
    throw Error(
      "API keys with project, file, Codex, or exec capabilities must include at least one allowed project id",
    );
  }
}

export function normalizeApiKeyScope({
  capabilities,
  allowed_project_ids,
}: {
  capabilities: unknown;
  allowed_project_ids: unknown;
}): Pick<ApiKeyPrincipal, "capabilities" | "allowed_project_ids"> {
  const normalized = {
    capabilities: normalizeApiKeyCapabilities(capabilities),
    allowed_project_ids: normalizeAllowedProjectIds(allowed_project_ids),
  };
  validateApiKeyScope(normalized);
  return normalized;
}

export function hasApiKeyCapability(
  principal: Pick<ApiKeyPrincipal, "capabilities">,
  capability: ApiKeyCapability,
): boolean {
  return principal.capabilities.includes(capability);
}

export function hasApiKeyProjectCapability(
  principal: Pick<ApiKeyPrincipal, "capabilities" | "allowed_project_ids">,
  capability: ApiKeyCapability,
  project_id: string,
): boolean {
  return (
    principal.capabilities.includes(capability) &&
    principal.allowed_project_ids.includes(project_id)
  );
}

export function requireApiKeyCapability(
  principal: Pick<ApiKeyPrincipal, "capabilities">,
  capability: ApiKeyCapability,
): void {
  if (!hasApiKeyCapability(principal, capability)) {
    throw Object.assign(
      new Error(`API key lacks required capability '${capability}'`),
      {
        code: "api_key_capability_denied",
        capability,
      },
    );
  }
}

export function requireApiKeyProjectCapability(
  principal: Pick<ApiKeyPrincipal, "capabilities" | "allowed_project_ids">,
  capability: ApiKeyCapability,
  project_id: string,
): void {
  if (!hasApiKeyProjectCapability(principal, capability, project_id)) {
    throw Object.assign(
      new Error(
        `API key lacks required capability '${capability}' for project ${project_id}`,
      ),
      {
        code: "api_key_project_capability_denied",
        capability,
        project_id,
      },
    );
  }
}
