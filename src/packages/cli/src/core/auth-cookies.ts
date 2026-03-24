import { existsSync, readFileSync } from "node:fs";

import { basePathCookieName, isValidUUID } from "@cocalc/util/misc";

type CookieGlobals = {
  cookie?: string;
  apiKey?: string;
  hubPassword?: string;
};

export type ProjectScopedAuthStatus = {
  has_project_secret: boolean;
  has_project_id: boolean;
  has_project_scoped_auth: boolean;
  project_auth_source: string | null;
  project_id: string | null;
  project_auth_message: string;
};

export function normalizeSecretValue(
  raw: string | undefined,
): string | undefined {
  const value = `${raw ?? ""}`.trim();
  if (!value) return undefined;
  if (existsSync(value)) {
    try {
      const data = readFileSync(value, "utf8").trim();
      if (data) return data;
    } catch {
      // fall through and use raw value
    }
  }
  return value;
}

export function cookieNameFor(baseUrl: string, name: string): string {
  const pathname = new URL(baseUrl).pathname || "/";
  const basePath = pathname.replace(/\/+$/, "") || "/";
  return basePathCookieName({ basePath, name });
}

function appendCookie(
  parts: string[],
  baseUrl: string,
  name: string,
  value: string,
): void {
  const scopedName = cookieNameFor(baseUrl, name);
  parts.push(`${scopedName}=${value}`);
  if (scopedName !== name) {
    parts.push(`${name}=${value}`);
  }
}

function resolveProjectSecret(env = process.env): string | undefined {
  return normalizeSecretValue(
    env.COCALC_PROJECT_SECRET ?? env.project_secret ?? env.COCALC_SECRET_TOKEN,
  );
}

function resolveProjectId(env = process.env): string | undefined {
  const projectId = `${env.COCALC_PROJECT_ID ?? env.project_id ?? ""}`.trim();
  if (!isValidUUID(projectId)) return undefined;
  return projectId;
}

function resolveProjectSecretSource(env = process.env): string | null {
  if (normalizeSecretValue(env.COCALC_PROJECT_SECRET)) {
    return "COCALC_PROJECT_SECRET";
  }
  if (normalizeSecretValue(env.project_secret)) {
    return "project_secret";
  }
  if (normalizeSecretValue(env.COCALC_SECRET_TOKEN)) {
    return "COCALC_SECRET_TOKEN";
  }
  return null;
}

export function describeProjectScopedAuth(
  env = process.env,
): ProjectScopedAuthStatus {
  const projectSecret = resolveProjectSecret(env);
  const projectId = resolveProjectId(env);
  const source = resolveProjectSecretSource(env);
  const hasProjectSecret = !!projectSecret?.trim();
  const hasProjectId = !!projectId;
  const hasProjectScopedAuth = hasProjectSecret && hasProjectId;

  let project_auth_message = "no project-scoped auth detected";
  if (hasProjectScopedAuth) {
    project_auth_message = `project-scoped auth is available via ${source ?? "project_secret"} + project_id; remote commands can authenticate even without api_key/cookie/bearer`;
  } else if (hasProjectSecret) {
    project_auth_message =
      "project secret token is present, but project_id is missing or invalid";
  } else if (hasProjectId) {
    project_auth_message =
      "project_id is present, but no project secret token was found";
  }

  return {
    has_project_secret: hasProjectSecret,
    has_project_id: hasProjectId,
    has_project_scoped_auth: hasProjectScopedAuth,
    project_auth_source: source,
    project_id: projectId ?? null,
    project_auth_message,
  };
}

export function buildCookieHeader(
  baseUrl: string,
  globals: CookieGlobals,
  options: { includeHubPassword?: boolean } = {},
  env = process.env,
): string | undefined {
  const includeHubPassword = options.includeHubPassword !== false;
  const parts: string[] = [];
  if (globals.cookie?.trim()) {
    parts.push(globals.cookie.trim());
  }

  const apiKey = globals.apiKey ?? env.COCALC_API_KEY;
  if (apiKey?.trim()) {
    appendCookie(parts, baseUrl, "api_key", apiKey);
  }

  if (includeHubPassword) {
    const hubPassword = normalizeSecretValue(
      globals.hubPassword ?? env.COCALC_HUB_PASSWORD,
    );
    if (hubPassword?.trim()) {
      appendCookie(parts, baseUrl, "hub_password", hubPassword);
    }
  }

  const projectAuth = describeProjectScopedAuth(env);
  if (
    projectAuth.has_project_scoped_auth &&
    projectAuth.project_id &&
    projectAuth.project_auth_source
  ) {
    appendCookie(parts, baseUrl, "project_secret", resolveProjectSecret(env)!);
    appendCookie(parts, baseUrl, "project_id", projectAuth.project_id);
  }

  if (!parts.length) return undefined;
  return parts.join("; ");
}
