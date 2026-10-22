/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AppSpec, ManagedAppStatus } from "@cocalc/conat/project/api/apps";
import type { ProjectAppPrivateHostnameRecord } from "@cocalc/conat/hub/api/system";
import { message } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { SHARED_BROWSER_APP_ID } from "@cocalc/util/shared-browser";
import { withProjectHostBase } from "./host-url";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";

// A same-origin link that opens a project app: the hub's /app-open sends
// it to the app's own origin, or (on sites without app origins) to its old
// path.  path is the app's path in the project (/<project_id>/...).
export function appOpenURL(
  project_id: string,
  path: string,
  app_id?: string,
): string | undefined {
  if (!path.startsWith(`/${project_id}/`)) return;
  const base = appBasePath === "/" ? "" : appBasePath.replace(/\/+$/, "");
  const query = app_id
    ? `${path.includes("?") ? "&" : "?"}app=${encodeURIComponent(app_id)}`
    : "";
  return `${base}/app-open${path}${query}`;
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

interface ProjectAppOpenOptions {
  getSpec?: (id: string) => Promise<AppSpec>;
  privateHostname?: ProjectAppPrivateHostnameRecord;
  project_id: string;
  spec?: AppSpec;
  status: ManagedAppStatus;
  // Only the path within the project (/<project_id>/...), not a URL.
  localPathOnly?: boolean;
}

export async function getProjectAppOpenUrl({
  getSpec,
  privateHostname,
  project_id,
  spec,
  status,
  localPathOnly,
}: ProjectAppOpenOptions): Promise<string | undefined> {
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
  if (localPathOnly) return preferredLocal;
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
  // A shared browser is shown by CoCalc's own viewer, not as a web page.
  if (opts.status.id.startsWith(SHARED_BROWSER_APP_ID)) {
    const spec = opts.spec ?? (await opts.getSpec?.(opts.status.id));
    const args = spec?.kind === "service" ? spec.command.args : [];
    const file = args[args.indexOf("--browser") + 1];
    if (args.includes("--browser") && file)
      redux
        .getProjectActions(opts.project_id)
        ?.open_file({ path: file, foreground: true });
    else
      void message.info(
        "This web browser shows in chat: ask an agent to use it, and its card opens it.",
      );
    return;
  }
  if (!opts.privateHostname?.url) {
    // Reserve the tab while the click still has user activation (browsers
    // block popups opened after an await), then send it where it goes.
    const tab = window.open("", "_blank");
    if (tab != null) {
      tab.opener = null;
      try {
        // Not noreferrer: the app origin accepts the link only from this
        // site (the Referer is just the site's origin).
        const url =
          (await getProjectAppOriginUrl(opts)) ??
          (await getProjectAppOpenUrl(opts));
        if (url) tab.location.href = url;
        else tab.close();
      } catch (err) {
        tab.close();
        throw err;
      }
      return;
    }
  }
  const url = await getProjectAppOpenUrl(opts);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

// A single-use link that opens the app on its own origin, when the site has
// a content domain (trust-free step 6); undefined to open it as before.
async function getProjectAppOriginUrl(
  opts: ProjectAppOpenOptions,
): Promise<string | undefined> {
  const path = await getProjectAppOpenUrl({ ...opts, localPathOnly: true });
  if (!path?.startsWith(`/${opts.project_id}/`)) return;
  try {
    const result =
      await webapp_client.conat_client.hub.hosts.issueProjectAppUrl({
        project_id: opts.project_id,
        path,
        app_id: opts.status.id,
      });
    return "url" in result ? result.url : undefined;
  } catch (err) {
    console.warn("opening the app on its own origin failed", err);
    return;
  }
}
