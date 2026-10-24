/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type { AppSpec, ManagedAppStatus } from "@cocalc/conat/project/api/apps";
import { message } from "antd";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { SHARED_BROWSER_APP_ID } from "@cocalc/util/shared-browser";
import { withProjectHostBase } from "./host-url";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import { PROJECT_HOST_HTTP_AUTH_QUERY_PARAM } from "@cocalc/conat/auth/project-host-http";

// A same-origin link that opens a project app: the hub's /app-open sends
// it to the app's own origin, or (on sites without app origins) to its old
// path.  path is the app's path in the project (/<project_id>/...).
export function appOpenURL(
  project_id: string,
  path: string,
  app_id?: string,
  { root = false }: { root?: boolean } = {},
): string | undefined {
  if (!path.startsWith(`/${project_id}/`)) return;
  const base = appBasePath === "/" ? "" : appBasePath.replace(/\/+$/, "");
  const params: string[] = [];
  if (app_id) params.push(`cocalc_app=${encodeURIComponent(app_id)}`);
  // The app runs without a base URL: open it at the root of its origin.
  if (root) params.push("cocalc_root=1");
  const query = params.length
    ? `${path.includes("?") ? "&" : "?"}${params.join("&")}`
    : "";
  return `${base}/app-open${path}${query}`;
}

// Whether an app runs at the root of its own origin (no base URL; trust-free
// step 6, phase 7c).
export function appRunsAtRoot(status?: { base_url?: string } | null): boolean {
  return status?.base_url === "/";
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

interface ProjectAppOpenOptions {
  getSpec?: (id: string) => Promise<AppSpec>;
  project_id: string;
  spec?: AppSpec;
  status: ManagedAppStatus;
  // Only the path within the project (/<project_id>/...), not a URL.
  localPathOnly?: boolean;
}

export async function getProjectAppOpenUrl({
  getSpec,
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

export async function openProjectAppStatus(opts: {
  getSpec?: (id: string) => Promise<AppSpec>;
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
  // The popup was blocked: open it directly (no opener).
  const url = await getProjectAppOpenUrl(opts);
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

// The app's path in the project (/<project_id>/...) of a host-origin app URL
// (without the host token), or undefined.
export function projectAppPathOfUrl(
  project_id: string,
  url: string,
): string | undefined {
  try {
    const parsed = new URL(url, "https://site.invalid");
    parsed.searchParams.delete(PROJECT_HOST_HTTP_AUTH_QUERY_PARAM);
    const path = `${parsed.pathname}${parsed.search}`;
    return path.startsWith(`/${project_id}/`) ? path : undefined;
  } catch {
    return;
  }
}

// A single-use link for the app framed by the site (a chat card), on the
// app's own origin (/_af/, a partitioned frame session), or why there is
// none ("off": the site has no app origins).  Always requested fresh by the
// frame's own page, never taken from shared data (F3).
export async function getProjectAppFrameUrl({
  project_id,
  path,
  app_id,
  root = false,
}: {
  project_id: string;
  path: string;
  app_id?: string;
  root?: boolean;
}): Promise<{ url: string } | { unavailable: string } | { error: string }> {
  try {
    const result =
      await webapp_client.conat_client.hub.hosts.issueProjectAppFrameUrl({
        project_id,
        path,
        app_id,
        root,
      });
    return "url" in result
      ? { url: result.url }
      : { unavailable: result.unavailable };
  } catch (err) {
    return { error: `${(err as any)?.message ?? err}` };
  }
}

// Whether url is this project's app on its project host (or this site),
// the only thing a card frames on sites without app origins.
export function isProjectHostAppUrl(project_id: string, url: string): boolean {
  try {
    const parsed = new URL(url, window.location.href);
    if (!parsed.pathname.startsWith(`/${project_id}/`)) return false;
    const host = withProjectHostBase(project_id, `/${project_id}/`);
    const hostOrigin = host
      ? new URL(host, window.location.href).origin
      : window.location.origin;
    return (
      parsed.origin === hostOrigin || parsed.origin === window.location.origin
    );
  } catch {
    return false;
  }
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
        root: appRunsAtRoot(opts.status),
      });
    return "url" in result ? result.url : undefined;
  } catch (err) {
    console.warn("opening the app on its own origin failed", err);
    return;
  }
}
