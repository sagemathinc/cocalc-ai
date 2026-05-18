/*
This is meant to be similar to the nexts pages http api/v2, but using Conat instead of HTTPS.

To do development:

1. Run this script at the terminal:

    echo "require('@cocalc/server/conat/api').initAPI()" | COCALC_PRODUCT=launchpad DEBUG_CONSOLE=yes DEBUG=cocalc:* node


2. Optional: start more servers -- requests get randomly routed to exactly one of them:

    echo "require('@cocalc/server/conat').default()" | COCALC_PRODUCT=launchpad DEBUG_CONSOLE=yes DEBUG=cocalc:* node
    echo "require('@cocalc/server/conat').default()" | COCALC_PRODUCT=launchpad DEBUG_CONSOLE=yes DEBUG=cocalc:* node


To make use of this from a browser:

    await cc.client.conat_client.hub.system.getCustomize(['siteName'])

or

    await cc.client.conat_client.callHub({name:"system.getCustomize", args:[['siteName']]})

When you make changes, just restart the above.  All clients will instantly
use the new version after you restart, and there is no need to restart the hub
itself or any clients.

To view requests in realtime

cd packages/backend
pnpm conat-watch 'hub.*.*.api' --match-replies

*/

import * as purchases from "./purchases";
import * as db from "./db";
import * as system from "./system";
import * as projects from "./projects";
import * as sync from "./sync";
import * as org from "./org";
import * as messages from "./messages";
import * as hosts from "./hosts";
import * as software from "./software";
import * as lro from "./lro";
import * as agent from "./agent";
import * as notifications from "./notifications";

import getLogger from "@cocalc/backend/logger";
import { type HubApi, getUserId, transformArgs } from "@cocalc/conat/hub/api";
import { conat } from "@cocalc/backend/conat";
import { delay } from "awaiting";
import { recordServiceAdmissionDenialLocal } from "./service-admission-denials";
import {
  getServiceAdmissionLimit,
  serviceAdmissionLimitEnvName,
} from "@cocalc/conat/admission/limits";
import { recordServiceAdmissionNearLimit } from "@cocalc/conat/admission/denials";

const ssh = {} as any;
const reflect = {} as any;

export const hubApi: HubApi = {
  system,
  projects,
  db,
  purchases,
  sync,
  org,
  messages,
  hosts,
  software,
  lro,
  agent,
  notifications,
  ssh,
  reflect,
};

const logger = getLogger("server:conat:api");

let activeApiRequests = 0;

export function initAPI() {
  mainLoop();
}

async function mainLoop() {
  let d = 3000;
  let lastStart = 0;
  while (true) {
    try {
      lastStart = Date.now();
      await serve();
    } catch (err) {
      logger.debug(`hub conat api service error -- ${err}`);
      if (Date.now() - lastStart >= 30000) {
        // it ran for a while, so no delay
        logger.debug(`will restart immediately`);
        d = 3000;
      } else {
        // it crashed quickly, so delay!
        d = Math.min(20000, d * 1.25 + Math.random());
        logger.debug(`will restart in ${d}ms`);
        await delay(d);
      }
    }
  }
}

async function serve() {
  const subject = "hub.*.*.api";
  logger.debug(`initAPI -- subject='${subject}', options=`, {
    queue: "0",
  });
  const cn = await conat({ noCache: true });
  const api = await cn.subscribe(subject, { queue: "0" });
  for await (const mesg of api) {
    (async () => {
      try {
        await handleMessage({ mesg });
      } catch (err) {
        logger.debug(`WARNING: unexpected error  - ${err}`);
      }
    })();
  }
}

async function handleMessage({ mesg }) {
  const request = mesg.data ?? ({} as any);
  // we explicitly do NOT await this, since we want this hub server to handle
  // potentially many messages at once, not one at a time!
  const maxActiveApiRequests = getServiceAdmissionLimit(
    "hub_conat_api_max_active",
  );
  const limitName = serviceAdmissionLimitEnvName("hub_conat_api_max_active");
  if (activeApiRequests >= maxActiveApiRequests) {
    void recordServiceAdmissionDenialLocal({
      surface: "hub-conat-api",
      source: "hub-api",
      limit: limitName,
      current: activeApiRequests,
      maximum: maxActiveApiRequests,
      reason: "hub api server is busy",
      subject: mesg.subject,
      key: request?.name,
    });
    logger.warn("rejecting hub.api request; active request cap reached", {
      active: activeApiRequests,
      max: maxActiveApiRequests,
      name: request?.name,
    });
    mesg.respond(null, {
      noThrow: true,
      headers: {
        error: "hub api server is busy",
        error_attrs: { code: 503 },
      },
    });
    return;
  }
  recordServiceAdmissionNearLimit({
    surface: "hub-conat-api",
    source: "hub-api",
    limit: limitName,
    current: activeApiRequests + 1,
    maximum: maxActiveApiRequests,
    reason: "hub api server is near capacity",
    subject: mesg.subject,
    key: request?.name,
  });
  activeApiRequests += 1;
  void handleApiRequest({ request, mesg }).finally(() => {
    activeApiRequests -= 1;
  });
}

async function handleApiRequest({ request, mesg }) {
  let resp, headers;
  try {
    const { account_id, project_id, host_id } = getUserId(mesg.subject);
    const { name, args, auth_session_hash } = request as any;
    logger.debug("handling hub.api request:", {
      account_id,
      project_id,
      host_id,
      name,
    });
    resp =
      (await getResponse({
        name,
        args,
        account_id,
        auth_session_hash,
        project_id,
        host_id,
      })) ?? null;
    headers = undefined;
  } catch (err) {
    resp = null;
    headers = {
      error: err.message ? err.message : `${err}`,
      error_attrs: { code: err.code, subject: err.subject },
    };
  }
  try {
    await mesg.respond(resp, { headers });
  } catch (err) {
    // there's nothing we can do here, e.g., maybe conat just died.
    logger.debug(
      `WARNING: error responding to hub.api request (client will receive no response) -- ${err}`,
    );
  }
}

async function getResponse({
  name,
  args,
  account_id,
  auth_session_hash,
  project_id,
  host_id,
}) {
  const [group, functionName] = name.split(".");
  const f = hubApi[group]?.[functionName];
  if (f == null) {
    throw Error(`unknown function '${name}'`);
  }
  const args2 = await transformArgs({
    name,
    args,
    account_id,
    auth_session_hash,
    project_id,
    host_id,
  });
  return await f(...args2);
}
