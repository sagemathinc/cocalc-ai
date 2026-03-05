/* Handle a proxy request */

import stripRememberMeCookie from "./strip-remember-me-cookie";
import { versionCheckFails } from "./version";
import getLogger from "../logger";
import { stripBasePath } from "./util";
import siteUrl from "@cocalc/database/settings/site-url";
import { parseReq } from "./parse";
import hasAccess from "./check-for-access-to-project";
import { handleFileDownload } from "@cocalc/conat/files/file-download";
import { isPublicAppSubdomainRequest } from "./public-app-subdomain";

const logger = getLogger("proxy:handle-request");
const APP_PUBLIC_TOKEN_QUERY_PARAM = "cocalc_app_token";
const PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Options {
  isPersonal: boolean;
  projectProxyHandlersPromise?;
}

export default function init({
  isPersonal,
  projectProxyHandlersPromise,
}: Options) {
  function isPublicAppTokenBypassRequest(req): boolean {
    try {
      const url = stripBasePath(`${req.url ?? "/"}`);
      const parsed = new URL(url, "http://proxy.local");
      const token = `${parsed.searchParams.get(APP_PUBLIC_TOKEN_QUERY_PARAM) ?? ""}`.trim();
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
      ));
      req.headers["cookie"] = cookie;
    }

    const allowPublicSubdomainBypass = isPublicAppSubdomainRequest(req);
    const allowPublicTokenBypass = isPublicAppTokenBypassRequest(req);
    const allowAnonymousProxyBypass =
      allowPublicSubdomainBypass || allowPublicTokenBypass;
    if (
      !isPersonal &&
      !allowAnonymousProxyBypass &&
      !remember_me &&
      !api_key
    ) {
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
    if (type == "files") {
      // keep the explicit branch for file-download handling, while access mode
      // policy remains centralized in the route definition.
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

    if (type == "files") {
      await handleFileDownload({ req, res, url });
      return;
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
        "<!doctype html><meta charset=\"utf-8\"><h1>Proxy request failed</h1><p>The request could not be completed.</p>";
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
