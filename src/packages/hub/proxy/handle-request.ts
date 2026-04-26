/* Handle a proxy request */

import stripRememberMeCookie from "./strip-remember-me-cookie";
import { versionCheckFails } from "./version";
import getLogger from "../logger";
import { stripBasePath } from "./util";
import siteUrl from "@cocalc/database/settings/site-url";
import { parseReq } from "./parse";
import hasAccess, {
  resolveAuthenticatedAccountId,
} from "./check-for-access-to-project";
import { handleFileDownload } from "@cocalc/conat/files/file-download";
import { initHubApi } from "@cocalc/conat/hub/api";
import callHub from "@cocalc/conat/hub/call-hub";
import { isPublicAppSubdomainRequest } from "./public-app-subdomain";
import { getProjectHostRedirectUrl } from "./project-host";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";

const logger = getLogger("proxy:handle-request");
const APP_PUBLIC_TOKEN_QUERY_PARAM = "cocalc_app_token";
const PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function formatManagedEgressCategory(category: string): string {
  if (category === "file-download") return "File downloads";
  return category.replace(/[-_]/g, " ");
}

function formatByteCount(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

interface Options {
  isPersonal: boolean;
  projectProxyHandlersPromise?;
}

export default function init({
  isPersonal,
  projectProxyHandlersPromise,
}: Options) {
  const fileDownloadClient = conatWithProjectRouting();
  const fileDownloadHub = initHubApi((opts) =>
    callHub({ client: fileDownloadClient, ...opts }),
  );

  async function checkManagedFileDownloadAllowed(opts: {
    account_id?: string;
    project_id: string;
  }): Promise<
    | {
        allowed: true;
      }
    | {
        allowed: false;
        message: string;
      }
  > {
    try {
      const policy = await fileDownloadHub.system.getManagedProjectEgressPolicy(
        {
          account_id: opts.account_id,
          project_id: opts.project_id,
          category: "file-download",
        },
      );
      if (policy.allowed) {
        return { allowed: true };
      }
      const breakdown = Object.entries(
        policy.managed_egress_categories_5h_bytes ?? {},
      )
        .filter(
          ([, bytes]) =>
            typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0,
        )
        .map(
          ([category, bytes]) =>
            `${formatManagedEgressCategory(category)}: ${formatByteCount(Number(bytes))}`,
        );
      const lines = [
        "Managed download limit reached for this account.",
        "New file downloads are temporarily blocked until the egress usage window resets.",
      ];
      if (policy.egress_5h_bytes != null) {
        lines.push(
          `5-hour usage: ${formatByteCount(policy.managed_egress_5h_bytes)} / ${formatByteCount(policy.egress_5h_bytes)}.`,
        );
      }
      if (policy.egress_7d_bytes != null) {
        lines.push(
          `7-day usage: ${formatByteCount(policy.managed_egress_7d_bytes)} / ${formatByteCount(policy.egress_7d_bytes)}.`,
        );
      }
      if (breakdown.length > 0) {
        lines.push(
          `Current managed egress categories (5 hours): ${breakdown.join(", ")}.`,
        );
      }
      return {
        allowed: false,
        message: lines.join("\n"),
      };
    } catch (err) {
      logger.warn("unable to evaluate managed file download policy", {
        account_id: opts.account_id,
        project_id: opts.project_id,
        err: `${err}`,
      });
      return { allowed: true };
    }
  }

  async function recordManagedFileDownload(opts: {
    account_id?: string;
    project_id: string;
    bytes: number;
    request_path: string;
    partial: boolean;
  }): Promise<void> {
    if (!(opts.bytes > 0)) {
      return;
    }
    try {
      await fileDownloadHub.system.recordManagedProjectEgress({
        account_id: opts.account_id,
        project_id: opts.project_id,
        category: "file-download",
        bytes: opts.bytes,
        metadata: {
          request_path: opts.request_path,
          partial: opts.partial,
        },
      });
    } catch (err) {
      logger.warn("unable to record managed file download egress", {
        project_id: opts.project_id,
        request_path: opts.request_path,
        bytes: opts.bytes,
        partial: opts.partial,
        err: `${err}`,
      });
    }
  }

  function isPublicAppTokenBypassRequest(req): boolean {
    try {
      const url = stripBasePath(`${req.url ?? "/"}`);
      const parsed = new URL(url, "http://proxy.local");
      const token =
        `${parsed.searchParams.get(APP_PUBLIC_TOKEN_QUERY_PARAM) ?? ""}`.trim();
      if (!token) return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length < 3) return false;
      const [project_id, proxyType] = segments;
      if (!project_id || !PROJECT_ID_RE.test(project_id)) return false;
      return proxyType === "apps";
    } catch {
      return false;
    }
  }

  async function handleProxyRequest(req, res): Promise<void> {
    const dbg = (...args) => {
      // for low level debugging -- silly isn't logged by default
      logger.silly(req.url, ...args);
    };
    dbg("got request");
    // dangerous/verbose to log...?
    // dbg("headers = ", req.headers);

    if (!isPersonal && versionCheckFails(req, res)) {
      dbg("version check failed");
      // note that the versionCheckFails function already sent back an error response.
      throw Error("version check failed");
    }

    // Before doing anything further with the request on to the proxy, we remove **all** cookies whose
    // name contains "remember_me", to prevent the project backend from getting at
    // the user's session cookie, since one project shouldn't be able to get
    // access to any user's account.
    let remember_me, api_key;
    if (req.headers["cookie"] != null) {
      let cookie;
      ({ cookie, remember_me, api_key } = stripRememberMeCookie(
        req.headers["cookie"],
        req,
      ));
      req.headers["cookie"] = cookie;
    }

    const allowPublicSubdomainBypass = isPublicAppSubdomainRequest(req);
    const allowPublicTokenBypass = isPublicAppTokenBypassRequest(req);
    const allowAnonymousProxyBypass =
      allowPublicSubdomainBypass || allowPublicTokenBypass;
    if (!isPersonal && !allowAnonymousProxyBypass && !remember_me && !api_key) {
      dbg("no rememember me set, so blocking");
      // Not in personal mode and there is no remember_me or api_key set all, so
      // definitely block access.  4xx since this is a *client* problem.
      const url = await siteUrl();
      throw Error(
        `Please login to <a target='_blank' href='${url}'>${url}</a> with cookies enabled, then refresh this page.`,
      );
    }

    const url = stripBasePath(req.url);
    const parsed = parseReq(url, remember_me, api_key);
    // TODO: parseReq is called again in getTarget so need to refactor...
    const { type, project_id, route } = parsed;
    const authenticatedAccountId =
      allowAnonymousProxyBypass || type !== "files"
        ? undefined
        : await resolveAuthenticatedAccountId({
            remember_me,
            api_key,
          });
    if (type == "files") {
      const currentDownloadAccountId = authenticatedAccountId;
      // keep the explicit branch for file-download handling, while access mode
      // policy remains centralized in the route definition.
      if (!allowAnonymousProxyBypass) {
        if (
          !(await hasAccess({
            project_id,
            remember_me,
            api_key,
            type: route.access,
            isPersonal,
          }))
        ) {
          throw Error(`user does not have ${route.access} access to project`);
        }
      }
      await handleFileDownload({
        req,
        res,
        url,
        client: fileDownloadClient,
        beforeExplicitDownload: async ({ project_id }) =>
          await checkManagedFileDownloadAllowed({
            account_id: currentDownloadAccountId,
            project_id,
          }),
        onExplicitDownloadComplete: async ({
          project_id,
          request_path,
          bytes,
          partial,
        }) =>
          await recordManagedFileDownload({
            account_id: currentDownloadAccountId,
            project_id,
            request_path,
            bytes,
            partial,
          }),
      });
      return;
    }

    if (!allowAnonymousProxyBypass) {
      if (
        !(await hasAccess({
          project_id,
          remember_me,
          api_key,
          type: route.access,
          isPersonal,
        }))
      ) {
        throw Error(`user does not have ${route.access} access to project`);
      }
    }

    if (
      !allowAnonymousProxyBypass &&
      type !== "conat" &&
      /^(GET|HEAD)$/i.test(req.method ?? "GET")
    ) {
      const account_id = authenticatedAccountId;
      if (account_id) {
        const target = await getProjectHostRedirectUrl({
          project_id,
          path: url,
          account_id,
        });
        if (target) {
          res.statusCode = 307;
          res.setHeader("Location", target);
          res.end();
          return;
        }
      }
    }

    const projectProxyHandlers = await projectProxyHandlersPromise;
    if (projectProxyHandlers == null) {
      throw Error("no project proxy request handler is configured");
    }

    projectProxyHandlers.handleRequest(req, res);
  }

  return async (req, res) => {
    try {
      await handleProxyRequest(req, res);
    } catch (err) {
      // SECURITY: this path handles internet-facing requests.  Never reflect
      // internal error text to clients.
      const body =
        '<!doctype html><meta charset="utf-8"><h1>Proxy request failed</h1><p>The request could not be completed.</p>';
      try {
        // this will fail if handleProxyRequest already wrote a header, so we
        // try/catch it.
        res.writeHead(500, {
          "Content-Type": "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
      } catch {}
      try {
        res.end(body);
      } catch {}
      // Not something to log as an error -- just debug; it's normal for it to happen, e.g., when
      // a project isn't running.
      logger.debug("proxy request failed", {
        url: req.url,
        err: err instanceof Error ? err.message : `${err}`,
      });
    }
  };
}
