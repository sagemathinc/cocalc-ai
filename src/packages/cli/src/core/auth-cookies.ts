import { existsSync, readFileSync } from "node:fs";

import { basePathCookieName, isValidUUID } from "@cocalc/util/misc";

type CookieGlobals = {
  cookie?: string;
  apiKey?: string;
  hubPassword?: string;
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

  const projectSecret = resolveProjectSecret(env);
  const projectId = resolveProjectId(env);
  if (projectSecret?.trim() && projectId) {
    appendCookie(parts, baseUrl, "project_secret", projectSecret);
    appendCookie(parts, baseUrl, "project_id", projectId);
  }

  if (!parts.length) return undefined;
  return parts.join("; ");
}
