/*
Proxy /conat traffic to a standalone Conat server. This covers both the
socket.io websocket transport and the plain HTTP request path.
*/

import { createProxyServer, type ProxyServer } from "http-proxy-3";
import getLogger from "@cocalc/backend/logger";
import {
  conatServer as conatServer0,
  conatClusterPort,
} from "@cocalc/backend/data";
import basePath from "@cocalc/backend/base-path";
import { conat } from "@cocalc/backend/conat";
import { type Client } from "@cocalc/conat/core/client";
import { delay } from "awaiting";

const logger = getLogger("hub:proxy-conat");

const ADDRESS_UPDATE_INTERVAL = 30_000;

type ProxyConatOptions = {
  localConatServer: boolean;
};

export async function proxyConatWebsocket(
  req,
  socket,
  head,
  opts: ProxyConatOptions,
) {
  const target = randomServer(opts) + extractConatPath(req.url);
  logger.debug(`conat proxy -- proxying a WEBSOCKET connection to ${target}`);
  const proxy = createConatProxy(target);
  proxy.on("error", (err) => {
    logger.debug(`WARNING: conat websocket proxy error -- ${err}`);
  });
  proxy.ws(req, socket, head);
}

export async function proxyConatRequest(req, res, opts: ProxyConatOptions) {
  const target =
    randomServer(opts) + extractConatPath(req.originalUrl ?? req.url);
  logger.debug(`conat proxy -- proxying an HTTP request to ${target}`);
  const proxy = createConatProxy(target);
  proxy.on("error", (err) => {
    logger.debug(`WARNING: conat http proxy error -- ${err}`);
    if (!res.headersSent) {
      res.statusCode = 502;
    }
    try {
      res.end("Bad Gateway");
    } catch {}
  });
  proxy.web(req, res);
}

let client: Client | null = null;
let addresses: string[] = [];
function randomServer(opts: ProxyConatOptions): string {
  if (client == null) {
    addressUpdateLoop();
  }
  if (addresses.length == 0) {
    addresses.push(
      opts.localConatServer ? localConatServerAddress() : conatServer0,
    );
    return addresses[0];
  }
  // random choice
  const i = Math.floor(Math.random() * addresses.length);
  return addresses[i];
}

function createConatProxy(target: string): ProxyServer {
  return createProxyServer({
    ws: true,
    secure: false,
    target,
  });
}

function localConatServerAddress(): string {
  return `http://localhost:${conatClusterPort}${basePath.length > 1 ? basePath : ""}`;
}

function extractConatPath(rawUrl: string | undefined): string {
  const url = `${rawUrl ?? "/"}`;
  const i = url.lastIndexOf("/conat");
  if (i === -1) {
    throw new Error(`invalid conat proxy path: ${url}`);
  }
  return url.slice(i);
}

async function addressUpdateLoop() {
  client = conat();
  await client.waitUntilSignedIn();
  if (!client.info?.clusterName) {
    // no point -- not a cluster
    return;
  }
  while (true) {
    try {
      addresses = await client.cluster();
      logger.debug("addressUpdateLoop: got", addresses);
    } catch (err) {
      logger.debug(
        "addressUpdateLoop: error -- updating cluster addresses",
        err,
      );
    }
    await delay(ADDRESS_UPDATE_INTERVAL);
  }
}
