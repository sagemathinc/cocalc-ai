/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AppSpec, ManagedAppStatus } from "@cocalc/conat/project/api/apps";
import type { ProjectAppPrivateHostnameRecord } from "@cocalc/conat/hub/api/system";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { withProjectHostBase } from "./host-url";

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

export function buildPrivateHostnameOpenUrl({
  privateHostnameUrl,
  spec,
  status,
}: {
  privateHostnameUrl: string;
  spec?: AppSpec;
  status: ManagedAppStatus;
}): string {
  if (
    spec?.kind !== "service" ||
    spec.proxy?.open_mode !== "port" ||
    !status.url
  ) {
    return privateHostnameUrl;
  }
  const localUrl = translateServiceOpenUrl(status.url, "port");
  if (!localUrl) return privateHostnameUrl;
  const privateUrl = new URL(privateHostnameUrl);
  const local = new URL(localUrl, "https://project-host.invalid");
  privateUrl.pathname = local.pathname;
  privateUrl.search = local.search;
  privateUrl.hash = local.hash;
  return privateUrl.toString();
}

export async function getProjectAppOpenUrl({
  getSpec,
  privateHostname,
  project_id,
  spec,
  status,
}: {
  getSpec?: (id: string) => Promise<AppSpec>;
  privateHostname?: ProjectAppPrivateHostnameRecord;
  project_id: string;
  spec?: AppSpec;
  status: ManagedAppStatus;
}): Promise<string | undefined> {
  let resolvedSpec = spec;
  const resolveSpec = async (): Promise<void> => {
    if (resolvedSpec || !getSpec) return;
    try {
      resolvedSpec = await getSpec(status.id);
    } catch {
      // Fall back to the app status URL below.
    }
  };

  if (privateHostname?.url) {
    await resolveSpec();
  }

  if (privateHostname?.url) {
    return await webapp_client.conat_client.addProjectHostAuthToUrl({
      project_id,
      url: buildPrivateHostnameOpenUrl({
        privateHostnameUrl: privateHostname.url,
        spec: resolvedSpec,
        status,
      }),
    });
  }

  await resolveSpec();
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
  const preferredLocal =
    serviceOpenMode === "port"
      ? (serviceLocal ?? basePathLocal)
      : (serviceLocal ?? basePathLocal);
  if (!preferredLocal) return;
  const local =
    withProjectHostBase(project_id, preferredLocal) ?? preferredLocal;
  return await webapp_client.conat_client.addProjectHostAuthToUrl({
    project_id,
    url: local,
  });
}

export async function getPrivateProjectAppOpenUrl({
  app_id,
  project_id,
}: {
  app_id: string;
  project_id: string;
}): Promise<string> {
  const hostname =
    await webapp_client.conat_client.hub.system.inspectProjectAppPrivateHostname(
      {
        project_id,
        app_id,
      },
    );
  if (!hostname?.url) {
    throw new Error(`Private hostname for app '${app_id}' is not reserved.`);
  }
  return await webapp_client.conat_client.addProjectHostAuthToUrl({
    project_id,
    url: hostname.url,
  });
}

export async function openProjectAppStatus(opts: {
  getSpec?: (id: string) => Promise<AppSpec>;
  privateHostname?: ProjectAppPrivateHostnameRecord;
  project_id: string;
  spec?: AppSpec;
  status: ManagedAppStatus;
}): Promise<void> {
  const url = await getProjectAppOpenUrl(opts);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}
