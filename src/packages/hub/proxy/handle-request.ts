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
import {
  getProjectHostRedirectUrl,
  setProjectHostProxyAccountId,
} from "./project-host";
import { handleFileDownload } from "@cocalc/conat/files/file-download";
import { conat } from "@cocalc/backend/conat";
import { isWorkspaceProjectRuntime } from "@cocalc/server/launchpad/project-runtime";
import { ensureWorkspaceFileDownloadReadServer } from "@cocalc/server/conat/project/workspace-filesystem";

const logger = getLogger("proxy:handle-request");

interface Options {
  isPersonal: boolean;
  projectProxyHandlersPromise?;
}

export default function init({
  isPersonal,
  projectProxyHandlersPromise,
}: Options) {
  // Workspace projects deliberately have no project-host assignment.  Keep
  // one direct client for their local project file-read services instead of
  // sending file requests through the host-based HTTP proxy.
  const workspaceFileDownloadClient = isWorkspaceProjectRuntime()
    ? conat()
    : undefined;

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

    if (!isPersonal && !remember_me && !api_key) {
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
    const authenticatedAccountId = await resolveAuthenticatedAccountId({
      remember_me,
      api_key,
    });
    setProjectHostProxyAccountId(req, authenticatedAccountId);

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

    if (
      workspaceFileDownloadClient != null &&
      type === "files" &&
      /^(GET|HEAD)$/i.test(req.method ?? "GET")
    ) {
      // Serve from the always-on hub-side reader rather than the project's own
      // files:read service, which only exists while the project is running.
      // The stat subject is the same workspace filesystem, so GET, HEAD and
      // temporary-archive cleanup all resolve paths identically.
      const { readServiceName, statSubject } =
        await ensureWorkspaceFileDownloadReadServer({
          client: workspaceFileDownloadClient,
          project_id,
        });
      await handleFileDownload({
        req,
        res,
        url,
        client: workspaceFileDownloadClient,
        readServiceName,
        statSubject,
      });
      return;
    }

    if (type !== "conat" && /^(GET|HEAD)$/i.test(req.method ?? "GET")) {
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
