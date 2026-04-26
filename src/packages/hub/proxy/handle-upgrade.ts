// Websocket support

import getLogger from "@cocalc/hub/logger";
import stripRememberMeCookie from "./strip-remember-me-cookie";
import { versionCheckFails } from "./version";
import { proxyConatWebsocket } from "./proxy-conat";
import basePath from "@cocalc/backend/base-path";
import { parseReq } from "./parse";
import hasAccess from "./check-for-access-to-project";
import { stripBasePath } from "./util";
import {
  isPublicAppSubdomainRequest,
  maybeRewritePublicAppSubdomainRequest,
} from "./public-app-subdomain";

const logger = getLogger("proxy:handle-upgrade");

export default function initUpgrade(
  {
    proxyConat,
    localConatServer,
    isPersonal,
    projectProxyHandlersPromise,
  }: {
    proxyConat;
    localConatServer;
    projectProxyHandlersPromise?;
    isPersonal;
  },
  proxy_regexp: string,
) {
  const re = new RegExp(proxy_regexp);

  async function handleProxyUpgradeRequest(req, socket, head): Promise<void> {
    await maybeRewritePublicAppSubdomainRequest(req);
    const allowPublicSubdomainBypass = isPublicAppSubdomainRequest(req);
    let remember_me: string | undefined = undefined;
    let api_key: string | undefined = undefined;

    if (proxyConat && isConatUpgradePath(req.url)) {
      proxyConatWebsocket(req, socket, head, {
        localConatServer,
      });
      return;
    }

    if (!req.url.match(re)) {
      logger.debug("denying unexpected websocket upgrade", { url: req.url });
      denyUpgrade(socket);
      return;
    }
    const projectProxyHandlers = await projectProxyHandlersPromise;
    if (projectProxyHandlers == null) {
      throw Error("no handler configured");
    }

    socket.on("error", (err) => {
      // server will crash sometimes without this:
      logger.debug("WARNING -- websocket socket error", err);
    });

    const dbg = (...args) => {
      logger.silly(req.url, ...args);
    };
    dbg("got upgrade request from url=", req.url);

    // Check that minimum version requirement is satisfied (this is in the header).
    // This is to have a way to stop buggy clients from causing trouble.  It's a purely
    // honor system sort of thing, but makes it possible for an admin to block clients
    // until they run newer code.  I used to have to use this a lot long ago...
    if (versionCheckFails(req)) {
      throw Error("client version check failed");
    }

    if (req.headers["cookie"] != null) {
      let cookie;
      ({ cookie, remember_me, api_key } = stripRememberMeCookie(
        req.headers["cookie"],
        req,
      ));
      req.headers["cookie"] = cookie;
    }

    const parsed = parseReq(stripBasePath(req.url), remember_me, api_key);
    const accessType = parsed.type === "files" ? "read" : "write";
    if (!allowPublicSubdomainBypass) {
      if (
        !(await hasAccess({
          project_id: parsed.project_id,
          remember_me,
          api_key,
          type: accessType,
          isPersonal,
        }))
      ) {
        throw Error(`user does not have ${accessType} access to project`);
      }
    }
    projectProxyHandlers.handleUpgrade(req, socket, head);
  }

  const handler = async (req, socket, head) => {
    try {
      await handleProxyUpgradeRequest(req, socket, head);
    } catch (err) {
      const msg = `WARNING: error upgrading websocket url=${req.url} -- ${err}`;
      logger.debug(msg);
      denyUpgrade(socket);
    }
  };

  return handler;
}

function denyUpgrade(socket) {
  socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
  socket.destroy();
}

function isConatUpgradePath(url: string) {
  const u = new URL(url, "http://cocalc.com");
  let pathname = u.pathname;
  if (basePath.length > 1) {
    pathname = pathname.slice(basePath.length);
  }
  return pathname == "/conat/";
}
