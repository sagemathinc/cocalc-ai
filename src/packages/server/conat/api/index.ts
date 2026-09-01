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
import * as adminData from "./admin-data-explorer";
import * as adminDb from "./admin-db";
import * as adminHost from "./admin-host";
import * as adminSupport from "./admin-support";
import * as adminCrashes from "./admin-crashes";
import * as aiSessions from "./ai-sessions";
import * as legacyMigration from "./legacy-migration";
import * as compute from "./compute";
import * as publicDirectoryShares from "./public-directory-shares";
import * as growthAnalytics from "./growth-analytics";
import * as commercialOrders from "./commercial-orders";
import * as adminCrm from "./crm";

import getLogger from "@cocalc/backend/logger";
import {
  type HubApi,
  getHubApiPrincipalPolicy,
  getUserId,
  isHubApiPrincipalAllowed,
  transformArgs,
} from "@cocalc/conat/hub/api";
import { hubApiErrorAttrs } from "@cocalc/conat/hub/api/error-attrs";
import { conat } from "@cocalc/backend/conat";
import { delay } from "awaiting";
import { recordServiceAdmissionDenialLocal } from "./service-admission-denials";
import {
  getServiceAdmissionLimit,
  serviceAdmissionLimitEnvName,
} from "@cocalc/conat/admission/limits";
import { recordServiceAdmissionNearLimit } from "@cocalc/conat/admission/denials";
import {
  isAccountBannedCached,
  syncAccountSecurityStateOnce,
  startAccountSecurityStateSyncLoop,
} from "@cocalc/server/accounts/security-state";
import { getHubApiAdmissionDecision } from "./admission";
import {
  type HubApiPrincipalType,
  recordHubApiPrincipalDenial,
} from "./principal-policy-denials";

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
  adminData,
  adminDb,
  adminHost,
  adminSupport,
  adminCrashes,
  aiSessions,
  legacyMigration,
  compute,
  publicDirectoryShares,
  growthAnalytics,
  commercialOrders,
  adminCrm,
  ssh,
  reflect,
};

const logger = getLogger("server:conat:api");

const HUB_API_SUBJECTS = ["hub.*.*.api", "hub.agent.*.*.*.*.*.api"] as const;

let activeApiRequests = 0;
const activeApiRequestsByAccount = new Map<string, number>();
type ActiveAccountApiRequest = { name: string; startedAt: number };
const activeApiRequestDetailsByAccount = new Map<
  string,
  Set<ActiveAccountApiRequest>
>();

function summarizeActiveAccountApiRequests(account_id?: string): {
  active_methods?: string;
  oldest_ms?: number;
} {
  if (!account_id) return {};
  const requests = activeApiRequestDetailsByAccount.get(account_id);
  if (!requests?.size) return {};
  const counts = new Map<string, number>();
  let oldestAt = Date.now();
  for (const request of requests) {
    counts.set(request.name, (counts.get(request.name) ?? 0) + 1);
    oldestAt = Math.min(oldestAt, request.startedAt);
  }
  return {
    active_methods: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([name, count]) => `${name}=${count}`)
      .join(","),
    oldest_ms: Math.max(0, Date.now() - oldestAt),
  };
}

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
  logger.debug("initAPI", {
    subjects: HUB_API_SUBJECTS,
    queue: "0",
  });
  // Load current ban/security state before accepting API traffic. The sync loop
  // below keeps this cache fresh without per-request database or inter-bay work.
  await syncAccountSecurityStateOnce({ maxPages: 1000 });
  startAccountSecurityStateSyncLoop();
  const cn = await conat({ noCache: true });
  const subscriptions = await Promise.all(
    HUB_API_SUBJECTS.map(async (subject) => ({
      subject,
      subscription: await cn.subscribe(subject, { queue: "0" }),
    })),
  );
  try {
    await Promise.race(
      subscriptions.map(async ({ subject, subscription }) => {
        for await (const mesg of subscription) {
          void handleMessage({ mesg }).catch((err) => {
            logger.debug(`WARNING: unexpected error - ${err}`);
          });
        }
        throw new Error(`hub api subscription ended: ${subject}`);
      }),
    );
  } finally {
    for (const { subscription } of subscriptions) {
      subscription.close();
    }
    cn.close();
  }
}

async function handleMessage({ mesg }) {
  const request = mesg.data ?? ({} as any);
  const { account_id } = getUserId(mesg.subject);
  // we explicitly do NOT await this, since we want this hub server to handle
  // potentially many messages at once, not one at a time!
  const maxActiveApiRequests = getServiceAdmissionLimit(
    "hub_conat_api_max_active",
  );
  const maxActiveApiRequestsPerAccount = getServiceAdmissionLimit(
    "hub_conat_api_max_active_per_account",
  );
  const activeAccountApiRequests = account_id
    ? (activeApiRequestsByAccount.get(account_id) ?? 0)
    : undefined;
  const limitName = serviceAdmissionLimitEnvName("hub_conat_api_max_active");
  const accountLimitName = serviceAdmissionLimitEnvName(
    "hub_conat_api_max_active_per_account",
  );
  const admission = getHubApiAdmissionDecision({
    active: activeApiRequests,
    maximum: maxActiveApiRequests,
    accountActive: activeAccountApiRequests,
    accountMaximum: account_id ? maxActiveApiRequestsPerAccount : undefined,
    key: request?.name,
  });
  if (!admission.allowed) {
    const accountLimited = admission.source.startsWith("hub-api-account");
    const activeSummary = summarizeActiveAccountApiRequests(account_id);
    const recordedReason = activeSummary.active_methods
      ? `${admission.reason}; active=${activeSummary.active_methods}; oldest_ms=${activeSummary.oldest_ms}`
      : admission.reason;
    void recordServiceAdmissionDenialLocal({
      surface: "hub-conat-api",
      source: admission.source,
      limit: accountLimited ? accountLimitName : limitName,
      current: accountLimited
        ? (activeAccountApiRequests ?? 0)
        : activeApiRequests,
      maximum: admission.maximum,
      reason: recordedReason,
      subject: mesg.subject,
      account_id,
      key: request?.name,
    });
    logger.warn("rejecting hub.api request; active request cap reached", {
      active: activeApiRequests,
      account_active: activeAccountApiRequests,
      account_id,
      max: admission.maximum,
      name: request?.name,
      source: admission.source,
      ...activeSummary,
    });
    mesg.respond(null, {
      noThrow: true,
      headers: {
        error: admission.reason ?? "hub api server is busy",
        error_attrs: { code: 503 },
      },
    });
    return;
  }
  recordServiceAdmissionNearLimit({
    surface: "hub-conat-api",
    source: admission.source,
    limit: limitName,
    current: activeApiRequests + 1,
    maximum: maxActiveApiRequests,
    reason: "hub api server is near capacity",
    subject: mesg.subject,
    key: request?.name,
  });
  activeApiRequests += 1;
  const activeRequest: ActiveAccountApiRequest | undefined = account_id
    ? {
        name: `${request?.name ?? "unknown"}`,
        startedAt: Date.now(),
      }
    : undefined;
  if (account_id) {
    activeApiRequestsByAccount.set(account_id, activeAccountApiRequests! + 1);
    let requests = activeApiRequestDetailsByAccount.get(account_id);
    if (!requests) {
      requests = new Set();
      activeApiRequestDetailsByAccount.set(account_id, requests);
    }
    requests.add(activeRequest!);
  }
  void handleApiRequest({ request, mesg }).finally(() => {
    activeApiRequests -= 1;
    if (account_id) {
      const next = (activeApiRequestsByAccount.get(account_id) ?? 1) - 1;
      if (next <= 0) {
        activeApiRequestsByAccount.delete(account_id);
      } else {
        activeApiRequestsByAccount.set(account_id, next);
      }
      const requests = activeApiRequestDetailsByAccount.get(account_id);
      if (activeRequest) requests?.delete(activeRequest);
      if (!requests?.size) activeApiRequestDetailsByAccount.delete(account_id);
    }
  });
}

export async function handleApiRequest({ request, mesg }) {
  let resp, headers;
  try {
    const {
      account_id,
      project_id,
      host_id,
      auth_actor,
      auth_token_fingerprint,
      auth_iat_s,
      auth_exp_s,
    } = getUserId(mesg.subject);
    const { name, args, auth_session_hash } = request as any;
    const principalPolicy = getHubApiPrincipalPolicy(name);
    if (
      principalPolicy != null &&
      !isHubApiPrincipalAllowed({
        policy: principalPolicy,
        account_id,
        project_id,
        host_id,
        auth_actor,
      })
    ) {
      const principal_type: HubApiPrincipalType = auth_actor
        ? "agent"
        : account_id
          ? "account"
          : project_id
            ? "project"
            : "host";
      void recordHubApiPrincipalDenial({
        principal_type,
        account_id: principal_type === "account" ? account_id : undefined,
        project_id:
          principal_type === "project" || principal_type === "agent"
            ? project_id
            : undefined,
        host_id: principal_type === "host" ? host_id : undefined,
        method: name,
        required_policy: principalPolicy,
      });
      throw Object.assign(
        new Error(
          principalPolicy === "account"
            ? `account principal required for '${name}'`
            : `principal '${principal_type}' is not permitted for '${name}' (requires ${principalPolicy})`,
        ),
        { code: 403 },
      );
    }
    if (auth_actor === "agent" && !AGENT_HUB_API_METHODS.has(name)) {
      throw Object.assign(
        new Error(`agent API method '${name}' is not permitted`),
        { code: 403 },
      );
    }
    logger.debug("handling hub.api request:", {
      account_id,
      project_id,
      host_id,
      name,
    });
    if (account_id && isAccountBannedCached(account_id)) {
      throw Object.assign(new Error("account is banned"), { code: 403 });
    }
    resp =
      (await getResponse({
        name,
        args,
        account_id,
        auth_session_hash,
        project_id,
        host_id,
        auth_actor,
        auth_token_fingerprint,
        auth_iat_s,
        auth_exp_s,
      })) ?? null;
    headers = undefined;
  } catch (err) {
    resp = null;
    headers = {
      error: err.message ? err.message : `${err}`,
      error_attrs: hubApiErrorAttrs(err),
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
  auth_actor,
  auth_token_fingerprint,
  auth_iat_s,
  auth_exp_s,
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
    auth_actor,
    auth_token_fingerprint,
    auth_iat_s,
    auth_exp_s,
  });
  return await f(...args2);
}

const AGENT_HUB_API_METHODS = new Set([
  "system.getPublicSiteUrl",
  "compute.listProjectVms",
  "compute.getProjectVm",
  "compute.listProjectVolumes",
  "compute.getProjectVolume",
  "compute.authorizeProjectSshKey",
  "compute.createVm",
  "compute.startVm",
  "compute.stopVm",
  "compute.deleteVm",
  "compute.setVmTtl",
  "compute.setVmFundingMode",
  "compute.setVmMachineType",
  "compute.setVmPricingModel",
  "compute.createVolume",
  "compute.resizeVolume",
  "compute.setVolumeFundingMode",
  "compute.deleteVolume",
]);
