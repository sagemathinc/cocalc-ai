/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AppSpec, ManagedAppStatus } from "@cocalc/conat/project/api/apps";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { withProjectHostBase } from "./host-url";

export interface PublicAppPolicy {
  enabled: boolean;
  dns_domain?: string;
  subdomain_suffix?: string;
}

function normalizePublicSuffix(raw?: string): string {
  const value = `${raw ?? ""}`.trim().toLowerCase();
  return value || "app";
}

function currentPublicDnsDomain(): string | undefined {
  if (typeof window === "undefined") return;
  const host = `${window.location.hostname ?? ""}`.trim().toLowerCase();
  if (!host || host === "localhost") return;
  return host;
}

export function buildPublicHostnameFromExposure(
  status: ManagedAppStatus,
  policy?: PublicAppPolicy,
): string | undefined {
  const exposure = status.exposure;
  if (exposure?.public_hostname) return exposure.public_hostname;
  const label = `${exposure?.random_subdomain ?? ""}`.trim().toLowerCase();
  const dnsDomain =
    `${policy?.dns_domain ?? ""}`.trim().toLowerCase() ||
    currentPublicDnsDomain();
  if (!label || !dnsDomain) return;
  const suffix = normalizePublicSuffix(policy?.subdomain_suffix);
  return suffix ? `${label}-${suffix}.${dnsDomain}` : `${label}.${dnsDomain}`;
}

export function buildPublicUrlFromExposure(
  status: ManagedAppStatus,
  policy?: PublicAppPolicy,
): string | undefined {
  const exposure = status.exposure;
  if (exposure?.public_url) return exposure.public_url;
  const hostname = buildPublicHostnameFromExposure(status, policy);
  return hostname ? `https://${hostname}` : undefined;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function translateServiceOpenUrl(
  localUrl: string | undefined,
  mode: "proxy" | "port",
): string | undefined {
  if (!localUrl || mode !== "port") return localUrl;
  if (localUrl.includes("/proxy/")) {
    return localUrl.replace("/proxy/", "/port/");
  }
  return localUrl;
}

export async function getProjectAppOpenUrl({
  getSpec,
  project_id,
  publicAppPolicy,
  spec,
  status,
}: {
  getSpec?: (id: string) => Promise<AppSpec>;
  project_id: string;
  publicAppPolicy?: PublicAppPolicy;
  spec?: AppSpec;
  status: ManagedAppStatus;
}): Promise<string | undefined> {
  const publicUrl = buildPublicUrlFromExposure(status, publicAppPolicy);
  if (publicUrl) return publicUrl;

  let resolvedSpec = spec;
  if (!resolvedSpec && getSpec) {
    try {
      resolvedSpec = await getSpec(status.id);
    } catch {
      // Fall back to the app status URL below.
    }
  }

  const declaredBasePath = `${resolvedSpec?.proxy?.base_path ?? ""}`.trim();
  const unmanagedBasePath =
    status.lifecycle_mode === "unmanaged" ? `/apps/${status.id}/` : "";
  let basePathLocal = declaredBasePath
    ? declaredBasePath.startsWith(`/${project_id}/`) ||
      declaredBasePath === `/${project_id}`
      ? declaredBasePath
      : `/${project_id}${declaredBasePath.startsWith("/") ? declaredBasePath : `/${declaredBasePath}`}`
    : unmanagedBasePath
      ? `/${project_id}${unmanagedBasePath}`
      : undefined;
  if (basePathLocal) {
    basePathLocal = ensureTrailingSlash(basePathLocal);
  }
  const serviceOpenMode =
    resolvedSpec?.kind === "service" && resolvedSpec.proxy.open_mode === "port"
      ? "port"
      : "proxy";
  const serviceLocal = translateServiceOpenUrl(status.url, serviceOpenMode);
  const preferredLocal = basePathLocal || serviceLocal;
  if (!preferredLocal) return;
  const local =
    withProjectHostBase(project_id, preferredLocal) ?? preferredLocal;
  return await webapp_client.conat_client.addProjectHostAuthToUrl({
    project_id,
    url: local,
  });
}

export async function openProjectAppStatus(opts: {
  getSpec?: (id: string) => Promise<AppSpec>;
  project_id: string;
  publicAppPolicy?: PublicAppPolicy;
  spec?: AppSpec;
  status: ManagedAppStatus;
}): Promise<void> {
  const url = await getProjectAppOpenUrl(opts);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
